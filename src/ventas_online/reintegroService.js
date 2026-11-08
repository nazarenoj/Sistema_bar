const pool = require('../config/db');
const Notificacion = require('../models/notificacionModel');
const Pasarela = require('./pasarelaMP');
const { TiendaInvalida } = require('./tiendaService');

// Reintegros en la pasarela (Ventas Online RF15, RN48, EX03, EX11). Cada pedido de reintegro lleva su clave de solicitud y se ejecuta por API; si la pasarela lo rechaza o no responde, queda
// «pendiente» y se reintenta durante N horas (24 por defecto) con la misma clave. Vencido el plazo, un usuario con permiso lo resuelve a mano por otro medio. Lo ya facturado no se revierte.
const invalida = (m, status = 400, extra = {}) => Object.assign(new TiendaInvalida(m), { status, ...extra });
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const alertar = (clave, severidad, mensaje) => Notificacion.crear({ modulo: 'ventas_online', tipo: 'reintegro', severidad, roles: ['gerente', 'administrativo'], clave, mensaje }).catch(() => {});

const vista = (r) => ({ id: r.id, pedido_id: r.pedido_id, pago_id: r.pago_id, importe: Number(r.importe), motivo: r.motivo, detalle: r.detalle, estado: r.estado, id_externo: r.id_externo, intentos: r.intentos, error: r.error, medio_manual: r.medio_manual,
  vence_reintento_ms: Number(r.vence_reintento_ms) });

// Pide un reintegro y lo intenta una vez. Idempotente por `solicitud`: repetirla devuelve el mismo reintegro.
const solicitar = async ({ pedidoId, pagoId, importe, motivo, detalle = null, solicitud }) => {
  const [[previo]] = await pool.query('SELECT * FROM onl_reintegros WHERE id_solicitud = ?', [solicitud]);
  if (previo) return vista(previo);
  const [[pago]] = await pool.query('SELECT * FROM onl_pagos WHERE id = ?', [pagoId]);
  if (!pago) throw invalida('El pago no existe.', 404);
  const imp = r2(importe ?? pago.importe);
  if (!(imp > 0) || r2(Number(pago.reintegrado) + imp) > r2(pago.importe) + 0.004) throw invalida(`Solo quedan ${r2(Number(pago.importe) - Number(pago.reintegrado))} por reintegrar de ese pago.`, 409, { codigo: 'REINTEGRO_EXCEDE' });
  const [[t]] = await pool.query('SELECT horas_reintento_reintegro FROM onl_tienda WHERE id = 1');
  const ahora = Date.now();
  const [r] = await pool.query('INSERT INTO onl_reintegros (pedido_id, pago_id, importe, motivo, detalle, id_solicitud, creado_ms, vence_reintento_ms, actualizado_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [pedidoId, pagoId, imp, motivo, detalle, solicitud, ahora, ahora + t.horas_reintento_reintegro * 3600000, ahora]);
  return ejecutar(r.insertId);
};

const ejecutar = async (id) => {
  const [[r]] = await pool.query('SELECT * FROM onl_reintegros WHERE id = ?', [id]);
  if (!r) throw invalida('Reintegro no encontrado.', 404);
  if (r.estado !== 'pendiente') return vista(r);
  const [[pago]] = await pool.query('SELECT * FROM onl_pagos WHERE id = ?', [r.pago_id]);
  try {
    const x = await Pasarela.proveedor().reintegrar(pago.id_externo, Number(r.importe), r.id_solicitud);
    await pool.query("UPDATE onl_reintegros SET estado = 'ejecutado', id_externo = ?, intentos = intentos + 1, error = NULL, actualizado_ms = ? WHERE id = ?", [x.id, Date.now(), id]);
    await pool.query('UPDATE onl_pagos SET reintegrado = reintegrado + ?, actualizado_ms = ? WHERE id = ?', [r.importe, Date.now(), pago.id]);
  } catch (err) {
    await pool.query('UPDATE onl_reintegros SET intentos = intentos + 1, error = ?, actualizado_ms = ? WHERE id = ?', [String(err.message).slice(0, 255), Date.now(), id]);
    await alertar(`reintegro-${id}`, 'alta', `El reintegro de ${Number(r.importe)} del pedido ${r.pedido_id} no se pudo ejecutar: ${err.message}. Queda pendiente y se reintenta.`); // EX11
  }
  return vista((await pool.query('SELECT * FROM onl_reintegros WHERE id = ?', [id]))[0][0]);
};

// Reintenta los pendientes dentro del plazo con la misma clave (EX11).
const reintentarPendientes = async () => {
  const [ids] = await pool.query("SELECT id FROM onl_reintegros WHERE estado = 'pendiente' AND vence_reintento_ms > ? ORDER BY id", [Date.now()]);
  const salida = { ejecutados: 0, pendientes: 0 };
  for (const { id } of ids) { const r = await ejecutar(id); if (r.estado === 'ejecutado') salida.ejecutados++; else salida.pendientes++; }
  return salida;
};

// Vencido el plazo, o antes si un usuario con permiso lo decide, el reintegro se hace por otro medio y se avisa a Ventas cuál fue (EX11).
const resolverManual = async (id, { medio, userId }) => {
  if (typeof medio !== 'string' || medio.trim().length < 3) throw invalida('Indicá por qué medio se devolvió el dinero.');
  const [[r]] = await pool.query('SELECT * FROM onl_reintegros WHERE id = ?', [id]);
  if (!r) throw invalida('Reintegro no encontrado.', 404);
  if (r.estado !== 'pendiente') throw invalida(`El reintegro ya está ${r.estado}.`, 409);
  await pool.query("UPDATE onl_reintegros SET estado = 'manual', medio_manual = ?, actualizado_ms = ? WHERE id = ?", [medio.trim().slice(0, 60), Date.now(), id]);
  await pool.query('UPDATE onl_pagos SET reintegrado = reintegrado + ?, actualizado_ms = ? WHERE id = ?', [r.importe, Date.now(), r.pago_id]);
  void userId;
  return vista((await pool.query('SELECT * FROM onl_reintegros WHERE id = ?', [id]))[0][0]);
};

const listar = async ({ pedidoId, estado } = {}) => {
  const w = [], p = [];
  if (pedidoId) { w.push('pedido_id = ?'); p.push(pedidoId); }
  if (estado) { w.push('estado = ?'); p.push(estado); }
  return (await pool.query(`SELECT * FROM onl_reintegros ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 300`, p))[0].map(vista);
};
const pendientesDe = async (pedidoId) => (await pool.query("SELECT COALESCE(SUM(importe), 0) AS t FROM onl_reintegros WHERE pedido_id = ? AND estado = 'pendiente'", [pedidoId]))[0][0].t;

module.exports = { solicitar, ejecutar, reintentarPendientes, resolverManual, listar, pendientesDe, alertar };
