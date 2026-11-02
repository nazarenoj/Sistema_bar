const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');

let api, pool, cerrar, token, n = 0, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

const producto = async (nombre, precio = 1000, extra = {}) => (await api('POST', '/api/productos', { token, body: { nombre: `${nombre} ${++n}`, precio, ...extra } })).json;
const grupo = (body) => api('POST', '/api/modificadores', { token, body });
const nuevoPedido = async () => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  return { mesa, pedido };
};
const agregar = (pedido, productos) => api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos } });
const items = async (pedido) => (await pool.query('SELECT * FROM pedido_productos WHERE pedido_id = ? ORDER BY id', [pedido.id]))[0];

// Un café con un grupo de leche (obligatorio, una opción) y uno de extras (opcional, hasta dos).
const escenario = async () => {
  const cafe = await producto('Café');
  const leche = (await grupo({ nombre: `Leche ${++n}`, obligatorio: true, maximo: 1, aplica_a: [{ producto_id: cafe.id }],
    opciones: [{ nombre: 'Entera' }, { nombre: 'Vegetal', ajuste_precio: 150 }] })).json;
  const extras = (await grupo({ nombre: `Extras ${++n}`, maximo: 2, aplica_a: [{ producto_id: cafe.id }],
    opciones: [{ nombre: 'Shot', ajuste_precio: 200 }, { nombre: 'Canela' }, { nombre: 'Descuento amigo', ajuste_precio: -50 }] })).json;
  return { cafe, leche, extras, o: (g, i) => g.opciones[i].id };
};

test('Ventas.RF30: los grupos se validan, se aplican a artículos o categorías y se editan sin perder las opciones usadas', async () => {
  const cafe = await producto('Café grupo');
  const base = { nombre: `Temperatura ${++n}`, aplica_a: [{ producto_id: cafe.id }], opciones: [{ nombre: 'Caliente' }, { nombre: 'Frío', ajuste_precio: 0 }] };
  assert.equal((await grupo({ ...base, nombre: '' })).status, 400);
  assert.equal((await grupo({ ...base, opciones: [] })).status, 400);
  assert.equal((await grupo({ ...base, obligatorio: true, minimo: 0 })).status, 400); // obligatorio exige al menos una
  assert.equal((await grupo({ ...base, maximo: 0 })).status, 400);
  assert.equal((await grupo({ ...base, aplica_a: [{ producto_id: 99999 }] })).status, 404);
  assert.equal((await grupo({ ...base, aplica_a: [] })).status, 400);
  assert.equal((await grupo({ ...base, opciones: [{ nombre: 'Raro', ajuste_precio: 'mucho' }] })).status, 400);
  const g = await grupo(base);
  assert.equal(g.status, 201, JSON.stringify(g.json));
  assert.equal((await grupo(base)).status, 409); // nombre repetido
  assert.deepEqual((await api('GET', `/api/modificadores/producto/${cafe.id}`, { token })).json.map((x) => x.id), [g.json.id]);
  // Se quita "Frío" y se agrega "Tibio": la quitada queda inactiva (puede estar en pedidos), no desaparece.
  const e = await api('PUT', `/api/modificadores/${g.json.id}`, { token, body: { ...base, opciones: [{ id: g.json.opciones[0].id, nombre: 'Caliente' }, { nombre: 'Tibio' }] } });
  assert.equal(e.status, 200, JSON.stringify(e.json));
  assert.equal(e.json.opciones.find((o) => o.nombre === 'Frío').activo, false);
  assert.deepEqual((await api('GET', `/api/modificadores/producto/${cafe.id}`, { token })).json[0].opciones.map((o) => o.nombre), ['Caliente', 'Tibio']);
  // Aplicado a una categoría llega a sus artículos.
  const cat = (await api('POST', '/api/categorias', { token, body: { nombre: `Bebidas ${++n}` } })).json;
  if (cat?.id) {
    const te = await producto('Té', 800, { categoria_id: cat.id });
    await grupo({ nombre: `Azúcar ${++n}`, aplica_a: [{ categoria_id: cat.id }], opciones: [{ nombre: 'Sin azúcar' }] });
    assert.equal((await api('GET', `/api/modificadores/producto/${te.id}`, { token })).json.length, 1);
  }
  assert.equal((await api('PUT', `/api/modificadores/${g.json.id}/activo`, { token, body: { activo: false } })).json.activo, false);
  assert.deepEqual((await api('GET', `/api/modificadores/producto/${cafe.id}`, { token })).json, []);
});

test('Ventas.RN41: el ajuste de las opciones se suma al precio y queda fijado; se respeta el máximo del grupo', async () => {
  const { cafe, leche, extras, o } = await escenario();
  const { pedido } = await nuevoPedido();
  const r = await agregar(pedido, [{ producto_id: cafe.id, cantidad: 2, opciones: [o(leche, 1), o(extras, 0), o(extras, 2)] }]);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const [it] = await items(pedido);
  assert.equal(Number(it.precio_unitario), 1300); // 1000 + 150 (vegetal) + 200 (shot) − 50
  const mods = (await pool.query('SELECT nombre, ajuste_precio_aplicado FROM pedido_item_modificadores WHERE item_id = ? ORDER BY id', [it.id]))[0];
  assert.deepEqual(mods.map((m) => [m.nombre, Number(m.ajuste_precio_aplicado)]), [['Vegetal', 150], ['Shot', 200], ['Descuento amigo', -50]]);
  // Cambiar el precio de la opción después no toca lo ya cargado.
  await pool.query('UPDATE opciones_modificador SET ajuste_precio = 999 WHERE id = ?', [o(leche, 1)]);
  assert.equal(Number((await items(pedido))[0].precio_unitario), 1300);
  // Máximo del grupo, opción repetida, ajena o mal formada.
  assert.equal((await agregar(pedido, [{ producto_id: cafe.id, cantidad: 1, opciones: [o(leche, 0), o(leche, 1)] }])).status, 400);
  assert.equal((await agregar(pedido, [{ producto_id: cafe.id, cantidad: 1, opciones: [o(extras, 0), o(extras, 0)] }])).status, 400);
  const otro = await producto('Alfajor');
  assert.equal((await agregar(pedido, [{ producto_id: otro.id, cantidad: 1, opciones: [o(leche, 0)] }])).status, 400); // la opción no se aplica a ese artículo
  assert.equal((await agregar(pedido, [{ producto_id: cafe.id, cantidad: 1, opciones: 'x' }])).status, 400);
  assert.equal((await items(pedido)).length, 1); // lo rechazado no dejó nada
});

test('Ventas.EX31: un grupo obligatorio incompleto impide enviar ese ítem a comanda y el resto sale; se completa después', async () => {
  const { cafe, leche, o } = await escenario();
  const alfajor = await producto('Alfajor');
  const { mesa, pedido } = await nuevoPedido();
  assert.equal((await agregar(pedido, [{ producto_id: cafe.id, cantidad: 1 }, { producto_id: alfajor.id, cantidad: 1 }])).status, 201); // agregar no se bloquea
  const env = await api('POST', '/api/comandas/enviar', { token, body: { mesa_id: mesa.id } });
  assert.equal(env.status, 201, JSON.stringify(env.json));
  assert.deepEqual(env.json.omitidos.map((x) => [x.nombre.startsWith('Café'), x.faltan[0].grupo.startsWith('Leche')]), [[true, true]]);
  assert.deepEqual(env.json.comandas.flatMap((c) => c.items.map((i) => i.nombre.slice(0, 7))), ['Alfajor']);
  // Solo el café pendiente: no hay nada que enviar y se dice qué grupo falta.
  const sola = await api('POST', '/api/comandas/enviar', { token, body: { mesa_id: mesa.id } });
  assert.equal(sola.status, 409);
  assert.match(sola.json.error, /Leche/);
  // Se completa el grupo y sale con sus opciones en la comanda.
  const [, itemCafe] = [null, (await items(pedido)).find((i) => i.producto_id === cafe.id)];
  const comp = await api('PUT', `/api/modificadores/items/${itemCafe.id}`, { token, body: { opciones: [o(leche, 1)] } });
  assert.equal(comp.status, 200, JSON.stringify(comp.json));
  assert.deepEqual([comp.json.precio_unitario, comp.json.faltan], [1150, []]);
  const ok = await api('POST', '/api/comandas/enviar', { token, body: { mesa_id: mesa.id } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.comandas[0].items[0].opciones, ['Vegetal']);
  // Ya enviado: no se cambia.
  assert.equal((await api('PUT', `/api/modificadores/items/${itemCafe.id}`, { token, body: { opciones: [o(leche, 0)] } })).status, 409);
});

test('Ventas.RN41: el cierre cobra con los ajustes, la venta guarda las opciones y Stock descuenta el insumo alternativo', async () => {
  const insumo = async (nombre) => (await api('POST', '/api/insumos', { token, body: { nombre: `${nombre} ${++n}`, unidad: 'kg', stock: 100 } })).json;
  const entera = await insumo('Leche entera');
  const vegetal = await insumo('Leche vegetal');
  const { cafe, leche, o } = await escenario();
  const r = await api('PUT', `/api/recetas/${cafe.id}`, { token, body: { lineas: [{ insumo_id: entera.id, cantidad_consumida: 0.25 }] } });
  assert.equal(r.status, 409); // un café común no es elaborado: se pasa a elaborado para que tenga receta
  await pool.query("UPDATE productos SET tipo = 'elaborado' WHERE id = ?", [cafe.id]);
  assert.equal((await api('PUT', `/api/recetas/${cafe.id}`, { token, body: { lineas: [{ insumo_id: entera.id, cantidad_consumida: 0.25 }] } })).status, 200);
  assert.equal((await api('PUT', `/api/venta-stock/modificadores/${o(leche, 1)}`, { token, body: { lineas: [{ accion: 'sustituir', insumo_original_id: entera.id, cantidad_original: 0.25, insumo_id: vegetal.id, cantidad: 0.25 }] } })).status, 200);
  const { mesa, pedido } = await nuevoPedido();
  await agregar(pedido, [{ producto_id: cafe.id, cantidad: 2, opciones: [o(leche, 1)] }]);
  const c = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-mod-${++k}-abcdef` }, body: { metodo_pago: 'efectivo' } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  await esperarMensajes(pool);
  const [[v]] = await pool.query('SELECT total, detalle FROM ventas WHERE id_global = ?', [c.json.venta_id_global]);
  assert.equal(Number(v.total), 2300); // 2 × (1000 + 150)
  assert.deepEqual(JSON.parse(v.detalle)[0].modificadores, [{ nombre: 'Vegetal', ajuste: 150 }]);
  const stock = async (i) => Number((await pool.query('SELECT stock FROM insumos WHERE id = ?', [i.id]))[0][0].stock);
  assert.deepEqual([await stock(entera), await stock(vegetal)], [100, 99.5]); // salió la leche vegetal, no la entera
});

test('Ventas.RF30: con VEN-MODIF apagada no se ofrecen ni se aceptan modificadores y la comanda sale completa', async () => {
  const { cafe, leche, o } = await escenario();
  const off = await api('POST', '/api/funciones/cambiar', { token, body: { desactivar: ['VEN-MODIF'], motivo: 'prueba' } });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  assert.equal((await api('GET', '/api/modificadores', { token })).status, 409);
  const { mesa, pedido } = await nuevoPedido();
  assert.equal((await agregar(pedido, [{ producto_id: cafe.id, cantidad: 1, opciones: [o(leche, 0)] }])).status, 409);
  assert.equal((await agregar(pedido, [{ producto_id: cafe.id, cantidad: 1 }])).status, 201);
  const env = await api('POST', '/api/comandas/enviar', { token, body: { mesa_id: mesa.id } });
  assert.equal(env.status, 201, JSON.stringify(env.json)); // sin la función no hay grupos obligatorios que frenen
  assert.deepEqual(env.json.omitidos, []);
});
