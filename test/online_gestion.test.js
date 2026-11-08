const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const { simularArca } = require('./ayudas_online');
const Pasarela = require('../src/ventas_online/pasarelaMP');
const PedidoOnline = require('../src/services/pedidoOnlineService');
const Reserva = require('../src/ventas_online/reservaPedidoService');
const Gestion = require('../src/ventas_online/gestionService');
const Cocina = require('../src/services/cocinaService');
const Comp = require('../src/stock/compromisoService');

let api, pool, cerrar, adm, gerente, administrativo, cajero, A, B, k = 0;
const pagos = new Map();
const T = '/tienda/cafe-ges';

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  simularArca();
  Pasarela.usarProveedor({ nombre: 'mercadopago', crearCobro: async () => ({ preferencia_id: 'P', url: 'https://x' }), obtenerPago: async (id) => ({ ...pagos.get(String(id)), id: String(id) }), buscarPagos: async () => [], reintegrar: async () => ({ id: 'R', estado: 'approved' }), verificarFirma: async () => true });
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  cajero = await usuario(api, pool, 'cami', 'cajero');
  await api('POST', '/api/modulos/ventas_online/instalar', { token: adm.token });
  await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { codigo: 'cafe-ges', nombre: 'Cafe', razon_social: 'Cafe SA', cuit: '30711111111', domicilio: 'Mitre 1', activa: true } });
  const p = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Cafe 250 g', precio: 1000, stock: 5 } })).json;
  await api('PUT', `/api/stock/configuracion/producto/${p.id}`, { token: adm.token, body: { permite_negativo: false } });
  A = p;
  B = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Medialuna', precio: 300, stock: 0 } })).json;
  for (const x of [A, B]) await api('PUT', `/api/ventas-online/catalogo/${x.id}`, { token: gerente.token, body: { categoria_online: 'Menu' } });
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
});
after(async () => { Pasarela.usarProveedor(null); await cerrar(); });

const nuevo = async (items, { medio = 'pago_al_retirar', entrega = { tipo: 'retiro' }, aceptar = true, extra = {} } = {}) => {
  require('../src/ventas_online/limites').pedidos.reiniciar();
  let c;
  for (const [i, it] of items.entries()) c = i === 0 ? (await api('POST', `${T}/carrito`, { body: it })).json : (await api('POST', `${T}/carrito/${c.token}/items`, { body: it })).json;
  const r = await api('POST', `${T}/checkout`, { headers: { 'X-ID-Solicitud': `sol-ges-${++k}-abcdef` }, body: { carrito: c.token, contacto: { nombre: 'Ana', email: `ana${k}@mail.test` }, entrega, medio_pago: medio, acepta_terminos: true, total_confirmado: c.total, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  if (aceptar) assert.equal((await api('POST', `/api/ventas-online/pedidos/${r.json.id}/aceptar`, { token: gerente.token })).status, 200);
  return r.json;
};
const det = async (p) => (await api('GET', `/api/ventas-online/pedidos/${p.id}`, { token: gerente.token })).json;
const estado = (p, e, t = gerente) => api('POST', `/api/ventas-online/pedidos/${p.id}/estado`, { token: t.token, body: { estado: e } });
const avisos = async (p) => (await pool.query('SELECT evento FROM onl_notificaciones WHERE pedido_id = ? ORDER BY id', [p.id]))[0].map((x) => x.evento);
const correos = async (p) => (await pool.query('SELECT asunto, cuerpo FROM correo_cola WHERE para = ? ORDER BY id', [`ana${p.email.match(/ana(\d+)/)[1]}@mail.test`]))[0];

test('Ventas Online.RF25/RN44: el pedido pagado pasa a Ventas: venta con cobro online, comanda en cocina y descuento de stock que consume la reserva', async () => {
  const p = await nuevo([{ producto_id: A.id, cantidad: 2 }, { producto_id: B.id, cantidad: 1 }]);
  const d = await det(p);
  assert.equal(d.estado, 'pagado');
  assert.equal(d.entrega_ventas.estado, 'entregado'); assert.ok(d.entrega_ventas.venta_id_global);
  const [[v]] = await pool.query('SELECT id, total, modalidad, detalle FROM ventas WHERE id_global = ?', [d.entrega_ventas.venta_id_global]);
  assert.equal(Number(v.total), 2300); assert.equal(v.modalidad, 'retiro');
  assert.equal(JSON.parse(v.detalle).length, 2);
  const pagos = (await pool.query('SELECT metodo_pago, importe FROM pago_venta WHERE venta_id = ?', [v.id]))[0];
  assert.deepEqual(pagos.map((x) => [x.metodo_pago, Number(x.importe)]), [['efectivo', 2300]]);
  const [ped] = await pool.query("SELECT origen, modalidad, referencia FROM pedidos WHERE origen = 'ventas_online'");
  assert.equal(ped.length, 1); assert.match(ped[0].referencia, /Online #\d+ R\d{3} Ana/);
  const [com] = await pool.query("SELECT id FROM comandas WHERE referencia LIKE 'Online #%' AND estado = 'emitida'");
  assert.ok(com.length >= 1); // la comanda llegó a cocina o barra
  await esperarMensajes(pool);
  const [[{ fisico }]] = await pool.query('SELECT COALESCE(SUM(cantidad), 0) AS fisico FROM stock_movimientos WHERE producto_id = ?', [A.id]);
  assert.equal(Number(fisico), 3); // 5 − 2: el descuento usó la reserva y no se contó dos veces
  assert.equal((await Comp.disponibleUnidades(A.id)).cantidad, 3);
});

test('Ventas Online.RN44: entregar dos veces el mismo pedido devuelve la venta original sin duplicar comanda, venta ni descuento', async () => {
  const p = await nuevo([{ producto_id: B.id, cantidad: 2 }]);
  const antes = (await det(p)).entrega_ventas.venta_id_global;
  const r = await api('POST', `/api/ventas-online/pedidos/${p.id}/entregar-a-ventas`, { token: gerente.token });
  assert.deepEqual([r.json.estado, r.json.ya_procesado, r.json.venta_id_global], ['entregado', true, antes]);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM ventas WHERE id_global = ?', [antes]))[0][0].n, 1);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM ventas_pedidos_online WHERE pedido_global = ?', [p.id_global]))[0][0].n, 1);
  const directo = await PedidoOnline.recibir({ idGlobal: p.id_global, lineas: [{ producto_id: B.id }], total: 600, pagos: [] }); // llamada directa de Ventas, mismo ID_Global
  assert.equal(directo.ya_procesado, true);
});

test('Ventas Online.RN02: si Ventas no responde el pedido queda pendiente de entrega y se reintenta sin perderse', async () => {
  const original = PedidoOnline.recibir;
  PedidoOnline.recibir = async () => { throw new Error('Ventas caida'); };
  const p = await nuevo([{ producto_id: B.id, cantidad: 1 }]);
  PedidoOnline.recibir = original;
  const d = await det(p);
  assert.equal(d.estado, 'pagado'); assert.equal(d.entrega_ventas.estado, 'pendiente'); assert.match(d.entrega_ventas.error, /Ventas caida/);
  assert.equal((await estado(p, 'en_preparacion')).status, 200); // la preparación reintenta la entrega primero
  assert.equal((await det(p)).entrega_ventas.estado, 'entregado');
  PedidoOnline.recibir = async () => { throw new Error('Ventas caida'); };
  const q = await nuevo([{ producto_id: B.id, cantidad: 1 }]);
  PedidoOnline.recibir = original;
  const r = await api('POST', '/api/ventas-online/pedidos/entregar-pendientes', { token: gerente.token });
  assert.ok(r.json.entregados >= 1);
  assert.equal((await det(q)).entrega_ventas.estado, 'entregado');
});

test('Ventas Online.RN45: con la reserva pendiente el pedido no pasa a Ventas ni a la comanda hasta que Stock la confirme', async () => {
  const original = Comp.comprometer;
  Comp.comprometer = async () => { throw new Error('Stock caido'); };
  const p = await nuevo([{ producto_id: A.id, cantidad: 1 }], { aceptar: false, medio: 'pasarela' });
  Comp.comprometer = original;
  assert.equal(p.reserva.estado, 'pendiente');
  const pago = require('../src/ventas_online/pagoService');
  pagos.set('PAYR1', { estado: 'approved', monto: p.a_pagar, referencia: p.id_global, metodo: 'visa', detalle: null });
  assert.equal((await pago.procesarPago('PAYR1')).pedido_estado, 'reserva_pendiente');
  const d = await det(p);
  assert.equal(d.estado, 'reserva_pendiente'); assert.equal(d.entrega_ventas.estado, 'pendiente');
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM ventas_pedidos_online WHERE pedido_global = ?', [p.id_global]))[0][0].n, 0);
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${p.id}/entregar-a-ventas`, { token: gerente.token })).json.codigo, 'PEDIDO_NO_PAGADO');
  assert.equal((await Reserva.confirmarPendientes()).confirmadas >= 1, true);
  const d2 = await det(p);
  assert.equal(d2.estado, 'pagado'); assert.equal(d2.entrega_ventas.estado, 'entregado');
});

test('Ventas Online.RF12: los estados solo avanzan en orden y cada cambio avisa al cliente una sola vez', async () => {
  const p = await nuevo([{ producto_id: B.id, cantidad: 1 }]);
  assert.deepEqual(await avisos(p), ['pagado']);
  for (const [salto, cod] of [['listo', 'ESTADO_INVALIDO'], ['entregado', 'ESTADO_INVALIDO'], ['despachado', 'ESTADO_INVALIDO'], ['cancelado', 'USAR_CANCELACION'], ['inventado', 'ESTADO_INVALIDO']]) {
    const r = await estado(p, salto);
    assert.equal(r.status, 409, salto); assert.equal(r.json.codigo, cod);
  }
  assert.equal((await estado(p, 'en_preparacion', cajero)).status, 403);
  assert.equal((await estado(p, 'en_preparacion')).json.estado, 'en_preparacion');
  assert.equal((await estado(p, 'en_preparacion')).status, 409); // repetirlo no avisa de nuevo
  assert.equal((await estado(p, 'listo')).json.estado, 'listo');
  assert.equal((await estado(p, 'despachado')).status, 409); // un retiro no se despacha
  assert.equal((await estado(p, 'entregado')).json.estado, 'entregado');
  assert.equal((await estado(p, 'listo')).status, 409); // no se retrocede
  assert.deepEqual(await avisos(p), ['pagado', 'en_preparacion', 'listo', 'entregado']);
  const mails = await correos(p);
  assert.equal(mails.length, 4); assert.match(mails[2].cuerpo, /Número para retirar: R\d{3}/);
  assert.equal(await Gestion.notificar(p.id, 'listo'), false); // el mismo aviso no sale dos veces
  assert.equal((await correos(p)).length, 4);
  const h = (await det(p)).historial.map((x) => x.estado);
  assert.deepEqual(h, ['pendiente_pago', 'pagado', 'en_preparacion', 'listo', 'entregado']);
});

test('Ventas Online.RN36: lo que avanza en la pantalla de cocina y barra llega al pedido, paso a paso, y el delivery espera a quien lo despacha', async () => {
  const p = await nuevo([{ producto_id: B.id, cantidad: 1 }]);
  const [[m]] = await pool.query('SELECT mesa_id FROM ventas_pedidos_online WHERE pedido_global = ?', [p.id_global]);
  const [[c]] = await pool.query("SELECT id FROM comandas WHERE mesa_id = ? AND estado = 'emitida'", [m.mesa_id]);
  await Cocina.avanzar(c.id, { userId: 1 });
  assert.equal((await Gestion.sincronizarCocina()).cambios >= 1, true);
  assert.equal((await det(p)).estado, 'en_preparacion');
  await Cocina.avanzar(c.id, { userId: 1 });
  await api('POST', '/api/ventas-online/pedidos/sincronizar-cocina', { token: gerente.token });
  assert.equal((await det(p)).estado, 'listo');
  assert.deepEqual(await avisos(p), ['pagado', 'en_preparacion', 'listo']);
  await Cocina.avanzar(c.id, { userId: 1 });
  await Gestion.sincronizarCocina();
  assert.equal((await det(p)).estado, 'entregado');
  // Delivery: listo en cocina no lo entrega; lo despacha y entrega una persona con permiso.
  await api('POST', '/api/ventas-online/zonas', { token: gerente.token, body: { nombre: 'Centro', codigos_postales: ['2000'], costo: 400 } });
  const d = await nuevo([{ producto_id: B.id, cantidad: 2 }], { entrega: { tipo: 'delivery', calle: 'Mitre 1', codigo_postal: '2000' }, extra: { total_confirmado: 1000 } });
  const [[md]] = await pool.query('SELECT mesa_id FROM ventas_pedidos_online WHERE pedido_global = ?', [d.id_global]);
  const [cd] = await pool.query("SELECT id FROM comandas WHERE mesa_id = ? AND estado = 'emitida'", [md.mesa_id]);
  for (const x of cd) { await Cocina.avanzar(x.id, { userId: 1 }); await Cocina.avanzar(x.id, { userId: 1 }); await Cocina.avanzar(x.id, { userId: 1 }); }
  await Gestion.sincronizarCocina();
  assert.equal((await det(d)).estado, 'listo');
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${d.id}/despachar`, { token: gerente.token })).json.estado, 'despachado');
  assert.equal((await estado(d, 'entregado')).json.estado, 'entregado');
  assert.deepEqual(await avisos(d), ['pagado', 'en_preparacion', 'listo', 'despachado', 'entregado']);
});

test('Ventas Online.EX04: sin Stock el administrador marca el pedido con faltante a mano, con motivo, y se avisa al cliente', async () => {
  const p = await nuevo([{ producto_id: B.id, cantidad: 1 }]);
  const conf = (b, t = gerente) => api('POST', `/api/ventas-online/pedidos/${p.id}/con-faltante`, { token: t.token, body: b });
  assert.equal((await conf({})).status, 400);
  assert.equal((await conf({ motivo: 'Se acabo la harina' }, cajero)).status, 403);
  assert.equal((await conf({ motivo: 'Se acabo la harina' })).json.estado, 'con_faltante');
  assert.deepEqual(await avisos(p), ['pagado', 'con_faltante']);
  assert.equal((await conf({ motivo: 'otra vez' })).status, 409);
});

test('Ventas Online.RF12: el panel lista y filtra los pedidos, muestra el detalle con historial e integracion y la lista de preparacion', async () => {
  const lista = (await api('GET', '/api/ventas-online/pedidos', { token: administrativo.token })).json;
  assert.ok(lista.length >= 6);
  assert.ok((await api('GET', '/api/ventas-online/pedidos?estado=entregado', { token: gerente.token })).json.every((x) => x.estado === 'entregado'));
  assert.ok((await api('GET', '/api/ventas-online/pedidos?estado=con_faltante', { token: gerente.token })).json.length >= 1);
  assert.equal((await api('GET', '/api/ventas-online/pedidos', { token: cajero.token })).status, 403);
  assert.equal((await api('GET', '/api/ventas-online/pedidos/99999', { token: gerente.token })).status, 404);
  const p = await nuevo([{ producto_id: B.id, cantidad: 3 }]);
  await esperarMensajes(pool);
  const d = await det(p);
  assert.ok(d.integracion); assert.ok(d.historial.length >= 2); assert.equal(d.pagos.length, 0);
  const prep = (await api('GET', '/api/ventas-online/preparacion', { token: gerente.token })).json;
  const mio = prep.find((x) => x.id === p.id);
  assert.equal(mio.items[0].cantidad, 3); assert.equal(mio.items[0].titulo, 'Medialuna');
  assert.ok(prep.every((x) => ['pagado', 'en_preparacion'].includes(x.estado)));
});
