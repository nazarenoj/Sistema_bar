const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const Comprobantes = require('./comprobanteService');

// Compras como receptor del «Cheque rechazado» que publica Financiero (Compras EX13, RN32): si el cheque de un cliente se endosó a un proveedor de esta instancia, la deuda con ese
// proveedor se reabre con una nota de débito interna por el importe y los gastos bancarios. Es idempotente por la ID_Operacion del mensaje.
M.registrarReceptor('compras', 'cheque_rechazado', async (conn, c) => {
  const [[medio]] = await conn.query(
    `SELECT m.orden_id, o.proveedor_id, o.numero, o.moneda FROM cmp_op_medios m JOIN cmp_ordenes_pago o ON o.id = m.orden_id WHERE m.cheque_id = ? AND o.estado <> 'anulada' ORDER BY m.id DESC LIMIT 1`, [Number(c.cheque_id)]);
  if (!medio) throw new M.RechazoNegocio('El cheque rechazado no figura en ninguna orden de pago de Compras.');
  const total = Number(c.importe) + Number(c.gastos_bancarios ?? 0);
  const nd = await Comprobantes.crearInterno(conn, { proveedorId: medio.proveedor_id, importe: total, moneda: c.moneda ?? medio.moneda, referencia: c.cheque_id,
    motivo: `Cheque rechazado ${c.banco ?? ''} N° ${c.numero ?? ''} entregado en la orden de pago ${medio.numero}: ${c.motivo}` });
  return { comprobante_id: nd.id, proveedor_id: medio.proveedor_id };
});

void pool;
