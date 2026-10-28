// Alta de una instancia (una sucursal de un cliente) con un solo comando:
//   node scripts/alta-instancia.js --db chepola_cliente1 --codigo CHP01 \
//     --razon-social "Cafetería Chepola SRL" --sucursal "Casa central" \
//     [--cuit 30712345678] [--perfil cafeteria] [--admin-usuario admin] [--admin-password ...]
//     [--registrar [--hosts chp01.ejemplo.com,otro.com]]   (la anota en instancias.json)
// Crea la base, aplica todas las migraciones, guarda los datos de la instancia y crea al primer
// Administrador (con cambio de contraseña obligatorio en el primer ingreso). Si no se pasa
// --admin-password se genera una al azar y se muestra una sola vez.
// Se conecta con DB_HOST/DB_USER/DB_PASSWORD/DB_PORT del .env.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { migrar } = require('../src/db/migrador');
const Funciones = require('../src/funciones/servicio');

const PERFILES = ['cafeteria', 'produccion_alimentos', 'cafeteria_produccion_propia', 'personalizado'];

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);

const falla = (msg) => { console.error(`Error: ${msg}`); process.exit(1); };

const database = args.db;
const codigo = args.codigo;
const razonSocial = args['razon-social'];
const sucursal = args.sucursal;
const cuit = args.cuit || null;
const perfil = args.perfil || 'cafeteria';
const adminUsuario = args['admin-usuario'] || 'admin';

if (!database || !/^[A-Za-z0-9_]{1,64}$/.test(database)) falla('--db es obligatorio (letras, números y _).');
if (!codigo || !/^[A-Z0-9]{2,10}$/.test(codigo)) falla('--codigo es obligatorio: 2 a 10 caracteres A-Z o 0-9 (es el prefijo de todos los ID_Global y no se puede cambiar después).');
if (!razonSocial) falla('--razon-social es obligatorio.');
if (!sucursal) falla('--sucursal es obligatorio.');
if (cuit && !/^\d{11}$/.test(cuit)) falla('--cuit debe tener 11 dígitos, sin guiones.');
if (!PERFILES.includes(perfil)) falla(`--perfil debe ser uno de: ${PERFILES.join(', ')}.`);

const generada = !args['admin-password'];
const adminPassword = args['admin-password'] || crypto.randomBytes(9).toString('base64url');
if (adminPassword.length < 8) falla('--admin-password debe tener al menos 8 caracteres.');

// Anota la instancia en instancias.json (lo que la app lee para saber a qué base ir). Repetirlo no duplica.
const registrar = () => {
  const archivo = path.resolve(process.env.INSTANCIAS_FILE || 'instancias.json');
  const lista = fs.existsSync(archivo) ? JSON.parse(fs.readFileSync(archivo, 'utf8')) : [];
  if (lista.some((i) => i.codigo === codigo)) return console.log(`${codigo} ya figuraba en ${archivo}.`);
  const hosts = args.hosts ? args.hosts.split(',').map((h) => h.trim()).filter(Boolean) : [];
  fs.writeFileSync(archivo, JSON.stringify([...lista, { codigo, db: database, hosts }], null, 2) + '\n');
  console.log(`${codigo} anotada en ${archivo}.`);
};

(async () => {
  const conexion = {
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT, database,
  };
  const nuevas = await migrar(conexion);

  const conn = await mysql.createConnection({ ...conexion, port: Number(conexion.port) || 3306 });
  try {
    const [filas] = await conn.query('SELECT codigo_instancia, version_configuracion FROM configuracion_instancia WHERE id = 1');
    if (filas.length) {
      if (filas[0].codigo_instancia !== codigo)
        falla(`la base "${database}" ya es la instancia ${filas[0].codigo_instancia}; el código no se puede cambiar.`);
      // Una alta que se cortó antes de cargar las funciones se completa; si no, no se toca nada.
      if (filas[0].version_configuracion === 0) {
        const r = await Funciones.aplicarPerfil(conn, perfil, { username: 'alta' }, 'alta');
        if (!r.ok) throw new Error(r.error);
        console.log(`Se cargaron las funciones del perfil ${perfil}.`);
      }
      console.log(`La instancia ${codigo} ya estaba dada de alta en "${database}". No se modificó nada más.`);
      return;
    }
    // Una sola transacción: si falla el administrador no queda la instancia a medio dar de alta.
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO configuracion_instancia (id, codigo_instancia, razon_social, cuit, sucursal, perfil_rubro)
       VALUES (1, ?, ?, ?, ?, ?)`,
      [codigo, razonSocial, cuit, sucursal, perfil]
    );
    const [admin] = await conn.query(
      `INSERT INTO users (username, password_hash, rol, nombre, debe_cambiar_password)
       VALUES (?, ?, 'admin', 'Administrador', 1)`,
      [adminUsuario, await bcrypt.hash(adminPassword, 10)]
    );
    await conn.query("INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = 'administrador'", [admin.insertId]);
    await conn.commit();
    // El perfil de rubro pre-carga las funciones activables (Usuarios RN29): versión 1 de la configuración.
    // Va aparte porque abre su propia transacción; si se corta, volver a correr el alta lo completa.
    const r = await Funciones.aplicarPerfil(conn, perfil, { username: 'alta' }, 'alta');
    if (!r.ok) throw new Error(r.error);
  } finally {
    await conn.end();
  }

  if (args.registrar !== undefined) registrar();
  console.log(`Instancia ${codigo} creada en la base "${database}" (migraciones aplicadas: ${nuevas.join(', ') || 'ninguna nueva'}).`);
  console.log(`Administrador: ${adminUsuario}`);
  if (generada) console.log(`Contraseña inicial (se muestra una sola vez): ${adminPassword}`);
  console.log('Debe cambiarla en el primer ingreso. Perfil de rubro aplicado: ' + perfil + '.');
})().catch((err) => falla(err.message));
