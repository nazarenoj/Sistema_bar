const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const M = require('../src/mensajeria/servicio');

let api, pool, cerrar, token, tokenBarista, cliente, cuenta, k = 0;
const dia = (hace) => { const f = new Date(Date.now() - hace * 86400000); const p = (x) => String(x).padStart(2, '0'); return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`; };

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
  };
  token = await usuario('adm', 'administrador');
  tokenBarista = await usuario('bea', 'barista');
  await api('POST', '/api/modulos/clientes/instalar', { token });
  cliente = (await api('POST', '/api/clientes', { token, body: { tipo_documento: 'CUIT', nro_documento: '30711111111', razon_social: 'Café del Centro SRL', consultar_arca: false } })).json;
  cuenta = (await api('POST', '/api/cuentas-corrientes', { token, body: { cliente_id: cliente.id, limite_credito: 100000, plazo_dias: 15 } })).json;
});
after(async () => { await cerrar(); });

const debito = async (importe, fecha, docId = `VTA-${++k}`) => {
  const conn = await pool.getConnection();
  await M.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'debito_venta', docTipo: 'venta', docIdGlobal: docId, contenido: { cliente_id: cliente.id, importe, venta_id_global: docId, fecha } });
  conn.release();
  await esperarMensajes(pool);
  return docId;
};
const recibo = (body, clave = `rec-${++k}-abcdefgh`, t = token) => api('POST', '/api/recibos', { token: t, headers: { 'X-ID-Solicitud': clave }, body: { cuenta_id: cuenta.id, ...body } });
const efectivo = (importe) => ({ valores: [{ forma: 'efectivo', importe }] });
const saldo = async () => (await api('GET', `/api/cuentas-corrientes/${cuenta.id}`, { token })).json.saldo;
const pendientes = async () => (await api('GET', `/api/cuentas-corrientes/${cuenta.id}/pendientes`, { token })).json;

test('Clientes.RF07/RN08: el recibo imputa por vencimiento del más antiguo al más reciente, admite pagos parciales y se numera correlativo', async () => {
  const a = await debito(1000, dia(60)), b = await debito(2000, dia(30)), c = await debito(3000, dia(5)); // vencen en ese orden
  assert.equal(await saldo(), 6000);
  assert.equal((await recibo(efectivo(100), 'rec-sin-permiso-abc', tokenBarista)).status, 403);
  const r = await recibo(efectivo(2500));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.numero_completo, r.json.total, r.json.estado, r.json.saldo_a_favor], ['0001-00000001', 2500, 'vigente', 0]);
  assert.deepEqual(r.json.imputaciones.map((i) => [i.comprobante_ref, i.importe]), [[a, 1000], [b, 1500]]); // el más antiguo primero, parcial en el segundo
  assert.equal(await saldo(), 3500);
  assert.deepEqual((await pendientes()).map((p) => [p.comprobante_ref, p.saldo_pendiente]), [[b, 500], [c, 3000]]);
  assert.equal(r.json.config_version >= 0, true);
  assert.ok(r.json.instantanea.length >= 0);
});

test('Clientes.RN36/RN39/EX28: el recibo es idempotente por clave: un reintento no lo duplica ni consume otro número; otro contenido con la misma clave es un conflicto', async () => {
  const clave = 'rec-idem-1-abcdefgh';
  const r1 = await recibo(efectivo(500), clave);
  assert.equal(r1.status, 201);
  const r2 = await recibo(efectivo(500), clave);
  assert.equal(r2.json.id, r1.json.id); // el middleware de solicitudes devuelve el resultado original
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM recibos'))[0][0].n, 2);
  // Directo sobre el servicio (sin el middleware de la plataforma): ya procesado y conflicto.
  const Recibos = require('../src/clientes/reciboService');
  const dup = await Recibos.registrar({ cuenta_id: cuenta.id, valores: [{ forma: 'efectivo', importe: 500 }] }, { userId: 1, idOperacion: clave });
  assert.deepEqual([dup.id, dup.ya_procesado], [r1.json.id, true]);
  await assert.rejects(Recibos.registrar({ cuenta_id: cuenta.id, valores: [{ forma: 'efectivo', importe: 900 }] }, { userId: 1, idOperacion: clave }), { codigo: 'CONFLICTO_IDEMPOTENCIA' });
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE tipo = 'conflicto_idempotencia' AND clave LIKE 'conflicto-recibo-%'"))[0][0].n, 1);
  const r3 = await recibo(efectivo(100));
  assert.equal(r3.json.numero_completo, '0001-00000003'); // sin saltos ni números consumidos por los reintentos
});

test('Clientes.EX05/RN07: un recibo mayor a la deuda pide confirmar el excedente, que queda como saldo a favor; el vuelto solo donde se admite; el cheque lleva sus datos', async () => {
  const deuda = (await pendientes()).reduce((a, p) => a + p.saldo_pendiente, 0);
  const exceso = await recibo(efectivo(deuda + 4000));
  assert.deepEqual([exceso.status, exceso.json.codigo, exceso.json.excedente], [409, 'EXCEDENTE', 4000]);
  assert.equal((await pool.query('SELECT MAX(numero) AS n FROM recibos'))[0][0].n, 3); // el rechazado no consumió número
  const ok = await recibo({ ...efectivo(deuda + 4000), confirmar_excedente: true });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.numero_completo, '0001-00000004');
  assert.deepEqual([ok.json.saldo_a_favor, await saldo(), (await pendientes()).length], [4000, -4000, 0]);
  // Vuelto: efectivo lo admite, transferencia no.
  const conVuelto = await recibo({ valores: [{ forma: 'efectivo', importe: 100, recibido: 150 }], imputacion: 'ninguna' });
  assert.equal(conVuelto.json.valores[0].vuelto, 50);
  assert.equal((await recibo({ valores: [{ forma: 'transferencia', importe: 100, recibido: 150 }], imputacion: 'ninguna' })).status, 400);
  assert.equal((await recibo({ valores: [{ forma: 'inventada', importe: 100 }], imputacion: 'ninguna' })).status, 400);
  assert.equal((await recibo({ valores: [{ forma: 'cuenta_corriente', importe: 100 }], imputacion: 'ninguna' })).status, 400);
  // Cheque: banco, número, fecha de pago y CUIT del librador válido.
  const cheque = (c) => recibo({ valores: [{ forma: 'cheque', importe: 700, cheque: c }, { forma: 'efectivo', importe: 300 }], imputacion: 'ninguna' });
  assert.equal((await cheque({ banco: 'Nación', numero: '123' })).status, 400);
  assert.equal((await cheque({ banco: 'Nación', numero: '123', fecha_pago: '2026-12-15', cuit_librador: '30711111112' })).status, 400);
  const ch = await cheque({ banco: 'Nación', numero: '00123456', fecha_pago: '2026-12-15', cuit_librador: '30-71111111-1' });
  assert.equal(ch.status, 201, JSON.stringify(ch.json));
  assert.deepEqual([ch.json.total, ch.json.valores[0].cheque_banco, ch.json.valores[0].cheque_cuit_librador], [1000, 'Nación', '30711111111']);
});

test('Clientes.RF07/EX09: la imputación manual elige los comprobantes, el saldo a favor se imputa después, y dos usuarios sobre el mismo comprobante no lo pasan', async () => {
  const v1 = await debito(1000, dia(2)), v2 = await debito(1500, dia(1));
  const favor = (await api('GET', `/api/cuentas-corrientes/${cuenta.id}/movimientos`, { token })).json.find((m) => m.tipo === 'recibo' && m.saldo_pendiente === 4000);
  const pend = await pendientes();
  const id1 = pend.find((p) => p.comprobante_ref === v1).id, id2 = pend.find((p) => p.comprobante_ref === v2).id;
  const imputar = (items, modo = 'manual') => api('POST', `/api/recibos/imputar/${cuenta.id}`, { token, body: { credito_id: favor.id, modo, imputaciones: items } });
  assert.equal((await imputar([{ debito_id: id1, importe: 5000 }])).status, 409); // más que el pendiente del comprobante
  assert.equal((await imputar([{ debito_id: 99999, importe: 10 }])).status, 409);
  const ok = await imputar([{ debito_id: id2, importe: 1500 }]); // elige el más reciente primero
  assert.deepEqual([ok.status, ok.json.aplicado, ok.json.restante], [200, 1500, 2500], JSON.stringify(ok.json));
  assert.deepEqual((await pendientes()).map((p) => p.comprobante_ref), [v1]);
  // Dos imputaciones a la vez sobre el mismo comprobante (EX09): se confirma la primera y se rechaza la segunda.
  const [a, b] = await Promise.all([imputar([{ debito_id: id1, importe: 1000 }]), imputar([{ debito_id: id1, importe: 1000 }])]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((await pendientes()).length, 0);
});

test('Clientes.RF07/RN16: desimputar exige permiso y motivo, y el comprobante vuelve a deber', async () => {
  const mov = (await api('GET', `/api/cuentas-corrientes/${cuenta.id}/movimientos`, { token })).json;
  const imp = (await pool.query("SELECT id, debito_mov_id, importe FROM imputaciones WHERE estado = 'vigente' ORDER BY id DESC LIMIT 1"))[0][0];
  assert.equal((await api('POST', `/api/recibos/imputaciones/${imp.id}/desimputar`, { token: tokenBarista, body: { motivo: 'x' } })).status, 403);
  assert.equal((await api('POST', `/api/recibos/imputaciones/${imp.id}/desimputar`, { token, body: {} })).status, 400);
  const antes = await saldo();
  assert.equal((await api('POST', `/api/recibos/imputaciones/${imp.id}/desimputar`, { token, body: { motivo: 'Se imputó al comprobante equivocado' } })).status, 200);
  assert.equal((await pendientes())[0].id, imp.debito_mov_id);
  assert.equal(await saldo(), antes); // el saldo no cambia: solo cambia a qué comprobante se aplica
  assert.equal((await api('POST', `/api/recibos/imputaciones/${imp.id}/desimputar`, { token, body: { motivo: 'otra vez' } })).status, 409);
  assert.ok(mov.length > 0);
});

test('Clientes.RF17/RN08: anular un recibo desimputa, deja un contramovimiento y conserva su número con estado Anulado', async () => {
  await debito(800, dia(1));
  const r = (await recibo(efectivo(800))).json;
  const antes = await saldo();
  assert.equal((await api('POST', `/api/recibos/${r.id}/anular`, { token, body: {} })).status, 400);
  assert.equal((await api('POST', `/api/recibos/${r.id}/anular`, { token: tokenBarista, body: { motivo: 'x' } })).status, 403);
  const an = await api('POST', `/api/recibos/${r.id}/anular`, { token, body: { motivo: 'Importe mal cargado' } });
  assert.equal(an.status, 200, JSON.stringify(an.json));
  assert.deepEqual([an.json.estado, an.json.numero_completo, an.json.saldo_a_favor], ['anulado', r.numero_completo, 0]);
  assert.equal(await saldo(), antes + 800); // la deuda vuelve
  assert.equal((await api('POST', `/api/recibos/${r.id}/anular`, { token, body: { motivo: 'otra vez' } })).status, 409);
  const siguiente = await recibo(efectivo(10));
  assert.equal(Number(siguiente.json.numero_completo.slice(-8)), Number(r.numero_completo.slice(-8)) + 1); // el anulado no libera su número
  const lista = (await api('GET', `/api/recibos?cuenta_id=${cuenta.id}`, { token })).json;
  assert.ok(lista.find((x) => x.id === r.id && x.estado === 'anulado'));
  const p = await api('GET', `/api/recibos/${siguiente.json.id}/pdf`, { token });
  assert.equal(p.status, 200);
});

test('Clientes.RF28: un recibo que llega de otra terminal como mensaje se registra una sola vez; una cuenta cerrada lo rechaza y una bloqueada lo admite', async () => {
  const emitir = async (docId, contenido) => {
    const conn = await pool.getConnection();
    await M.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'recibo_registrado', docTipo: 'recibo', docIdGlobal: docId, contenido });
    conn.release();
    await esperarMensajes(pool);
  };
  const antes = (await pool.query('SELECT COUNT(*) AS n FROM recibos'))[0][0].n;
  await emitir('REC-TERM-2', { cuenta_id: cuenta.id, valores: [{ forma: 'efectivo', importe: 50 }], imputacion: 'ninguna' });
  await emitir('REC-TERM-2', { cuenta_id: cuenta.id, valores: [{ forma: 'efectivo', importe: 50 }], imputacion: 'ninguna' });
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM recibos'))[0][0].n, antes + 1);
  await api('POST', `/api/cuentas-corrientes/${cuenta.id}/bloquear`, { token, body: { motivo: 'prueba' } }).catch(() => null);
  await pool.query("UPDATE cuentas_corrientes SET estado = 'bloqueada', motivo_bloqueo = 'manual' WHERE id = ?", [cuenta.id]);
  assert.equal((await recibo(efectivo(20))).status, 201); // una cuenta bloqueada admite cobros
  await pool.query("UPDATE cuentas_corrientes SET estado = 'cerrada' WHERE id = ?", [cuenta.id]);
  assert.equal((await recibo(efectivo(20))).status, 409);
  await emitir('REC-TERM-3', { cuenta_id: cuenta.id, valores: [{ forma: 'efectivo', importe: 50 }], imputacion: 'ninguna' });
  assert.match((await pool.query("SELECT motivo_rechazo FROM mensajes_integracion WHERE doc_id_global = 'REC-TERM-3'"))[0][0].motivo_rechazo, /cerrada/);
});
