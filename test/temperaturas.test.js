const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

const notificaciones = async (tipo) => (await pool.query("SELECT * FROM notificaciones WHERE tipo = ? AND estado <> 'resuelta'", [tipo]))[0];

test('Stock.RF25: la función STK-TEMP viene apagada y sus rutas se bloquean', async () => {
  const r = await api('GET', '/api/temperaturas/puntos', { token });
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'FUNCION_DESACTIVADA');
});

test('Stock.RF25/EX26: una lectura fuera de rango alerta y queda pendiente hasta cargar la acción correctiva', async () => {
  const act = await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['STK-TEMP'], motivo: 'prueba' } });
  assert.equal(act.status, 200, JSON.stringify(act.json));
  assert.equal(await require('../src/funciones/servicio').estaActiva('STK-TEMP'), true);

  assert.equal((await api('POST', '/api/temperaturas/puntos', { token, body: { nombre: 'X', rango_min: 8, rango_max: 2 } })).status, 400); // rango invertido
  const p = (await api('POST', '/api/temperaturas/puntos', { token, body: { nombre: 'Heladera 1', tipo: 'heladera', rango_min: 0, rango_max: 5, frecuencia_horas: 6 } })).json;
  assert.equal((await api('POST', '/api/temperaturas/puntos', { token, body: { nombre: 'Heladera 1', rango_min: 0, rango_max: 5 } })).status, 409);

  const ok = await api('POST', `/api/temperaturas/puntos/${p.id}/registros`, { token, body: { valor: 3.5 } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.fuera_de_rango, ok.json.accion_estado], [0, 'no_requiere']);
  assert.equal((await notificaciones('temperatura_fuera_de_rango')).length, 0);

  const mal = (await api('POST', `/api/temperaturas/puntos/${p.id}/registros`, { token, body: { valor: 9, origen: 'app' } })).json;
  assert.deepEqual([mal.fuera_de_rango, mal.accion_estado, mal.origen], [1, 'pendiente', 'app']);
  assert.equal((await notificaciones('temperatura_fuera_de_rango')).length, 1);
  assert.equal((await api('GET', '/api/temperaturas/registros?pendientes=1', { token })).json.length, 1);
  assert.equal((await api('GET', '/api/temperaturas/puntos', { token })).json[0].acciones_pendientes, 1);

  assert.equal((await api('POST', `/api/temperaturas/registros/${mal.id}/accion`, { token, body: { tipo: 'mover_mercaderia' } })).status, 400); // falta el detalle
  assert.equal((await api('POST', `/api/temperaturas/registros/${ok.json.id}/accion`, { token, body: { tipo: 'otra', detalle: 'x' } })).status, 409); // no la requería
  const acc = await api('POST', `/api/temperaturas/registros/${mal.id}/accion`, { token, body: { tipo: 'mover_mercaderia', detalle: 'Se pasó todo a la heladera 2' } });
  assert.equal(acc.status, 200, JSON.stringify(acc.json));
  assert.equal(acc.json.accion_estado, 'cargada');
  assert.equal((await notificaciones('temperatura_fuera_de_rango')).length, 0);
  assert.equal((await api('POST', `/api/temperaturas/registros/${mal.id}/accion`, { token, body: { tipo: 'otra', detalle: 'otra vez' } })).status, 409);
});

test('Stock.EX26: un punto sin registro pasada la frecuencia alerta como omitido y se cierra con la próxima lectura', async () => {
  const Temp = require('../src/stock/temperaturaService');
  const p = (await api('POST', '/api/temperaturas/puntos', { token, body: { nombre: 'Cámara 1', tipo: 'camara', rango_min: -2, rango_max: 4, frecuencia_horas: 2 } })).json;
  await pool.query('UPDATE puntos_control SET created_at = DATE_SUB(NOW(), INTERVAL 3 HOUR) WHERE id = ?', [p.id]);
  assert.equal((await api('GET', '/api/temperaturas/puntos', { token })).json.find((x) => x.id === p.id).omitido, true);
  await Temp.evaluar();
  assert.equal((await notificaciones('temperatura_omitida')).length, 1);
  await Temp.evaluar(); // no duplica
  assert.equal((await notificaciones('temperatura_omitida')).length, 1);
  await api('POST', `/api/temperaturas/puntos/${p.id}/registros`, { token, body: { valor: 1 } });
  assert.equal((await notificaciones('temperatura_omitida')).length, 0);
});

test('Stock.RF25: las listas de verificación exigen todas las respuestas y una observación en lo no cumplido', async () => {
  assert.equal((await api('POST', '/api/temperaturas/listas', { token, body: { nombre: 'Vacía', items: [] } })).status, 400);
  const l = (await api('POST', '/api/temperaturas/listas', { token, body: { nombre: 'Limpieza de apertura', tipo: 'limpieza', items: ['Mesadas sanitizadas', 'Piso limpio'] } })).json;
  assert.deepEqual(l.items, ['Mesadas sanitizadas', 'Piso limpio']);
  const url = `/api/temperaturas/listas/${l.id}/verificaciones`;
  assert.equal((await api('POST', url, { token, body: { respuestas: [{ ok: true }] } })).status, 400); // faltan ítems
  assert.equal((await api('POST', url, { token, body: { respuestas: [{ ok: true }, { ok: false }] } })).status, 400); // el no sin observación
  const v = await api('POST', url, { token, body: { respuestas: [{ ok: true }, { ok: false, observacion: 'Falta trapo' }] } });
  assert.equal(v.status, 201, JSON.stringify(v.json));
  assert.equal(v.json.completa, false);
  assert.equal((await api('POST', url, { token, body: { respuestas: [{ ok: true }, { ok: true }], origen: 'app' } })).json.completa, true);
});
