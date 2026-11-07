const pool = require('../config/db');

// Cobros de Ventas cuya integración con Financiero no está completa (Financiero RF28, llamada n.º 16): los mensajes de cobro todavía Pendientes, Fallidos o
// Rechazados de una terminal en un período. Es la vista de «integración pendiente» del registro de ventas.
const cobrosConIntegracionPendiente = async ({ terminalId, desdeMs, hastaMs }) => {
  const [filas] = await pool.query(
    `SELECT m.doc_id_global, m.id_operacion, m.estado, m.retenido_por_orden, m.motivo_rechazo, m.ts_origen_ms, m.contenido
     FROM mensajes_integracion m
     WHERE m.modulo_origen = 'ventas' AND m.modulo_destino = 'financiero' AND m.tipo = 'cobro_registrado' AND m.descartado = 0 AND m.estado <> 'confirmado'
       AND m.ts_origen_ms BETWEEN ? AND ? ORDER BY m.ts_origen_ms`, [desdeMs, hastaMs]);
  return filas.map((f) => ({ ...f, contenido: JSON.parse(f.contenido) })).filter((f) => (f.contenido.terminal_id ?? null) === (terminalId ?? null)).map((f) => ({
    venta: f.doc_id_global, id_operacion: f.id_operacion, estado: f.estado, motivo: f.motivo_rechazo, ts_ms: Number(f.ts_origen_ms),
    pagos: (f.contenido.pagos ?? []).map((p) => ({ forma: p.forma, importe: Number(p.importe) })),
  }));
};

module.exports = { cobrosConIntegracionPendiente };
