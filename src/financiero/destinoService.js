const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const Cuentas = require('./cuentaService');
const { invalida, r2 } = require('./comun');

// Qué formas de pago llegan a una caja o cuenta (Financiero RF02). Algunas no mueven fondos: el cobro a cuenta corriente es una deuda del
// cliente (Clientes) y el vale o gift card es un canje, no un ingreso (Ventas RN77).
const NO_FONDOS = new Set(['cuenta_corriente', 'vale']);

const listar = async () => {
  const [filas] = await pool.query(
    `SELECT d.*, f.nombre AS forma_nombre, f.moneda AS forma_moneda, c.nombre AS cuenta_nombre, c.tipo AS cuenta_tipo, c.moneda AS cuenta_moneda, t.nombre AS terminal_nombre
     FROM fin_destino_forma_pago d JOIN formas_pago f ON f.codigo = d.forma_codigo LEFT JOIN fin_cuentas c ON c.id = d.cuenta_id LEFT JOIN terminales t ON t.id = d.terminal_id
     ORDER BY f.orden, d.terminal_clave`);
  return filas.map((d) => ({
    id: d.id, forma: d.forma_codigo, forma_nombre: d.forma_nombre, terminal_id: d.terminal_id, terminal_nombre: d.terminal_nombre, modo: d.modo, cuenta_id: d.cuenta_id,
    cuenta_nombre: d.cuenta_nombre, plazo_acreditacion_dias: d.plazo_acreditacion_dias, comision_pct: Number(d.comision_pct),
  }));
};

// Formas de pago activas que mueven fondos y todavía no tienen destino: sus cobros se rechazan (RN32) hasta asignarles uno.
const sinDestino = async () => {
  const [filas] = await pool.query(
    `SELECT f.codigo, f.nombre FROM formas_pago f WHERE f.activa = 1 AND f.codigo NOT IN ('cuenta_corriente', 'vale')
     AND NOT EXISTS (SELECT 1 FROM fin_destino_forma_pago d WHERE d.forma_codigo = f.codigo) ORDER BY f.orden`);
  return filas;
};

const asignar = async (d) => {
  const forma = String(d.forma ?? '').trim();
  const [[f]] = await pool.query('SELECT codigo, nombre, moneda FROM formas_pago WHERE codigo = ?', [forma]);
  if (!f) throw invalida('La forma de pago no existe.', 404);
  if (NO_FONDOS.has(forma)) throw invalida(`"${f.nombre}" no mueve fondos: no lleva caja ni cuenta de destino.`);
  const modo = d.modo ?? 'cuenta';
  if (!['cuenta', 'caja_del_turno'].includes(modo)) throw invalida('El modo debe ser "cuenta" o "caja_del_turno".');
  let terminalId = d.terminal_id ?? null;
  if (terminalId !== null) {
    const [[t]] = await pool.query('SELECT id FROM terminales WHERE id = ?', [Number(terminalId)]);
    if (!t) throw invalida('La terminal indicada no existe.', 404);
    terminalId = Number(terminalId);
  }
  let cuentaId = null;
  if (modo === 'cuenta') {
    if (!d.cuenta_id) throw invalida('Indicá la caja o cuenta de destino.');
    const c = await Cuentas.obtenerFila(Number(d.cuenta_id));
    if (!c.activa) throw invalida('La caja o cuenta de destino está desactivada.', 409);
    if ((f.moneda ?? 'ARS') !== c.moneda) throw invalida(`"${f.nombre}" es en ${f.moneda ?? 'ARS'} y la caja o cuenta es en ${c.moneda}: el destino tiene que ser de la misma moneda.`, 409);
    cuentaId = c.id;
  } else if ((f.moneda ?? 'ARS') !== 'ARS') {
    throw invalida('Una forma de pago en divisa necesita una caja o cuenta en esa moneda.', 409);
  }
  const plazo = d.plazo_acreditacion_dias === undefined ? 0 : Number(d.plazo_acreditacion_dias);
  const comision = d.comision_pct === undefined ? 0 : Number(d.comision_pct);
  if (!Number.isInteger(plazo) || plazo < 0 || plazo > 90) throw invalida('El plazo de acreditación son entre 0 y 90 días.');
  if (!(comision >= 0 && comision <= 100)) throw invalida('La comisión estimada es un porcentaje entre 0 y 100.');
  await pool.query(
    `INSERT INTO fin_destino_forma_pago (forma_codigo, terminal_id, terminal_clave, modo, cuenta_id, plazo_acreditacion_dias, comision_pct) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE modo = VALUES(modo), cuenta_id = VALUES(cuenta_id), plazo_acreditacion_dias = VALUES(plazo_acreditacion_dias), comision_pct = VALUES(comision_pct)`,
    [forma, terminalId, terminalId ?? 0, modo, cuentaId, plazo, comision]);
  return (await listar()).find((x) => x.forma === forma && (x.terminal_id ?? null) === terminalId);
};

const quitar = async (id) => {
  const [r] = await pool.query('DELETE FROM fin_destino_forma_pago WHERE id = ?', [id]);
  if (!r.affectedRows) throw invalida('Destino no encontrado.', 404);
  return { eliminado: true };
};

// A qué caja o cuenta va el cobro de una forma de pago hecho en una terminal. La regla de la terminal manda sobre la general (RF02).
// Un error de negocio rechaza el mensaje, sin reintento (RN32, EX23).
const resolver = async (db, forma, terminalId) => {
  const [reglas] = await db.query('SELECT * FROM fin_destino_forma_pago WHERE forma_codigo = ? AND (terminal_clave = ? OR terminal_clave = 0) ORDER BY terminal_clave DESC', [forma, terminalId ?? 0]);
  const regla = reglas[0];
  if (!regla) throw new M.RechazoNegocio(`La forma de pago "${forma}" no tiene caja o cuenta de destino.`);
  let cuenta;
  if (regla.modo === 'caja_del_turno') {
    [[cuenta]] = await db.query("SELECT * FROM fin_cuentas WHERE terminal_id = ? AND tipo = 'caja_efectivo' AND activa = 1", [terminalId ?? -1]);
    if (!cuenta) throw new M.RechazoNegocio(`La terminal de la venta no tiene una caja de efectivo asignada para cobrar "${forma}".`);
  } else {
    [[cuenta]] = await db.query('SELECT * FROM fin_cuentas WHERE id = ?', [regla.cuenta_id]);
    if (!cuenta || !cuenta.activa) throw new M.RechazoNegocio(`El destino de "${forma}" (${cuenta?.nombre ?? regla.cuenta_id}) está desactivado.`);
  }
  return { cuenta, plazo: regla.plazo_acreditacion_dias, comisionPct: Number(regla.comision_pct) };
};

// Desactivar un destino deja a esas formas de pago sin caja: se avisa y pide confirmación (EX25).
Cuentas.alDesactivar(async (cuentaId) => {
  const [filas] = await pool.query('SELECT DISTINCT forma_codigo FROM fin_destino_forma_pago WHERE cuenta_id = ?', [cuentaId]);
  return filas.length ? { confirma: `Es el destino de: ${filas.map((f) => f.forma_codigo).join(', ')}; esos cobros se rechazarán hasta asignarles otro.` } : null;
});

module.exports = { NO_FONDOS, listar, sinDestino, asignar, quitar, resolver, r2 };
