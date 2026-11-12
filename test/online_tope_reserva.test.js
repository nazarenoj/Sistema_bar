const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const { simularArca } = require('./ayudas_online');
const Comp = require('../src/stock/compromisoService');
const Checkout = require('../src/ventas_online/checkoutService');

// Ventas Online RN56: un pedido sin pago aprobado reserva por artículo hasta un porcentaje del disponible (30 %); por encima queda pendiente de autorización de un supervisor, sin reservar.
let api, pool, cerrar, adm, gerente, cajero, S, k = 0;
const T = '/tienda/cafe-tope';

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  simularArca();
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  cajero = await usuario(api, pool, 'cami', 'cajero');
  await api('POST', '/api/modulos/ventas_online/instalar', { token: adm.token });
  await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { codigo: 'cafe-tope', nombre: 'Cafe', razon_social: 'Cafe SA', cuit: '30711111111', domicilio: 'Mitre 1', activa: true } });
  S = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Budin', precio: 800, stock: 10 } })).json;
  await api('PUT', `/api/stock/configuracion/producto/${S.id}`, { token: adm.token, body: { permite_negativo: false } });
  await api('PUT', `/api/ventas-online/catalogo/${S.id}`, { token: gerente.token, body: { categoria_online: 'Menu' } });
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
});
after(async () => { await cerrar(); });

const pedir = async (cantidad, medio) => {
  require('../src/ventas_online/limites').pedidos.reiniciar();
  const c = (await api('POST', `${T}/carrito`, { body: { producto_id: S.id, cantidad } })).json;
  return api('POST', `${T}/checkout`, { headers: { 'X-ID-Solicitud': `sol-tope-${++k}-abcdef` }, body: { carrito: c.token, contacto: { nombre: 'Ana', email: `ana${k}@mail.test` }, facturacion: { tipo: 'consumidor_final' }, entrega: { tipo: 'retiro' },
    medio_pago: medio, acepta_terminos: true, total_confirmado: c.total } });
};
const reservado = async () => [...(await Comp.comprometidos()).values()].reduce((a, b) => a + b, 0);
const estado = async (id) => (await pool.query('SELECT estado, reserva_estado FROM onl_pedidos WHERE id = ?', [id]))[0][0];

test('Ventas Online.RN56: hasta el 30 % del disponible se reserva sin pago; lo que pasa queda pendiente de autorización y no reserva', async () => {
  const a = await pedir(3, 'transferencia'); // 30 % de 10
  assert.equal(a.status, 201, JSON.stringify(a.json));
  assert.deepEqual(Object.values(await estado(a.json.id)), ['pendiente_pago', 'confirmada']);
  assert.equal(await reservado(), 3);
  const b = await pedir(1, 'pago_al_retirar'); // sumado a lo ya reservado sin pago pasa el tope
  assert.equal(b.status, 201, JSON.stringify(b.json));
  assert.deepEqual(Object.values(await estado(b.json.id)), ['pendiente_autorizacion', 'sin_reserva']);
  assert.match(b.json.aviso, /autorización/);
  assert.equal(await reservado(), 3); // no reservó
  // Un pedido con pago online no está sujeto al tope.
  const c = await pedir(5, 'pasarela');
  assert.equal(c.status, 201, JSON.stringify(c.json));
  assert.deepEqual(Object.values(await estado(c.json.id)), ['pendiente_pago', 'confirmada']);
  assert.equal(await reservado(), 8);
  globalThis.__pend = b.json.id;
});

test('Ventas Online.RN56: un supervisor autoriza con motivo y el pedido reserva; sin disponible no se puede', async () => {
  const id = globalThis.__pend;
  const uri = `/api/ventas-online/pedidos/${id}/autorizar-reserva`;
  assert.equal((await api('POST', uri, { token: cajero.token, body: { motivo: 'cliente habitual' } })).status, 403);
  assert.equal((await api('POST', uri, { token: gerente.token, body: {} })).status, 400); // pide motivo
  const ok = await api('POST', uri, { token: gerente.token, body: { motivo: 'cliente habitual' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(Object.values(await estado(id)), ['pendiente_pago', 'confirmada']);
  assert.equal(await reservado(), 9);
  assert.equal((await api('POST', uri, { token: gerente.token, body: { motivo: 'otra vez' } })).json.codigo, 'NO_PENDIENTE_AUTORIZACION');
  const h = (await pool.query('SELECT detalle FROM onl_pedido_historial WHERE pedido_id = ? ORDER BY id', [id]))[0].map((x) => x.detalle);
  assert.ok(h.some((d) => /autorizada por el comercio: cliente habitual/.test(d ?? '')));
});

test('Ventas Online.RN56: un pedido pendiente de autorización que nadie autoriza se cancela como cualquier impago y no deja reserva', async () => {
  const p = await pedir(1, 'pago_al_retirar'); // el disponible quedó en 1 y ya se pasó del tope
  assert.equal(p.status, 201, JSON.stringify(p.json));
  assert.equal((await estado(p.json.id)).estado, 'pendiente_autorizacion');
  await pool.query('UPDATE onl_pedidos SET created_ms = created_ms - 100 * 3600000 WHERE id = ?', [p.json.id]);
  assert.ok(await Checkout.cancelarImpagos() >= 1);
  assert.equal((await estado(p.json.id)).estado, 'cancelado');
  assert.equal(await reservado(), 9); // nada que liberar
});

test('Ventas Online.RN07: un elaborado que se produce al venderse no se reserva (un artículo común con el mismo stock sí)', async () => {
  const antes = await reservado();
  const E = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Torta del día', precio: 900, stock: 5, tipo: 'elaborado' } })).json;
  await api('PUT', `/api/stock/configuracion/producto/${E.id}`, { token: adm.token, body: { permite_negativo: false } });
  await api('PUT', `/api/ventas-online/catalogo/${E.id}`, { token: gerente.token, body: { categoria_online: 'Menu' } });
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
  require('../src/ventas_online/limites').pedidos.reiniciar();
  const c = (await api('POST', `${T}/carrito`, { body: { producto_id: E.id, cantidad: 2 } })).json;
  const r = await api('POST', `${T}/checkout`, { headers: { 'X-ID-Solicitud': `sol-elab-${++k}-abcdef` }, body: { carrito: c.token, contacto: { nombre: 'Ana', email: 'ana@mail.test' }, facturacion: { tipo: 'consumidor_final' }, entrega: { tipo: 'retiro' },
    medio_pago: 'pasarela', acepta_terminos: true, total_confirmado: c.total } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(await reservado(), antes); // el elaborado no comprometió stock
  assert.equal((await estado(r.json.id)).reserva_estado, 'no_aplica');
});
