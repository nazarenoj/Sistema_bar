const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token, n = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

const producto = async (nombre, extra = {}) => (await api('POST', '/api/productos', { token, body: { nombre: `${nombre} ${++n}`, precio: 1000, ...extra } })).json;
const cat = async () => (await api('GET', '/api/venta-alergenos', { token })).json;
const id = async (codigo) => (await cat()).find((a) => a.codigo === codigo).id;
const codigos = (l) => l.map((a) => a.codigo).sort();
const nuevoPedido = async () => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  return { mesa, pedido: (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json };
};
const agregar = (pedido, productos) => api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos } });
// Las funciones sanitarias piden la credencial de otro Administrador para apagarse por la API: acá se apagan directo.
const apagar = (funcion) => pool.query('INSERT INTO estado_funcionalidades (funcion_id, activa) VALUES (?, 0) ON DUPLICATE KEY UPDATE activa = 0', [funcion]);
const linea = async (pedido) => (await pool.query('SELECT alergenos_linea, alergenos_pendientes FROM pedido_productos WHERE pedido_id = ? ORDER BY id DESC LIMIT 1', [pedido.id]))[0][0];

test('Ventas.RF31: la lista es configurable y los alérgenos se declaran en artículos y opciones', async () => {
  assert.equal((await cat()).length >= 9, true);
  assert.equal((await api('POST', '/api/venta-alergenos', { token, body: { codigo: 'MAL CODIGO', nombre: 'x' } })).status, 400);
  const nuevo = await api('POST', '/api/venta-alergenos', { token, body: { codigo: 'sesamo', nombre: 'Sésamo' } });
  assert.equal(nuevo.status, 201, JSON.stringify(nuevo.json));
  assert.equal((await api('POST', '/api/venta-alergenos', { token, body: { codigo: 'sesamo', nombre: 'Sésamo' } })).status, 409);
  const p = await producto('Pan');
  assert.equal((await api('PUT', `/api/venta-alergenos/articulos/${p.id}`, { token, body: { alergenos: [99999] } })).status, 404);
  const d = await api('PUT', `/api/venta-alergenos/articulos/${p.id}`, { token, body: { alergenos: [await id('gluten'), nuevo.json.id] } });
  assert.deepEqual(d.json.map((a) => a.codigo).sort(), ['gluten', 'sesamo']);
  assert.equal((await api('PUT', `/api/venta-alergenos/${nuevo.json.id}/activo`, { token, body: { activo: false } })).json.activo, false);
  assert.deepEqual(codigos((await api('GET', `/api/venta-alergenos/articulos/${p.id}`, { token })).json.alergenos), ['gluten']); // el desactivado no figura
});

test('Ventas.RN42: la línea guarda la unión del artículo, las opciones elegidas y los componentes de un combo', async () => {
  const pan = await producto('Pan');
  const cafe = await producto('Café');
  await api('PUT', `/api/venta-alergenos/articulos/${pan.id}`, { token, body: { alergenos: [await id('gluten')] } });
  const g = (await api('POST', '/api/modificadores', { token, body: { nombre: `Leche ${++n}`, aplica_a: [{ producto_id: cafe.id }], opciones: [{ nombre: 'Entera' }, { nombre: 'Soja' }] } })).json;
  assert.equal((await api('PUT', `/api/venta-alergenos/opciones/${g.opciones[1].id}`, { token, body: { alergenos: [await id('soja')] } })).status, 200);
  const { mesa, pedido } = await nuevoPedido();
  assert.equal((await agregar(pedido, [{ producto_id: cafe.id, cantidad: 1, opciones: [g.opciones[0].id] }])).status, 201);
  assert.deepEqual(JSON.parse((await linea(pedido)).alergenos_linea), []);
  assert.equal((await agregar(pedido, [{ producto_id: cafe.id, cantidad: 1, opciones: [g.opciones[1].id] }])).status, 201);
  assert.deepEqual(codigos(JSON.parse((await linea(pedido)).alergenos_linea)), ['soja']);
  // Un combo suma los de sus componentes.
  const combo = await producto('Combo', { tipo: 'combo' });
  assert.equal((await api('PUT', `/api/productos/${combo.id}/componentes`, { token, body: { componentes: [{ componente_id: pan.id, cantidad: 1 }, { componente_id: cafe.id, cantidad: 1 }] } })).status, 200);
  assert.equal((await agregar(pedido, [{ producto_id: combo.id, cantidad: 1 }])).status, 201);
  assert.deepEqual(codigos(JSON.parse((await linea(pedido)).alergenos_linea)), ['gluten']); // el pan del combo; el café no declara
  // Salen en la comanda y en el detalle de la venta.
  const env = await api('POST', '/api/comandas/enviar', { token, body: { mesa_id: mesa.id } });
  assert.equal(env.status, 201, JSON.stringify(env.json));
  const items = env.json.comandas.flatMap((c) => c.items);
  assert.ok(items.some((i) => i.alergenos?.includes('Soja')));
});

test('Ventas.RF31: el menú se filtra por alérgeno', async () => {
  const pan = await producto('Pan menú');
  const jugo = await producto('Jugo menú');
  await api('PUT', `/api/venta-alergenos/articulos/${pan.id}`, { token, body: { alergenos: [await id('gluten')] } });
  const sin = (await api('GET', '/api/venta-alergenos/menu?excluir=gluten', { token })).json.map((x) => x.id);
  assert.equal(sin.includes(pan.id), false);
  assert.equal(sin.includes(jugo.id), true);
  const todos = (await api('GET', '/api/venta-alergenos/menu', { token })).json;
  assert.deepEqual(codigos(todos.find((x) => x.id === pan.id).alergenos), ['gluten']);
});

test('Ventas.RN42: con Stock y STK-ALERGENOS suma los derivados por receta y los del insumo sustituto; si Stock falla, usa lo último calculado y marca pendiente', async () => {
  const insumo = async (nombre) => (await api('POST', '/api/insumos', { token, body: { nombre: `${nombre} ${++n}`, unidad: 'kg' } })).json;
  const stockAlergeno = async (codigo) => (await api('GET', '/api/alergenos', { token })).json.find((a) => a.codigo === codigo).id;
  const harina = await insumo('Harina');
  const vegetal = await insumo('Leche de soja');
  await api('PUT', `/api/alergenos/item/insumo/${harina.id}`, { token, body: { alergenos: [{ alergeno_id: await stockAlergeno('gluten'), tipo: 'contiene' }] } });
  await api('PUT', `/api/alergenos/item/insumo/${vegetal.id}`, { token, body: { alergenos: [{ alergeno_id: await stockAlergeno('soja'), tipo: 'contiene' }] } });
  for (const i of [harina, vegetal]) await api('POST', '/api/stock/ingresos', { token, body: { motivo: 'compra', lineas: [{ item: { tipo: 'insumo', id: i.id }, cantidad: 10, costo_unitario: 1 }] } }); // el pedido ya controla existencias al agregar
  const torta = await producto('Torta', { tipo: 'elaborado' });
  assert.equal((await api('PUT', `/api/recetas/${torta.id}`, { token, body: { lineas: [{ insumo_id: harina.id, cantidad_consumida: 1 }] } })).status, 200);
  const g = (await api('POST', '/api/modificadores', { token, body: { nombre: `Base ${++n}`, aplica_a: [{ producto_id: torta.id }], opciones: [{ nombre: 'Común' }, { nombre: 'Con soja' }] } })).json;
  await api('PUT', `/api/venta-stock/modificadores/${g.opciones[1].id}`, { token, body: { lineas: [{ accion: 'agregar', insumo_id: vegetal.id, cantidad: 0.1 }] } });
  const { pedido } = await nuevoPedido();
  await agregar(pedido, [{ producto_id: torta.id, cantidad: 1, opciones: [g.opciones[1].id] }]);
  let l = await linea(pedido);
  assert.deepEqual(codigos(JSON.parse(l.alergenos_linea)), ['gluten', 'soja']); // el de la receta y el del insumo agregado
  assert.equal(l.alergenos_pendientes, 0);
  // Stock no responde: se muestran los últimos que calculó, con la marca, y el pedido sigue.
  const puertos = require('../src/modulos/puertos');
  const real = await puertos.obtener('stock');
  puertos.registrar('stock', { ...real, alergenosLinea: async () => { throw new Error('caído'); } });
  try {
    assert.equal((await agregar(pedido, [{ producto_id: torta.id, cantidad: 1 }])).status, 201);
  } finally { puertos.registrar('stock', real); }
  l = await linea(pedido);
  assert.equal(l.alergenos_pendientes, 1);
  assert.deepEqual(codigos(JSON.parse(l.alergenos_linea)), ['gluten', 'soja']);
  // Sin STK-ALERGENOS rigen solo los declarados en Ventas.
  await apagar('STK-ALERGENOS');
  await agregar(pedido, [{ producto_id: torta.id, cantidad: 1 }]);
  assert.deepEqual(JSON.parse((await linea(pedido)).alergenos_linea), []);
});

test('Ventas.RF31: con VEN-ALERGENOS apagada no se ofrecen ni se guardan', async () => {
  const p = await producto('Pan off');
  await api('PUT', `/api/venta-alergenos/articulos/${p.id}`, { token, body: { alergenos: [await id('gluten')] } });
  await apagar('VEN-ALERGENOS');
  assert.equal((await api('GET', '/api/venta-alergenos', { token })).status, 409);
  const { pedido } = await nuevoPedido();
  assert.equal((await agregar(pedido, [{ producto_id: p.id, cantidad: 1 }])).status, 201);
  assert.equal((await linea(pedido)).alergenos_linea, null);
});
