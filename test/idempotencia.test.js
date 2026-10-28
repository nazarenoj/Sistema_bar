const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('jefe', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'jefe', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

const alta = (id, username = 'ana', extra = {}) =>
  api('POST', '/api/usuarios', { token, headers: id && { 'X-ID-Solicitud': id }, body: { username, password: 'clave-larga-2', rolIds: [1], ...extra } });
const cuantos = async (u) => (await pool.query('SELECT COUNT(*) AS n FROM users WHERE username = ?', [u]))[0][0].n;

test('Usuarios.RN70: un reintento con la misma clave y el mismo contenido devuelve el resultado original sin repetir el efecto', async () => {
  const primera = await alta('solicitud-0001');
  assert.equal(primera.status, 201);
  const resultados = [];
  for (let i = 0; i < 5; i++) resultados.push(await alta('solicitud-0001'));
  for (const r of resultados) {
    assert.equal(r.status, 201);
    assert.deepEqual(r.json, primera.json);
    assert.equal(r.headers.get('idempotency-replayed'), 'true');
  }
  assert.equal(await cuantos('ana'), 1);
});

test('Usuarios.EX49: el doble clic (dos envíos a la vez con la misma clave) produce un solo efecto', async () => {
  const [a, b] = await Promise.all([alta('solicitud-0002', 'beto'), alta('solicitud-0002', 'beto')]);
  assert.equal(await cuantos('beto'), 1);
  const estados = [a.status, b.status].sort();
  assert.ok(estados[0] === 201 && [201, 409].includes(estados[1]), JSON.stringify(estados));
  if (estados[1] === 409) assert.equal([a, b].find((r) => r.status === 409).json.codigo, 'EN_PROCESO');
});

test('Usuarios.EX48: la misma clave con otro contenido se rechaza como conflicto, no ejecuta nada y queda auditado', async () => {
  assert.equal((await alta('solicitud-0003', 'carla')).status, 201);
  const conflicto = await alta('solicitud-0003', 'dora');
  assert.equal(conflicto.status, 409);
  assert.equal(conflicto.json.codigo, 'CONFLICTO_IDEMPOTENCIA');
  assert.equal(await cuantos('dora'), 0);
  const [aud] = await pool.query("SELECT resultado, entidad_id FROM auditoria WHERE modulo = 'idempotencia' AND accion = 'conflicto'");
  assert.deepEqual(aud.map((a) => [a.resultado, a.entidad_id]), [['denegado', 'solicitud-0003']]);
});

test('Usuarios.RN71/EX47: el origen consulta el estado por la clave antes de reenviar', async () => {
  const consulta = (id) => api('GET', `/api/solicitudes/${id}`, { token });
  assert.equal((await consulta('solicitud-nunca-vista')).json.estado, 'desconocida');
  await alta('solicitud-0004', 'eva');
  const r = (await consulta('solicitud-0004')).json;
  assert.equal(r.estado, 'procesada');
  assert.equal(r.status, 201);
  // Una operación rechazada también queda registrada, con su motivo.
  const mala = await alta('solicitud-0005', 'x');
  assert.equal(mala.status, 400);
  assert.equal((await consulta('solicitud-0005')).json.estado, 'rechazada');
});

test('un rechazo por permisos no gasta la clave: se puede reintentar con la autorización', async () => {
  const [r] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('mozo1', ?, 'empleado')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query("INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = 'barista'", [r.insertId]);
  const t = (await api('POST', '/api/auth/login', { body: { username: 'mozo1', password: 'clave-larga-1' } })).json.token;
  const intento = () => api('POST', '/api/usuarios', { token: t, headers: { 'X-ID-Solicitud': 'solicitud-0006' }, body: { username: 'fede', password: 'clave-larga-2', rolIds: [1] } });
  assert.equal((await intento()).status, 403);
  assert.equal((await api('GET', '/api/solicitudes/solicitud-0006', { token })).json.estado, 'desconocida');
});

test('Usuarios.RN69: las operaciones de cobro no se aceptan sin clave y las claves mal formadas se rechazan', async () => {
  const sin = await api('POST', '/api/mesas/1/cerrar', { token, body: { metodo_pago: 'efectivo' } });
  assert.equal(sin.status, 400);
  assert.equal(sin.json.codigo, 'FALTA_ID_SOLICITUD');
  assert.equal((await alta('corta')).status, 400);
  assert.equal((await alta('con espacios y símbolos!')).status, 400);
});

test('Usuarios.RN70: las solicitudes vencidas se purgan y las vigentes se conservan', async () => {
  await pool.query("UPDATE solicitudes_procesadas SET vence_ms = 1 WHERE id_solicitud = 'solicitud-0001'");
  const purgar = require('../src/middleware/idempotencia').purgarVencidas;
  assert.equal(await purgar(), 1);
  assert.equal((await api('GET', '/api/solicitudes/solicitud-0004', { token })).json.estado, 'procesada');
});
