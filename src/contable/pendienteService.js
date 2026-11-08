const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const Notificacion = require('../models/notificacionModel');
const Asientos = require('./asientoService');
const { invalida, fechaLocal, iso } = require('./comun');

// Pendientes de imputar (Contable RF15, RN08, RN29, RN30, EX02, EX19): movimientos que no pudieron contabilizarse por falta de regla, o que esperan a su documento original. Nunca frenan al
// módulo de origen. Se resuelven creando la regla (y reintentando) o imputándolos a mano; ningún pendiente se descarta.
const vista = (p) => ({ id: p.id, id_operacion: p.id_operacion, modulo: p.modulo, tipo_evento: p.tipo_evento, id_documento: p.id_documento, fecha: iso(p.fecha), importe: p.importe === null ? null : Number(p.importe), motivo: p.motivo,
  detalle: p.detalle, estado: p.estado, responsable_id: p.responsable_id, plazo: iso(p.plazo), vencido: p.estado === 'abierto' && !!p.plazo && iso(p.plazo) < fechaLocal(), asiento_id: p.asiento_id, resolucion: p.resolucion });

// Se registra con el pool y no con la conexión del mensaje: esa transacción se revierte al rechazar y el pendiente tiene que quedar.
const registrar = async ({ idOperacion, modulo, tipoEvento, idDocumento, fecha, importe, motivo, detalle }) => {
  const [[cfg]] = await pool.query('SELECT responsable_id, plazo_pendientes_dias FROM con_config WHERE id = 1');
  const plazo = new Date(); plazo.setDate(plazo.getDate() + Number(cfg.plazo_pendientes_dias ?? 5));
  const [r] = await pool.query('INSERT INTO con_pendientes (id_operacion, modulo, tipo_evento, id_documento, fecha, importe, motivo, detalle, responsable_id, plazo, creado_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE detalle = VALUES(detalle), motivo = VALUES(motivo)',
    [idOperacion, modulo, tipoEvento, idDocumento ?? '', fecha, importe ?? null, motivo, detalle ? String(detalle).slice(0, 255) : null, cfg.responsable_id ?? null, iso(plazo), Date.now()]);
  if (r.affectedRows === 1) { // recién creado: avisa al responsable
    await Notificacion.crear({ modulo: 'contable', tipo: 'pendiente_imputar', severidad: 'media', mensaje: `Hay un movimiento pendiente de imputar: ${tipoEvento} ${idDocumento}${detalle ? ` (${detalle})` : ''}.`, roles: ['contador', 'gerente'], clave: `pendiente-contable:${idOperacion}` }).catch(() => {});
  }
};

// Al contabilizarse el movimiento (por el reintento o a mano) el pendiente sale del listado.
const resolver = async (db, idOperacion, { asientoId = null, resolucion = 'automatico', usuarioId = null } = {}) => {
  const [r] = await db.query("UPDATE con_pendientes SET estado = 'resuelto', asiento_id = ?, resolucion = ?, resuelto_ms = ?, resuelto_por = ? WHERE id_operacion = ? AND estado = 'abierto'", [asientoId, resolucion, Date.now(), usuarioId, idOperacion]);
  if (r.affectedRows) await Notificacion.resolverPorClave(`pendiente-contable:${idOperacion}`, 'El pendiente se resolvió').catch(() => {});
};

const listar = async ({ estado = 'abierto', motivo } = {}) => {
  const w = ['estado = ?'], p = [estado];
  if (motivo) { w.push('motivo = ?'); p.push(motivo); }
  return (await pool.query(`SELECT * FROM con_pendientes WHERE ${w.join(' AND ')} ORDER BY fecha, id LIMIT 500`, p))[0].map(vista);
};
const contarAbiertos = async (db = pool) => Number((await db.query("SELECT COUNT(*) AS n FROM con_pendientes WHERE estado = 'abierto'"))[0][0].n);
const obtener = async (id) => {
  const [[p]] = await pool.query('SELECT * FROM con_pendientes WHERE id = ?', [id]);
  if (!p) throw invalida('Pendiente no encontrado.', 404);
  return p;
};

// Vuelve a entregar el mensaje al receptor: sirve cuando se creó la regla que faltaba.
const reintentar = async (id, usuarioId) => {
  const p = await obtener(id);
  if (p.estado !== 'abierto') throw invalida('El pendiente ya está resuelto.', 409, { codigo: 'YA_RESUELTO' });
  const [r] = await pool.query("UPDATE mensajes_integracion SET estado = 'pendiente', intentos = 0, primer_intento_ms = NULL, proximo_intento_ms = ?, motivo_rechazo = NULL WHERE id_operacion = ? AND estado IN ('rechazado', 'fallido', 'pendiente', 'enviado')", [Date.now(), p.id_operacion]);
  if (!r.affectedRows) throw invalida('El mensaje de este pendiente ya no está en la bandeja de salida de su origen.', 409, { codigo: 'MENSAJE_NO_DISPONIBLE' });
  await pool.query("UPDATE bandeja_pendientes SET estado = 'reintentado', user_accion = ?, accion_ms = ? WHERE mensaje_id IN (SELECT id FROM mensajes_integracion WHERE id_operacion = ?) AND estado = 'abierto'", [usuarioId, Date.now(), p.id_operacion]);
  M.despertar();
  return { reintentado: true };
};

// Imputarlo a mano: un asiento con las líneas que indica el responsable, vinculado al documento de origen; el mensaje queda Confirmado y sale de ambos listados (RN30).
const imputar = async (id, { lineas, leyenda }, usuarioId, idSolicitud = null) => {
  const p = await obtener(id);
  if (p.estado !== 'abierto') throw invalida('El pendiente ya está resuelto.', 409, { codigo: 'YA_RESUELTO' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[ya]] = await conn.query('SELECT asiento_id FROM con_asiento_origen WHERE id_operacion = ?', [p.id_operacion]);
    if (ya) throw invalida('Ese movimiento ya tiene asiento.', 409, { codigo: 'YA_CONTABILIZADO' });
    const a = await Asientos.crear(conn, { fecha: iso(p.fecha), tipo: 'imputacion', leyenda: String(leyenda ?? `Imputación manual de ${p.tipo_evento} ${p.id_documento}`).slice(0, 200), lineas: lineas ?? [], usuarioId, idSolicitud,
      origen: { modulo: p.modulo, tipo_documento: p.tipo_evento, id_documento: p.id_documento, id_operacion: p.id_operacion, importe: p.importe, tipo_evento: p.tipo_evento, fecha_documento: iso(p.fecha) } });
    await resolver(conn, p.id_operacion, { asientoId: a.id, resolucion: 'a_mano', usuarioId });
    await conn.commit();
    await M.confirmarResuelto(p.id_operacion, { asiento_id: a.id, numero: a.numero, a_mano: true });
    return { asiento_id: a.id, numero: a.numero };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const asignar = async (id, { responsable_id: responsable, plazo }) => {
  await obtener(id);
  await pool.query('UPDATE con_pendientes SET responsable_id = COALESCE(?, responsable_id), plazo = COALESCE(?, plazo) WHERE id = ?', [responsable ?? null, plazo ?? null, id]);
  return vista(await obtener(id));
};

module.exports = { registrar, resolver, listar, obtener, reintentar, imputar, asignar, contarAbiertos, vista };
