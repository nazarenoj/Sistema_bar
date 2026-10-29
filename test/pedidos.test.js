const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token, producto, n = 0, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
  producto = (await api('POST', '/api/productos', { token, body: { nombre: 'Café', precio: 100, stock: 100 } })).json;
});
after(async () => { await cerrar(); });

const abrir = (body) => api('POST', '/api/pedidos', { token, body });
const mesaNueva = async () => (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
const cargar = (pedidoId, cantidad = 1, extra = {}) => api('POST', `/api/pedidos/${pedidoId}/productos`, { token, body: { productos: [{ producto_id: producto.id, cantidad, ...extra }] } });
const cobrar = (mesaId) => api('POST', `/api/mesas/${mesaId}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cobro-ped-${++k}-${Math.random().toString(36).slice(2, 7)}` }, body: { metodo_pago: 'efectivo' } });
const itemsDe = async (pedidoId) => (await pool.query('SELECT * FROM pedido_productos WHERE pedido_id = ? ORDER BY id', [pedidoId]))[0];

test('Ventas.RF05: un pedido de mostrador, para llevar, delivery o retiro se abre sin mesa y se cobra como una venta', async () => {
  for (const modalidad of ['mostrador', 'para_llevar', 'delivery', 'retiro']) {
    const p = await abrir({ modalidad, referencia: 'Juan 1155550000' });
    assert.equal(p.status, 201, JSON.stringify(p.json));
    assert.equal(p.json.modalidad, modalidad);
    assert.equal(p.json.origen, 'local');
    assert.ok(p.json.mozo_id > 0); // por defecto, quien lo abre
    await cargar(p.json.id, 2);
    const r = await cobrar(p.json.mesa_id);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const v = (await api('GET', `/api/ventas/${r.json.venta_id_global}`, { token })).json;
    assert.deepEqual([v.modalidad, Number(v.total)], [modalidad, 200]);
    assert.equal((await api('GET', `/api/ventas?canal=${modalidad}`, { token })).json.ventas.length, 1); // el registro filtra por canal
    assert.equal((await api('POST', `/api/mesas/${p.json.mesa_id}/confirmar-ticket`, { token })).status, 200);
    assert.equal((await pool.query('SELECT activa FROM mesas WHERE id = ?', [p.json.mesa_id]))[0][0].activa, 0); // la mesa propia se cierra
  }
});

test('Ventas.RF05: los pedidos sin salón no aparecen en el salón y dos abiertos a la vez son cuentas separadas', async () => {
  const a = (await abrir({ modalidad: 'mostrador' })).json;
  const b = (await abrir({ modalidad: 'mostrador' })).json;
  assert.notEqual(a.mesa_id, b.mesa_id);
  const salon = (await api('GET', '/api/mesas?salon_id=1', { token })).json;
  assert.ok(!salon.some((m) => m.id === a.mesa_id || m.id === b.mesa_id));
  await cargar(a.id, 1); await cargar(b.id, 3);
  assert.equal((await cobrar(a.mesa_id)).json.total_acumulado, 100);
  assert.equal((await cobrar(b.mesa_id)).json.total_acumulado, 300);
});

test('Ventas.RF05: modalidad, origen y mozo inválidos se rechazan; el mozo se puede indicar', async () => {
  assert.equal((await abrir({ modalidad: 'drive' })).status, 400);
  assert.equal((await abrir({ modalidad: 'mostrador', origen: 'plataforma' })).status, 400); // sin Ventas Online
  assert.equal((await abrir({ modalidad: 'mostrador', mozo_id: 99999 })).status, 400);
  assert.equal((await abrir({ modalidad: 'salon' })).status, 400); // el salón necesita mesa
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'mozo'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('mario', ?, 'empleado')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  const p = await abrir({ modalidad: 'mostrador', mozo_id: u.insertId });
  assert.equal(p.json.mozo_id, u.insertId);
  await cargar(p.json.id, 1);
  const r = await cobrar(p.json.mesa_id);
  assert.equal((await pool.query('SELECT mozo_id FROM ventas WHERE id_global = ?', [r.json.venta_id_global]))[0][0].mozo_id, u.insertId);
});

test('Ventas.RN09: con el Modo Salón desactivado solo se ofrecen mostrador, para llevar, delivery y retiro', async () => {
  const mesa = await mesaNueva();
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { desactivar: ['VEN-SALON'] } })).status, 200);
  const salon = await abrir({ modalidad: 'salon', mesa_id: mesa.id });
  assert.equal(salon.status, 409);
  assert.equal(salon.json.funcion, 'VEN-SALON');
  assert.equal((await abrir({ modalidad: 'retiro' })).status, 201);
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['VEN-SALON'] } })).status, 200);
  assert.equal((await abrir({ modalidad: 'salon', mesa_id: mesa.id })).status, 201);
});

test('Ventas.RN10: una silla solo puede tener un pedido abierto a la vez', async () => {
  const mesa = await mesaNueva();
  const silla = (await api('POST', `/api/mesas/${mesa.id}/sillas`, { token, body: { pos_x: 0, pos_y: 0 } })).json;
  const otra = (await api('POST', `/api/mesas/${mesa.id}/sillas`, { token, body: { pos_x: 10, pos_y: 0 } })).json;
  const p1 = await abrir({ mesa_id: mesa.id, silla_id: silla.id });
  assert.equal(p1.status, 201);
  const dup = await abrir({ mesa_id: mesa.id, silla_id: silla.id });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.codigo, 'SILLA_OCUPADA');
  assert.equal((await abrir({ mesa_id: mesa.id, silla_id: otra.id })).status, 201); // otra silla de la misma mesa sí
  const ajena = await mesaNueva();
  assert.equal((await abrir({ mesa_id: ajena.id, silla_id: silla.id })).status, 400); // la silla es de otra mesa
});

test('Ventas.RF06: cada ítem puede llevar observaciones libres', async () => {
  const mesa = await mesaNueva();
  const p = (await abrir({ mesa_id: mesa.id })).json;
  assert.equal((await cargar(p.id, 1, { observaciones: 'sin azúcar, bien caliente' })).status, 201);
  assert.equal((await cargar(p.id, 1, { observaciones: 'x'.repeat(300) })).status, 400);
  assert.equal((await itemsDe(p.id))[0].observaciones, 'sin azúcar, bien caliente');
  const por = await api('POST', `/api/pedidos/${p.id}/productos/nombre`, { token, body: { productos: [{ nombre: 'Café', cantidad: 1, observaciones: 'con leche' }] } });
  assert.equal(por.status, 201);
  assert.equal((await itemsDe(p.id))[1].observaciones, 'con leche');
});

test('Ventas.RF06: se puede mover un pedido a otra mesa', async () => {
  const origen = await mesaNueva();
  const destino = await mesaNueva();
  const p = (await abrir({ mesa_id: origen.id })).json;
  await cargar(p.id, 1);
  const r = await api('PATCH', `/api/pedidos/${p.id}/mesa`, { token, body: { mesa_id: destino.id } });
  assert.equal(r.status, 200);
  assert.equal(r.json.mesa_id, destino.id);
  const estado = async (m) => (await pool.query('SELECT estado FROM mesas WHERE id = ?', [m.id]))[0][0].estado;
  assert.deepEqual([await estado(origen), await estado(destino)], ['libre', 'ocupado']);
  assert.equal((await api('PATCH', `/api/pedidos/${p.id}/mesa`, { token, body: { mesa_id: destino.id } })).status, 400); // ya está ahí
  assert.equal((await api('PATCH', `/api/pedidos/${p.id}/mesa`, { token, body: { mesa_id: 99999 } })).status, 404);
  // Un pedido que no es de salón no se mueve.
  const m = (await abrir({ modalidad: 'mostrador' })).json;
  assert.equal((await api('PATCH', `/api/pedidos/${m.id}/mesa`, { token, body: { mesa_id: destino.id } })).status, 400);
});

test('Ventas.RF06: se divide la cuenta por ítem, pasando todo o parte de la cantidad a otro pedido', async () => {
  const mesa = await mesaNueva();
  const p1 = (await abrir({ mesa_id: mesa.id })).json;
  await cargar(p1.id, 3, { observaciones: 'sin azúcar' });
  const item = (await itemsDe(p1.id))[0];
  const r = await api('POST', `/api/pedidos/${p1.id}/dividir`, { token, body: { items: [{ item_id: item.id, cantidad: 1 }] } }); // 1 de 3 a un pedido nuevo
  assert.equal(r.status, 200);
  assert.equal((await itemsDe(p1.id))[0].cantidad, 2);
  const nuevo = await itemsDe(r.json.destino_id);
  assert.deepEqual([nuevo[0].cantidad, nuevo[0].observaciones], [1, 'sin azúcar']);
  assert.equal((await api('POST', `/api/pedidos/${p1.id}/dividir`, { token, body: { items: [{ item_id: item.id, cantidad: 5 }] } })).status, 400); // más de lo que hay
  const todo = await api('POST', `/api/pedidos/${p1.id}/dividir`, { token, body: { items: [{ item_id: item.id, cantidad: 2 }], destino_pedido_id: r.json.destino_id } });
  assert.equal(todo.status, 200);
  assert.equal((await itemsDe(p1.id)).length, 0);
  assert.deepEqual((await itemsDe(r.json.destino_id)).map((i) => i.cantidad), [2, 1]); // la fila original (2) va primero; la partida (1) ya estaba
  assert.equal((await api('POST', `/api/pedidos/${p1.id}/dividir`, { token, body: { items: [{ item_id: item.id, cantidad: 1 }], destino_pedido_id: p1.id } })).status, 400);
  const otra = (await abrir({ mesa_id: (await mesaNueva()).id })).json;
  assert.equal((await api('POST', `/api/pedidos/${r.json.destino_id}/dividir`, { token, body: { items: [{ item_id: nuevo[0].id, cantidad: 1 }], destino_pedido_id: otra.id } })).status, 400); // otra mesa
});

test('Ventas.RN11: quitar un ítem queda registrado con quién y por qué', async () => {
  const mesa = await mesaNueva();
  const p = (await abrir({ mesa_id: mesa.id })).json;
  await cargar(p.id, 2);
  const item = (await itemsDe(p.id))[0];
  const r = await api('DELETE', `/api/pedidos/${p.id}/productos/${item.id}`, { token, body: { motivo: 'el cliente se arrepintió' } });
  assert.equal(r.status, 200);
  const [[a]] = await pool.query('SELECT nombre, cantidad, motivo, user_id FROM item_anulaciones WHERE pedido_id = ?', [p.id]);
  assert.deepEqual([a.nombre, a.cantidad, a.motivo], ['Café', 2, 'el cliente se arrepintió']);
  assert.ok(a.user_id > 0);
  await assert.rejects(pool.query('DELETE FROM item_anulaciones'), /solo agregar/);
});
