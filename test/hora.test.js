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

const desvios = async () => (await pool.query("SELECT * FROM notificaciones WHERE tipo = 'desvio_hora'"))[0];

test('Usuarios.EX14: un equipo con el reloj desviado dispara alerta y auditoría, y la hora guardada sigue siendo la del servidor', async () => {
  const enHora = await api('GET', '/api/funciones', { token, headers: { 'X-Hora-Cliente': String(Date.now() + 20000) } });
  assert.equal(enHora.status, 200);
  assert.equal((await desvios()).length, 0); // 20 s de diferencia está dentro de lo tolerado

  const mal = Date.now() - 3 * 3600000; // el reloj atrasa 3 horas
  const antes = Date.now();
  await api('GET', '/api/funciones', { token, headers: { 'X-Hora-Cliente': String(mal) } });
  await api('GET', '/api/funciones', { token, headers: { 'X-Hora-Cliente': String(mal) } }); // no repite el aviso
  const [alerta] = await desvios();
  assert.equal(alerta.severidad, 'media');
  assert.match(alerta.mensaje, /Los documentos usan la hora del servidor/);
  assert.equal((await desvios()).length, 1);
  const [aud] = await pool.query("SELECT ts_ms, detalle FROM auditoria WHERE accion = 'desvio_hora_equipo'");
  assert.equal(aud.length, 1);
  assert.match(aud[0].detalle, /difiere -10\d{3} s/);
  // El evento queda con la hora del servidor, no con la del equipo.
  assert.ok(Number(aud[0].ts_ms) >= antes && Number(aud[0].ts_ms) <= Date.now());
});

test('Usuarios.RN21: ningún documento toma la hora del navegador', async () => {
  const fs = require('fs');
  const path = require('path');
  // El único lugar del servidor que lee X-Hora-Cliente es el detector de desvío.
  const usos = [];
  const recorrer = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) return recorrer(f);
    if (e.name.endsWith('.js') && /x-hora-cliente/i.test(fs.readFileSync(f, 'utf8'))) usos.push(path.relative(path.join(__dirname, '..', 'src'), f).split(path.sep).join('/'));
  });
  recorrer(path.join(__dirname, '..', 'src'));
  assert.deepEqual(usos, ['middleware/horaCliente.js']);
});

test('Usuarios.EX13: con el disco por encima del 85 % se emite una alerta crítica anticipada, que se resuelve al liberar espacio', async () => {
  const { revisarDisco } = require('../src/mensajeria/trabajador');
  assert.equal(await revisarDisco(async () => ({ bavail: 10, blocks: 100 })), 90);
  let [[a]] = await pool.query("SELECT severidad, estado FROM notificaciones WHERE clave = 'disco-lleno'");
  assert.deepEqual([a.severidad, a.estado], ['critica', 'nueva']);
  assert.equal(await revisarDisco(async () => ({ bavail: 10, blocks: 100 })), 90); // no duplica la alerta
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE clave = 'disco-lleno'"))[0][0].n, 1);

  assert.equal(await revisarDisco(async () => ({ bavail: 60, blocks: 100 })), 40);
  [[a]] = await pool.query("SELECT estado FROM notificaciones WHERE clave = 'disco-lleno'");
  assert.equal(a.estado, 'resuelta');
});

test('Usuarios.RN70/EX48: un conflicto de idempotencia alerta al Administrador con severidad alta', async () => {
  const alta = (username) => api('POST', '/api/usuarios', { token, headers: { 'X-ID-Solicitud': 'solicitud-conflicto-1' }, body: { username, password: 'clave-larga-2', rolIds: [1] } });
  assert.equal((await alta('ana')).status, 201);
  assert.equal((await alta('beto')).status, 409);
  const [[a]] = await pool.query("SELECT severidad, roles_destinatarios FROM notificaciones WHERE tipo = 'conflicto_idempotencia'");
  assert.deepEqual([a.severidad, a.roles_destinatarios], ['alta', ',administrador,']);
});
