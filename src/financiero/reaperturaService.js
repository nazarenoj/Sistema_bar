const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const Cuentas = require('./cuentaService');
const Turnos = require('./turnoService');
const { invalida } = require('./comun');

// Reapertura de un turno cerrado (Financiero RF18, RN07, RN43). Solo con motivo, con la autorización de otro usuario que tenga el permiso, dentro de la
// antigüedad máxima y si la caja no tiene otro turno abierto. El cierre anterior se conserva en el historial; al volver a cerrar se recalcula todo el turno.
const DIA_MS = 86400000;

const reabrir = async (turnoId, { motivo }, ctx) => {
  const turno = await Turnos.fila(turnoId);
  if (turno.estado !== 'cerrado') throw invalida('El turno no está cerrado.', 409);
  const texto = String(motivo ?? '').trim();
  if (texto.length < 3) throw invalida('El motivo de la reapertura es obligatorio.');
  const cuenta = await Cuentas.obtenerFila(turno.cuenta_id);
  const config = await Cuentas.config();

  // RN43, EX32: fuera de la antigüedad máxima no se ofrece; el ajuste se registra en el turno actual o en la caja central (con permiso y motivo).
  const [[ultimo]] = await pool.query('SELECT version, cerrado_ms FROM fin_cierres WHERE turno_id = ? ORDER BY version DESC LIMIT 1', [turnoId]);
  const antiguedadMs = Date.now() - Number(ultimo.cerrado_ms);
  if (config.antiguedad_max_reapertura_dias === 0 || antiguedadMs > config.antiguedad_max_reapertura_dias * DIA_MS) {
    await ctx.auditarRechazo(`reapertura del turno ${turnoId} fuera de la antigüedad máxima (${(antiguedadMs / DIA_MS).toFixed(1)} días, tope ${config.antiguedad_max_reapertura_dias})`);
    throw invalida(`El último cierre tiene ${(antiguedadMs / DIA_MS).toFixed(1)} días y el tope para reabrir es ${config.antiguedad_max_reapertura_dias}: registrá el ajuste como movimiento en el turno actual o en la caja central.`, 409,
      { codigo: 'REAPERTURA_FUERA_DE_PLAZO', detalle: { antiguedad_dias: Number((antiguedadMs / DIA_MS).toFixed(2)), tope_dias: config.antiguedad_max_reapertura_dias } });
  }
  // RN07, EX14: solo si la caja no tiene otro turno abierto; se muestra cuál es.
  const abierto = await Turnos.abiertoDe(cuenta.id);
  if (abierto) {
    await ctx.auditarRechazo(`reapertura del turno ${turnoId} con el turno ${abierto.id} abierto en la caja`);
    const [[u]] = await pool.query('SELECT username FROM users WHERE id = ?', [abierto.user_id]);
    throw invalida(`La caja "${cuenta.nombre}" ya tiene el turno ${abierto.id} abierto (${u?.username ?? abierto.user_id}).`, 409,
      { codigo: 'TURNO_ABIERTO', detalle: { turno_id: abierto.id, usuario: u?.username ?? null, terminal_id: abierto.terminal_id, abierto_ms: Number(abierto.abierto_ms) } });
  }
  // La credencial de otro usuario con el permiso (la rechaza y la audita la propia validación, EX14).
  const aut = await ctx.autorizar();
  if (!aut?.ok) throw invalida(aut?.error ?? 'La reapertura necesita la autorización de un supervisor.', aut?.status ?? 403, { codigo: aut?.codigo ?? 'REQUIERE_AUTORIZACION' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM fin_cuentas WHERE id = ? FOR UPDATE', [cuenta.id]);
    try {
      await conn.query("UPDATE fin_turnos SET estado = 'abierto', cuenta_abierta = ?, cerrado_ms = NULL, reaperturas = reaperturas + 1 WHERE id = ? AND estado = 'cerrado'", [cuenta.id, turnoId]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw invalida(`La caja "${cuenta.nombre}" ya tiene un turno abierto.`, 409, { codigo: 'TURNO_ABIERTO' });
      throw err;
    }
    await conn.query('UPDATE fin_movimientos SET turno_id = ?, en_espera = 0 WHERE cuenta_id = ? AND en_espera = 1', [turnoId, cuenta.id]); // lo que esperaba un turno entra al reabierto (EX13, EX30)
    await conn.query('INSERT INTO fin_reaperturas (turno_id, version_cierre, motivo, user_id, autorizante_id, cierre_anterior_ms, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [turnoId, ultimo.version, texto.slice(0, 255), ctx.userId, aut.supervisor.id, Number(ultimo.cerrado_ms), Date.now()]);
    await M.publicar(conn, { origen: 'financiero', destino: 'contable', tipo: 'reapertura_turno', docTipo: 'turno', docIdGlobal: turno.id_global, docVersion: 1000 + turno.reaperturas + 1, userId: ctx.userId,
      contenido: { turno_id_global: turno.id_global, caja: cuenta.nombre, motivo: texto, cierre_anterior: ultimo.version, fecha_ms: Date.now() } });
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  M.despertar();
  return { turno: await Turnos.obtener(turnoId, { verTeorico: true }), autorizante: aut.supervisor.username };
};

const historial = async (turnoId) => (await pool.query(
  `SELECT r.id, r.version_cierre, r.motivo, r.cierre_anterior_ms, r.ts_ms, u.username AS usuario, a.username AS autorizante FROM fin_reaperturas r
   JOIN users u ON u.id = r.user_id JOIN users a ON a.id = r.autorizante_id WHERE r.turno_id = ? ORDER BY r.id`, [turnoId]))[0];

module.exports = { reabrir, historial };
