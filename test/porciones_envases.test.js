const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');

let api, pool, cerrar, token, M, n = 0, k = 0, d = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  M = require('../src/mensajeria/servicio');
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

const insumo = async (nombre, stock = 100) => (await api('POST', '/api/insumos', { token, body: { nombre, unidad: 'kg', stock } })).json;
const producto = async (nombre, extra = {}) => (await api('POST', '/api/productos', { token, body: { nombre, precio: 100, ...extra } })).json;
const stockDe = async (tipo, id) => Number((await pool.query(`SELECT stock FROM ${tipo === 'insumo' ? 'insumos' : 'productos'} WHERE id = ?`, [id]))[0][0].stock);
const movs = async (tipo, id) => (await pool.query(`SELECT * FROM stock_movimientos WHERE ${tipo}_id = ? ORDER BY id`, [id]))[0];
const vender = async (p, cantidad) => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: p.id, cantidad }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-por-${++k}-abcdef` }, body: { metodo_pago: 'efectivo' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await esperarMensajes(pool);
  return r.json;
};
// Mensaje de descuento con modalidad y opciones, como lo mandaría Ventas.
const descontar = async (items, modalidad) => {
  const conn = await pool.getConnection();
  try {
    await M.publicar(conn, { origen: 'ventas', destino: 'stock', tipo: 'descuento_stock', docTipo: 'venta', docIdGlobal: `TST01-PORC${String(++d).padStart(20, '0')}`, contenido: { doc_tipo: 'venta', modalidad, items } });
  } finally { conn.release(); }
  await esperarMensajes(pool);
};
const devolver = async (idVenta, body) => {
  const r = await api('POST', '/api/devoluciones', { token, headers: { 'X-ID-Solicitud': `devol-por-${++k}-abcdef` }, body: { venta_id_global: idVenta, motivo: 'prueba', ...body } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  await esperarMensajes(pool);
};
const cfgPorcion = (porcion, pieza, modalidad, porciones_por_pieza = 8) => api('PUT', `/api/venta-stock/porciones/${porcion.id}`, { token, body: { origen_producto_id: pieza?.id, porciones_por_pieza, modalidad } });

test('Stock.RF30/RN44: la porción proporcional se controla en porciones, la pieza entra como N y su devolución siempre es merma', async () => {
  const porcion = await producto('Porción A');
  assert.equal((await cfgPorcion(porcion, null, 'proporcional', 1)).status, 400); // al menos 2 porciones por pieza
  assert.equal((await cfgPorcion(porcion, porcion, 'fraccionamiento')).status, 400); // la pieza es otro artículo
  assert.equal((await cfgPorcion(porcion, null, 'proporcional')).status, 200);
  const ing = await api('POST', `/api/venta-stock/porciones/${porcion.id}/ingresos`, { token, body: { piezas: 2, costo_pieza: 80 } });
  assert.equal(ing.status, 201, JSON.stringify(ing.json));
  assert.equal(await stockDe('producto', porcion.id), 16);
  assert.equal(Number((await movs('producto', porcion.id))[0].costo_unitario), 10); // la pieza dividida por las porciones
  const v = await vender(porcion, 3);
  assert.equal(await stockDe('producto', porcion.id), 13);
  await devolver(v.venta_id_global, { items: [{ linea: 0, cantidad: 1 }] }); // por defecto reingresa… pero una porción no
  assert.equal(await stockDe('producto', porcion.id), 13);
  const m = (await movs('producto', porcion.id)).filter((x) => x.documento === v.venta_id_global).map((x) => x.motivo);
  assert.deepEqual(m, ['venta', 'devolucion_venta', 'devolucion_merma']);
});

test('Stock.RF30/RN78: el fraccionamiento convierte piezas en porciones con el costo dividido y el lote de la pieza', async () => {
  const torta = await producto('Torta B');
  const porcion = await producto('Porción B');
  for (const p of [torta, porcion]) assert.equal((await api('PUT', `/api/lotes/configuracion/producto/${p.id}`, { token, body: { controla_lote: true } })).status, 200);
  const ing = await api('POST', '/api/stock/ingresos', { token, body: { motivo: 'compra', lineas: [{ item: { tipo: 'producto', id: torta.id }, cantidad: 2, costo_unitario: 80, lote: { codigo: 'T1', fecha_vencimiento: '2099-01-10' } }] } });
  assert.equal(ing.status, 201, JSON.stringify(ing.json));
  assert.equal((await api('POST', `/api/venta-stock/porciones/${porcion.id}/fraccionar`, { token, body: { piezas: 1 } })).status, 409); // sin configurar
  await cfgPorcion(porcion, torta, 'fraccionamiento');
  assert.equal((await api('POST', `/api/venta-stock/porciones/${porcion.id}/fraccionar`, { token, body: { piezas: 5 } })).status, 409); // no hay tantas
  const f = await api('POST', `/api/venta-stock/porciones/${porcion.id}/fraccionar`, { token, body: { piezas: 1 } });
  assert.equal(f.status, 201, JSON.stringify(f.json));
  assert.deepEqual([Number(f.json.porciones), Number(f.json.costo_porcion)], [8, 10]);
  assert.equal(await stockDe('producto', torta.id), 1);
  assert.equal(await stockDe('producto', porcion.id), 8);
  const [[lp]] = await pool.query('SELECT l.codigo, l.fecha_vencimiento, o.codigo AS origen FROM lotes l JOIN lotes o ON o.id = l.lote_origen_id WHERE l.producto_id = ?', [porcion.id]);
  assert.equal(lp.codigo, 'T1');
  assert.equal(lp.origen, 'T1');
  assert.equal(new Date(lp.fecha_vencimiento).getFullYear(), 2099);
  const v = await vender(porcion, 2); // vende porciones, no la pieza
  assert.deepEqual([await stockDe('producto', porcion.id), await stockDe('producto', torta.id)], [6, 1]);
  await devolver(v.venta_id_global, { todo: true });
  assert.equal(await stockDe('producto', porcion.id), 6); // la devolución de una porción es merma
});

test('Stock.RF38: el envase sale según la modalidad del pedido; el del artículo prevalece sobre el de la categoría y sin mapeo no descuenta', async () => {
  const vaso = await insumo('Vaso');
  const bolsa = await insumo('Bolsa');
  const cafe = await producto('Café envase');
  assert.equal((await api('PUT', '/api/venta-stock/envases', { token, body: { producto_id: cafe.id, modalidad: 'volando', insumo_id: vaso.id, cantidad: 1 } })).status, 400);
  assert.equal((await api('PUT', '/api/venta-stock/envases', { token, body: { producto_id: cafe.id, modalidad: 'para_llevar', insumo_id: vaso.id, cantidad: 1 } })).status, 200);
  const [[{ categoria_id }]] = await pool.query('SELECT categoria_id FROM productos WHERE id = ?', [cafe.id]);
  if (categoria_id) await api('PUT', '/api/venta-stock/envases', { token, body: { categoria_id, modalidad: 'para_llevar', insumo_id: bolsa.id, cantidad: 1 } });
  await descontar([{ linea: 0, producto_id: cafe.id, cantidad: 2 }], 'para_llevar');
  assert.equal(await stockDe('insumo', vaso.id), 98); // por cantidad vendida
  assert.equal(await stockDe('insumo', bolsa.id), 100); // el del artículo prevaleció
  await descontar([{ linea: 0, producto_id: cafe.id, cantidad: 1 }], 'salon'); // sin mapeo para salón: no es un error
  assert.equal(await stockDe('insumo', vaso.id), 98);
  // Una venta de Ventas por el flujo normal (modalidad del pedido) trae el mensaje con la modalidad.
  const v = await vender(cafe, 1);
  const [[msg]] = await pool.query("SELECT contenido FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'descuento_stock'", [v.venta_id_global]);
  assert.equal(JSON.parse(msg.contenido).modalidad, 'salon');
});

test('Stock.RF31: una opción sustituye, agrega o quita un insumo de lo descontado, solo con VEN-MODIF', async () => {
  const entera = await insumo('Leche entera');
  const vegetal = await insumo('Leche vegetal');
  const shot = await insumo('Shot');
  const latte = await producto('Latte', { tipo: 'elaborado' });
  await api('PUT', `/api/recetas/${latte.id}`, { token, body: { lineas: [{ insumo_id: entera.id, cantidad_consumida: 0.25 }] } });
  assert.equal((await api('PUT', '/api/venta-stock/modificadores/vegetal', { token, body: { lineas: [{ accion: 'sustituir', insumo_original_id: entera.id, cantidad_original: 0.25, insumo_id: vegetal.id, cantidad: 0.3 }] } })).status, 200);
  assert.equal((await api('PUT', '/api/venta-stock/modificadores/extra', { token, body: { lineas: [{ accion: 'agregar', insumo_id: shot.id, cantidad: 1 }] } })).status, 200);
  assert.equal((await api('PUT', '/api/venta-stock/modificadores/malo', { token, body: { lineas: [{ accion: 'agregar' }] } })).status, 400);
  await descontar([{ linea: 0, producto_id: latte.id, cantidad: 2, opciones: ['vegetal', 'extra'] }]);
  assert.deepEqual([await stockDe('insumo', entera.id), await stockDe('insumo', vegetal.id), await stockDe('insumo', shot.id)], [100, 99.4, 98]);
  // Sin VEN-MODIF la opción solo afecta precio y comanda: se descuenta la receta tal cual.
  await api('POST', '/api/funciones/cambiar', { token, body: { desactivar: ['VEN-MODIF'], motivo: 'prueba' } });
  await descontar([{ linea: 0, producto_id: latte.id, cantidad: 2, opciones: ['vegetal'] }]);
  assert.deepEqual([await stockDe('insumo', entera.id), await stockDe('insumo', vegetal.id)], [99.5, 99.4]);
});

test('Stock.RF32: el artículo sin lo necesario se marca agotado en Ventas en menos de 5 s, sin bloquear la venta, y vuelve al reponer', async () => {
  const leche = await insumo('Leche agotable', 1);
  const capu = await producto('Capuchino', { tipo: 'elaborado' });
  await api('PUT', `/api/recetas/${capu.id}`, { token, body: { lineas: [{ insumo_id: leche.id, cantidad_consumida: 0.25 }] } });
  assert.equal((await api('GET', '/api/venta-stock/agotados', { token })).status, 409); // VEN-KDS está apagada
  const act = await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['VEN-KDS'], motivo: 'prueba' } });
  assert.equal(act.status, 200, JSON.stringify(act.json));
  const marca = async () => Number((await pool.query('SELECT agotado_auto FROM productos WHERE id = ?', [capu.id]))[0][0].agotado_auto);
  await vender(capu, 3);
  assert.equal(await marca(), 0); // queda 0,25: alcanza para una
  const t0 = Date.now();
  await vender(capu, 1);
  assert.equal(await marca(), 1);
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual((await api('GET', '/api/venta-stock/agotados', { token })).json.map((a) => a.producto_id), [capu.id]);
  // La marca informa a la cocina y no impide cargar el artículo en un pedido (RN01).
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  assert.equal((await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: capu.id, cantidad: 1 }] } })).status, 201);
  await api('POST', '/api/stock/ingresos', { token, body: { motivo: 'compra', lineas: [{ item: { tipo: 'insumo', id: leche.id }, cantidad: 10, costo_unitario: 1 }] } });
  await esperarMensajes(pool);
  assert.equal(await marca(), 0);
  assert.deepEqual((await api('GET', '/api/venta-stock/agotados', { token })).json, []);
});
