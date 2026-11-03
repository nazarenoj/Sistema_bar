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

const producto = async (nombre, extra = {}) => (await api('POST', '/api/productos', { token, body: { nombre: `${nombre} ${++n}`, precio: 100, ...extra } })).json;
const nuevoPedido = async () => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  return { mesa, pedido: (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json };
};
const agregar = (pedido, p) => api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: p.id, cantidad: 1 }] } });
const franja = (body) => api('POST', '/api/franjas', { token, body });
// Una franja de una hora que empieza `desdeHoras` horas desde ahora (módulo 24): de 'ahora + 2 h' a 'ahora + 3 h' no incluye el momento actual.
const hora = (horas) => `${String((new Date().getHours() + horas + 24) % 24).padStart(2, '0')}:00`;

test('Ventas.RF29: sin VEN-FRANJA el menú se ofrece completo; las franjas se validan', async () => {
  assert.equal((await api('GET', '/api/franjas', { token })).status, 409);
  const p = await producto('Desayuno');
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['VEN-FRANJA'], motivo: 'prueba' } })).status, 200);
  assert.equal((await franja({ nombre: '', producto_id: p.id, hora_desde: '07:00', hora_hasta: '11:30' })).status, 400);
  assert.equal((await franja({ nombre: 'Mañana', hora_desde: '07:00', hora_hasta: '11:30' })).status, 400); // ni artículo ni categoría
  assert.equal((await franja({ nombre: 'Mañana', producto_id: p.id, categoria_id: 1, hora_desde: '07:00', hora_hasta: '11:30' })).status, 400);
  assert.equal((await franja({ nombre: 'Mañana', producto_id: p.id, hora_desde: '7am', hora_hasta: '11:30' })).status, 400);
  assert.equal((await franja({ nombre: 'Mañana', producto_id: p.id, hora_desde: '07:00', hora_hasta: '07:00' })).status, 400);
  assert.equal((await franja({ nombre: 'Mañana', producto_id: p.id, dias_semana: '7', hora_desde: '07:00', hora_hasta: '11:30' })).status, 400);
  assert.equal((await franja({ nombre: 'Mañana', producto_id: 99999, hora_desde: '07:00', hora_hasta: '11:30' })).status, 404);
  const ok = await franja({ nombre: 'Mañana', producto_id: p.id, hora_desde: '07:00', hora_hasta: '11:30' });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal((await api('DELETE', `/api/franjas/${ok.json.id}`, { token })).status, 204);
  assert.equal((await api('DELETE', `/api/franjas/${ok.json.id}`, { token })).status, 404);
});

test('Ventas.RN45: fuera de su franja un ítem no se ofrece ni se agrega; dentro, sí, y lo ya agregado conserva su precio', async () => {
  const dentro = await producto('Merienda');
  const fuera = await producto('Brunch');
  const libre = await producto('Café');
  await franja({ nombre: 'Ahora', producto_id: dentro.id, hora_desde: hora(-1), hora_hasta: hora(1) });
  await franja({ nombre: 'Más tarde', producto_id: fuera.id, hora_desde: hora(2), hora_hasta: hora(3) });
  const { mesa, pedido } = await nuevoPedido();
  assert.equal((await agregar(pedido, dentro)).status, 201);
  assert.equal((await agregar(pedido, libre)).status, 201); // sin franja: siempre
  const r = await agregar(pedido, fuera);
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'FUERA_DE_FRANJA');
  assert.match(r.json.franjas[0], /Más tarde/);
  const ids = (await api('GET', '/api/franjas/menu', { token })).json.map((x) => x.id);
  assert.deepEqual([ids.includes(dentro.id), ids.includes(fuera.id), ids.includes(libre.id)], [true, false, true]);
  // La franja termina con el ítem ya cargado: conserva su precio y sale a comanda.
  await pool.query("UPDATE franjas_menu SET hora_desde = ?, hora_hasta = ? WHERE producto_id = ?", [hora(5) + ':00', hora(6) + ':00', dentro.id]);
  assert.equal((await agregar(pedido, dentro)).status, 409);
  const env = await api('POST', '/api/comandas/enviar', { token, body: { mesa_id: mesa.id } });
  assert.equal(env.status, 201, JSON.stringify(env.json));
  assert.equal(Number((await pool.query('SELECT precio_unitario FROM pedido_productos WHERE pedido_id = ? AND producto_id = ?', [pedido.id, dentro.id]))[0][0].precio_unitario), 100);
});

test('Ventas.RF29: una franja de categoría rige a sus artículos, la propia manda, los días y la medianoche se respetan', async () => {
  const cat = (await api('POST', '/api/categorias', { token, body: { nombre: `Desayunos ${++n}` } })).json;
  const a = await producto('Tostado', { categoria_id: cat.id });
  const b = await producto('Medialuna', { categoria_id: cat.id });
  await franja({ nombre: 'Categoría fuera', categoria_id: cat.id, hora_desde: hora(2), hora_hasta: hora(3) });
  const { pedido } = await nuevoPedido();
  assert.equal((await agregar(pedido, a)).status, 409);
  // La franja propia del artículo reemplaza a la de su categoría.
  await franja({ nombre: 'Propia ahora', producto_id: b.id, hora_desde: hora(-1), hora_hasta: hora(1) });
  assert.equal((await agregar(pedido, b)).status, 201);
  // Días: solo el día de mañana no es hoy.
  const manana = String((new Date().getDay() + 1) % 7);
  const c = await producto('Menú ejecutivo');
  await franja({ nombre: 'Mañana nomás', producto_id: c.id, dias_semana: manana, hora_desde: '00:00', hora_hasta: '23:59' });
  assert.equal((await agregar(pedido, c)).status, 409);
  // Cruza la medianoche: de 'hace una hora' a 'dentro de una hora' vale aunque desde > hasta.
  const d = await producto('Cena tardía');
  await franja({ nombre: 'Noche', producto_id: d.id, hora_desde: hora(-1), hora_hasta: hora(1) });
  assert.equal((await agregar(pedido, d)).status, 201);
  const Franjas = require('../src/services/franjaService');
  const f = await Franjas.crear({ nombre: 'Trasnoche', producto_id: (await producto('Pizza')).id, hora_desde: '22:00', hora_hasta: '02:00' });
  assert.equal((await Franjas.disponible(pool, f.producto_id, new Date(2026, 0, 5, 23, 30))).disponible, true);
  assert.equal((await Franjas.disponible(pool, f.producto_id, new Date(2026, 0, 6, 1, 0))).disponible, true);
  assert.equal((await Franjas.disponible(pool, f.producto_id, new Date(2026, 0, 6, 12, 0))).disponible, false);
});
