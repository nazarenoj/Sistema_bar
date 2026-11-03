const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const M = require('../src/mensajeria/servicio');
const Cuentas = require('../src/clientes/cuentaService');

let api, pool, cerrar, token, tokenBarista, cliente, cuenta, k = 0;

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
});
after(async () => { await cerrar(); });

// Lo que Ventas pide registrar en la cuenta, por la bandeja de salida.
const emitir = async (tipo, contenido, { docId = `VTA-${++k}`, secuencia = 1, destino = 'clientes' } = {}) => {
  const conn = await pool.getConnection();
  try { await M.publicar(conn, { origen: 'ventas', destino, tipo, docTipo: 'venta', docIdGlobal: docId, secuencia, contenido: { cliente_id: cliente.id, venta_id_global: docId, ...contenido } }); } finally { conn.release(); }
  await esperarMensajes(pool);
  return docId;
};
const saldo = async () => (await api('GET', `/api/cuentas-corrientes/${cuenta.id}`, { token })).json.saldo;
const movs = async () => (await api('GET', `/api/cuentas-corrientes/${cuenta.id}/movimientos`, { token })).json;

test('Clientes.RF03/RN03/RN33: apertura con límite, plazo y umbrales de mora; solo con permiso y solo para clientes con cuenta posible', async () => {
  const abrir = (b, t = token) => api('POST', '/api/cuentas-corrientes', { token: t, body: b });
  assert.equal((await abrir({ cliente_id: cliente.id }, tokenBarista)).status, 403);
  const cf = (await api('GET', '/api/clientes?q=consumidor', { token })).json[0];
  assert.equal((await abrir({ cliente_id: cf.id })).status, 409); // RN03: nunca al Consumidor Final
  assert.equal((await abrir({ cliente_id: cliente.id, limite_credito: -5 })).status, 400);
  assert.equal((await abrir({ cliente_id: cliente.id, dias_mora_autorizacion: 30, dias_mora_bloqueo: 10 })).status, 400); // la autorización va antes del bloqueo
  assert.equal((await abrir({ cliente_id: cliente.id, moneda: 'USD' })).status, 409); // necesita CLI-MONEDA-EXT
  assert.equal((await abrir({ cliente_id: cliente.id, tasa_mora: 2 })).status, 409); // necesita CLI-MORA
  const r = await abrir({ cliente_id: cliente.id, limite_credito: 100000, plazo_dias: 15 });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  cuenta = r.json;
  assert.deepEqual([cuenta.moneda, cuenta.estado, cuenta.saldo, cuenta.disponible, cuenta.dias_mora_autorizacion, cuenta.dias_mora_bloqueo], ['ARS', 'activa', 0, 100000, 5, 30]); // toma los de la instancia
  assert.equal((await abrir({ cliente_id: cliente.id })).status, 409); // una cuenta por moneda
  const mod = await api('PUT', `/api/cuentas-corrientes/${cuenta.id}`, { token, body: { limite_credito: 120000, dias_mora_autorizacion: 7 } });
  assert.deepEqual([mod.json.limite_credito, mod.json.dias_mora_autorizacion], [120000, 7]);
  assert.equal((await api('PUT', `/api/cuentas-corrientes/${cuenta.id}`, { token: tokenBarista, body: { limite_credito: 1 } })).status, 403);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM auditoria WHERE modulo = 'clientes' AND accion IN ('abrir_cuenta', 'modificar_cuenta')"))[0][0].n, 2);
});

test('Clientes.RF04/RN36/EX23: el débito por venta es idempotente por ID_Operacion y vence según el plazo de la cuenta', async () => {
  const docId = await emitir('debito_venta', { importe: 30000, fecha: '2026-11-02' }, { docId: 'VTA-A' });
  assert.equal(await saldo(), 30000);
  const m = (await movs())[0];
  assert.deepEqual([m.tipo, m.naturaleza, m.importe, m.fecha_vencimiento.slice(0, 10), m.saldo_pendiente, m.estado], ['venta', 'debito', 30000, '2026-11-17', 30000, 'pendiente']); // 15 días
  // El mismo mensaje otra vez (o reenviado tras una restauración): no duplica la deuda.
  const conn = await pool.getConnection();
  await conn.query("UPDATE mensajes_integracion SET estado = 'pendiente', proximo_intento_ms = 0, retenido_por_orden = 0 WHERE doc_id_global = ?", [docId]);
  conn.release();
  await esperarMensajes(pool);
  assert.equal(await saldo(), 30000);
  assert.equal((await movs()).length, 1);
  // Y una publicación repetida del mismo documento no genera otro mensaje.
  await emitir('debito_venta', { importe: 30000, fecha: '2026-11-02' }, { docId: 'VTA-A' });
  assert.equal((await movs()).length, 1);
});

test('Clientes.RN37/EX24: un error de negocio deja el mensaje rechazado en la bandeja de pendientes, sin reintento ni tocar la venta', async () => {
  await emitir('debito_venta', { importe: 0 }, { docId: 'VTA-MALA' });
  await emitir('debito_venta', { importe: 500, cliente_id: 99999 }, { docId: 'VTA-SINCLI' });
  await emitir('debito_venta', { importe: 500, moneda: 'USD' }, { docId: 'VTA-USD' });
  const rech = (await pool.query("SELECT motivo_rechazo FROM mensajes_integracion WHERE estado = 'rechazado' ORDER BY id"))[0].map((x) => x.motivo_rechazo);
  assert.deepEqual(rech, ['El importe del débito no es válido.', 'El cliente no existe.', 'El cliente no tiene cuenta corriente en USD.']);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM bandeja_pendientes WHERE causa = 'rechazado' AND modulo_responsable = 'clientes' AND estado = 'abierto'"))[0][0].n, 3);
  assert.equal(await saldo(), 30000);
});

test('Clientes.RF05/RN41: un remito se registra como débito de tipo Remito, y su anulación espera al débito original (EX25)', async () => {
  await emitir('remito_emitido', { importe: 8000, fecha: '2026-11-03', remito_id_global: 'REM-1' }, { docId: 'REM-1' });
  assert.equal(await saldo(), 38000);
  assert.equal((await movs()).find((m) => m.comprobante_ref === 'REM-1').tipo, 'remito');
  // La anulación llega antes que su débito: se retiene y recién entonces se aplica.
  await emitir('anulacion_debito', {}, { docId: 'VTA-B', secuencia: 2 });
  assert.equal((await pool.query("SELECT retenido_por_orden FROM mensajes_integracion WHERE doc_id_global = 'VTA-B'"))[0][0].retenido_por_orden, 1);
  await emitir('debito_venta', { importe: 5000 }, { docId: 'VTA-B', secuencia: 1 });
  await pool.query("UPDATE mensajes_integracion SET retenido_por_orden = 0, proximo_intento_ms = 0 WHERE doc_id_global = 'VTA-B' AND retenido_por_orden = 1");
  await esperarMensajes(pool);
  assert.equal(await saldo(), 38000); // sumó 5000 y la anulación los sacó
  const b = (await movs()).filter((m) => m.comprobante_ref === 'VTA-B' || m.comprobante_ref === 'VTA-B:anulacion');
  assert.deepEqual(b.map((m) => [m.naturaleza, m.estado]).sort(), [['credito', 'cancelado'], ['debito', 'anulado']]);
});

test('Clientes.RN05/RN06: el saldo nunca se edita y los movimientos no se modifican ni se borran', async () => {
  await assert.rejects(pool.query('UPDATE movimientos_cc SET importe = 1 WHERE cuenta_id = ?', [cuenta.id]), /no se edita/);
  await assert.rejects(pool.query('DELETE FROM movimientos_cc WHERE cuenta_id = ?', [cuenta.id]), /no se elimina/);
  assert.equal((await api('PUT', `/api/cuentas-corrientes/${cuenta.id}`, { token, body: { saldo: 0 } })).json.saldo, 38000); // no hay campo de saldo que editar
});

test('Clientes.RF09/RN09/EX06: notas de débito y crédito referencian el comprobante, la NC no lo supera y la fiscal queda pendiente si no se emite', async () => {
  const ventaA = (await movs()).find((m) => m.comprobante_ref === 'VTA-A');
  const nota = (b, t = token, h = {}) => api('POST', `/api/cuentas-corrientes/${cuenta.id}/notas`, { token: t, headers: h, body: b });
  assert.equal((await nota({ tipo: 'nc', importe: 100, motivo: 'bonificacion', referencia_id: ventaA.id }, tokenBarista)).status, 403);
  assert.equal((await nota({ tipo: 'nc', importe: 100, motivo: 'bonificacion' })).status, 400); // sin comprobante asociado
  assert.equal((await nota({ tipo: 'nc', importe: 100, motivo: 'inventado', referencia_id: ventaA.id })).status, 400);
  assert.equal((await nota({ tipo: 'nc', importe: 31000, motivo: 'bonificacion', referencia_id: ventaA.id })).status, 409); // supera el comprobante
  const nc = await nota({ tipo: 'nc', importe: 4000, motivo: 'bonificacion', referencia_id: ventaA.id }, token, { 'X-ID-Solicitud': 'nota-nc-1-abcdef' });
  assert.equal(nc.status, 201, JSON.stringify(nc.json));
  assert.equal(await saldo(), 34000);
  assert.equal((await movs()).find((m) => m.comprobante_ref === 'VTA-A' && m.tipo === 'venta').saldo_pendiente, 26000); // la NC bajó lo pendiente del comprobante
  assert.equal((await nota({ tipo: 'nc', importe: 27000, motivo: 'bonificacion', referencia_id: ventaA.id })).status, 409); // ya se corrigieron 4000
  const nd = await nota({ tipo: 'nd', importe: 700, motivo: 'otros', referencia_id: ventaA.id });
  assert.deepEqual([nd.json.naturaleza, nd.json.saldo_pendiente], ['debito', 700]);
  assert.equal(await saldo(), 34700);

  // Fiscal: si Ventas no puede emitir, queda pendiente de emisión y no afecta el saldo; se reintenta y recién ahí cuenta.
  Cuentas.usarEmisor(async () => { throw new Error('ARCA no responde'); });
  const fiscal = await nota({ tipo: 'nd', importe: 1000, motivo: 'intereses_mora', referencia_id: ventaA.id, fiscal: true });
  assert.equal(fiscal.status, 201);
  assert.deepEqual([fiscal.json.estado, /pendiente de emisión/.test(fiscal.json.aviso)], ['pendiente_emision', true]);
  assert.equal(await saldo(), 34700);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE tipo = 'nota_pendiente_emision' AND estado <> 'resuelta'"))[0][0].n, 1);
  Cuentas.usarEmisor(async (n) => { assert.equal(n.receptor.doc_tipo, 80); return { tipo_comprobante: 7, punto_venta: 1, numero: 15, cae: '70123456789012', estado: 'aprobada' }; });
  const re = await api('POST', `/api/cuentas-corrientes/notas/${fiscal.json.id}/emitir`, { token });
  assert.deepEqual([re.status, re.json.estado, re.json.comprobante_fiscal.cae], [200, 'pendiente', '70123456789012']);
  assert.equal(await saldo(), 35700);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE tipo = 'nota_pendiente_emision' AND estado <> 'resuelta'"))[0][0].n, 0);
  // El mismo envío con la misma clave de solicitud no crea otra nota.
  const igual = await nota({ tipo: 'nc', importe: 4000, motivo: 'bonificacion', referencia_id: ventaA.id }, token, { 'X-ID-Solicitud': 'nota-nc-1-abcdef' });
  assert.equal(igual.json.id, nc.json.id);
  assert.equal(await saldo(), 35700);
});

test('Clientes.RN15/EX10: una cuenta solo se cierra con saldo cero y una cerrada rechaza débitos', async () => {
  const c2 = (await api('POST', '/api/clientes', { token, body: { tipo_documento: 'DNI', nro_documento: '31000111', razon_social: 'Sin deuda' } })).json;
  const ab = (await api('POST', '/api/cuentas-corrientes', { token, body: { cliente_id: c2.id, limite_credito: 1000 } })).json;
  assert.equal((await api('POST', `/api/cuentas-corrientes/${cuenta.id}/cerrar`, { token })).status, 409);
  assert.equal((await api('POST', `/api/cuentas-corrientes/${ab.id}/cerrar`, { token })).json.estado, 'cerrada');
  await emitir('debito_venta', { importe: 10, cliente_id: c2.id }, { docId: 'VTA-CERRADA' });
  assert.equal((await pool.query("SELECT motivo_rechazo FROM mensajes_integracion WHERE doc_id_global = 'VTA-CERRADA'"))[0][0].motivo_rechazo, 'La cuenta corriente está cerrada.');
  assert.equal((await api('GET', `/api/cuentas-corrientes?cliente_id=${c2.id}`, { token })).json[0].estado, 'cerrada');
});
