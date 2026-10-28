const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DB_NAME, conexion, conectar, borrarBase, migrarBase } = require('./ayudas');
const { leerMigraciones } = require('../src/db/migrador');

const bases = [];
const nombreNuevo = (sufijo) => { const n = `${DB_NAME}_${sufijo}`; bases.push(n); return n; };
after(async () => { for (const b of bases) await borrarBase(b); });

const VERSIONES = leerMigraciones().map((m) => m.version);

test('una base nueva recibe todas las migraciones y correrlo de nuevo no cambia nada', async () => {
  const base = nombreNuevo('nueva');
  assert.deepEqual(await migrarBase(base), VERSIONES);
  assert.deepEqual(await migrarBase(base), []);

  const conn = await conectar(base);
  const [reg] = await conn.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(reg.map((r) => r.version), VERSIONES);
  // Cosas que tienen que existir después de migrar todo.
  const [[{ n }]] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ? AND
     ((table_name = 'pedidos' AND column_name = 'metodo_pago') OR (table_name = 'users' AND column_name = 'pin_hash'))`, [base]);
  assert.equal(n, 2);
  await conn.end();
});

test('una base anterior al ejecutor se toma como si ya tuviera la 001 y recibe solo las siguientes', async () => {
  const base = nombreNuevo('vieja');
  const mysql = require('mysql2/promise');
  const raiz = await mysql.createConnection(conexion());
  await raiz.query(`CREATE DATABASE \`${base}\``);
  await raiz.end();

  // Se arma como la dejaba el autoaprovisionamiento anterior: el esquema de la 001 y nada más.
  const conn = await conectar(base);
  await conn.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'migraciones', '001_esquema_base.sql'), 'utf8'));
  await conn.query("INSERT INTO users (username, password_hash, rol) VALUES ('viejo', 'x', 'admin')");

  assert.deepEqual(await migrarBase(base), VERSIONES.filter((v) => v !== '001'));
  const [[u]] = await conn.query("SELECT activo, debe_cambiar_password FROM users WHERE username = 'viejo'");
  assert.equal(u.activo, 1); // el usuario existente sigue activo con las columnas nuevas
  assert.equal(u.debe_cambiar_password, 0);
  await conn.end();
});

test('una migración ya aplicada no se puede editar', async () => {
  const base = nombreNuevo('editada');
  await migrarBase(base);
  const conn = await conectar(base);
  await conn.query("UPDATE schema_migrations SET huella = REPEAT('0', 64) WHERE version = '002'");
  await conn.end();
  await assert.rejects(migrarBase(base), /002_pedidos_metodo_pago\.sql ya estaba aplicada/);
});

test('002 se puede volver a correr sobre una base que ya tenía la columna', async () => {
  const base = nombreNuevo('doble');
  await migrarBase(base);
  const conn = await conectar(base);
  await conn.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'migraciones', '002_pedidos_metodo_pago.sql'), 'utf8'));
  await conn.end();
});

test('alta-instancia: crea la base, la instancia y el administrador; es idempotente y protege el código', async () => {
  const base = nombreNuevo('alta');
  const correr = (extra) => spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'alta-instancia.js'),
    '--db', base, '--codigo', 'CHP01', '--razon-social', 'Chepola SRL', '--sucursal', 'Casa central',
    '--perfil', 'produccion_alimentos', '--admin-usuario', 'jefe', '--admin-password', 'clave-inicial-1', ...extra,
  ], { env: process.env, encoding: 'utf8' });

  const primera = correr([]);
  assert.equal(primera.status, 0, primera.stderr);

  const conn = await conectar(base);
  const [[cfg]] = await conn.query('SELECT * FROM configuracion_instancia');
  assert.equal(cfg.codigo_instancia, 'CHP01');
  assert.equal(cfg.perfil_rubro, 'produccion_alimentos');
  const [[adm]] = await conn.query("SELECT rol, debe_cambiar_password, password_hash FROM users WHERE username = 'jefe'");
  assert.equal(adm.rol, 'admin');
  assert.equal(adm.debe_cambiar_password, 1);
  assert.notEqual(adm.password_hash, 'clave-inicial-1');

  const segunda = correr([]);
  assert.equal(segunda.status, 0);
  assert.match(segunda.stdout, /ya estaba dada de alta/);
  const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM users WHERE username = ?', ['jefe']);
  assert.equal(n, 1);
  await conn.end();

  const otroCodigo = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'alta-instancia.js'),
    '--db', base, '--codigo', 'OTRO1', '--razon-social', 'X', '--sucursal', 'Y',
  ], { env: process.env, encoding: 'utf8' });
  assert.equal(otroCodigo.status, 1);
  assert.match(otroCodigo.stderr, /el código no se puede cambiar/);

  const codigoMalo = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'alta-instancia.js'),
    '--db', nombreNuevo('mala'), '--codigo', 'chp-01', '--razon-social', 'X', '--sucursal', 'Y',
  ], { env: process.env, encoding: 'utf8' });
  assert.equal(codigoMalo.status, 1);
  assert.match(codigoMalo.stderr, /--codigo es obligatorio/);
});
