// Ayudas de las pruebas. Cada archivo de prueba corre en su propio proceso y usa una base propia
// (chepola_test_<pid>_<hora>) que crea al empezar y borra al terminar.
//
// Las pruebas necesitan un MySQL/MariaDB DESCARTABLE: se conectan con DB_HOST, DB_USER,
// DB_PASSWORD y DB_PORT del entorno (o del .env). Por seguridad se niegan a correr contra un
// servidor que no sea local, salvo que se defina TEST_PERMITIR_REMOTO=1.
process.env.NODE_ENV = 'test';
process.env.INSTANCIAS_FILE = 'no-existe.json'; // la prueba usa la instancia única por defecto
process.env.LOG_LEVEL = 'error'; // las pruebas no ensucian logs/ ni la consola
require('dotenv').config();
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-pruebas';

const host = process.env.DB_HOST;
if (!['localhost', '127.0.0.1', '::1'].includes(host) && process.env.TEST_PERMITIR_REMOTO !== '1') {
  throw new Error(`Las pruebas crean y borran bases de datos y DB_HOST es "${host}". Usá un MySQL local o definí TEST_PERMITIR_REMOTO=1.`);
}

const DB_NAME = `chepola_test_${process.pid}_${Date.now()}`;
process.env.DB_NAME = DB_NAME;

const mysql = require('mysql2/promise');
const { migrar } = require('../src/db/migrador');

const conexion = () => ({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, port: Number(process.env.DB_PORT) || 3306,
});

const conectar = (database = DB_NAME) => mysql.createConnection({ ...conexion(), database, multipleStatements: true });

const borrarBase = async (nombre = DB_NAME) => {
  const admin = await mysql.createConnection(conexion());
  await admin.query(`DROP DATABASE IF EXISTS \`${nombre}\``);
  await admin.end();
};

const migrarBase = (nombre = DB_NAME) => migrar({ ...conexion(), database: nombre });

// Levanta la app de verdad (con la base de la prueba) en un puerto libre y devuelve un cliente HTTP.
// Por defecto la instancia queda dada de alta (código TST01), como después de `npm run alta`.
const iniciarApp = async ({ alta = true } = {}) => {
  await migrarBase();
  if (alta) {
    const c = await conectar();
    await c.query("INSERT INTO configuracion_instancia (id, codigo_instancia, razon_social, sucursal) VALUES (1, 'TST01', 'Prueba SA', 'Central')");
    await c.end();
  }
  const app = require('../src/server');
  const pool = require('../src/config/db');
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const api = async (metodo, ruta, { token, body, headers } = {}) => {
    const res = await fetch(`${base}${ruta}`, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...headers,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
  };

  const cerrar = async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await borrarBase();
  };
  return { api, pool, cerrar };
};

module.exports = { DB_NAME, conexion, conectar, borrarBase, migrarBase, iniciarApp };
