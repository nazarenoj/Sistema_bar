// Aplica las migraciones pendientes a una base: node scripts/migrar.js [--db nombre]
// Sin --db usa DB_NAME del .env. Correrlo de nuevo no cambia nada.
require('dotenv').config();
const { migrar } = require('../src/db/migrador');

const i = process.argv.indexOf('--db');
const database = i > -1 ? process.argv[i + 1] : process.env.DB_NAME;
if (!database) { console.error('Falta --db o DB_NAME.'); process.exit(1); }

migrar({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, port: process.env.DB_PORT, database,
}).then((nuevas) => {
  console.log(nuevas.length ? `Base "${database}": aplicadas ${nuevas.join(', ')}.` : `Base "${database}": ya estaba al día.`);
}).catch((err) => { console.error(`Falló: ${err.message}`); process.exit(1); });
