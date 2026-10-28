const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DB_NAME, borrarBase } = require('./ayudas');

const BASE_A = `${DB_NAME}_a`;
const BASE_B = `${DB_NAME}_b`;
const archivo = path.join(os.tmpdir(), `instancias_${process.pid}.json`);
let api, cerrar;

const alta = (db, codigo) => {
  const r = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'alta-instancia.js'),
    '--db', db, '--codigo', codigo, '--razon-social', `Cliente ${codigo}`, '--sucursal', 'Central',
    '--admin-usuario', 'jefe', '--admin-password', 'clave-inicial-1', '--registrar', '--hosts', `${codigo.toLowerCase()}.local`,
  ], { env: { ...process.env, INSTANCIAS_FILE: archivo }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};

before(async () => {
  alta(BASE_A, 'AAA1');
  alta(BASE_B, 'BBB1');
  process.env.INSTANCIAS_FILE = archivo;
  const app = require('../src/server');
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  api = async (metodo, ruta, { token, body, instancia } = {}) => {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...(instancia && { 'X-Instancia': instancia }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  cerrar = async () => {
    await new Promise((res) => server.close(res));
    await require('../src/config/db').end();
    await borrarBase(BASE_A); await borrarBase(BASE_B);
    fs.rmSync(archivo, { force: true });
  };
});
after(async () => { await cerrar(); });

const entrar = (instancia, password = 'clave-inicial-1') => api('POST', '/api/auth/login', { instancia, body: { username: 'jefe', password } });

test('con varias instancias hay que identificar cuál; una desconocida se rechaza', async () => {
  assert.equal((await api('POST', '/api/auth/login', { body: { username: 'jefe', password: 'x' } })).status, 404);
  assert.equal((await entrar('NOEXISTE')).status, 404);
  assert.equal((await entrar('AAA1')).status, 200);
});

test('dos instancias operan a la vez sin verse los datos', async () => {
  const a = (await entrar('AAA1')).json.token;
  const b = (await entrar('BBB1')).json.token;
  for (const [t, i] of [[a, 'AAA1'], [b, 'BBB1']]) {
    const cp = await api('POST', '/api/auth/cambiar-password', { token: t, instancia: i, body: { actual: 'clave-inicial-1', nueva: 'otra-clave-123' } });
    assert.equal(cp.status, 200, JSON.stringify(cp.json));
  }
  const crear = await api('POST', '/api/usuarios', { token: a, instancia: 'AAA1', body: { username: 'solo_en_a', password: 'clave-larga-1', rol: 'empleado' } });
  assert.equal(crear.status, 201, JSON.stringify(crear.json));
  const enA = (await api('GET', '/api/usuarios', { token: a, instancia: 'AAA1' })).json.map((u) => u.username);
  const enB = (await api('GET', '/api/usuarios', { token: b, instancia: 'BBB1' })).json.map((u) => u.username);
  assert.ok(enA.includes('solo_en_a'));
  assert.ok(!enB.includes('solo_en_a'));
});

test('un token de una instancia no sirve en otra, aunque se pida la otra por cabecera', async () => {
  const a = (await entrar('AAA1', 'otra-clave-123')).json.token;
  assert.equal((await api('GET', '/api/usuarios', { token: a, instancia: 'BBB1' })).status, 401);
  assert.equal((await api('GET', '/api/usuarios', { token: a, instancia: 'AAA1' })).status, 200);
});
