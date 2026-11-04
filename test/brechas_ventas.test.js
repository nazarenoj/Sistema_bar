const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

// Brechas de Ventas cerradas tras la revisión de dependencias entre fases (plan-checkpoints.md, «Brechas conocidas»).
let api, pool, cerrar, token, tokenEncargado, tokenPropias, userPropias, cafe, n = 0, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return { id: r.insertId, token: (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token };
  };
  token = (await usuario('adm', 'administrador')).token;
  tokenEncargado = (await usuario('enc', 'encargado')).token;
  ({ token: tokenPropias, id: userPropias } = await usuario('gus', 'gerente'));
  cafe = (await api('POST', '/api/productos', { token, body: { nombre: 'Café', precio: 1000, stock: 500 } })).json;
});
after(async () => { await cerrar(); });

const mesaConPedido = async (t = token) => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token: t, body: { mesa_id: mesa.id } })).json;
  return { mesa, pedido };
};
const cargar = async (pedido, t = token) => {
  const r = await api('POST', `/api/pedidos/${pedido.id}/productos`, { token: t, body: { productos: [{ producto_id: cafe.id, cantidad: 1 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
};
const cerrarMesa = (mesa, t = token, extra = {}) => api('POST', `/api/mesas/${mesa.id}/cerrar`, { token: t, headers: { 'X-ID-Solicitud': `brecha-${++k}-abcdefgh` }, body: { metodo_pago: 'efectivo', ...extra } });

test('Ventas RN81: el cliente identificado en el pedido aplica su lista de precios y queda en la venta; el registro filtra por cliente', async () => {
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['VEN-LISTAS'], motivo: 'prueba' } })).status, 200);
  const may = (await api('POST', '/api/listas-precio', { token, body: { nombre: 'Mayorista', tipo: 'mayorista' } })).json;
  assert.equal((await api('PUT', `/api/listas-precio/${may.id}/precios`, { token, body: { precios: [{ producto_id: cafe.id, precio: 400 }] } })).status, 200);
  await pool.query("INSERT INTO ventas_clientes_copia (cliente_id, razon_social, lista_precio_id, socio, actualizado_ms) VALUES (7, 'Panadería Sur', ?, 0, 1), (8, 'Ana Pérez', NULL, 0, 1)", [may.id]);
  const { mesa, pedido } = await mesaConPedido();
  assert.equal((await api('PUT', `/api/pedidos/${pedido.id}/cliente`, { token, body: { cliente_id: 99 } })).status, 404);
  assert.equal((await api('PUT', `/api/pedidos/${pedido.id}/cliente`, { token, body: { cliente_id: 'x' } })).status, 400);
  const r = await api('PUT', `/api/pedidos/${pedido.id}/cliente`, { token, body: { cliente_id: 7 } });
  assert.deepEqual([r.status, r.json.cliente, r.json.lista?.nombre], [200, 'Panadería Sur', 'Mayorista'], JSON.stringify(r.json));
  await cargar(pedido);
  assert.equal(Number((await pool.query('SELECT precio_unitario FROM pedido_productos WHERE pedido_id = ?', [pedido.id]))[0][0].precio_unitario), 400);
  const cierre = await cerrarMesa(mesa);
  assert.equal(cierre.status, 200, JSON.stringify(cierre.json));
  assert.equal((await pool.query('SELECT cliente_id FROM ventas WHERE id_global = ?', [cierre.json.venta_id_global]))[0][0].cliente_id, 7);
  // Un cliente sin lista deja la del pedido como estaba; sin cliente la venta no lo tiene.
  const otra = await mesaConPedido();
  assert.equal((await api('PUT', `/api/pedidos/${otra.pedido.id}/cliente`, { token, body: { cliente_id: 8 } })).json.lista, null);
  await cargar(otra.pedido);
  assert.equal(Number((await pool.query('SELECT precio_unitario FROM pedido_productos WHERE pedido_id = ?', [otra.pedido.id]))[0][0].precio_unitario), 1000);
  await cerrarMesa(otra.mesa);
  const sin = await mesaConPedido();
  await cargar(sin.pedido);
  await cerrarMesa(sin.mesa);
  const reg = await api('GET', '/api/ventas?cliente_id=7', { token });
  assert.equal(reg.json.ventas.length, 1);
  assert.equal((await api('GET', '/api/ventas', { token })).json.ventas.length, 3);
});

test('Ventas RN23: con el alcance «propias» el registro de ventas solo muestra lo que registró el usuario; el Administrador ve todo', async () => {
  const mia = await mesaConPedido(tokenPropias);
  await cargar(mia.pedido, tokenPropias);
  const c = await cerrarMesa(mia.mesa, tokenPropias);
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const todas = (await api('GET', '/api/ventas', { token: tokenPropias })).json.ventas.length;
  assert.ok(todas > 1);
  await pool.query("INSERT INTO usuario_alcances (user_id, tipo, valor) VALUES (?, 'propias', '')", [userPropias]);
  const lista = await api('GET', '/api/ventas', { token: tokenPropias });
  assert.deepEqual([lista.json.ventas.length, lista.json.ventas[0].id_global], [1, c.json.venta_id_global]);
  assert.equal((await api('GET', '/api/ventas?usuario=adm&solo_usuario_id=999', { token: tokenPropias })).json.ventas.length, 0); // no se puede ampliar por parámetro
  assert.equal((await api('GET', `/api/ventas/${c.json.venta_id_global}`, { token: tokenPropias })).status, 200);
  const ajena = (await api('GET', '/api/ventas', { token })).json.ventas.find((v) => v.id_global !== c.json.venta_id_global);
  assert.equal((await api('GET', `/api/ventas/${ajena.id_global}`, { token: tokenPropias })).status, 404);
  assert.equal((await api('GET', '/api/ventas', { token })).json.ventas.length, todas);
});

test('Ventas B2/B3: quitar un ítem ya enviado pide un permiso propio y anular la comanda devuelve los ítems a «sin enviar»', async () => {
  await pool.query("UPDATE rol_permisos SET nivel = 'denegado' WHERE permiso = 'ventas.pedidos.quitar_enviado' AND rol_id = (SELECT id FROM roles WHERE codigo = 'encargado')");
  const { mesa, pedido } = await mesaConPedido();
  await cargar(pedido);
  const item = () => pool.query('SELECT id, enviado_at FROM pedido_productos WHERE pedido_id = ? ORDER BY id', [pedido.id]).then(([r]) => r);
  const [sinEnviar] = await item();
  assert.equal((await api('DELETE', `/api/pedidos/${pedido.id}/productos/${sinEnviar.id}`, { token: tokenEncargado, body: {} })).status, 200); // sin enviar: alcanza con anular
  await cargar(pedido);
  const env = await api('POST', '/api/comandas/enviar', { token, body: { mesa_id: mesa.id } });
  assert.equal(env.status, 201, JSON.stringify(env.json));
  const [enviado] = await item();
  assert.ok(enviado.enviado_at);
  const sin = await api('DELETE', `/api/pedidos/${pedido.id}/productos/${enviado.id}`, { token: tokenEncargado, body: { motivo: 'error' } });
  assert.deepEqual([sin.status, sin.json.permiso], [403, 'ventas.pedidos.quitar_enviado']);
  // Anular la comanda lo devuelve a «sin enviar»: se puede reenviar.
  const an = await api('POST', `/api/comandas/${env.json.comandas[0].id}/anular`, { token, body: { motivo: 'cocina cerrada' } });
  assert.equal(an.status, 200, JSON.stringify(an.json));
  assert.equal((await item())[0].enviado_at, null);
  assert.equal((await api('POST', '/api/comandas/enviar', { token, body: { mesa_id: mesa.id } })).status, 201);
});
