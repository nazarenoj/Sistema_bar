const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const DIR_MIGRACIONES = path.join(__dirname, '..', '..', 'database', 'migraciones');
const BASELINE = '001';

// Se ignora el fin de línea al calcular la huella: el mismo archivo pesa distinto con CRLF (Windows)
// que con LF (Linux/Hostinger) y no por eso cambió.
const huella = (sql) => crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

const leerMigraciones = () =>
  fs.readdirSync(DIR_MIGRACIONES)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort()
    .map((archivo) => {
      const sql = fs.readFileSync(path.join(DIR_MIGRACIONES, archivo), 'utf8');
      return { version: archivo.slice(0, 3), archivo, sql, huella: huella(sql) };
    });

// Crea la base (si no existe) y le aplica, en orden, las migraciones que todavía no tiene.
// Es idempotente: correrlo dos veces seguidas no cambia nada. Devuelve las versiones aplicadas.
//
// - Una base de antes del ejecutor (tiene `users` pero no `schema_migrations`) se toma como si ya
//   tuviera la 001: el autoaprovisionamiento anterior le había aplicado ese mismo esquema.
// - Una migración ya aplicada no se puede editar: si cambió su huella, se aborta. Los cambios van
//   siempre en una migración nueva.
// - El DDL de MySQL no es transaccional: si una migración falla a mitad no queda registrada y se
//   vuelve a correr entera, por eso cada archivo tiene que poder re-ejecutarse (ver 002).
// - Un candado nombrado evita que dos procesos migren la misma base a la vez.
const migrar = async ({ host, user, password, port, database }) => {
  const base = { host, user, password, port: Number(port) || 3306 };

  const admin = await mysql.createConnection(base);
  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await admin.end();
  }

  const conn = await mysql.createConnection({ ...base, database, multipleStatements: true });
  const lockName = `chepola_migraciones_${database}`;
  try {
    const [[{ ok }]] = await conn.query('SELECT GET_LOCK(?, 60) AS ok', [lockName]);
    if (!ok) throw new Error(`No se pudo obtener el candado de migraciones de "${database}" (otro proceso migrando).`);

    const [[{ n: tieneRegistro }]] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = 'schema_migrations'`,
      [database]
    );
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version     CHAR(3)      NOT NULL PRIMARY KEY,
      archivo     VARCHAR(120) NOT NULL,
      huella      CHAR(64)     NOT NULL,
      aplicada_en TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
    )`);

    const migraciones = leerMigraciones();
    const registrar = (m) =>
      conn.query('INSERT INTO schema_migrations (version, archivo, huella) VALUES (?, ?, ?)', [m.version, m.archivo, m.huella]);

    if (!tieneRegistro) {
      const [[{ n: tieneUsers }]] = await conn.query(
        `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = 'users'`,
        [database]
      );
      if (tieneUsers) await registrar(migraciones.find((m) => m.version === BASELINE));
    }

    const [aplicadasRows] = await conn.query('SELECT version, huella FROM schema_migrations');
    const aplicadas = new Map(aplicadasRows.map((r) => [r.version, r.huella]));

    const nuevas = [];
    for (const m of migraciones) {
      if (aplicadas.has(m.version)) {
        if (aplicadas.get(m.version) !== m.huella)
          throw new Error(`La migración ${m.archivo} ya estaba aplicada y su contenido cambió. Los cambios van en una migración nueva.`);
        continue;
      }
      try {
        await conn.query(m.sql);
      } catch (err) {
        err.message = `Migración ${m.archivo}: ${err.message}`;
        throw err;
      }
      await registrar(m);
      nuevas.push(m.version);
    }
    return nuevas;
  } finally {
    await conn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
    await conn.end();
  }
};

module.exports = { migrar, leerMigraciones };
