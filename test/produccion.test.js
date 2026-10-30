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

const stockDe = async (tabla, id) => Number((await pool.query(`SELECT stock FROM ${tabla} WHERE id = ?`, [id]))[0][0].stock);
// Dos insumos con existencias a un costo y un elaborado con su receta (0,5 kg de harina y 0,1 kg de manteca por unidad).
const escenario = async (sufijo) => {
  const insumo = async (nombre, costo) => {
    const i = (await api('POST', '/api/insumos', { token, body: { nombre: `${nombre} ${sufijo}`, unidad: 'kg' } })).json;
    const r = await api('POST', '/api/stock/ingresos', { token, body: { motivo: 'compra', lineas: [{ item: { tipo: 'insumo', id: i.id }, cantidad: 100, costo_unitario: costo }] } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return i;
  };
  const harina = await insumo('Harina', 10);
  const manteca = await insumo('Manteca', 50);
  const masa = (await api('POST', '/api/productos', { token, body: { nombre: `Masa ${sufijo}`, precio: 100, tipo: 'elaborado' } })).json;
  const r = await api('PUT', `/api/recetas/${masa.id}`, { token, body: { lineas: [{ insumo_id: harina.id, cantidad_consumida: 0.5 }, { insumo_id: manteca.id, cantidad_consumida: 0.1 }] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { harina, manteca, masa };
};

test('Stock.RN15/RN72: confirmar una orden descuenta los insumos, ingresa el terminado con su costo y separa la merma fuera de tolerancia', async () => {
  const { harina, manteca, masa } = await escenario('A');
  assert.equal((await api('PUT', `/api/produccion/ficha/${masa.id}`, { token, body: { costo_adicional: 1 } })).status, 200);
  const o = (await api('POST', '/api/produccion/ordenes', { token, body: { producto_id: masa.id, cantidad: 10, turno: 'manana' } })).json;
  assert.equal(o.estado, 'borrador');
  assert.deepEqual(o.consumos.map((c) => c.cantidad_teorica), [5, 1]);
  // Harina: 4 % de más (dentro de la tolerancia del 5 %). Manteca: 50 % de más (fuera).
  const aj = await api('PUT', `/api/produccion/ordenes/${o.id}/consumos`, { token, body: { consumos: [{ item_tipo: 'insumo', item_id: harina.id, cantidad_real: 5.2 }, { item_tipo: 'insumo', item_id: manteca.id, cantidad_real: 1.5 }] } });
  assert.equal(aj.status, 200);
  assert.equal((await api('PUT', `/api/produccion/ordenes/${o.id}/consumos`, { token, body: { consumos: [{ item_tipo: 'insumo', item_id: 99999, cantidad_real: 1 }] } })).status, 400);
  const c = await api('POST', `/api/produccion/ordenes/${o.id}/confirmar`, { token, body: { cantidad_real: 10, peso_crudo: 20, peso_final: 18 } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.estado, 'confirmada');
  assert.equal(Number(c.json.costo_total), 112);          // 5,2×10 + 1×50 + 10×1 (la merma de 0,5 de manteca queda afuera)
  assert.equal(Number(c.json.costo_unitario), 11.2);
  assert.equal(Number(c.json.merma_valorizada), 25);
  assert.equal(Number(c.json.rendimiento_pct), 100);
  assert.equal(Number(c.json.merma_coccion_pct), 10);
  assert.equal(await stockDe('insumos', harina.id), 94.8);
  assert.equal(await stockDe('insumos', manteca.id), 98.5);
  assert.equal(await stockDe('productos', masa.id), 10);
  const [movs] = await pool.query('SELECT motivo, cantidad, costo_unitario FROM stock_movimientos WHERE documento = ? ORDER BY id', [o.id_global]);
  assert.deepEqual(movs.map((m) => m.motivo), ['consumo_produccion', 'consumo_produccion', 'merma_produccion', 'produccion']);
  assert.equal(Number(movs[3].costo_unitario), 11.2);
  assert.equal((await api('POST', `/api/produccion/ordenes/${o.id}/confirmar`, { token, body: {} })).status, 409); // una sola vez
  assert.equal((await api('POST', `/api/produccion/ordenes/${o.id}/cancelar`, { token })).status, 409);
  const inf = (await api('GET', '/api/produccion/informe', { token })).json.find((r) => r.producto_id === masa.id);
  assert.deepEqual([inf.tandas, inf.producido, inf.merma_valorizada], [1, 10, 25]);
});

test('Stock.RF23: producir menos de lo planificado mide el desvío contra lo producido y baja el rendimiento', async () => {
  const { harina, manteca, masa } = await escenario('B');
  const o = (await api('POST', '/api/produccion/ordenes', { token, body: { producto_id: masa.id, cantidad: 10 } })).json;
  // Rindió 8 de 10 y se gastó lo proporcional (4 kg de harina y 0,8 de manteca): sin desvío, nada de merma.
  await api('PUT', `/api/produccion/ordenes/${o.id}/consumos`, { token, body: { consumos: [{ item_tipo: 'insumo', item_id: harina.id, cantidad_real: 4 }, { item_tipo: 'insumo', item_id: manteca.id, cantidad_real: 0.8 }] } });
  const c = (await api('POST', `/api/produccion/ordenes/${o.id}/confirmar`, { token, body: { cantidad_real: 8 } })).json;
  assert.equal(Number(c.rendimiento_pct), 80);
  assert.equal(Number(c.merma_valorizada), 0);
  assert.equal(await stockDe('productos', masa.id), 8);
  // Una orden en borrador se puede cancelar y ya no se confirma.
  const o2 = (await api('POST', '/api/produccion/ordenes', { token, body: { producto_id: masa.id, cantidad: 1 } })).json;
  assert.equal((await api('POST', `/api/produccion/ordenes/${o2.id}/cancelar`, { token })).status, 200);
  assert.equal((await api('POST', `/api/produccion/ordenes/${o2.id}/confirmar`, { token, body: {} })).status, 409);
});

test('Stock.RF11: con producción previa la venta descuenta el elaborado terminado, no los insumos', async () => {
  const { harina, masa } = await escenario('C');
  assert.equal((await api('PUT', `/api/produccion/ficha/${masa.id}`, { token, body: { modo_produccion: 'previa' } })).status, 200);
  const o = (await api('POST', '/api/produccion/ordenes', { token, body: { producto_id: masa.id, cantidad: 10 } })).json;
  assert.equal((await api('POST', `/api/produccion/ordenes/${o.id}/confirmar`, { token, body: {} })).status, 200);
  assert.equal(await stockDe('insumos', harina.id), 95);
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: 900 + ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: masa.id, cantidad: 2 }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-prod-${++k}-abcdef` }, body: { metodo_pago: 'efectivo' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await esperarMensajes(pool);
  assert.equal(await stockDe('productos', masa.id), 8);
  assert.equal(await stockDe('insumos', harina.id), 95); // los insumos ya se descontaron al producir
});

test('Stock.RF24: la ficha técnica trae el costo de receta y el margen teórico contra el precio', async () => {
  const { masa } = await escenario('D');
  await api('PUT', `/api/produccion/ficha/${masa.id}`, { token, body: { costo_adicional: 1, procedimiento: 'Amasar y reposar', peso_porcion: 0.2, conservacion: 'Heladera 3 días' } });
  const f = (await api('GET', `/api/produccion/ficha/${masa.id}`, { token })).json;
  assert.equal(f.costo_receta, 11); // 0,5×10 + 0,1×50 + 1
  assert.equal(f.margen_teorico, 89);
  assert.equal(f.componentes.length, 2);
  assert.equal(f.producto.procedimiento, 'Amasar y reposar');
  assert.equal((await api('PUT', `/api/produccion/ficha/${masa.id}`, { token, body: { modo_produccion: 'otro' } })).status, 400);
});

test('Stock.RF10: no se produce un artículo sin receta ni uno que no es elaborado', async () => {
  const sin = (await api('POST', '/api/productos', { token, body: { nombre: 'Sin receta', precio: 10, tipo: 'elaborado' } })).json;
  assert.equal((await api('POST', '/api/produccion/ordenes', { token, body: { producto_id: sin.id, cantidad: 1 } })).status, 400);
  const simple = (await api('POST', '/api/productos', { token, body: { nombre: 'Agua', precio: 10 } })).json;
  assert.equal((await api('POST', '/api/produccion/ordenes', { token, body: { producto_id: simple.id, cantidad: 1 } })).status, 400);
  assert.equal((await api('POST', '/api/produccion/ordenes', { token, body: { producto_id: sin.id, cantidad: 0 } })).status, 400);
});
