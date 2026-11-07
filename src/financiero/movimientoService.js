const pool = require('../config/db');
const { r2 } = require('./comun');

// Consulta de movimientos de fondos (Financiero RF16): filtros combinables, con paginación por cursor (id descendente).
const listar = async ({ cuentaId, tipo, desde, hasta, turnoId, docIdGlobal, limite = 100, antesDe } = {}) => {
  const w = [], p = [];
  if (cuentaId) { w.push('m.cuenta_id = ?'); p.push(Number(cuentaId)); }
  if (tipo) { w.push('m.tipo = ?'); p.push(String(tipo)); }
  if (turnoId) { w.push('m.turno_id = ?'); p.push(Number(turnoId)); }
  if (docIdGlobal) { w.push('m.doc_id_global = ?'); p.push(String(docIdGlobal)); }
  if (desde) { w.push('m.fecha_ms >= ?'); p.push(new Date(`${desde}T00:00:00`).getTime()); }
  if (hasta) { w.push('m.fecha_ms <= ?'); p.push(new Date(`${hasta}T23:59:59.999`).getTime()); }
  if (antesDe) { w.push('m.id < ?'); p.push(Number(antesDe)); }
  const tope = Math.min(Math.max(Number(limite) || 100, 1), 500);
  const [filas] = await pool.query(
    `SELECT m.*, c.nombre AS cuenta_nombre FROM fin_movimientos m JOIN fin_cuentas c ON c.id = m.cuenta_id ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY m.id DESC LIMIT ?`, [...p, tope]);
  return filas.map((m) => ({
    id: m.id, id_global: m.id_global, cuenta_id: m.cuenta_id, cuenta: m.cuenta_nombre, turno_id: m.turno_id, tipo: m.tipo, importe: r2(m.importe), moneda: m.moneda,
    importe_divisa: m.importe_divisa === null ? null : Number(m.importe_divisa), cotizacion: m.cotizacion === null ? null : Number(m.cotizacion), forma_pago: m.forma_pago,
    referencia_externa: m.referencia_externa, doc_id_global: m.doc_id_global, vinculo_id: m.vinculo_id, motivo: m.motivo, marcas: m.marcas, en_espera: !!m.en_espera,
    user_id: m.user_id, fecha_ms: Number(m.fecha_ms),
  }));
};

// Ratifica una devolución en efectivo que dejó la caja en negativo sin una autorización previa (Financiero EX31): otro usuario con el permiso, con su credencial.
const ratificar = async (id, { autorizar }) => {
  const { invalida } = require('./comun');
  const Notificacion = require('../models/notificacionModel');
  const [[m]] = await pool.query('SELECT id, marcas FROM fin_movimientos WHERE id = ?', [id]);
  if (!m) throw invalida('Movimiento no encontrado.', 404);
  if (!/^saldo_negativo_sin_autorizacion/.test(m.marcas ?? '')) throw invalida('El movimiento no está pendiente de ratificación.', 409, { codigo: 'NO_PENDIENTE' });
  const a = await autorizar();
  if (!a?.ok) throw invalida(a?.error ?? 'La ratificación necesita la credencial de otro usuario con el permiso.', a?.status ?? 403, { codigo: a?.codigo ?? 'REQUIERE_AUTORIZACION' });
  await pool.query('UPDATE fin_movimientos SET marcas = ? WHERE id = ?', [m.marcas.replace('sin_autorizacion', 'ratificado'), id]);
  await Notificacion.resolverPorClave(`saldo-negativo:${id}`, `Ratificado por ${a.supervisor.username}`);
  return { id, marcas: m.marcas.replace('sin_autorizacion', 'ratificado'), autorizante: a.supervisor.username };
};

module.exports = { listar, ratificar };
