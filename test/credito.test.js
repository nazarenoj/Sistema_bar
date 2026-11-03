const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const puertos = require('../src/modulos/puertos');
const Credito = require('../src/clientes/creditoService');
const Cuentas = require('../src/clientes/cuentaService');

let api, pool, cerrar, token, cliente, cuenta, n = 0, k = 0;
const SUP = { usuario: 'sup', credencial: 'clave-larga-1' };

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
  };
  token = await usuario('adm', 'administrador');
  await usuario('sup', 'encargado');
  await api('POST', '/api/modulos/clientes/instalar', { token });
  cliente = (await api('POST', '/api/clientes', { token, body: { tipo_documento: 'CUIT', nro_documento: '30711111111', razon_social: 'Café del Centro SRL', consultar_arca: false } })).json;
});
after(async () => { await cerrar(); });

const cc = (path = '', metodo = 'GET', body) => api(metodo, `/api/cuentas-corrientes${path}`, { token, body });
// Vende una cuenta de `precio` con los pagos indicados.
const vender = async (precio, pagos, extra = {}) => {
  const p = (await api('POST', '/api/productos', { token, body: { nombre: `Prod ${++n}`, precio } })).json;
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: p.id, cantidad: 1 }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-cc-${++k}-abcdef` }, body: { pagos, cliente_id: cliente.id, ...extra } });
  await esperarMensajes(pool);
  return r;
};
const aCuenta = (importe) => [{ forma: 'cuenta_corriente', importe }];
const saldo = async () => (await cc(`/${cuenta.id}`)).json.saldo;

test('Ventas RF16: la forma de pago "Cuenta Corriente" se ofrece solo con VEN-CC y Clientes; sin cliente identificado no se cierra', async () => {
  const f = async () => (await api('GET', '/api/formas-pago', { token })).json.find((x) => x.codigo === 'cuenta_corriente');
  assert.equal((await f()).disponible, false);
  assert.equal((await vender(100, aCuenta(100))).status, 400); // VEN-CC apagada
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['VEN-CC'], motivo: 'prueba' } })).status, 200);
  assert.equal((await f()).disponible, true);
  cuenta = (await cc('', 'POST', { cliente_id: cliente.id, limite_credito: 10000, plazo_dias: 15 })).json;
  assert.equal((await vender(100, aCuenta(100), { cliente_id: null })).json.codigo, 'CLIENTE_NO_IDENTIFICADO');
  const cf = (await api('GET', '/api/clientes?q=consumidor', { token })).json[0];
  assert.equal((await vender(100, aCuenta(100), { cliente_id: cf.id })).json.codigo, 'CREDITO_BLOQUEADO'); // RN03: nunca al Consumidor Final
});

test('Clientes.RN04/RF26: con veredicto Permitida la venta se cierra con la reserva, y el débito la convierte en deuda en el mismo registro', async () => {
  const r = await vender(4000, aCuenta(4000));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(await saldo(), 4000);
  const [m] = (await cc(`/${cuenta.id}/movimientos`)).json;
  assert.deepEqual([m.tipo, m.importe, m.en_contingencia], ['venta', 4000, 0]);
  assert.match(m.id_reserva_credito, /^RC-/);
  assert.equal((await pool.query('SELECT estado FROM reservas_credito WHERE id_reserva = ?', [m.id_reserva_credito]))[0][0].estado, 'convertida'); // no cuenta dos veces
  assert.equal((await cc(`/${cuenta.id}`)).json.disponible, 6000);
  // Pago mixto: solo la parte a cuenta es deuda.
  assert.equal((await vender(1000, [{ forma: 'efectivo', importe: 600 }, { forma: 'cuenta_corriente', importe: 400 }])).status, 200);
  assert.equal(await saldo(), 4400);
});

test('Clientes.RN04/EX04: crédito excedido requiere la autorización de un supervisor (otro usuario) con el motivo exacto', async () => {
  const sin = await vender(7000, aCuenta(7000));
  assert.deepEqual([sin.status, sin.json.codigo], [403, 'CREDITO_REQUIERE_AUTORIZACION']);
  assert.match(sin.json.error, /Crédito excedido: límite 10000, saldo 4400, reservas vigentes 0, disponible 5600, excedente 1400/);
  assert.equal(await saldo(), 4400);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM reservas_credito WHERE estado = 'vigente'"))[0][0].n, 0); // la venta no se cerró: nada quedó reservado
  const con = await vender(7000, aCuenta(7000), { autorizacion: SUP });
  assert.equal(con.status, 200, JSON.stringify(con.json));
  assert.equal(await saldo(), 11400);
  const propia = await vender(100, aCuenta(100), { autorizacion: { usuario: 'adm', credencial: 'clave-larga-1' } });
  assert.equal(propia.status, 403); // nadie se autoriza a sí mismo
  assert.equal((await pool.query("SELECT veredicto FROM veredictos_credito ORDER BY id DESC LIMIT 1"))[0][0].veredicto, 'requiere_autorizacion'); // cada veredicto queda registrado
});

test('Clientes.RF13/RN04: una cuenta bloqueada nunca admite autorización; sí admite cobros; desbloquear exige permiso y motivo', async () => {
  assert.equal((await cc(`/${cuenta.id}/bloquear`, 'POST', {})).status, 400); // el bloqueo manual exige motivo
  const b = await cc(`/${cuenta.id}/bloquear`, 'POST', { motivo: 'Cheques rechazados' });
  assert.equal(b.json.estado, 'bloqueada');
  const r = await vender(100, aCuenta(100), { autorizacion: SUP });
  assert.deepEqual([r.status, r.json.codigo], [409, 'CREDITO_BLOQUEADO']); // la autorización no sirve
  assert.match(r.json.error, /bloqueada \(manualmente: Cheques rechazados\)/);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE tipo = 'cuenta_bloqueada'"))[0][0].n, 1);
  assert.equal((await cc(`/${cuenta.id}/desbloquear`, 'POST', {})).status, 400);
  assert.equal((await cc(`/${cuenta.id}/desbloquear`, 'POST', { motivo: 'Regularizó' })).json.estado, 'activa');
});

test('Clientes.RN33: el modo de control de crédito (bloquear / requerir autorización / solo advertir) rige los veredictos siguientes', async () => {
  const exceso = { cliente_id: cliente.id, importe: 500 }; // la cuenta está excedida
  assert.equal((await cc('/veredicto', 'POST', exceso)).json.veredicto, 'requiere_autorizacion');
  assert.equal((await cc('/modo-credito', 'PUT', { modo: 'otro' })).status, 400);
  await cc('/modo-credito', 'PUT', { modo: 'bloquear' });
  assert.equal((await cc('/veredicto', 'POST', exceso)).json.veredicto, 'bloqueada');
  assert.equal((await vender(500, aCuenta(500), { autorizacion: SUP })).json.codigo, 'CREDITO_BLOQUEADO');
  await cc('/modo-credito', 'PUT', { modo: 'solo_advertir' });
  const adv = await cc('/veredicto', 'POST', exceso);
  assert.deepEqual([adv.json.veredicto, /Crédito excedido/.test(adv.json.aviso)], ['permitida', true]);
  assert.equal((await vender(500, aCuenta(500))).status, 200); // con "solo advertir" la venta sigue
  await cc('/modo-credito', 'PUT', { modo: 'requerir_autorizacion' });
  assert.equal((await cc('/modo-credito')).json.modo, 'requerir_autorizacion');
});

test('Clientes.RF26/EX22/EX21: dos terminales no superan el límite a la vez; la reserva es idempotente, se reemplaza, se renueva y vence sola', async () => {
  await cc(`/${cuenta.id}`, 'PUT', { limite_credito: 20000 }); // saldo 11900: quedan 8100
  const pedir = (id, importe, extra = {}) => cc('/reservas', 'POST', { cliente_id: cliente.id, importe, idSolicitud: id, ...extra });
  const [a, b] = await Promise.all([pedir('res-term-1-abcdef', 6000), pedir('res-term-2-abcdef', 6000)]);
  const resultados = [a.json, b.json].sort((x, y) => (x.id_reserva ? -1 : 1) - (y.id_reserva ? -1 : 1));
  assert.deepEqual([resultados[0].veredicto, !!resultados[0].id_reserva, resultados[1].veredicto, !!resultados[1].id_reserva], ['permitida', true, 'requiere_autorizacion', false]); // solo alcanzó para una
  const ganadora = resultados[0];
  assert.equal((await cc(`/${cuenta.id}/reservas`)).json[0].importe, 6000); // visible en la ficha
  assert.equal((await cc(`/${cuenta.id}`)).json.disponible, 2100);
  // Un reintento con la misma clave devuelve la misma reserva; con otro importe es un conflicto de idempotencia.
  const claveGanadora = a.json.id_reserva === ganadora.id_reserva ? 'res-term-1-abcdef' : 'res-term-2-abcdef';
  assert.equal((await pedir(claveGanadora, 6000)).json.id_reserva, ganadora.id_reserva);
  assert.equal((await pedir(claveGanadora, 7000)).status, 409);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE tipo = 'conflicto_idempotencia'"))[0][0].n, 1);
  // Cambiar el importe es un intento nuevo con Reemplaza_A: libera la anterior y toma la nueva en una sola operación.
  const nueva = await pedir('res-term-3-abcdef', 7500, { reemplazaA: ganadora.id_reserva });
  assert.equal(nueva.json.veredicto, 'permitida');
  assert.equal((await cc(`/${cuenta.id}/reservas`)).json.length, 1);
  assert.equal((await cc(`/${cuenta.id}`)).json.disponible, 600);
  // Renovar hasta 3 veces; vencida, no se renueva y libera el crédito.
  for (let i = 0; i < 3; i++) assert.equal((await cc(`/reservas/${nueva.json.id_reserva}/renovar`, 'POST')).status, 200);
  assert.equal((await cc(`/reservas/${nueva.json.id_reserva}/renovar`, 'POST')).status, 409);
  await pool.query('UPDATE reservas_credito SET vence_ms = ? WHERE id_reserva = ?', [Date.now() - 1000, nueva.json.id_reserva]);
  assert.equal((await cc(`/${cuenta.id}`)).json.disponible, 8100); // vence sola
  assert.equal((await cc(`/reservas/${nueva.json.id_reserva}/renovar`, 'POST')).json.codigo, 'RESERVA_VENCIDA');
  const lib = await pedir('res-term-4-abcdef', 1000);
  assert.equal((await cc(`/reservas/${lib.json.id_reserva}`, 'DELETE')).json.liberadas, 1);
  assert.equal((await cc(`/${cuenta.id}`)).json.disponible, 8100);
});

test('Clientes.RN33/RF13: la mora sobre el umbral pide autorización y sobre el de bloqueo bloquea la cuenta una sola vez por comprobante', async () => {
  const c2 = (await api('POST', '/api/clientes', { token, body: { tipo_documento: 'DNI', nro_documento: '30999111', razon_social: 'Moroso' } })).json;
  const ab = (await cc('', 'POST', { cliente_id: c2.id, limite_credito: 100000, plazo_dias: 15 })).json;
  const dias = (d) => { const f = new Date(Date.now() - d * 86400000); const p = (x) => String(x).padStart(2, '0'); return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`; };
  const debito = async (ref, hace) => { const c = await pool.getConnection(); await Cuentas.registrarDebito(c, { tipo: 'venta', clienteId: c2.id, importe: 1000, ref, fecha: dias(hace + 15), idOperacion: `op-${ref}` }); c.release(); };
  await debito('V-MORA-10', 10); // vencido hace 10 días: supera el umbral de autorización (5), no el de bloqueo (30)
  const v = (await cc('/veredicto', 'POST', { cliente_id: c2.id, importe: 100 })).json;
  assert.deepEqual([v.veredicto, v.dias_mora, v.comprobante_vencido], ['requiere_autorizacion', 10, 'V-MORA-10']);
  assert.match(v.motivos[0], /Mora sobre el umbral de autorización \(5 días\): 10 días de mora, comprobante vencido más antiguo V-MORA-10/);
  await debito('V-MORA-40', 40); // vencido hace 40 días: bloquea
  const b = (await cc('/veredicto', 'POST', { cliente_id: c2.id, importe: 100 })).json;
  assert.deepEqual([b.veredicto, b.estado_cuenta], ['bloqueada', 'bloqueada']);
  assert.equal((await cc(`/${ab.id}`)).json.motivo_bloqueo, 'mora');
  assert.equal((await cc('/revisar', 'POST')).status, 200);
  // Tras desbloquear con permiso, los comprobantes que ya superaban el umbral no vuelven a bloquear (RN33); uno posterior, sí.
  await cc(`/${ab.id}/desbloquear`, 'POST', { motivo: 'Acordó un plan de pagos' });
  assert.equal((await cc('/revisar', 'POST')).json.bloqueadas, 0);
  assert.notEqual((await cc('/veredicto', 'POST', { cliente_id: c2.id, importe: 100 })).json.veredicto, 'bloqueada');
  await debito('V-MORA-45', 45);
  assert.equal((await cc('/veredicto', 'POST', { cliente_id: c2.id, importe: 100 })).json.veredicto, 'bloqueada');
  // Un bloqueo por mora rige también con "solo advertir".
  await cc('/modo-credito', 'PUT', { modo: 'solo_advertir' });
  assert.equal((await cc('/veredicto', 'POST', { cliente_id: c2.id, importe: 100 })).json.veredicto, 'bloqueada');
  await cc('/modo-credito', 'PUT', { modo: 'requerir_autorizacion' });
});

test('Clientes.RF27/RN35/EX20/EX27: si Clientes no responde la venta no se cierra salvo contingencia autorizada, y su débito se registra siempre y alerta el exceso', async () => {
  const real = puertos.obtener ? await puertos.obtener('credito') : null;
  puertos.registrar('credito', { ...real, reservar: async () => { throw new Error('Clientes reiniciándose'); } });
  const sin = await vender(30000, aCuenta(30000));
  assert.deepEqual([sin.status, sin.json.codigo], [409, 'CREDITO_NO_RESPONDE']);
  const sinMotivo = await vender(30000, aCuenta(30000), { autorizacion: SUP });
  assert.equal(sinMotivo.json.codigo, 'CREDITO_NO_RESPONDE'); // la contingencia exige el motivo
  const antes = await saldo();
  const ok = await vender(30000, aCuenta(30000), { autorizacion: SUP, motivo_contingencia: 'Cliente mayorista esperando en el mostrador' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  puertos.registrar('credito', real);
  assert.equal(await saldo(), antes + 30000); // el débito se registra siempre, porque la venta ya existe
  const m = (await cc(`/${cuenta.id}/movimientos`)).json[0];
  assert.deepEqual([m.en_contingencia, m.id_reserva_credito, m.excedente > 0], [1, null, true]);
  const alerta = (await pool.query("SELECT mensaje FROM notificaciones WHERE tipo = 'credito_excedido_contingencia'"))[0][0].mensaje;
  assert.match(alerta, /Venta en contingencia .* de Café del Centro SRL por 30000: el crédito quedó excedido/);
  const lista = (await cc('/contingencias')).json;
  assert.deepEqual(lista.map((x) => [x.importe, x.estado]), [[30000, 'registrada_con_exceso']]);
});

test('Clientes.EX21/RN34: un débito que llega con la reserva vencida se registra igual y alerta el exceso', async () => {
  const c3 = (await api('POST', '/api/clientes', { token, body: { tipo_documento: 'DNI', nro_documento: '31777888', razon_social: 'Reserva vencida' } })).json;
  const ab = (await cc('', 'POST', { cliente_id: c3.id, limite_credito: 1000, plazo_dias: 7 })).json;
  const res = (await cc('/reservas', 'POST', { cliente_id: c3.id, importe: 900, idSolicitud: 'res-venc-1-abcdef' })).json;
  await pool.query('UPDATE reservas_credito SET vence_ms = ? WHERE id_reserva = ?', [Date.now() - 1000, res.id_reserva]);
  await cc('/reservas', 'POST', { cliente_id: c3.id, importe: 900, idSolicitud: 'res-venc-2-abcdef' }); // otra operación toma el crédito
  const M = require('../src/mensajeria/servicio');
  const conn = await pool.getConnection();
  await M.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'debito_venta', docTipo: 'venta', docIdGlobal: 'VTA-VENCIDA', contenido: { cliente_id: c3.id, importe: 900, venta_id_global: 'VTA-VENCIDA', reserva_id: res.id_reserva } });
  await M.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'debito_venta', docTipo: 'venta', docIdGlobal: 'VTA-VENCIDA-2', contenido: { cliente_id: c3.id, importe: 900, venta_id_global: 'VTA-VENCIDA-2' } });
  conn.release();
  await esperarMensajes(pool);
  assert.equal((await cc(`/${ab.id}`)).json.saldo, 1800);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE tipo = 'credito_excedido'"))[0][0].n, 1); // solo el segundo débito dejó el crédito excedido
});

test('Clientes.RN39/RF28: el estado de procesamiento de una operación se consulta por su clave, y una devolución baja la deuda en la cuenta', async () => {
  const est = async (op) => (await cc(`/operaciones/${encodeURIComponent(op)}/estado`)).json;
  assert.equal((await est('ventas:debito_venta:NO-EXISTE:1')).estado, 'desconocida');
  assert.equal((await est('ventas:debito_venta:VTA-VENCIDA:1')).estado, 'confirmado');
  // Devolución total de una venta a cuenta: anula el débito (contramovimiento) y la deuda vuelve.
  const antes = await saldo();
  const v = await vender(2000, aCuenta(2000), { autorizacion: SUP });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  assert.equal(await saldo(), antes + 2000);
  const d = await api('POST', '/api/devoluciones', { token, headers: { 'X-ID-Solicitud': 'devol-cc-1-abcdef' }, body: { venta_id_global: v.json.venta_id_global, motivo: 'Devolución completa', items: [{ linea: 0, cantidad: 1 }], reintegros: [{ forma: 'cuenta_corriente', importe: 2000 }] } });
  assert.equal(d.status, 201, JSON.stringify(d.json));
  await esperarMensajes(pool);
  assert.equal(await saldo(), antes);
  assert.equal((await cc(`/${cuenta.id}/movimientos`)).json.find((m) => m.comprobante_ref === `${v.json.venta_id_global}:anulacion`).naturaleza, 'credito');
});
