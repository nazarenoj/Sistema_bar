const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token, tokenBarista, k = 0;
let a, b, c; // productos de $100, $200 y $50 (c en una categoría)

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
  };
  token = await usuario('adm', 'administrador');
  tokenBarista = await usuario('bea', 'barista');
  const cat = (await api('POST', '/api/categorias', { token, body: { nombre: 'Dulces' } })).json;
  const crear = async (nombre, precio, extra = {}) => (await api('POST', '/api/productos', { token, body: { nombre, precio, ...extra } })).json;
  a = await crear('A', 100, { sku: 'SKU-A' });
  b = await crear('B', 200, { sku: 'SKU-B' });
  c = await crear('C', 50, { sku: 'SKU-C', categoria_id: cat.id });
  c.categoria = cat.id;
});
after(async () => { await cerrar(); });

const precio = async (p) => Number((await pool.query('SELECT precio FROM productos WHERE id = ?', [p.id]))[0][0].precio);
const previa = (body) => api('POST', '/api/precios/vista-previa', { token, body });
const actualizar = (body, t = token) => api('POST', '/api/precios/actualizaciones', { token: t, headers: { 'X-ID-Solicitud': `precios-${++k}-${Math.random().toString(36).slice(2, 7)}` }, body });

test('Ventas.RF14: la vista previa muestra los cambios sin guardar nada', async () => {
  const r = await previa({ tipo: 'porcentaje', valor: 10 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.cambios.map((x) => [x.nombre, x.precio_anterior, x.precio_nuevo]), [['A', 100, 110], ['B', 200, 220], ['C', 50, 55]]);
  assert.deepEqual([await precio(a), await precio(b), await precio(c)], [100, 200, 50]);
});

test('Ventas.RN17: la actualización no afecta a los pedidos abiertos; los ítems nuevos usan el precio nuevo', async () => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: 1, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: a.id, cantidad: 1 }] } });
  const r = await actualizar({ tipo: 'porcentaje', valor: 10, filtro: { productos: [a.id] } });
  assert.equal(r.status, 201);
  assert.equal(r.json.estado, 'aplicada');
  assert.equal(await precio(a), 110);
  assert.equal(await precio(b), 200); // fuera del filtro
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: a.id, cantidad: 1 }] } });
  const items = (await pool.query('SELECT precio_unitario FROM pedido_productos WHERE pedido_id = ? ORDER BY id', [pedido.id]))[0].map((x) => Number(x.precio_unitario));
  assert.deepEqual(items, [100, 110]);
  globalThis.__ultima = r.json.id_global;
});

test('Ventas.RF14: se revierte una actualización aplicada, salvo donde alguien cambió el precio después', async () => {
  await pool.query('UPDATE productos SET precio = 999 WHERE id = ?', [b.id]);
  const r1 = await actualizar({ tipo: 'monto', valor: 5, filtro: { productos: [a.id, b.id] } }); // a 110 -> 115, b 999 -> 1004
  assert.equal(await precio(a), 115);
  await pool.query('UPDATE productos SET precio = 1500 WHERE id = ?', [b.id]); // cambio manual posterior
  const rev = await api('POST', `/api/precios/actualizaciones/${r1.json.id_global}/revertir`, { token, body: { motivo: 'error de carga' } });
  assert.equal(rev.status, 200);
  assert.equal(rev.json.estado, 'revertida');
  assert.deepEqual(rev.json.omitidos, ['B']); // no se pisó el cambio manual
  assert.deepEqual([await precio(a), await precio(b)], [110, 1500]);
  assert.equal((await api('POST', `/api/precios/actualizaciones/${r1.json.id_global}/revertir`, { token, body: {} })).status, 400); // ya revertida
  await pool.query('UPDATE productos SET precio = 200 WHERE id = ?', [b.id]);
});

test('Ventas.RF14: se actualiza por monto y por categoría; un precio negativo rechaza todo el lote', async () => {
  const neg = await previa({ tipo: 'monto', valor: -60 });
  assert.equal(neg.status, 400); // C (50) quedaría negativo
  assert.match(neg.json.error, /negativo/);
  const r = await actualizar({ tipo: 'monto', valor: 25, filtro: { categoria_id: c.categoria } });
  assert.equal(r.status, 201);
  assert.deepEqual([await precio(a), await precio(b), await precio(c)], [110, 200, 75]);
  assert.equal((await previa({ tipo: 'porcentaje', valor: 'mucho' })).status, 400);
  assert.equal((await previa({ tipo: 'porcentaje', valor: -100 })).status, 400);
  assert.equal((await previa({ tipo: 'otro', valor: 1 })).status, 400);
});

test('Ventas.EX12: una importación con filas inválidas se rechaza entera y no cambia nada', async () => {
  const antes = [await precio(a), await precio(b), await precio(c)];
  const r = await actualizar({ tipo: 'importacion', items: [{ sku: 'SKU-A', precio: 130 }, { sku: 'NO-EXISTE', precio: 10 }, { sku: 'SKU-B', precio: -3 }, { sku: 'SKU-A', precio: 140 }] });
  assert.equal(r.status, 400);
  assert.equal(r.json.codigo, 'PRECIOS_INVALIDOS');
  assert.deepEqual(r.json.errores.map((e) => e.fila), [2, 3, 4]);
  assert.deepEqual([await precio(a), await precio(b), await precio(c)], antes);
  assert.equal((await actualizar({ tipo: 'importacion', items: [] })).status, 400);
});

test('Ventas.RF14: una importación válida (lista o CSV) actualiza los artículos por SKU', async () => {
  const r = await actualizar({ tipo: 'importacion', csv: 'sku,precio\nSKU-A,130\nSKU-B;250,5\n' });
  assert.equal(r.status, 201);
  assert.deepEqual([await precio(a), await precio(b), await precio(c)], [130, 250.5, 75]);
  const r2 = await actualizar({ tipo: 'importacion', items: [{ producto_id: c.id, precio: 80 }] });
  assert.equal(r2.status, 201);
  assert.equal(await precio(c), 80);
});

test('Ventas.RF14: una actualización con vigencia futura queda programada, se aplica al llegar o se cancela', async () => {
  const manana = new Date(Date.now() + 86400000).toISOString();
  const p1 = await actualizar({ tipo: 'monto', valor: 10, filtro: { productos: [a.id] }, vigencia_desde: manana });
  assert.equal(p1.json.estado, 'programada');
  assert.equal(await precio(a), 130); // todavía no
  await pool.query("UPDATE actualizaciones_precio SET vigencia_desde = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id_global = ?", [p1.json.id_global]);
  assert.equal(await require('../src/services/precioService').aplicarVencidas(), 1);
  assert.equal(await precio(a), 140);
  assert.equal((await api('GET', `/api/precios/actualizaciones/${p1.json.id_global}`, { token })).json.estado, 'aplicada');

  const p2 = await actualizar({ tipo: 'monto', valor: 10, filtro: { productos: [a.id] }, vigencia_desde: manana });
  assert.equal((await api('POST', `/api/precios/actualizaciones/${p2.json.id_global}/cancelar`, { token })).status, 200);
  assert.equal(await require('../src/services/precioService').aplicarVencidas(), 0);
  assert.equal(await precio(a), 140);
  assert.equal((await api('POST', `/api/precios/actualizaciones/${p2.json.id_global}/cancelar`, { token })).status, 409); // ya no está programada
  assert.equal((await actualizar({ tipo: 'monto', valor: 1, vigencia_desde: 'pronto' })).status, 400);
});

test('Ventas.RF14: solo quien tiene el permiso actualiza precios; queda auditado', async () => {
  assert.equal((await actualizar({ tipo: 'monto', valor: 1 }, tokenBarista)).status, 403);
  assert.ok((await pool.query("SELECT COUNT(*) n FROM auditoria WHERE accion IN ('precios_aplicados', 'precios_revertidos')"))[0][0].n >= 3);
  assert.ok((await api('GET', '/api/precios/actualizaciones', { token })).json.length >= 5);
});
