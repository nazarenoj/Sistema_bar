// Registro de instancias (A1). Cada instancia es una base de datos propia (Usuarios RN22, RN79).
// Se define en `instancias.json` (ruta cambiable con INSTANCIAS_FILE; no se versiona):
//   [{ "codigo": "CHP01", "db": "chepola_chp01", "hosts": ["chp01.ejemplo.com"],
//      "afip": { "cuit": "20...", "entorno": "produccion", "certPath": "...", "keyPath": "..." } }]
// "dbHost", "dbUser", "dbPassword" y "dbPort" son opcionales (por defecto, los del .env).
// Sin archivo, hay una sola instancia "DEFAULT" que usa DB_NAME y las AFIP_* del .env: así la
// instalación actual sigue andando igual.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('async_hooks');
const { migrar } = require('../db/migrador');
const afipDesdeEnv = require('../config/afipEnv');

const als = new AsyncLocalStorage();
const instancias = new Map(); // codigo -> { codigo, db, hosts, conexion, afip, pool }

const CODIGO_RE = /^[A-Z0-9]{2,10}$/;

const archivo = () => path.resolve(process.env.INSTANCIAS_FILE || 'instancias.json');

const cargar = () => {
  instancias.clear();
  let lista;
  if (fs.existsSync(archivo())) {
    lista = JSON.parse(fs.readFileSync(archivo(), 'utf8'));
    if (!Array.isArray(lista) || !lista.length) throw new Error('instancias.json debe ser una lista con al menos una instancia.');
  } else {
    lista = [{ codigo: 'DEFAULT', db: process.env.DB_NAME }];
  }
  for (const i of lista) {
    if (i.codigo !== 'DEFAULT' && !CODIGO_RE.test(i.codigo || '')) throw new Error(`Código de instancia inválido: "${i.codigo}" (2 a 10 caracteres A-Z0-9).`);
    if (!i.db) throw new Error(`La instancia ${i.codigo} no tiene "db".`);
    if (instancias.has(i.codigo)) throw new Error(`Código de instancia repetido: ${i.codigo}.`);
    if ([...instancias.values()].some((x) => x.db === i.db && x.conexion.host === (i.dbHost || process.env.DB_HOST)))
      throw new Error(`Dos instancias comparten la base "${i.db}".`);
    instancias.set(i.codigo, {
      codigo: i.codigo, db: i.db, hosts: (i.hosts || []).map((h) => h.toLowerCase()),
      conexion: {
        host: i.dbHost || process.env.DB_HOST, user: i.dbUser || process.env.DB_USER,
        password: i.dbPassword ?? process.env.DB_PASSWORD, port: Number(i.dbPort || process.env.DB_PORT) || 3306,
      },
      afip: afipDesdeEnv(i.afip),
      pool: null,
    });
  }
};

const poolDe = (inst) => {
  if (!inst.pool) {
    inst.pool = mysql.createPool({ ...inst.conexion, database: inst.db, waitForConnections: true, connectionLimit: 10, queueLimit: 0 });
  }
  return inst.pool;
};

const listar = () => { if (!instancias.size) cargar(); return [...instancias.values()]; };

const predeterminada = () => { const l = listar(); return l.length === 1 ? l[0] : null; };

// Instancia de una request: cabecera X-Instancia, o el host. Una instalación con una sola
// instancia no necesita ninguna de las dos.
const resolver = (req) => {
  const l = listar();
  const cod = String(req.headers['x-instancia'] || '').trim().toUpperCase();
  if (cod) return l.find((i) => i.codigo === cod) || null;
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  return l.find((i) => i.hosts.includes(host)) || predeterminada();
};

// Crea las bases que falten y aplica las migraciones pendientes a TODAS las instancias (A2).
const migrarTodas = async () => {
  for (const i of listar()) await migrar({ ...i.conexion, database: i.db });
};

const actual = () => als.getStore() || predeterminada();
const dentroDe = (inst, fn) => als.run(inst, fn);

const cerrarTodas = async () => {
  for (const i of instancias.values()) if (i.pool) { await i.pool.end(); i.pool = null; }
};

module.exports = { listar, resolver, migrarTodas, actual, dentroDe, poolDe, cerrarTodas, recargar: cargar };
