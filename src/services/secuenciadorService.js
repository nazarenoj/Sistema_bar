const crypto = require('crypto');
const pool = require('../config/db');

// Candado por clave "punto de venta : tipo : modalidad" con arrendamiento renovable (Ventas RN49, RN50).
// Una sola solicitud en vuelo por clave; las demás esperan hasta ESPERA_MS y, vencida la espera, se
// rechaza con CLAVE_OCUPADA (la pantalla ofrece CAEA o no fiscal, B8).
// shortcut: la espera es por sondeo (no FIFO estricto) y al vencer un arrendamiento ajeno no se consulta
// a ARCA antes de seguir (eso es B7); subir cuando haya intentos indeterminados.
const ARRENDAMIENTO_MS = 60000;
const RENOVAR_MS = 20000;
const ESPERA_MS = 10000;
const SONDEO_MS = 50;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const claveDe = ({ puntoVenta, tipo, modalidad = 'CAE' }) => `${puntoVenta}:${tipo}:${modalidad}`;

const conClave = async (k, trabajo, { esperaMs = ESPERA_MS, arrendamientoMs = ARRENDAMIENTO_MS, renovarMs = RENOVAR_MS } = {}) => {
  const clave = claveDe(k);
  const yo = crypto.randomUUID();
  await pool.query("INSERT IGNORE INTO secuenciador_claves (clave, estado, vence_ms) VALUES (?, 'libre', 0)", [clave]);

  const limite = Date.now() + esperaMs;
  for (;;) {
    const ahora = Date.now();
    const [r] = await pool.query(
      "UPDATE secuenciador_claves SET propietario = ?, estado = 'ocupada', vence_ms = ? WHERE clave = ? AND (estado = 'libre' OR (estado = 'ocupada' AND vence_ms < ?))",
      [yo, ahora + arrendamientoMs, clave, ahora]
    );
    if (r.affectedRows) break;
    // Una clave "resolviendo" (intento indeterminado) no se espera: se ofrece CAEA, otro punto de venta o no fiscal.
    const [[actual]] = await pool.query('SELECT estado FROM secuenciador_claves WHERE clave = ?', [clave]);
    if (actual?.estado === 'resolviendo') {
      const err = new Error('Esta clave está resolviendo un comprobante pendiente con ARCA: no se puede emitir con ella hasta resolverlo.');
      err.codigo = 'CLAVE_RESOLVIENDO';
      throw err;
    }
    if (ahora >= limite) {
      const err = new Error('Hay otra emisión en curso para este punto de venta y tipo de comprobante. Reintentá en unos segundos.');
      err.codigo = 'CLAVE_OCUPADA';
      throw err;
    }
    await dormir(SONDEO_MS);
  }

  // Mientras la solicitud sigue en curso se renueva el arrendamiento (RN50).
  const renovador = setInterval(() => {
    pool.query('UPDATE secuenciador_claves SET vence_ms = ? WHERE clave = ? AND propietario = ?', [Date.now() + arrendamientoMs, clave, yo]).catch(() => {});
  }, renovarMs);
  try {
    return await trabajo();
  } finally {
    clearInterval(renovador);
    await pool.query("UPDATE secuenciador_claves SET estado = 'libre', propietario = NULL WHERE clave = ? AND propietario = ?", [clave, yo]).catch(() => {});
  }
};

// Estado de las claves (para la pantalla de claves en "Resolviendo", RF47).
const listar = async () => (await pool.query('SELECT * FROM secuenciador_claves ORDER BY clave'))[0];

module.exports = { conClave, claveDe, listar, ARRENDAMIENTO_MS };
