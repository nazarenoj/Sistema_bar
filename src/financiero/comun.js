// Piezas comunes de Financiero: el error de negocio, el redondeo a centavos y el registro de un movimiento de fondos.
const { idGlobal } = require('../utils/idGlobal');

class FinInvalido extends Error {}
const invalida = (mensaje, status = 400, extra = {}) => Object.assign(new FinInvalido(mensaje), { status, ...extra });

const r2 = (x) => Math.round(Number(x) * 100) / 100;
const cts = (x) => Math.round(Number(x) * 100);

// Manejador común de las rutas: un error de negocio responde con su estado y código; lo demás lo atiende el errorHandler.
const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof FinInvalido) return res.status(err.status ?? 400).json({ error: err.message, ...(err.codigo && { codigo: err.codigo }), ...(err.detalle && { detalle: err.detalle }) });
    next(err);
  }
};

// Graba un movimiento (RN02): una sola caja o cuenta, importe con signo. Lo llama cada operación dentro de su transacción (`conn`).
const movimiento = async (conn, m) => {
  const [r] = await conn.query(
    `INSERT INTO fin_movimientos (id_global, cuenta_id, turno_id, tipo, importe, moneda, importe_divisa, cotizacion, categoria_id, forma_pago, referencia_externa,
       id_operacion, linea, doc_id_global, vinculo_id, motivo, marcas, en_espera, user_id, fecha_ms, terminal_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [await idGlobal(), m.cuentaId, m.turnoId ?? null, m.tipo, r2(m.importe), m.moneda ?? 'ARS', m.importeDivisa ?? null, m.cotizacion ?? null, m.categoriaId ?? null,
      m.formaPago ?? null, m.referenciaExterna ?? null, m.idOperacion ?? null, m.linea ?? 0, m.docIdGlobal ?? null, m.vinculoId ?? null,
      m.motivo ? String(m.motivo).slice(0, 255) : null, m.marcas ?? null, m.enEspera ? 1 : 0, m.userId ?? null, m.fechaMs ?? Date.now(), m.terminalId ?? null]
  );
  return r.insertId;
};

// ¿La persona de la request tiene la acción permitida? (para decidir qué datos mostrar, sin cortar la request).
const puede = async (req, permiso) => {
  const { permisosDe } = require('../middleware/requierePermiso');
  return (await permisosDe(req)).niveles[permiso] === 'permitido';
};

module.exports = { FinInvalido, invalida, r2, cts, manejar, movimiento, puede };
