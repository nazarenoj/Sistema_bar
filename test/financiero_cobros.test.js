const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario, terminal, vender } = require('./ayudas_financiero');
const M = require('../src/mensajeria/servicio');

process.env.AFIP_CONDICION_IVA_EMISOR = 'monotributista';

let api, pool, cerrar, adm, cajero, term, barra, procesador, banco, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  term = await terminal(pool, 'Barra 1', 'BARRA001');
  adm = await usuario(api, pool, 'adm', 'administrador');
  cajero = await usuario(api, pool, 'cami', 'cajero', 'BARRA001');
  await api('POST', '/api/modulos/financiero/instalar', { token: adm.token });
  const crear = async (b) => (await api('POST', '/api/financiero/cuentas', { token: adm.token, body: b })).json;
  barra = await crear({ tipo: 'caja_efectivo', nombre: 'Caja Barra', terminal_id: term });
  procesador = await crear({ tipo: 'procesador', nombre: 'Posnet' });
  banco = await crear({ tipo: 'banco', nombre: 'Banco' });
  // Los cobros en efectivo piden turno abierto (Financiero RN04): el cajero abre el de su caja.
  const t = await api('POST', '/api/financiero/turnos', { token: cajero.token, body: { cuenta_id: barra.id, fondo_contado: 0 } });
  assert.equal(t.status, 201, JSON.stringify(t.json));
});
after(async () => { await cerrar(); });

const destino = (b) => api('PUT', '/api/financiero/destinos', { token: adm.token, body: b });
const movs = async (q = '') => (await api('GET', `/api/financiero/movimientos?${q}`, { token: adm.token })).json;
const saldo = async (id) => (await api('GET', `/api/financiero/cuentas/${id}`, { token: adm.token })).json.saldo;
const venta = (o) => vender(api, pool, cajero.token, { armar: adm.token, ...o });
const publicar = async (tipo, contenido, { docId = `VTA-X${++k}`, secuencia = 1, docVersion = 1 } = {}) => {
  const conn = await pool.getConnection();
  try { await M.publicar(conn, { origen: 'ventas', destino: 'financiero', tipo, docTipo: 'venta', docIdGlobal: docId, secuencia, docVersion, contenido }); } finally { conn.release(); }
  await esperarMensajes(pool);
  return docId;
};
const estadoMensaje = async (docId, tipo) => (await pool.query('SELECT estado, motivo_rechazo, retenido_por_orden FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = ? ORDER BY id DESC LIMIT 1', [docId, tipo]))[0][0];

test('Financiero.RF02: cada forma de pago tiene su destino; las que no mueven fondos no lo llevan; la moneda tiene que coincidir', async () => {
  assert.equal((await destino({ forma: 'efectivo', modo: 'caja_del_turno' }, cajero.token)).status, 200);
  assert.equal((await api('PUT', '/api/financiero/destinos', { token: cajero.token, body: { forma: 'otro', cuenta_id: banco.id } })).status, 403);
  assert.equal((await destino({ forma: 'no_existe', cuenta_id: banco.id })).status, 404);
  assert.equal((await destino({ forma: 'cuenta_corriente', cuenta_id: banco.id })).status, 400); // la deuda es de Clientes, no mueve fondos
  assert.equal((await destino({ forma: 'tarjeta_debito' })).status, 400); // falta el destino
  assert.equal((await destino({ forma: 'tarjeta_debito', cuenta_id: 9999 })).status, 404);
  assert.equal((await destino({ forma: 'tarjeta_debito', cuenta_id: procesador.id, plazo_acreditacion_dias: 91 })).status, 400);
  assert.equal((await destino({ forma: 'tarjeta_debito', cuenta_id: procesador.id, comision_pct: 101 })).status, 400);
  const d = await destino({ forma: 'tarjeta_debito', cuenta_id: procesador.id, plazo_acreditacion_dias: 2, comision_pct: 1.5 });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.deepEqual([d.json.cuenta_nombre, d.json.plazo_acreditacion_dias, d.json.comision_pct], ['Posnet', 2, 1.5]);
  await destino({ forma: 'tarjeta_credito', cuenta_id: procesador.id, plazo_acreditacion_dias: 18, comision_pct: 3 });
  const r = (await api('GET', '/api/financiero/destinos', { token: adm.token })).json;
  assert.deepEqual(r.sin_destino.map((f) => f.codigo).sort(), ['otro', 'transferencia']); // sus cobros se rechazan hasta asignarles uno
});

test('Financiero.RF17/RN02: un cobro de Ventas entra a la caja de la terminal; el vuelto no es ingreso y un cobro mixto se reparte', async () => {
  const v = await venta({ importe: 100, pagos: [{ forma: 'efectivo', importe: 100, recibido: 150 }] });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  const ms = await movs(`venta=${v.id}`);
  assert.equal(ms.length, 1);
  assert.deepEqual([ms[0].tipo, ms[0].importe, ms[0].forma_pago, ms[0].cuenta], ['cobro', 100, 'efectivo', 'Caja Barra']);
  assert.equal(await saldo(barra.id), 100);
  const mixto = await venta({ importe: 300, pagos: [{ forma: 'efectivo', importe: 100 }, { forma: 'tarjeta_debito', importe: 200, referencia: 'CUP-1' }] });
  const mm = await movs(`venta=${mixto.id}`);
  assert.deepEqual(mm.map((m) => [m.cuenta, m.importe]).sort(), [['Caja Barra', 100], ['Posnet', 200]]);
  assert.equal(await saldo(barra.id), 200);
  assert.equal(await saldo(procesador.id), 200);
});

test('Financiero.RN29/EX20: el mismo mensaje dos veces no crea otro movimiento', async () => {
  const c = { terminal_id: term, pagos: [{ forma: 'efectivo', importe: 70 }] };
  const doc = await publicar('cobro_registrado', c);
  const antes = (await movs(`venta=${doc}`)).length;
  assert.equal(antes, 1);
  await publicar('cobro_registrado', c, { docId: doc }); // mismo documento y versión: la mensajería lo reconoce
  assert.equal((await movs(`venta=${doc}`)).length, 1);
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'cobro_registrado'", [doc]);
  assert.equal(n, 1);
});

test('Financiero.RN32/EX23: sin destino, destino inactivo o moneda distinta el mensaje se rechaza con su motivo y la venta queda igual; al corregir se reprocesa', async () => {
  const sin = await venta({ importe: 80, pagos: [{ forma: 'transferencia', importe: 80, referencia: 'TR-1' }] });
  assert.equal(sin.status, 200); // la venta no se frena (RN01)
  assert.equal((await movs(`venta=${sin.id}`)).length, 0);
  const est = await estadoMensaje(sin.id, 'cobro_registrado');
  assert.equal(est.estado, 'rechazado');
  assert.match(est.motivo_rechazo, /no tiene caja o cuenta de destino/);
  // Se corrige la causa y se reprocesa desde la bandeja de pendientes.
  await destino({ forma: 'transferencia', cuenta_id: banco.id });
  const pend = (await api('GET', '/api/integracion/pendientes', { token: adm.token })).json;
  const p = pend.find((x) => x.doc_id_global === sin.id);
  assert.ok(p, 'el rechazo figura en la bandeja de pendientes');
  assert.equal((await api('POST', `/api/integracion/pendientes/${p.id}/reintentar`, { token: adm.token })).status, 200);
  await esperarMensajes(pool);
  assert.equal((await movs(`venta=${sin.id}`)).length, 1);
  assert.equal(await saldo(banco.id), 80);

  // Moneda distinta: un cobro en dólares a un destino en pesos.
  const usd = await publicar('cobro_registrado', { terminal_id: term, pagos: [{ forma: 'transferencia', importe: 1000, moneda: 'USD', importe_divisa: 1, cotizacion: 1000 }] });
  assert.match((await estadoMensaje(usd, 'cobro_registrado')).motivo_rechazo, /es en USD y el destino/);
  // Terminal sin caja asignada para el efectivo.
  const huerfana = await publicar('cobro_registrado', { terminal_id: 99999, pagos: [{ forma: 'efectivo', importe: 5 }] });
  assert.match((await estadoMensaje(huerfana, 'cobro_registrado')).motivo_rechazo, /no tiene una caja de efectivo asignada/);
});

test('Financiero.RN30/EX21: la misma referencia externa en una misma venta es un cobro duplicado: se rechaza, alerta y no crea movimientos', async () => {
  const doc = await publicar('cobro_registrado', { terminal_id: term, pagos: [{ forma: 'tarjeta_debito', importe: 50, referencia: 'CUP-9' }, { forma: 'tarjeta_credito', importe: 50, referencia: 'CUP-9' }] });
  const est = await estadoMensaje(doc, 'cobro_registrado');
  assert.equal(est.estado, 'rechazado');
  assert.match(est.motivo_rechazo, /Cobro duplicado/);
  assert.equal((await movs(`venta=${doc}`)).length, 0); // la transacción completa se revierte
  const alertas = (await api('GET', '/api/notificaciones', { token: adm.token })).json;
  assert.ok(JSON.stringify(alertas).includes('Cobro duplicado'));
  // El mismo número de cupón en otra venta (de otra terminal de tarjetas, por ejemplo) no es duplicado: la regla es por venta.
  const a = await publicar('cobro_registrado', { terminal_id: term, pagos: [{ forma: 'tarjeta_debito', importe: 10, referencia: 'CUP-777' }] });
  const b = await publicar('cobro_registrado', { terminal_id: term, pagos: [{ forma: 'tarjeta_debito', importe: 10, referencia: 'CUP-777' }] });
  assert.equal((await movs(`venta=${a}`)).length + (await movs(`venta=${b}`)).length, 2);
});

test('Financiero.RN46: el cobro de una venta no fiscal se registra igual y lleva la marca', async () => {
  const v = await venta({ importe: 60, pagos: [{ forma: 'efectivo', importe: 60 }], extra: { modalidad: 'no_fiscal', tipo_no_fiscal: 'ticket' } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  const [m] = await movs(`venta=${v.id}`);
  assert.equal(m.importe, 60);
  assert.equal(m.marcas, 'venta_no_fiscal');
});

test('Financiero.RN02/RN31/EX13: una devolución es un contramovimiento vinculado al cobro; si el cobro no se confirmó, espera al original', async () => {
  const v = await venta({ importe: 100, pagos: [{ forma: 'efectivo', importe: 100 }] });
  const antes = await saldo(barra.id);
  const dev = await api('POST', '/api/devoluciones', { token: adm.token, headers: { 'X-ID-Solicitud': 'dev-fin-1' }, body: { venta_id_global: v.id, motivo: 'error en el pedido', todo: true } });
  assert.equal(dev.status, 201, JSON.stringify(dev.json));
  await esperarMensajes(pool);
  const ms = await movs(`venta=${v.id}`);
  const cobro = ms.find((m) => m.tipo === 'cobro'), contra = ms.find((m) => m.tipo === 'devolucion');
  assert.equal(contra.importe, -100);
  assert.equal(contra.vinculo_id, cobro.id); // RN02: nunca se borra, se corrige con un contramovimiento
  assert.equal(await saldo(barra.id), antes - 100);

  // Un cobro rechazado (sin destino) deja a su devolución «en espera del original» (EX22) hasta que el cobro quede confirmado.
  await pool.query("DELETE FROM fin_destino_forma_pago WHERE forma_codigo = 'transferencia'");
  const t = await venta({ importe: 40, pagos: [{ forma: 'transferencia', importe: 40, referencia: 'TR-2' }] });
  await api('POST', '/api/devoluciones', { token: adm.token, headers: { 'X-ID-Solicitud': 'dev-fin-2' }, body: { venta_id_global: t.id, motivo: 'se arrepintió', todo: true } });
  await esperarMensajes(pool);
  assert.equal((await estadoMensaje(t.id, 'cobro_revertido')).retenido_por_orden, 1);
  assert.equal((await movs(`venta=${t.id}`)).length, 0);
  await destino({ forma: 'transferencia', cuenta_id: banco.id });
  const p = (await api('GET', '/api/integracion/pendientes', { token: adm.token })).json.find((x) => x.doc_id_global === t.id && x.tipo === 'cobro_registrado');
  await api('POST', `/api/integracion/pendientes/${p.id}/reintentar`, { token: adm.token });
  await esperarMensajes(pool);
  const despues = await movs(`venta=${t.id}`);
  assert.deepEqual(despues.map((m) => m.importe).sort((a, b) => a - b), [-40, 40]); // se aplicó el cobro y recién después su devolución
});

test('Financiero.RN42/EX31: la devolución en efectivo se registra siempre; si deja la caja en negativo queda marcada, alerta y no se esconde', async () => {
  const v = await venta({ importe: 500, pagos: [{ forma: 'efectivo', importe: 500 }] });
  // El efectivo salió de la caja por otro lado (un retiro): el saldo no alcanza para la devolución.
  const s = await saldo(barra.id);
  await pool.query("INSERT INTO fin_movimientos (id_global, cuenta_id, tipo, importe, fecha_ms) VALUES ('RET-X', ?, 'retiro', ?, ?)", [barra.id, -(s - 100), Date.now()]);
  assert.equal(await saldo(barra.id), 100);
  await api('POST', '/api/devoluciones', { token: adm.token, headers: { 'X-ID-Solicitud': 'dev-fin-3' }, body: { venta_id_global: v.id, motivo: 'no hay stock', todo: true } });
  await esperarMensajes(pool);
  const contra = (await movs(`venta=${v.id}`)).find((m) => m.tipo === 'devolucion');
  assert.equal(contra.importe, -500); // no se rechaza: el efectivo ya salió
  assert.equal(await saldo(barra.id), -400);
  assert.match(contra.marcas, /^saldo_negativo_sin_autorizacion:-400/);
  const alertas = JSON.stringify((await api('GET', '/api/notificaciones', { token: adm.token })).json);
  assert.ok(alertas.includes('sin autorización previa'));
});

test('Financiero.EX25: desactivar el destino de una forma de pago pide confirmación y lista las formas afectadas', async () => {
  const r = await api('POST', `/api/financiero/cuentas/${procesador.id}/desactivar`, { token: adm.token });
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'REQUIERE_CONFIRMACION');
  assert.match(r.json.error, /tarjeta_debito, tarjeta_credito/);
  const ok = await api('POST', `/api/financiero/cuentas/${procesador.id}/desactivar`, { token: adm.token, body: { confirmar: true } });
  assert.equal(ok.json.activa, false);
  // Con el destino perdido, un cobro que llegue igual se rechaza (EX23).
  const doc = await publicar('cobro_registrado', { terminal_id: term, pagos: [{ forma: 'tarjeta_debito', importe: 30 }] });
  assert.match((await estadoMensaje(doc, 'cobro_registrado')).motivo_rechazo, /desactivado/);
});
