const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DB_NAME, borrarBase } = require('./ayudas');

// Ventas Online RN01: la tienda pública de una instancia no lee datos de otra. Dos instancias reales, cada una con su base, su tienda y su catálogo.
const BASE_A = `${DB_NAME}_oa`;
const BASE_B = `${DB_NAME}_ob`;
const archivo = path.join(os.tmpdir(), `instancias_online_${process.pid}.json`);
let api, cerrar, tokens = {};

const alta = (db, codigo) => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'alta-instancia.js'), '--db', db, '--codigo', codigo, '--razon-social', `Cliente ${codigo}`, '--sucursal', 'Central',
    '--admin-usuario', 'jefe', '--admin-password', 'clave-inicial-1', '--registrar', '--hosts', `${codigo.toLowerCase()}.local`], { env: { ...process.env, INSTANCIAS_FILE: archivo }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};

before(async () => {
  alta(BASE_A, 'AAA1');
  alta(BASE_B, 'BBB1');
  // El administrador del alta recibe el rol Administrador (con todos los permisos de cada módulo).
  const mysql = require('mysql2/promise');
  for (const db of [BASE_A, BASE_B]) {
    const cx = await mysql.createConnection({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, port: Number(process.env.DB_PORT), database: db });
    await cx.query("INSERT IGNORE INTO usuario_roles (user_id, rol_id) SELECT u.id, r.id FROM users u JOIN roles r ON r.codigo = 'administrador' WHERE u.username = 'jefe'");
    await cx.query("UPDATE users SET debe_cambiar_password = 0 WHERE username = 'jefe'");
    await cx.end();
  }
  process.env.INSTANCIAS_FILE = archivo;
  const app = require('../src/server');
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  api = async (metodo, ruta, { token, body, instancia } = {}) => {
    const r = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...(instancia && { 'X-Instancia': instancia }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  cerrar = async () => {
    await new Promise((res) => server.close(res));
    await require('../src/config/db').end();
    await borrarBase(BASE_A); await borrarBase(BASE_B);
    fs.rmSync(archivo, { force: true });
  };
  for (const [i, nombre, codigo, producto, precio] of [['AAA1', 'Cafe A', 'tienda-a', 'Medialuna A', 500], ['BBB1', 'Cafe B', 'tienda-b', 'Scon B', 700]]) {
    tokens[i] = (await api('POST', '/api/auth/login', { instancia: i, body: { username: 'jefe', password: 'clave-inicial-1' } })).json.token;
    const t = tokens[i];
    const ins = await api('POST', '/api/modulos/ventas_online/instalar', { instancia: i, token: t });
    assert.equal(ins.status, 200, JSON.stringify(ins.json));
    const p = (await api('POST', '/api/productos', { instancia: i, token: t, body: { nombre: producto, precio, stock: 10 } })).json;
    const c = await api('PUT', '/api/ventas-online/tienda', { instancia: i, token: t, body: { codigo, nombre, razon_social: `${nombre} SA`, cuit: '30711111111', domicilio: 'Mitre 1', activa: true,
      horarios: Object.fromEntries(['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'].map((d) => [d, [{ desde: '00:00', hasta: '23:59' }]])) } });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal((await api('PUT', `/api/ventas-online/catalogo/${p.id}`, { instancia: i, token: t, body: { categoria_online: 'Menu' } })).status, 200);
    await api('POST', '/api/ventas-online/sincronizar', { instancia: i, token: t });
  }
});
after(async () => { await cerrar(); });

test('Ventas Online.RN01: cada tienda responde solo en su instancia y no se ve la de otra', async () => {
  assert.equal((await api('GET', '/tienda/tienda-a', { instancia: 'AAA1' })).json.nombre, 'Cafe A');
  assert.equal((await api('GET', '/tienda/tienda-b', { instancia: 'BBB1' })).json.nombre, 'Cafe B');
  // El código de la tienda identifica la instancia (RN01): aunque la pidan con la cabecera de otra, responde la suya y nunca mezcla datos.
  assert.equal((await api('GET', '/tienda/tienda-b', { instancia: 'AAA1' })).json.nombre, 'Cafe B');
  assert.equal((await api('GET', '/tienda/tienda-a', { instancia: 'BBB1' })).json.nombre, 'Cafe A');
  assert.equal((await api('GET', '/tienda/tienda-c', { instancia: 'AAA1' })).status, 404);
});

test('Ventas Online.RN01: el catálogo y los pedidos de una instancia no aparecen en la otra', async () => {
  const a = (await api('GET', '/tienda/tienda-a/catalogo', { instancia: 'AAA1' })).json;
  const b = (await api('GET', '/tienda/tienda-b/catalogo', { instancia: 'AAA1' })).json; // aun con la cabecera de A, la tienda B responde con lo de B
  assert.deepEqual(a.map((x) => x.titulo), ['Medialuna A']);
  assert.deepEqual(b.map((x) => x.titulo), ['Scon B']);
  // Un carrito de A no existe para B aunque se conozca su token.
  const carrito = (await api('POST', '/tienda/tienda-a/carrito', { instancia: 'AAA1', body: { producto_id: a[0].id, cantidad: 1 } })).json;
  assert.ok(carrito.token);
  assert.equal((await api('GET', `/tienda/tienda-b/carrito/${carrito.token}`, { instancia: 'BBB1' })).status, 404);
  // El panel de cada una ve solo lo suyo.
  const panelA = (await api('GET', '/api/ventas-online/pedidos', { instancia: 'AAA1', token: tokens.AAA1 })).json;
  const panelB = (await api('GET', '/api/ventas-online/pedidos', { instancia: 'BBB1', token: tokens.BBB1 })).json;
  assert.ok(Array.isArray(panelA) && Array.isArray(panelB));
  assert.equal(panelB.length, 0);
  // La sesión de una instancia no sirve en la otra.
  assert.equal((await api('GET', '/api/ventas-online/tienda', { instancia: 'BBB1', token: tokens.AAA1 })).status, 401);
});
