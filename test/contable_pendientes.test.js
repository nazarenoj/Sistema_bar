const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { preparar } = require('./ayudas_contable');

let api, pool, cerrar, c, k = 0;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  c = await preparar(api, pool);
});
after(async () => { await cerrar(); });

const g = () => ({ token: c.gerente.token });
const sol = () => ({ 'X-ID-Solicitud': `con-${++k}-${Math.random().toString(36).slice(2, 10)}` });
const reglaIva = async () => (await pool.query("SELECT id FROM con_reglas WHERE formulario = 'venta' AND componente = 'iva'"))[0][0].id;
const manual = (body, headers = sol(), tok = c.gerente) => api('POST', '/api/contable/asientos-manuales', { token: tok.token, headers, body });
const par = (monto) => [{ cuenta_id: c.clave('caja').id, debe: monto }, { cuenta_id: c.clave('capital').id, haber: monto }];

test('Contable.RF15/RN30/EX02: un evento sin regla va a Pendientes de imputar con responsable y plazo, sin frenar a la venta, y se resuelve creando la regla', async () => {
  await pool.query('UPDATE con_reglas SET activa = 0 WHERE id = ?', [await reglaIva()]);
  const id = await c.vender('efectivo');
  assert.equal((await api('GET', `/api/ventas/${id}`, { token: c.adm.token })).status, 200); // RN27: la venta sigue ahí
  assert.equal(await c.asientoDe(id), null);
  const pend = (await api('GET', '/api/contable/pendientes', g())).json;
  assert.equal(pend.length, 1);
  assert.equal(pend[0].motivo, 'sin_regla');
  assert.equal(pend[0].id_documento, id);
  assert.match(pend[0].detalle, /venta \/ iva/);
  assert.ok(pend[0].plazo && pend[0].vencido === false);
  const [[n]] = await pool.query("SELECT COUNT(*) n FROM notificaciones WHERE modulo = 'contable' AND tipo = 'pendiente_imputar'");
  assert.equal(Number(n.n), 1); // alerta al responsable
  // Se crea (reactiva) la regla y se reintenta: se genera el asiento y el pendiente sale de ambos listados.
  await pool.query('UPDATE con_reglas SET activa = 1 WHERE id = ?', [await reglaIva()]);
  assert.equal((await api('POST', `/api/contable/pendientes/${pend[0].id}/reintentar`, { ...g(), body: {} })).status, 200);
  await esperarMensajes(pool);
  const a = await c.asientoDe(id);
  assert.ok(a);
  assert.equal(c.linea(a, 'iva_debito', 'haber'), 43.39);
  assert.equal((await api('GET', '/api/contable/pendientes', g())).json.length, 0);
  const [[m]] = await pool.query("SELECT estado FROM mensajes_integracion WHERE doc_id_global = ? AND modulo_destino = 'contable'", [id]);
  assert.equal(m.estado, 'confirmado');
  assert.equal((await api('POST', `/api/contable/pendientes/${pend[0].id}/reintentar`, { ...g(), body: {} })).status, 409);
});

test('Contable.RF15: un pendiente se puede imputar a mano; el asiento queda vinculado al documento y el mensaje Confirmado', async () => {
  const regla = await reglaIva();
  await pool.query('UPDATE con_reglas SET activa = 0 WHERE id = ?', [regla]);
  const id = await c.vender('efectivo');
  const [p] = (await api('GET', '/api/contable/pendientes', g())).json;
  const lineas = [{ cuenta_id: c.clave('caja').id, debe: 250 }, { cuenta_id: c.clave('ventas_salon').id, haber: 206.61 }, { cuenta_id: c.clave('iva_debito').id, haber: 43.39 }];
  const mal = await api('POST', `/api/contable/pendientes/${p.id}/imputar`, { ...g(), headers: sol(), body: { lineas: lineas.slice(0, 2) } });
  assert.equal(mal.status, 400);
  assert.equal(mal.json.codigo, 'ASIENTO_DESBALANCEADO'); // EX01
  const ok = await api('POST', `/api/contable/pendientes/${p.id}/imputar`, { ...g(), headers: sol(), body: { lineas } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const a = await c.asientoDe(id);
  assert.equal(a.tipo, 'imputacion');
  assert.equal(a.id, ok.json.asiento_id);
  assert.equal((await api('GET', '/api/contable/pendientes', g())).json.length, 0);
  assert.equal((await api('GET', '/api/contable/pendientes?estado=resuelto', g())).json.find((x) => x.id === p.id).resolucion, 'a_mano');
  const [[m]] = await pool.query("SELECT estado FROM mensajes_integracion WHERE doc_id_global = ? AND modulo_destino = 'contable'", [id]);
  assert.equal(m.estado, 'confirmado');
  await pool.query('UPDATE con_reglas SET activa = 1 WHERE id = ?', [regla]);
});

test('Contable.RN29/EX19: una devolución que llega antes que su venta espera como pendiente «Espera al original»', async () => {
  const id = await c.vender('efectivo');
  const r = await api('POST', '/api/devoluciones', { token: c.adm.token, headers: sol(), body: { venta_id_global: id, motivo: 'el cliente se arrepintió', items: [{ linea: 0, cantidad: 1 }] } });
  assert.equal(r.status, 201);
  // Se simula que la venta todavía no se contabilizó cuando llega la devolución.
  await pool.query("UPDATE mensajes_integracion SET estado = 'pendiente' WHERE doc_id_global = ? AND modulo_destino = 'contable'", [id]);
  const M = require('../src/mensajeria/servicio');
  await M.procesarPendientes();
  const esperando = (await api('GET', '/api/contable/pendientes?motivo=espera_original', g())).json;
  assert.equal(esperando.length, 1);
  assert.equal(esperando[0].tipo_evento, 'venta_devuelta');
  assert.equal(await c.asientoDe(r.json.devolucion.id_global), null); // no genera asiento mientras espera
  // Al confirmarse la venta, la devolución se aplica y el pendiente se resuelve.
  await pool.query("UPDATE mensajes_integracion SET estado = 'confirmado' WHERE doc_id_global = ? AND modulo_destino = 'contable'", [id]);
  await pool.query("UPDATE mensajes_integracion SET proximo_intento_ms = 0, estado = 'pendiente', intentos = 0 WHERE doc_id_global = ? AND tipo = 'venta_devuelta'", [r.json.devolucion.id_global]);
  await esperarMensajes(pool);
  assert.ok(await c.asientoDe(r.json.devolucion.id_global));
  assert.equal((await api('GET', '/api/contable/pendientes?motivo=espera_original', g())).json.length, 0);
});

test('Contable.RF05/RN07/RN13: un asiento manual balancea, se numera sin saltos y exige permiso', async () => {
  assert.equal((await manual({ fecha: c.hoy, leyenda: 'Aporte', lineas: par(1000) }, sol(), c.cajero)).status, 403);
  const a = await manual({ fecha: c.hoy, leyenda: 'Aporte de capital', lineas: par(1000) });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  assert.equal(a.json.tipo, 'manual');
  const b = await manual({ fecha: c.hoy, leyenda: 'Otro aporte', lineas: par(500) });
  assert.equal(b.json.numero, a.json.numero + 1);
  // EX01: desbalanceado; cuenta no imputable; sin leyenda.
  const mal = await manual({ fecha: c.hoy, leyenda: 'Mal', lineas: [{ cuenta_id: c.clave('caja').id, debe: 100 }, { cuenta_id: c.clave('capital').id, haber: 90 }] });
  assert.equal(mal.status, 400);
  assert.equal(mal.json.codigo, 'ASIENTO_DESBALANCEADO');
  assert.equal(mal.json.diferencia, 10);
  const padre = c.cuentas.find((x) => !x.imputable);
  assert.equal((await manual({ fecha: c.hoy, leyenda: 'Rubro', lineas: [{ cuenta_id: padre.id, debe: 5 }, { cuenta_id: c.clave('capital').id, haber: 5 }] })).json.codigo, 'CUENTA_NO_IMPUTABLE');
  assert.equal((await manual({ fecha: c.hoy, leyenda: '', lineas: par(5) })).status, 400);
  const ayer = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  assert.equal((await manual({ fecha: ayer, leyenda: 'Antes', lineas: par(5) })).json.codigo, 'ANTERIOR_AL_INICIO');
});

test('Contable.RN33: el asiento manual lleva ID_Solicitud: el reintento devuelve el original sin consumir número y otra carga con la misma clave es un conflicto', async () => {
  const h = sol();
  const a = await manual({ fecha: c.hoy, leyenda: 'Con clave', lineas: par(70) }, h);
  const [[antes]] = await pool.query('SELECT COUNT(*) n FROM con_asientos');
  const otra = await manual({ fecha: c.hoy, leyenda: 'Con clave', lineas: par(70) }, h);
  assert.equal(otra.json.id, a.json.id);
  assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM con_asientos'))[0][0].n), Number(antes.n));
  assert.equal((await manual({ fecha: c.hoy, leyenda: 'Con clave', lineas: par(71) }, h)).json.codigo, 'CONFLICTO_IDEMPOTENCIA');
  assert.equal((await manual({ fecha: c.hoy, leyenda: 'Sin clave', lineas: par(5) }, {})).json.codigo, 'FALTA_ID_SOLICITUD');
});

test('Contable.RN07: un asiento se anula con un contraasiento que conserva el original; no se anula dos veces', async () => {
  const a = (await manual({ fecha: c.hoy, leyenda: 'Para anular', lineas: par(300) })).json;
  assert.equal((await api('POST', `/api/contable/asientos/${a.id}/anular`, { ...g(), headers: sol(), body: { motivo: '' } })).status, 400);
  const r = await api('POST', `/api/contable/asientos/${a.id}/anular`, { ...g(), headers: sol(), body: { motivo: 'Cargado por error' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const orig = (await api('GET', `/api/contable/asientos/${a.id}`, g())).json;
  assert.equal(orig.estado, 'anulado');
  assert.equal(orig.numero, a.numero); // conserva su número
  const contra = (await api('GET', `/api/contable/asientos/${r.json.contraasiento}`, g())).json;
  assert.equal(contra.tipo, 'anulacion');
  assert.equal(contra.anula_id, a.id);
  assert.equal(contra.lineas.find((l) => l.cuenta_id === c.clave('caja').id).haber, 300);
  assert.equal((await api('POST', `/api/contable/asientos/${a.id}/anular`, { ...g(), headers: sol(), body: { motivo: 'Otra vez' } })).status, 409);
  assert.equal((await api('POST', `/api/contable/asientos/${contra.id}/anular`, { ...g(), headers: sol(), body: { motivo: 'No se puede' } })).status, 409);
});

test('Contable.RF05: los modelos de asiento se reutilizan y los recurrentes se generan una sola vez por fecha', async () => {
  const dia = Number(c.hoy.slice(8, 10));
  const modelo = await api('POST', '/api/contable/modelos', { ...g(), body: { nombre: 'Alquiler', leyenda: 'Alquiler del local', lineas: [{ cuenta_id: c.clave('compras').id, debe: 800 }, { cuenta_id: c.clave('caja').id, haber: 800 }], recurrente: dia <= 28, dia_mes: Math.min(dia, 28), desde: c.hoy } });
  assert.equal(modelo.status, 201, JSON.stringify(modelo.json));
  assert.equal((await api('POST', '/api/contable/modelos', { ...g(), body: { nombre: 'Malo', leyenda: 'x', lineas: [{ cuenta_id: c.clave('compras').id, debe: 5 }] } })).status, 400);
  const uno = await api('POST', `/api/contable/modelos/${modelo.json.id}/generar`, { ...g(), headers: sol(), body: { fecha: c.hoy } });
  assert.equal(uno.status, 201);
  assert.equal(uno.json.tipo, 'modelo');
  if (dia > 28) return; // el día del mes de un recurrente va hasta el 28
  const r1 = await api('POST', '/api/contable/modelos/recurrentes/generar', { ...g(), body: {} });
  assert.equal(r1.json.generados.length, 1);
  assert.equal(r1.json.generados[0].fecha, c.hoy);
  assert.equal((await api('POST', '/api/contable/modelos/recurrentes/generar', { ...g(), body: {} })).json.generados.length, 0); // no se genera dos veces
});

test('Contable.EX03: un asiento manual con fecha de un período cerrado se rechaza', async () => {
  const per = (await api('GET', '/api/contable/periodos', g())).json.find((p) => p.anio === Number(c.hoy.slice(0, 4)) && p.mes === Number(c.hoy.slice(5, 7)));
  assert.equal((await api('POST', `/api/contable/periodos/${per.id}/cerrar`, g())).status, 200);
  const r = await manual({ fecha: c.hoy, leyenda: 'En período cerrado', lineas: par(10) });
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'PERIODO_CERRADO');
  await api('POST', `/api/contable/periodos/${per.id}/reabrir`, { token: (await require('./ayudas_financiero').usuario(api, pool, 'cont', 'contador')).token, body: { motivo: 'Seguir con las pruebas' } });
});
