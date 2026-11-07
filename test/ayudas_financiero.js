// Ayudas de las pruebas de Financiero: usuarios con rol, una terminal con su caja y una venta de verdad por la API de Ventas.
const bcrypt = require('bcryptjs');
const { esperarMensajes } = require('./ayudas');

const usuario = async (api, pool, username, rol, terminal) => {
  const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
  const login = await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1', ...(terminal && { terminal }) } });
  return { id: r.insertId, token: login.json.token };
};

const terminal = async (pool, nombre, codigo) => (await pool.query('INSERT INTO terminales (nombre, codigo) VALUES (?, ?)', [nombre, codigo]))[0].insertId;

let n = 0;
// Una cuenta de `importe` (un producto de ese precio) cerrada con los pagos indicados. Devuelve la venta.
// `armar` es el token con permiso para armar la mesa y el pedido; `token` es quien cierra la cuenta (su terminal es la de la venta).
const vender = async (api, pool, token, { importe = 100, pagos, metodo_pago = 'efectivo', extra = {}, armar = token } = {}) => {
  const mesa = (await api('POST', '/api/mesas', { token: armar, body: { numero_mesa: 900 + ++n, salon_id: 1 } })).json;
  const prod = (await api('POST', '/api/productos', { token: armar, body: { nombre: `Prod ${n}`, precio: importe, stock: 10 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token: armar, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token: armar, body: { productos: [{ producto_id: prod.id, cantidad: 1 }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `venta-${n}-${Math.random().toString(36).slice(2, 8)}` }, body: { ...(pagos ? { pagos } : { metodo_pago }), ...extra } });
  await esperarMensajes(pool);
  return { status: r.status, json: r.json, id: r.json?.venta_id_global, mesa, prod };
};

module.exports = { usuario, terminal, vender };
