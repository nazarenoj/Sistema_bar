const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');

let api, pool, cerrar, token, tokenBarista, n = 0, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
  };
  token = await usuario('adm', 'administrador');
  tokenBarista = await usuario('bea', 'barista');
});
after(async () => { await cerrar(); });

const producto = async (nombre, precio = 1000) => (await api('POST', '/api/productos', { token, body: { nombre: `${nombre} ${++n}`, precio } })).json;
const lista = (body, t = token) => api('POST', '/api/listas-precio', { token: t, body });
const nuevoPedido = async (t = token) => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  return { mesa, pedido: (await api('POST', '/api/pedidos', { token: t, body: { mesa_id: mesa.id } })).json };
};
const agregar = (pedido, productos, t = token) => api('POST', `/api/pedidos/${pedido.id}/productos`, { token: t, body: { productos } });
const precioLinea = async (pedido) => { const [r] = (await pool.query('SELECT precio_unitario, lista_precio_id FROM pedido_productos WHERE pedido_id = ? ORDER BY id DESC LIMIT 1', [pedido.id]))[0]; return [Number(r.precio_unitario), r.lista_precio_id]; };

test('Ventas.RF34: sin VEN-LISTAS no hay listas y rige el precio base', async () => {
  assert.equal((await api('GET', '/api/listas-precio', { token })).status, 409);
  const p = await producto('Café');
  const { pedido } = await nuevoPedido();
  const r = await agregar(pedido, [{ producto_id: p.id, cantidad: 1 }]);
  assert.equal(r.status, 201);
  assert.deepEqual(await precioLinea(pedido), [1000, null]);
  const act = await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['VEN-LISTAS'], motivo: 'prueba' } });
  assert.equal(act.status, 200, JSON.stringify(act.json));
});

test('Ventas.RF34: las listas se validan, la Minorista es la base y los precios se cargan por artículo', async () => {
  const todas = (await api('GET', '/api/listas-precio', { token })).json;
  const minorista = todas.find((l) => l.es_base);
  assert.equal(minorista.nombre, 'Minorista');
  assert.equal((await lista({ nombre: '' })).status, 400);
  assert.equal((await lista({ nombre: 'X', tipo: 'rara' })).status, 400);
  assert.equal((await lista({ nombre: 'X', vigente_desde: '2026-02-01', vigente_hasta: '2026-01-01' })).status, 400);
  const may = await lista({ nombre: 'Mayorista', tipo: 'mayorista' });
  assert.equal(may.status, 201, JSON.stringify(may.json));
  assert.equal((await lista({ nombre: 'Mayorista' })).status, 409);
  assert.equal((await api('PUT', `/api/listas-precio/${minorista.id}/activa`, { token, body: { activa: false } })).status, 409);
  const p = await producto('Alfajor', 500);
  assert.equal((await api('PUT', `/api/listas-precio/${minorista.id}/precios`, { token, body: { precios: [{ producto_id: p.id, precio: 1 }] } })).status, 409);
  assert.equal((await api('PUT', `/api/listas-precio/${may.json.id}/precios`, { token, body: { precios: [{ producto_id: p.id, precio: -1 }] } })).status, 400);
  assert.equal((await api('PUT', `/api/listas-precio/${may.json.id}/precios`, { token, body: { precios: [{ producto_id: 99999, precio: 1 }] } })).status, 404);
  const ok = await api('PUT', `/api/listas-precio/${may.json.id}/precios`, { token, body: { precios: [{ producto_id: p.id, precio: 400 }] } });
  assert.deepEqual(ok.json.map((x) => [x.producto_id, x.precio, x.precio_base]), [[p.id, 400, 500]]);
  assert.equal((await api('PUT', `/api/listas-precio/${may.json.id}/precios`, { token: tokenBarista, body: { precios: [{ producto_id: p.id, precio: 1 }] } })).status, 403);
});

test('Ventas.RN32/RF35: el pedido usa la lista de la terminal o la Minorista y cada línea guarda la lista usada', async () => {
  const may = (await lista({ nombre: `Mayorista ${++n}`, tipo: 'mayorista' })).json;
  const p = await producto('Medialuna', 300);
  const sinPrecio = await producto('Torta', 9000);
  await api('PUT', `/api/listas-precio/${may.id}/precios`, { token, body: { precios: [{ producto_id: p.id, precio: 200 }] } });
  const minorista = (await api('GET', '/api/listas-precio', { token })).json.find((l) => l.es_base);
  // La lista de la terminal manda al abrir; sin terminal, la Minorista.
  const [t] = await pool.query("INSERT INTO terminales (nombre, codigo) VALUES ('Caja mayorista', 'MAY00001')");
  const Listas = require('../src/services/listaPrecioService');
  const { pedido: abierto } = await nuevoPedido();
  assert.equal((await pool.query('SELECT lista_precio_id FROM pedidos WHERE id = ?', [abierto.id]))[0][0].lista_precio_id, minorista.id);
  {
    assert.equal((await api('PUT', `/api/listas-precio/terminales/${t.insertId}`, { token, body: { lista_precio_id: may.id } })).status, 200);
    const { pedido: deTerminal } = await nuevoPedido();
    await Listas.alAbrirPedido(deTerminal.id, t.insertId);
    assert.equal((await pool.query('SELECT lista_precio_id FROM pedidos WHERE id = ?', [deTerminal.id]))[0][0].lista_precio_id, may.id);
  }
  // Elección manual en un pedido vacío: sin permiso especial; el precio sale de la lista.
  const { pedido } = await nuevoPedido(tokenBarista);
  const e = await api('PUT', `/api/listas-precio/pedidos/${pedido.id}`, { token: tokenBarista, body: { lista_precio_id: may.id } });
  assert.equal(e.status, 200, JSON.stringify(e.json));
  const r = await agregar(pedido, [{ producto_id: p.id, cantidad: 2 }], tokenBarista);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(await precioLinea(pedido), [200, may.id]);
  assert.equal(r.json.advertencias, undefined);
  // Sin precio en la lista: precio base, línea en la Minorista y se advierte (EX23).
  const r2 = await agregar(pedido, [{ producto_id: sinPrecio.id, cantidad: 1 }], tokenBarista);
  assert.equal(r2.status, 201);
  assert.match(r2.json.advertencias[0], /no tiene precio en la lista/);
  assert.deepEqual(await precioLinea(pedido), [9000, minorista.id]);
  // Con ítems cargados, cambiar la lista exige el permiso de precios y no toca lo ya agregado (RN17).
  const sin = await api('PUT', `/api/listas-precio/pedidos/${pedido.id}`, { token: tokenBarista, body: { lista_precio_id: minorista.id } });
  assert.equal(sin.status, 403);
  assert.equal((await api('PUT', `/api/listas-precio/pedidos/${pedido.id}`, { token, body: { lista_precio_id: minorista.id } })).status, 200);
  assert.equal(Number((await pool.query('SELECT precio_unitario FROM pedido_productos WHERE pedido_id = ? ORDER BY id LIMIT 1', [pedido.id]))[0][0].precio_unitario), 200);
  assert.equal((await api('GET', `/api/pedidos/${pedido.id}`, { token })).json.lista_precio ?? 'Minorista', 'Minorista');
});

test('Ventas.EX23: una lista vencida o inactiva usa el precio base, advierte y no bloquea; la venta registra la lista', async () => {
  const mensual = (await lista({ nombre: `Temporada ${++n}`, vigente_desde: '2020-01-01', vigente_hasta: '2099-12-31' })).json;
  const p = await producto('Budín', 700);
  await api('PUT', `/api/listas-precio/${mensual.id}/precios`, { token, body: { precios: [{ producto_id: p.id, precio: 600 }] } });
  const { mesa, pedido } = await nuevoPedido();
  assert.equal((await api('PUT', `/api/listas-precio/pedidos/${pedido.id}`, { token, body: { lista_precio_id: mensual.id } })).status, 200);
  await agregar(pedido, [{ producto_id: p.id, cantidad: 1 }]);
  assert.equal((await precioLinea(pedido))[0], 600);
  // La lista vence mientras el pedido sigue abierto: lo próximo que se agrega va al precio base con aviso.
  await pool.query("UPDATE listas_precio SET vigente_hasta = '2021-01-01' WHERE id = ?", [mensual.id]);
  const r = await agregar(pedido, [{ producto_id: p.id, cantidad: 1 }]);
  assert.equal(r.status, 201);
  assert.match(r.json.advertencias[0], /inactiva o vencida/);
  assert.equal((await precioLinea(pedido))[0], 700);
  // No se puede elegir a mano una lista vencida.
  const { pedido: otro } = await nuevoPedido();
  assert.equal((await api('PUT', `/api/listas-precio/pedidos/${otro.id}`, { token, body: { lista_precio_id: mensual.id } })).status, 409);
  // El cierre cobra y deja la lista usada en el detalle de la venta.
  const c = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-lis-${++k}-abcdef` }, body: { metodo_pago: 'efectivo' } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  await esperarMensajes(pool);
  const [[v]] = await pool.query('SELECT total, detalle FROM ventas WHERE id_global = ?', [c.json.venta_id_global]);
  assert.equal(Number(v.total), 1300);
  assert.deepEqual(JSON.parse(v.detalle).map((l) => l.lista), [mensual.nombre, 'Minorista']);
});
