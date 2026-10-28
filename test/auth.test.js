const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar;
before(async () => { ({ api, pool, cerrar } = await iniciarApp()); });
after(async () => { await cerrar(); });

const CLAVE = 'clave-larga-1';

// Crea un usuario directo en la base (sin cambio de contraseña pendiente) y devuelve su token.
const crearUsuario = async (username, { rol = 'empleado', password = CLAVE, debeCambiar = 0 } = {}) => {
  const [r] = await pool.query(
    'INSERT INTO users (username, password_hash, rol, debe_cambiar_password) VALUES (?, ?, ?, ?)',
    [username, await bcrypt.hash(password, 4), rol, debeCambiar]
  );
  return r.insertId;
};
const ingresar = async (username, password = CLAVE, terminal) => {
  const r = await api('POST', '/api/auth/login', { body: { username, password, terminal } });
  return r;
};
const token = async (username) => (await ingresar(username)).json.token;

test('login: credenciales correctas devuelven token, y las incorrectas dan el mismo mensaje exista o no el usuario', async () => {
  await crearUsuario('ana');
  const ok = await ingresar('ana');
  assert.equal(ok.status, 200);
  assert.ok(ok.json.token);
  assert.equal(ok.json.usuario.username, 'ana');
  assert.equal(ok.json.inactividad_min, 10);

  const malaPass = await ingresar('ana', 'incorrecta-123');
  const noExiste = await ingresar('nadie', 'incorrecta-123');
  assert.equal(malaPass.status, 401);
  assert.equal(noExiste.status, 401);
  assert.equal(malaPass.json.error, noExiste.json.error);
});

test('sin token o con token inválido no se accede a la API', async () => {
  assert.equal((await api('GET', '/api/productos')).status, 401);
  assert.equal((await api('GET', '/api/productos', { token: 'basura' })).status, 401);
  assert.equal((await api('GET', '/health')).status, 200);
});

test('5 contraseñas incorrectas bloquean al usuario, incluso con la contraseña correcta, y el Administrador lo desbloquea', async () => {
  await crearUsuario('beto');
  const admin = await crearUsuario('jefe1', { rol: 'admin' });
  for (let i = 0; i < 5; i++) assert.equal((await ingresar('beto', 'mal-mal-mal')).status, 401);

  const bloqueado = await ingresar('beto');
  assert.equal(bloqueado.status, 423);
  assert.match(bloqueado.json.error, /bloqueado/);

  const [[beto]] = await pool.query("SELECT id FROM users WHERE username = 'beto'");
  const tokenAdmin = await token('jefe1');
  assert.equal((await api('POST', `/api/usuarios/${beto.id}/desbloquear`, { token: tokenAdmin })).status, 200);
  assert.equal((await ingresar('beto')).status, 200);
  assert.ok(admin);
});

test('un ingreso correcto reinicia el contador de intentos fallidos', async () => {
  await crearUsuario('carla');
  for (let i = 0; i < 4; i++) await ingresar('carla', 'mal-mal-mal');
  assert.equal((await ingresar('carla')).status, 200);
  for (let i = 0; i < 4; i++) await ingresar('carla', 'mal-mal-mal');
  assert.equal((await ingresar('carla')).status, 200); // 4 + 4 fallos, pero separados por un ingreso: no se bloquea
});

test('contraseña por cambiar: solo se puede usar el cambio de contraseña hasta hacerlo', async () => {
  await crearUsuario('dani', { debeCambiar: 1 });
  const t = await token('dani');
  const bloqueado = await api('GET', '/api/productos', { token: t });
  assert.equal(bloqueado.status, 403);
  assert.equal(bloqueado.json.codigo, 'CAMBIO_PASSWORD');

  assert.equal((await api('POST', '/api/auth/cambiar-password', { token: t, body: { actual: CLAVE, nueva: 'corta' } })).status, 400);
  assert.equal((await api('POST', '/api/auth/cambiar-password', { token: t, body: { actual: 'otra-incorrecta', nueva: 'nueva-clave-9' } })).status, 400);
  assert.equal((await api('POST', '/api/auth/cambiar-password', { token: t, body: { actual: CLAVE, nueva: CLAVE } })).status, 400);
  assert.equal((await api('POST', '/api/auth/cambiar-password', { token: t, body: { actual: CLAVE, nueva: 'nueva-clave-9' } })).status, 200);

  assert.equal((await api('GET', '/api/productos', { token: t })).status, 200);
  assert.equal((await ingresar('dani', CLAVE)).status, 401); // la vieja ya no sirve
  assert.equal((await ingresar('dani', 'nueva-clave-9')).status, 200);
});

test('inactividad: la sesión vence, los latidos no la renuevan y la actividad sí', async () => {
  await crearUsuario('eva');
  const t = await token('eva');
  const sid = (await pool.query('SELECT MAX(id) AS id FROM sesiones'))[0][0].id;
  const vejez = (min) => pool.query('UPDATE sesiones SET ultimo_acceso = DATE_SUB(NOW(), INTERVAL ? MINUTE) WHERE id = ?', [min, sid]);

  await vejez(5);
  assert.equal((await api('POST', '/api/terminales/ping', { token: t })).status, 200);
  const [[tras]] = await pool.query('SELECT TIMESTAMPDIFF(MINUTE, ultimo_acceso, NOW()) AS min FROM sesiones WHERE id = ?', [sid]);
  assert.ok(tras.min >= 5, 'el latido no debe renovar la actividad');

  assert.equal((await api('GET', '/api/productos', { token: t })).status, 200);
  const [[despues]] = await pool.query('SELECT TIMESTAMPDIFF(MINUTE, ultimo_acceso, NOW()) AS min FROM sesiones WHERE id = ?', [sid]);
  assert.equal(despues.min, 0, 'una acción real sí la renueva');

  await vejez(11);
  const vencida = await api('GET', '/api/productos', { token: t });
  assert.equal(vencida.status, 401);
  assert.match(vencida.json.error, /inactividad/);
  const [[s]] = await pool.query('SELECT motivo_fin FROM sesiones WHERE id = ?', [sid]);
  assert.equal(s.motivo_fin, 'inactividad');
});

test('logout cierra la sesión: el token deja de servir', async () => {
  await crearUsuario('fer');
  const t = await token('fer');
  assert.equal((await api('POST', '/api/auth/logout', { token: t })).status, 200);
  assert.equal((await api('GET', '/api/productos', { token: t })).status, 401);
});

test('usuarios: solo el Administrador gestiona; el PIN es único; siempre queda un Administrador', async () => {
  await crearUsuario('gus');
  await crearUsuario('admin2', { rol: 'admin' });
  const tGus = await token('gus');
  const tAdmin = await token('admin2');

  assert.equal((await api('GET', '/api/usuarios', { token: tGus })).status, 403);

  const alta = await api('POST', '/api/usuarios', { token: tAdmin, body: { username: 'hugo', password: 'inicial-1234', rol: 'empleado', pin: '4321' } });
  assert.equal(alta.status, 201, JSON.stringify(alta.json));
  assert.equal((await api('POST', '/api/usuarios', { token: tAdmin, body: { username: 'ines', password: 'inicial-1234', rol: 'empleado', pin: '4321' } })).status, 400);
  assert.equal((await api('POST', '/api/usuarios', { token: tAdmin, body: { username: 'hugo', password: 'inicial-1234', rol: 'empleado' } })).status, 400);
  assert.equal((await api('POST', '/api/usuarios', { token: tAdmin, body: { username: 'jose', password: 'corta', rol: 'empleado' } })).status, 400);
  assert.equal((await api('POST', '/api/usuarios', { token: tAdmin, body: { username: 'jose', password: 'inicial-1234', rol: 'empleado', pin: '12' } })).status, 400);

  // Lo creado por un Administrador debe cambiar la contraseña en el primer ingreso.
  const primera = await ingresar('hugo', 'inicial-1234');
  assert.equal(primera.json.usuario.debe_cambiar_password, true);

  // El listado nunca trae hashes.
  const lista = await api('GET', '/api/usuarios', { token: tAdmin });
  assert.ok(lista.json.every((u) => !('password_hash' in u) && !('pin_hash' in u) && !('tarjeta_hash' in u)));

  // Dejar sin Administradores no se permite; con otro Administrador activo sí.
  const [admins] = await pool.query("SELECT id, username FROM users WHERE rol = 'admin' ORDER BY id");
  const otros = admins.filter((a) => a.username !== 'admin2');
  for (const a of otros) assert.equal((await api('POST', `/api/usuarios/${a.id}/desactivar`, { token: tAdmin })).status, 200);
  const yo = admins.find((a) => a.username === 'admin2');
  assert.equal((await api('POST', `/api/usuarios/${yo.id}/desactivar`, { token: tAdmin })).status, 400);
  assert.equal((await api('PUT', `/api/usuarios/${yo.id}`, { token: tAdmin, body: { rol: 'empleado' } })).status, 400);
  assert.equal((await api('PUT', `/api/usuarios/${yo.id}`, { token: tAdmin, body: { fecha_baja: '2099-01-01' } })).status, 400);
  for (const a of otros) await api('POST', `/api/usuarios/${a.id}/activar`, { token: tAdmin });
  assert.equal((await api('POST', `/api/usuarios/${yo.id}/desactivar`, { token: tAdmin })).status, 200);
});

test('desactivar un usuario cierra sus sesiones y le impide ingresar; la baja programada vencida también', async () => {
  const id = await crearUsuario('kari');
  await crearUsuario('admin3', { rol: 'admin' });
  const tAdmin = await token('admin3');
  const t = await token('kari');
  assert.equal((await api('POST', `/api/usuarios/${id}/desactivar`, { token: tAdmin })).status, 200);
  assert.equal((await api('GET', '/api/productos', { token: t })).status, 401);
  const rechazo = await ingresar('kari');
  assert.equal(rechazo.status, 403);
  assert.match(rechazo.json.error, /desactivado/);

  await api('POST', `/api/usuarios/${id}/activar`, { token: tAdmin });
  assert.equal((await ingresar('kari')).status, 200);
  await pool.query("UPDATE users SET fecha_baja = DATE_SUB(CURDATE(), INTERVAL 1 DAY) WHERE id = ?", [id]);
  assert.equal((await ingresar('kari')).status, 403);
});

test('restablecer contraseña: cierra las sesiones y obliga a cambiarla', async () => {
  const id = await crearUsuario('lola');
  await crearUsuario('admin4', { rol: 'admin' });
  const tAdmin = await token('admin4');
  const t = await token('lola');
  assert.equal((await api('POST', `/api/usuarios/${id}/password`, { token: tAdmin, body: { password: 'corta' } })).status, 400);
  assert.equal((await api('POST', `/api/usuarios/${id}/password`, { token: tAdmin, body: { password: 'temporal-777' } })).status, 200);
  assert.equal((await api('GET', '/api/productos', { token: t })).status, 401);
  const nuevo = await ingresar('lola', 'temporal-777');
  assert.equal(nuevo.json.usuario.debe_cambiar_password, true);
});

test('cambio rápido de usuario por PIN o tarjeta: abre otra sesión en la misma terminal y frena los intentos fallidos', async () => {
  await crearUsuario('admin5', { rol: 'admin' });
  const tAdmin = await token('admin5');
  const term = await api('POST', '/api/terminales', { token: tAdmin, body: { nombre: 'Caja 1' } });
  assert.equal(term.status, 201);
  assert.match(term.json.codigo, /^[A-Z2-9]{8}$/);

  await api('POST', '/api/usuarios', { token: tAdmin, body: { username: 'mozo1', password: 'inicial-1234', rol: 'empleado', pin: '2468', codigo_tarjeta: 'TARJETA-0001' } });
  const [[mozo]] = await pool.query("SELECT id FROM users WHERE username = 'mozo1'");
  await pool.query('UPDATE users SET debe_cambiar_password = 0 WHERE id = ?', [mozo.id]);

  const login = await ingresar('admin5', CLAVE, term.json.codigo.toLowerCase());
  assert.equal(login.status, 200);
  assert.equal(login.json.usuario.terminal.nombre, 'Caja 1');

  const porPin = await api('POST', '/api/auth/cambiar-usuario', { token: login.json.token, body: { codigo: '2468' } });
  assert.equal(porPin.status, 200);
  assert.equal(porPin.json.usuario.username, 'mozo1');
  assert.equal(porPin.json.usuario.terminal.nombre, 'Caja 1');
  assert.equal((await api('GET', '/api/productos', { token: login.json.token })).status, 401, 'la sesión anterior se cierra');
  const [[cerrada]] = await pool.query("SELECT motivo_fin FROM sesiones WHERE user_id = (SELECT id FROM users WHERE username = 'admin5') ORDER BY id DESC LIMIT 1");
  assert.equal(cerrada.motivo_fin, 'cambio_usuario');

  const porTarjeta = await api('POST', '/api/auth/cambiar-usuario', { token: porPin.json.token, body: { codigo: 'TARJETA-0001' } });
  assert.equal(porTarjeta.status, 200);

  let t = porTarjeta.json.token;
  for (let i = 0; i < 5; i++) assert.equal((await api('POST', '/api/auth/cambiar-usuario', { token: t, body: { codigo: '0000' } })).status, 401);
  const frenado = await api('POST', '/api/auth/cambiar-usuario', { token: t, body: { codigo: '2468' } });
  assert.equal(frenado.status, 429);
});

test('terminales y sesiones: latido, estado de conexión y cierre forzado', async () => {
  await crearUsuario('admin6', { rol: 'admin' });
  await crearUsuario('nico');
  const tAdmin = await token('admin6');
  const term = await api('POST', '/api/terminales', { token: tAdmin, body: { nombre: 'Barra', tipo: 'pantalla_cocina', inactividad_min: 2 } });
  assert.equal(term.status, 201);
  assert.equal((await api('POST', '/api/terminales', { token: tAdmin, body: { nombre: 'Barra' } })).status, 400);
  assert.equal((await ingresar('nico', CLAVE, 'ZZZZZZZZ')).status, 400, 'terminal inexistente');

  const login = await ingresar('nico', CLAVE, term.json.codigo);
  assert.equal(login.json.inactividad_min, 2, 'la terminal manda sobre el rol');

  let lista = await api('GET', '/api/terminales', { token: tAdmin });
  const fila = lista.json.find((x) => x.nombre === 'Barra');
  assert.equal(fila.estado_conexion, 'en_linea');
  assert.equal(fila.sesiones_abiertas, 1);

  await pool.query("UPDATE terminales SET ultimo_contacto = DATE_SUB(NOW(), INTERVAL 10 MINUTE) WHERE nombre = 'Barra'");
  lista = await api('GET', '/api/terminales', { token: tAdmin });
  assert.equal(lista.json.find((x) => x.nombre === 'Barra').estado_conexion, 'sin_conexion');
  await api('POST', '/api/terminales/ping', { token: login.json.token });
  lista = await api('GET', '/api/terminales', { token: tAdmin });
  assert.equal(lista.json.find((x) => x.nombre === 'Barra').estado_conexion, 'en_linea');

  const sesiones = await api('GET', '/api/sesiones', { token: tAdmin });
  const sesion = sesiones.json.find((s) => s.username === 'nico');
  assert.equal(sesion.terminal, 'Barra');
  assert.equal((await api('POST', `/api/sesiones/${sesion.id}/cerrar`, { token: tAdmin })).status, 200);
  assert.equal((await api('GET', '/api/productos', { token: login.json.token })).status, 401);
  assert.equal((await api('POST', `/api/sesiones/${sesion.id}/cerrar`, { token: tAdmin })).status, 404);

  assert.equal((await api('PUT', `/api/terminales/${term.json.id}`, { token: tAdmin, body: { activa: false } })).status, 200);
  assert.equal((await ingresar('nico', CLAVE, term.json.codigo)).status, 400, 'terminal desactivada');
});
