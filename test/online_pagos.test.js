const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const { simularArca } = require('./ayudas_online');
const Pasarela = require('../src/ventas_online/pasarelaMP');
const Reintegros = require('../src/ventas_online/reintegroService');
const Checkout = require('../src/ventas_online/checkoutService');
const Comp = require('../src/stock/compromisoService');

let api, pool, cerrar, adm, gerente, administrativo, cajero, A, B, k = 0, n = 0;
const T = '/tienda/cafe-pago';
const SECRETO = 'secreto-de-prueba';

// Una pasarela simulada: guarda los pagos, abre cobros y reintegra; la firma es la real.
const pagos = new Map();
const reintegros = [];
let fallaReintegro = false;
const fake = {
  nombre: 'mercadopago',
  crearCobro: async ({ referencia, importe, idSolicitud }) => ({ preferencia_id: `PREF-${idSolicitud}`, url: `https://pago.test/${referencia}?importe=${importe}` }),
  obtenerPago: async (id) => { const p = pagos.get(String(id)); if (!p) throw new Error('no existe'); return { ...p, id: String(id) }; },
  buscarPagos: async (ref) => [...pagos].filter(([, p]) => p.referencia === ref).map(([id, p]) => ({ ...p, id })),
  reintegrar: async (id, monto, sol) => { if (fallaReintegro) throw new Error('la pasarela no responde'); reintegros.push({ id, monto, sol }); return { id: `RF-${reintegros.length}`, estado: 'approved' }; },
  verificarFirma: Pasarela.mercadoPago.verificarFirma,
};

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  simularArca();
  Pasarela.usarProveedor(fake);
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  cajero = await usuario(api, pool, 'cami', 'cajero');
  await api('POST', '/api/modulos/ventas_online/instalar', { token: adm.token });
  await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { codigo: 'cafe-pago', nombre: 'Cafe', razon_social: 'Cafe SA', cuit: '30711111111', domicilio: 'Mitre 1', activa: true } });
  const p = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Cafe 250 g', precio: 1000, stock: 6 } })).json;
  await api('PUT', `/api/stock/configuracion/producto/${p.id}`, { token: adm.token, body: { permite_negativo: false } });
  A = p;
  B = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Medialuna', precio: 300, stock: 0 } })).json;
  for (const x of [A, B]) await api('PUT', `/api/ventas-online/catalogo/${x.id}`, { token: gerente.token, body: { categoria_online: 'Menu' } });
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
});
after(async () => { Pasarela.usarProveedor(null); await cerrar(); });

const nuevoPedido = async (items, medio = 'pasarela', extra = {}) => {
  require('../src/ventas_online/limites').pedidos.reiniciar();
  let c;
  for (const [i, it] of items.entries()) c = i === 0 ? (await api('POST', `${T}/carrito`, { body: it })).json : (await api('POST', `${T}/carrito/${c.token}/items`, { body: it })).json;
  const r = await api('POST', `${T}/checkout`, { headers: { 'X-ID-Solicitud': `sol-pago-${++k}-abcdef` }, body: { carrito: c.token, contacto: { nombre: 'Ana', email: 'ana@mail.test' }, facturacion: { tipo: 'consumidor_final' }, entrega: { tipo: 'retiro' }, medio_pago: medio, acepta_terminos: true, total_confirmado: c.total, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
};
const q = (p) => `?email=ana@mail.test&_=${p.id}`;
const ver = async (p) => (await api('GET', `${T}/pedidos/${p.id_global}${q(p)}`)).json;
const pagarId = (p) => `${T}/pedidos/${p.id_global}/pagar?email=ana@mail.test`;
// Una notificacion firmada como la manda Mercado Pago.
const notificar = (idPago, { firmar = true, secreto = SECRETO } = {}) => {
  const ts = String(Date.now()), reqId = `req-${++n}`;
  const v1 = crypto.createHmac('sha256', secreto).update(`id:${/^[a-z0-9]+$/i.test(idPago) ? String(idPago).toLowerCase() : idPago};request-id:${reqId};ts:${ts};`).digest('hex');
  return api('POST', `${T}/webhooks/mercadopago?data.id=${idPago}`, { headers: { 'x-request-id': reqId, ...(firmar && { 'x-signature': `ts=${ts},v1=${v1}` }) }, body: { type: 'payment', data: { id: idPago } } });
};
const pago = (p, id, estado = 'approved', extra = {}) => { pagos.set(id, { estado, monto: p.a_pagar, referencia: p.id_global, metodo: 'visa', detalle: null, ...extra }); };
const disp = async () => (await api('GET', `${T}/catalogo`)).json.find((x) => x.id === A.id).disponible;

test('Ventas Online.RF10: las credenciales de la pasarela se configuran con permiso y nunca se devuelven', async () => {
  assert.equal((await api('PUT', '/api/ventas-online/pasarela', { token: administrativo.token, body: { access_token: 'x' } })).status, 403);
  const r = await api('PUT', '/api/ventas-online/pasarela', { token: gerente.token, body: { access_token: 'APP_USR-prueba', webhook_secret: SECRETO } });
  assert.equal(r.status, 200); assert.deepEqual(r.json, { access_token: true, webhook_secret: true });
  assert.ok(!JSON.stringify((await api('GET', '/api/ventas-online/tienda', { token: gerente.token })).json).includes('APP_USR'));
});

test('Ventas Online.RF10: el cobro se abre despues de la reserva, solo para pedidos por pasarela, y repetir la clave devuelve el mismo', async () => {
  const p = await nuevoPedido([{ producto_id: A.id, cantidad: 2 }]);
  const c = await api('POST', pagarId(p), { headers: { 'X-ID-Solicitud': 'cobro-0001-abcdef' } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.match(c.json.url, /pago\.test/); assert.equal(c.json.repetido, false);
  assert.equal((await api('POST', pagarId(p), { headers: { 'X-ID-Solicitud': 'cobro-0001-abcdef' } })).json.repetido, true);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM onl_cobros WHERE pedido_id = ?', [p.id]))[0][0].n, 1);
  const otro = await nuevoPedido([{ producto_id: B.id, cantidad: 1 }], 'pago_al_retirar');
  assert.equal((await api('POST', `${T}/pedidos/${otro.id_global}/pagar?email=ana@mail.test`)).status, 409);
  assert.equal((await api('POST', `${T}/pedidos/${p.id_global}/pagar`)).status, 404); // sin el correo no se ve el pedido
});

test('Ventas Online.RN09: la notificacion sin firma valida se rechaza; la valida confirma el pedido, hace firme la reserva y se procesa una sola vez', async () => {
  const p = await nuevoPedido([{ producto_id: A.id, cantidad: 1 }]);
  pago(p, 'PAY-1');
  assert.equal((await notificar('PAY-1', { firmar: false })).status, 401);
  assert.equal((await notificar('PAY-1', { secreto: 'otro' })).status, 401);
  assert.equal((await ver(p)).estado, 'pendiente_pago');
  const ok = await notificar('PAY-1');
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.estado, ok.json.pedido_estado], ['aprobado', 'pagado']);
  const v = await ver(p);
  assert.equal(v.estado, 'pagado'); assert.equal(v.reserva.estado, 'firme'); assert.ok(v.pagado_ms);
  const [[r]] = await pool.query("SELECT vence_ms FROM reservas WHERE tipo = 'compromiso_stock' AND contenido LIKE ? LIMIT 1", [`%"compromiso":"${(await pool.query('SELECT reserva_id FROM onl_pedidos WHERE id = ?', [p.id]))[0][0].reserva_id}"%`]);
  assert.ok(Number(r.vence_ms) > Date.now() + 30 * 86400000); // la reserva ya no vence
  const otra = await notificar('PAY-1');
  assert.equal(otra.json.ya_procesado, true); assert.equal(otra.json.estado, 'aprobado');
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM onl_pagos WHERE id_externo = ?', ['PAY-1']))[0][0].n, 1);
  const det = (await api('GET', `/api/ventas-online/pedidos/${p.id}/pagos`, { token: gerente.token })).json;
  assert.deepEqual([det.pagos[0].estado, det.pagos[0].importe], ['aprobado', p.a_pagar]);
  assert.equal((await api('GET', `/api/ventas-online/pedidos/${p.id}/pagos`, { token: cajero.token })).status, 403);
});

test('Ventas Online.EX01: un pago rechazado deja el pedido pendiente de pago con la misma reserva y se puede reintentar', async () => {
  const p = await nuevoPedido([{ producto_id: A.id, cantidad: 1 }]);
  const reserva = (await ver(p)).reserva.vence_ms;
  pago(p, 'PAY-2', 'rejected');
  const r = await notificar('PAY-2');
  assert.deepEqual([r.json.estado, r.json.pedido_estado], ['rechazado', 'pendiente_pago']);
  assert.equal((await ver(p)).reserva.vence_ms, reserva);
  pago(p, 'PAY-3', 'approved');
  assert.equal((await notificar('PAY-3')).json.pedido_estado, 'pagado');
});

test('Ventas Online.EX03: dos pagos aprobados distintos para un pedido: cobra el primero y el segundo se marca duplicado y se reintegra', async () => {
  const p = await nuevoPedido([{ producto_id: B.id, cantidad: 2 }]);
  pago(p, 'PAY-4'); pago(p, 'PAY-5');
  assert.equal((await notificar('PAY-4')).json.estado, 'aprobado');
  const dup = await notificar('PAY-5');
  assert.equal(dup.json.estado, 'duplicado');
  assert.deepEqual(reintegros.at(-1), { id: 'PAY-5', monto: p.a_pagar, sol: 'dup:mercadopago:PAY-5' });
  const det = (await api('GET', `/api/ventas-online/pedidos/${p.id}/pagos`, { token: gerente.token })).json;
  assert.deepEqual(det.pagos.map((x) => x.estado), ['aprobado', 'duplicado']);
  assert.equal(det.reintegros[0].estado, 'ejecutado'); assert.equal(det.reintegros[0].motivo, 'duplicado');
  assert.equal((await notificar('PAY-5')).json.ya_procesado, true); // la repetida no reintegra dos veces
  assert.equal(reintegros.filter((x) => x.id === 'PAY-5').length, 1);
});

test('Ventas Online.EX29: pago aprobado con la reserva vencida: se reserva de nuevo si hay disponible; si no, queda con faltante', async () => {
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
  const vencer = async (p) => {
    const [[x]] = await pool.query('SELECT reserva_id FROM onl_pedidos WHERE id = ?', [p.id]);
    await pool.query("UPDATE reservas SET vence_ms = ? WHERE tipo = 'compromiso_stock' AND contenido LIKE ?", [Date.now() - 1000, `%"compromiso":"${x.reserva_id}"%`]);
    await pool.query('UPDATE onl_pedidos SET reserva_vence_ms = ? WHERE id = ?', [Date.now() - 1000, p.id]);
  };
  const p = await nuevoPedido([{ producto_id: A.id, cantidad: 1 }]);
  await vencer(p);
  pago(p, 'PAY-6');
  const r = await notificar('PAY-6');
  assert.equal(r.json.pedido_estado, 'pagado');
  assert.equal((await ver(p)).reserva.intento, 2); // un intento nuevo con clave nueva
  // Sin disponible: el pago entra pero no hay stock.
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
  const sobra = await disp();
  const p2 = await nuevoPedido([{ producto_id: A.id, cantidad: sobra }]);
  await vencer(p2);
  const tomado = await Comp.comprometer({ idSolicitud: 'otro-canal-1', lineas: [{ linea: 0, producto_id: A.id, cantidad: sobra }] });
  assert.equal(tomado.ok, true);
  pago(p2, 'PAY-7');
  assert.equal((await notificar('PAY-7')).json.pedido_estado, 'con_faltante');
  assert.equal((await ver(p2)).estado, 'con_faltante');
  await Comp.liberar(tomado.id_compromiso);
});

test('Ventas Online: un pago de un pedido cancelado o de importe distinto no confirma nada: alerta y reintegro (no se descarta)', async () => {
  const p = await nuevoPedido([{ producto_id: B.id, cantidad: 1 }]);
  await api('POST', `${T}/pedidos/${p.id_global}/abandonar?email=ana@mail.test`);
  pago(p, 'PAY-8');
  assert.equal((await notificar('PAY-8')).json.estado, 'sin_pedido');
  assert.equal((await ver(p)).estado, 'cancelado');
  assert.equal(reintegros.at(-1).id, 'PAY-8');
  assert.ok((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE modulo = 'ventas_online' AND tipo = 'reintegro'"))[0][0].n >= 1);
  const huerfano = { a_pagar: 50, id_global: 'NO-EXISTE' };
  pago(huerfano, 'PAY-9');
  assert.equal((await notificar('PAY-9')).json.estado, 'sin_pedido');
  const q2 = await nuevoPedido([{ producto_id: B.id, cantidad: 1 }]);
  pago(q2, 'PAY-10', 'approved', { monto: 10 });
  assert.equal((await notificar('PAY-10')).json.estado, 'importe_distinto');
  assert.equal((await ver(q2)).estado, 'pendiente_pago');
});

test('Ventas Online.EX11: un reintegro que la pasarela no ejecuta queda pendiente, se reintenta con la misma clave y vencido el plazo se resuelve a mano', async () => {
  const p = await nuevoPedido([{ producto_id: B.id, cantidad: 1 }]);
  pago(p, 'PAY-11'); pago(p, 'PAY-12');
  await notificar('PAY-11');
  fallaReintegro = true;
  await notificar('PAY-12');
  fallaReintegro = false;
  const lista = (await api('GET', '/api/ventas-online/reintegros?estado=pendiente', { token: gerente.token })).json;
  assert.equal(lista.length, 1); assert.equal(lista[0].intentos, 1); assert.match(lista[0].error, /no responde/);
  assert.equal((await api('POST', '/api/ventas-online/reintegros/reintentar', { token: gerente.token })).json.ejecutados, 1);
  assert.equal((await api('GET', '/api/ventas-online/reintegros?estado=pendiente', { token: gerente.token })).json.length, 0);
  // La misma solicitud no crea otro reintegro.
  const [[pg]] = await pool.query("SELECT id FROM onl_pagos WHERE id_externo = 'PAY-12'");
  const igual = await Reintegros.solicitar({ pedidoId: p.id, pagoId: pg.id, importe: p.a_pagar, motivo: 'duplicado', solicitud: 'dup:mercadopago:PAY-12' });
  assert.equal(igual.estado, 'ejecutado');
  await assert.rejects(Reintegros.solicitar({ pedidoId: p.id, pagoId: pg.id, importe: 1, motivo: 'x', solicitud: 'otra-clave-1' }), /por reintegrar/); // no se devuelve mas de lo cobrado
  // Resolucion manual por otro medio (con permiso).
  const p2 = await nuevoPedido([{ producto_id: B.id, cantidad: 1 }]);
  pago(p2, 'PAY-13'); pago(p2, 'PAY-14');
  await notificar('PAY-13');
  fallaReintegro = true; await notificar('PAY-14'); fallaReintegro = false;
  const pend = (await api('GET', '/api/ventas-online/reintegros?estado=pendiente', { token: gerente.token })).json[0];
  assert.equal((await api('POST', `/api/ventas-online/reintegros/${pend.id}/manual`, { token: administrativo.token, body: { medio: 'transferencia' } })).status, 403);
  assert.equal((await api('POST', `/api/ventas-online/reintegros/${pend.id}/manual`, { token: gerente.token, body: {} })).status, 400);
  const m = await api('POST', `/api/ventas-online/reintegros/${pend.id}/manual`, { token: gerente.token, body: { medio: 'transferencia bancaria' } });
  assert.deepEqual([m.json.estado, m.json.medio_manual], ['manual', 'transferencia bancaria']);
});

test('Ventas Online.EX02: si no llega la notificacion se consulta la pasarela por la referencia del pedido', async () => {
  const p = await nuevoPedido([{ producto_id: B.id, cantidad: 1 }]);
  await api('POST', pagarId(p));
  pago(p, 'PAY-15');
  const r = await api('POST', '/api/ventas-online/pagos/consultar-pendientes', { token: gerente.token });
  assert.ok(r.json.aprobados >= 1, JSON.stringify(r.json));
  assert.equal((await ver(p)).estado, 'pagado');
});

test('Ventas Online.RN06: la transferencia se confirma a mano y el pago al retirar al aceptar el pedido, con la reserva confirmada', async () => {
  const t = await nuevoPedido([{ producto_id: B.id, cantidad: 1 }], 'transferencia');
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${t.id}/confirmar-transferencia`, { token: gerente.token, body: {} })).status, 400);
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${t.id}/aceptar`, { token: gerente.token })).status, 409); // la transferencia no se acepta sin comprobar
  const ok = await api('POST', `/api/ventas-online/pedidos/${t.id}/confirmar-transferencia`, { token: gerente.token, body: { referencia: 'CBU 123 operacion 99' } });
  assert.equal(ok.json.estado, 'pagado');
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${t.id}/confirmar-transferencia`, { token: gerente.token, body: { referencia: 'otra vez' } })).status, 409);
  const r = await nuevoPedido([{ producto_id: B.id, cantidad: 1 }], 'pago_al_retirar');
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${r.id}/aceptar`, { token: cajero.token })).status, 403);
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${r.id}/aceptar`, { token: gerente.token })).json.estado, 'pagado');
  const e = await nuevoPedido([{ producto_id: B.id, cantidad: 1 }], 'pago_al_retirar');
  await pool.query("UPDATE onl_pedidos SET reserva_estado = 'pendiente' WHERE id = ?", [e.id]);
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${e.id}/aceptar`, { token: gerente.token })).json.codigo, 'RESERVA_PENDIENTE');
});

test('Ventas Online.RF10: con ONL-PASARELA apagada solo se ofrecen los medios que no pasan por la pasarela', async () => {
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { desactivar: ['ONL-PASARELA'], motivo: 'prueba' } });
  require('../src/ventas_online/limites').pedidos.reiniciar();
  const c = (await api('POST', `${T}/carrito`, { body: { producto_id: B.id, cantidad: 1 } })).json;
  const r = await api('POST', `${T}/checkout`, { headers: { 'X-ID-Solicitud': 'sol-sin-pasarela-0001' }, body: { carrito: c.token, contacto: { nombre: 'Ana', email: 'ana@mail.test' }, medio_pago: 'pasarela', acepta_terminos: true, total_confirmado: c.total } });
  assert.equal(r.json.codigo, 'FUNCION_INACTIVA');
  const sin = await Checkout.vista((await pool.query('SELECT id FROM onl_pedidos ORDER BY id DESC LIMIT 1'))[0][0].id);
  assert.ok(sin);
});
