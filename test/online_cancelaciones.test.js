process.env.AFIP_CONDICION_IVA_EMISOR = 'responsable_inscripto';
process.env.AFIP_PUNTO_VENTA = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const Pasarela = require('../src/ventas_online/pasarelaMP');
const PedidoOnline = require('../src/services/pedidoOnlineService');
const Pagos = require('../src/ventas_online/pagoService');
const Cancel = require('../src/ventas_online/cancelacionService');
const wsfe = require('../src/afip/wsfeClient');
const Comp = require('../src/stock/compromisoService');

let api, pool, cerrar, adm, gerente, encargado, cajero, A, B, k = 0, ultimo = 0, arcaCaida = false;
const T = '/tienda/cafe-can';
const pagos = new Map();
const reintegros = [];

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  wsfe.compUltimoAutorizado = async () => { if (arcaCaida) throw new Error('ARCA sin conexion'); return ultimo; };
  wsfe.compConsultar = async () => null;
  wsfe.solicitarCAE = async ({ item }) => { ultimo = item.CbteDesde; return { FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CAE: `7000000000${String(ultimo).padStart(4, '0')}`, CAEFchVto: '20261231' }] } }; };
  Pasarela.usarProveedor({ nombre: 'mercadopago', crearCobro: async () => ({ preferencia_id: 'P', url: 'https://x' }), obtenerPago: async (id) => ({ ...pagos.get(String(id)), id: String(id) }), buscarPagos: async () => [],
    reintegrar: async (id, monto, sol) => { reintegros.push({ id, monto, sol }); return { id: `RF-${reintegros.length}`, estado: 'approved' }; }, verificarFirma: async () => true });
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  encargado = await usuario(api, pool, 'enzo', 'encargado');
  cajero = await usuario(api, pool, 'cami', 'cajero');
  await api('POST', '/api/modulos/ventas_online/instalar', { token: adm.token });
  await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { codigo: 'cafe-can', nombre: 'Cafe', razon_social: 'Cafe SA', cuit: '30711111111', domicilio: 'Mitre 1', activa: true } });
  A = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Cafe 250 g', precio: 1000, stock: 20 } })).json;
  await api('PUT', `/api/stock/configuracion/producto/${A.id}`, { token: adm.token, body: { permite_negativo: false } });
  B = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Medialuna', precio: 300, stock: 0 } })).json;
  for (const x of [A, B]) await api('PUT', `/api/ventas-online/catalogo/${x.id}`, { token: gerente.token, body: { categoria_online: 'Menu' } });
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
});
after(async () => { Pasarela.usarProveedor(null); await cerrar(); });

// Un pedido pagado por la pasarela.
const pagado = async (items, { medio = 'pasarela', cupon = null } = {}) => {
  require('../src/ventas_online/limites').pedidos.reiniciar();
  let c;
  for (const [i, it] of items.entries()) c = i === 0 ? (await api('POST', `${T}/carrito`, { body: it })).json : (await api('POST', `${T}/carrito/${c.token}/items`, { body: it })).json;
  if (cupon) c = (await api('PUT', `${T}/carrito/${c.token}/cupon`, { body: { codigo: cupon } })).json;
  const r = await api('POST', `${T}/checkout`, { headers: { 'X-ID-Solicitud': `sol-can-${++k}-abcdef` }, body: { carrito: c.token, contacto: { nombre: 'Ana', email: `ana${k}@mail.test` }, medio_pago: medio, acepta_terminos: true, total_confirmado: c.total } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const p = r.json;
  if (medio === 'pasarela') { pagos.set(`PAGO${k}`, { estado: 'approved', monto: p.a_pagar, referencia: p.id_global, metodo: 'visa', detalle: null }); await Pagos.procesarPago(`PAGO${k}`); } else if (medio === 'transferencia') await api('POST', `/api/ventas-online/pedidos/${p.id}/confirmar-transferencia`, { token: gerente.token, body: { referencia: 'op 1234' } });
  else await api('POST', `/api/ventas-online/pedidos/${p.id}/aceptar`, { token: gerente.token });
  return { ...p, pago: `PAGO${k}` };
};
const det = async (p) => (await api('GET', `/api/ventas-online/pedidos/${p.id}`, { token: gerente.token })).json;
const estado = (p, e) => api('POST', `/api/ventas-online/pedidos/${p.id}/estado`, { token: gerente.token, body: { estado: e } });
const cancelar = (p, body = { motivo: 'El cliente se arrepintio del pedido' }, t = gerente) => api('POST', `/api/ventas-online/pedidos/${p.id}/cancelar`, { token: t.token, body });
const devolver = (p, body, t = gerente) => api('POST', `/api/ventas-online/pedidos/${p.id}/devolucion`, { token: t.token, body });
const fisico = async (prod) => Number((await pool.query('SELECT COALESCE(SUM(cantidad), 0) AS n FROM stock_movimientos WHERE producto_id = ?', [prod.id]))[0][0].n);
const avisos = async (p) => (await pool.query('SELECT evento FROM onl_notificaciones WHERE pedido_id = ? ORDER BY id', [p.id]))[0].map((x) => x.evento);

test('Ventas Online.RF15/RN52: cancelar un pedido pagado antes del despacho: Ventas devuelve (nota de credito, reingreso a Stock) y despues se reintegra todo por la pasarela', async () => {
  const antes = await fisico(A);
  const p = await pagado([{ producto_id: A.id, cantidad: 2 }, { producto_id: B.id, cantidad: 1 }]); // 2300
  await esperarMensajes(pool);
  assert.equal(await fisico(A), antes - 2);
  assert.equal((await det(p)).comprobantes.length, 1);
  assert.equal((await cancelar(p, { motivo: 'x' })).status, 400);
  assert.equal((await cancelar(p, { motivo: 'El cliente cambio de idea' }, cajero)).status, 403);
  const r = await cancelar(p);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.estado, 'completa');
  const d = await det(p);
  assert.equal(d.estado, 'cancelado'); assert.equal(d.alineacion, 'alineado');
  assert.deepEqual(reintegros.filter((x) => x.id === p.pago).map((x) => x.monto), [2300]); // reintegro total
  const [[nc]] = await pool.query('SELECT estado, importe_total FROM facturas WHERE devolucion_id IS NOT NULL ORDER BY id DESC LIMIT 1');
  assert.deepEqual([nc.estado, Number(nc.importe_total)], ['aprobada', 2300]); // la nota de credito salio antes del reintegro
  await esperarMensajes(pool);
  assert.equal(await fisico(A), antes); // reingreso a Stock
  assert.deepEqual(await avisos(p), ['pagado', 'cancelado']);
  assert.equal((await cancelar(p)).status, 409);
  const lista = (await api('GET', `/api/ventas-online/pedidos/${p.id}/devoluciones`, { token: gerente.token })).json;
  assert.deepEqual([lista[0].tipo, lista[0].estado, lista[0].reintegro_pasarela], ['cancelacion', 'completa', 2300]);
});

test('Ventas Online.EX35: si la nota de credito no sale, el reintegro queda retenido y se ejecuta solo cuando se emite', async () => {
  const p = await pagado([{ producto_id: B.id, cantidad: 2 }]);
  const antes = reintegros.length;
  arcaCaida = true;
  const r = await cancelar(p);
  arcaCaida = false;
  assert.equal(r.json.estado, 'nota_credito_pendiente');
  assert.equal(reintegros.length, antes); // NO se reintegra antes de la nota de credito
  assert.equal((await det(p)).alineacion, 'pendiente_reintegro');
  assert.equal((await det(p)).estado, 'cancelado');
  assert.ok((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE modulo = 'ventas_online' AND mensaje LIKE '%nota de crédito%'"))[0][0].n >= 1);
  const re = await api('POST', '/api/ventas-online/devoluciones/reintentar', { token: gerente.token });
  assert.equal(re.json.reanudadas, 1, JSON.stringify(re.json));
  assert.deepEqual(reintegros.slice(antes).map((x) => [x.id, x.monto]), [[p.pago, 600]]);
  assert.equal((await det(p)).alineacion, 'alineado');
  assert.equal((await api('GET', `/api/ventas-online/pedidos/${p.id}/devoluciones`, { token: gerente.token })).json[0].estado, 'completa');
});

test('Ventas Online.RF15: un pedido que todavia no paso a Ventas solo libera lo reservado y se reintegra; el cupon vuelve', async () => {
  await api('POST', '/api/ventas-online/cupones', { token: gerente.token, body: { codigo: 'DIEZ', tipo: 'monto', valor: 100, usos_max: 5 } });
  const original = PedidoOnline.recibir;
  PedidoOnline.recibir = async () => { throw new Error('Ventas caida'); };
  const stock = (await Comp.disponibleUnidades(A.id)).cantidad;
  const p = await pagado([{ producto_id: A.id, cantidad: 3 }], { cupon: 'DIEZ' });
  PedidoOnline.recibir = original;
  assert.equal((await det(p)).entrega_ventas.estado, 'pendiente');
  assert.equal((await Comp.disponibleUnidades(A.id)).cantidad, stock - 3);
  assert.equal((await pool.query("SELECT usos FROM onl_cupones WHERE codigo = 'DIEZ'"))[0][0].usos, 1);
  const r = await cancelar(p);
  assert.equal(r.json.estado, 'completa');
  assert.equal((await Comp.disponibleUnidades(A.id)).cantidad, stock); // se libero la reserva
  assert.equal((await pool.query("SELECT usos FROM onl_cupones WHERE codigo = 'DIEZ'"))[0][0].usos, 0);
  assert.deepEqual(reintegros.filter((x) => x.id === p.pago).map((x) => x.monto), [2900]); // lo cobrado, con el descuento del cupon
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM ventas_pedidos_online WHERE pedido_global = ?', [p.id_global]))[0][0].n, 0);
});

test('Ventas Online.RF15: el cliente cancela su pedido hasta que entra en preparacion; un despachado se devuelve, no se cancela', async () => {
  const p = await pagado([{ producto_id: B.id, cantidad: 1 }]);
  const q = await pagado([{ producto_id: B.id, cantidad: 1 }]);
  await estado(q, 'en_preparacion');
  const url = (x) => `${T}/pedidos/${x.id_global}/cancelar?email=${encodeURIComponent(x.email)}`;
  assert.equal((await api('POST', `${T}/pedidos/${p.id_global}/cancelar`, { body: {} })).status, 404); // sin el correo no se ve el pedido
  assert.equal((await api('POST', url(q), { body: {} })).json.codigo, 'EN_PREPARACION');
  assert.equal((await api('POST', url(p), { body: { motivo: 'Me equivoque de pedido' } })).json.estado, 'completa');
  assert.equal((await det(p)).estado, 'cancelado');
  await estado(q, 'listo'); await estado(q, 'entregado');
  assert.equal((await cancelar(q)).json.codigo, 'USAR_DEVOLUCION');
});

test('Ventas Online.RF15: la devolucion parcial posterior a la entrega reintegra solo lo devuelto y la total deja el pedido devuelto', async () => {
  const antes = await fisico(A);
  const p = await pagado([{ producto_id: A.id, cantidad: 2 }, { producto_id: B.id, cantidad: 2 }]); // 2600
  await estado(p, 'en_preparacion'); await estado(p, 'listo'); await estado(p, 'entregado');
  await esperarMensajes(pool);
  assert.equal((await devolver(p, { lineas: [{ linea: 1, cantidad: 1 }], motivo: '' })).status, 400);
  assert.equal((await devolver(p, { lineas: [{ linea: 1, cantidad: 1 }], motivo: 'Una unidad llego rota' }, cajero)).status, 403);
  assert.equal((await devolver(p, { lineas: [{ linea: 2, cantidad: 5 }], motivo: 'Devuelvo mas de lo comprado' })).status, 400);
  const parcial = await devolver(p, { lineas: [{ linea: 1, cantidad: 1 }], motivo: 'Una unidad llego rota' }); // 1 de 2 cafes = 1000
  assert.equal(parcial.status, 201, JSON.stringify(parcial.json));
  assert.deepEqual([parcial.json.devolucion_tipo, parcial.json.total_devuelto, parcial.json.estado], ['parcial', 1000, 'completa']);
  assert.equal((await det(p)).estado, 'entregado');
  assert.deepEqual(reintegros.filter((x) => x.id === p.pago).map((x) => x.monto), [1000]);
  const resto = await devolver(p, { todo: true, motivo: 'Devuelve lo que queda', reingreso: 'merma' });
  assert.deepEqual([resto.json.devolucion_tipo, resto.json.total_devuelto], ['total', 1600]);
  assert.equal((await det(p)).estado, 'devuelto');
  assert.deepEqual(reintegros.filter((x) => x.id === p.pago).map((x) => x.monto), [1000, 1600]);
  assert.equal((await det(p)).alineacion, 'alineado');
  await esperarMensajes(pool);
  assert.equal(await fisico(A), antes - 2 + 1); // el cafe devuelto antes reingreso; el resto se dio de baja como merma
  assert.equal((await devolver(p, { todo: true, motivo: 'Otra vez' })).status, 409);
});

test('Ventas Online.RN15: el arrepentimiento dentro de los 10 dias reintegra el total y repone stock; fuera de plazo se rechaza', async () => {
  const antes = await fisico(A);
  const p = await pagado([{ producto_id: A.id, cantidad: 1 }]);
  await estado(p, 'en_preparacion'); await estado(p, 'listo'); await estado(p, 'entregado');
  await esperarMensajes(pool);
  const url = `${T}/pedidos/${p.id_global}/arrepentimiento`;
  assert.equal((await api('POST', url, { body: { email: 'otro@mail.test' } })).status, 404);
  // Comprado hace 20 dias pero entregado hace 2: el plazo corre desde lo ultimo que ocurrio.
  await pool.query('UPDATE onl_pedidos SET created_ms = ? WHERE id = ?', [Date.now() - 20 * 86400000, p.id]);
  const ok = await api('POST', url, { body: { email: p.email, motivo: 'No lo quiero' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.match(ok.json.codigo, /^ARR-[0-9A-F]{8}$/); assert.equal(ok.json.estado, 'resuelto');
  const d = await det(p);
  assert.equal(d.estado, 'devuelto'); assert.equal(d.alineacion, 'alineado');
  assert.deepEqual(reintegros.filter((x) => x.id === p.pago).map((x) => x.monto), [1000]);
  await esperarMensajes(pool);
  assert.equal(await fisico(A), antes); // repuso el stock
  assert.match((await pool.query('SELECT cuerpo FROM correo_cola WHERE para = ? AND asunto LIKE ? ORDER BY id DESC LIMIT 1', [p.email, '%arrepentimiento%']))[0][0].cuerpo, /ARR-/);
  // Fuera de plazo: ni la compra ni la entrega estan dentro de los 10 dias.
  const q = await pagado([{ producto_id: B.id, cantidad: 1 }]);
  await estado(q, 'en_preparacion'); await estado(q, 'listo'); await estado(q, 'entregado');
  await pool.query('UPDATE onl_pedidos SET created_ms = ? WHERE id = ?', [Date.now() - 30 * 86400000, q.id]);
  await pool.query("UPDATE onl_pedido_historial SET ts_ms = ? WHERE pedido_id = ? AND estado = 'entregado'", [Date.now() - 12 * 86400000, q.id]);
  const fuera = await api('POST', `${T}/pedidos/${q.id_global}/arrepentimiento`, { body: { email: q.email } });
  assert.equal(fuera.status, 409); assert.equal(fuera.json.codigo, 'FUERA_DE_PLAZO');
  assert.equal((await det(q)).estado, 'entregado');
  const lista = (await api('GET', '/api/ventas-online/arrepentimientos', { token: gerente.token })).json;
  assert.deepEqual(lista.map((x) => x.estado), ['rechazado', 'resuelto']);
  assert.ok(Cancel);
});

test('Ventas Online.EX11: cancelar un pedido pagado por transferencia deja el reintegro pendiente hasta devolver el dinero por otro medio', async () => {
  const p = await pagado([{ producto_id: B.id, cantidad: 1 }], { medio: 'transferencia' });
  const r = await cancelar(p);
  assert.equal(r.json.estado, 'reintegro_pendiente');
  const pend = (await api('GET', '/api/ventas-online/reintegros?estado=pendiente', { token: gerente.token })).json.find((x) => x.pedido_id === p.id);
  assert.match(pend.error, /Pago manual/);
  const m = await api('POST', `/api/ventas-online/reintegros/${pend.id}/manual`, { token: gerente.token, body: { medio: 'transferencia bancaria' } });
  assert.equal(m.json.estado, 'manual');
});
