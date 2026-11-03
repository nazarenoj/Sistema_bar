const M = require('../mensajeria/servicio');
const Recibos = require('./reciboService');
const Cuentas = require('./cuentaService');

// Clientes como receptor de los efectos que Ventas pide registrar en la cuenta (Clientes RF04, RF05, RF28, RN36, RN37). Cada uno se registra una sola
// vez por ID_Operacion (la mensajería guarda la operación procesada en la misma transacción); un error de negocio deja el mensaje Rechazado, con su
// motivo, en la Bandeja de pendientes, sin tocar la venta. Una anulación espera a que su débito original esté Confirmado (EX25).
const debito = (tipo) => async (conn, c, ctx) => {
  const r = await Cuentas.registrarDebito(conn, {
    tipo, clienteId: c.cliente_id, moneda: c.moneda ?? 'ARS', importe: c.importe, ref: c.venta_id_global ?? c.remito_id_global, fecha: c.fecha,
    idOperacion: ctx.idOperacion, reservaId: c.reserva_id ?? null, contingencia: !!c.contingencia, detalle: c.concepto ?? null,
    cotizacion: c.cotizacion ?? null, importePesos: c.importe_pesos ?? null, importeMonedaCuenta: c.importe_moneda_cuenta ?? null,
  });
  return { movimiento_id: r.movimientoId };
};

M.registrarReceptor('clientes', 'debito_venta', debito('venta'));
M.registrarReceptor('clientes', 'remito_emitido', debito('remito'));
const anulacion = (conn, c, ctx) => Cuentas.anularDebito(conn, { ref: c.venta_id_global ?? c.remito_id_global, idOperacion: ctx.idOperacion });
M.registrarReceptor('clientes', 'anulacion_debito', anulacion, { revierte: 'debito_venta' });
M.registrarReceptor('clientes', 'devolucion_debito', (conn, c, ctx) => Cuentas.devolverDebito(conn, { ref: c.venta_id_global, importe: c.importe, idOperacion: ctx.idOperacion }), { revierte: 'debito_venta' });
M.registrarReceptor('clientes', 'recibo_registrado', async (conn, c, ctx) => {
  try { const r = await Recibos.registrar(c, { userId: c.user_id ?? null, idOperacion: ctx.idOperacion }); return { recibo_id: r.id, numero: r.numero_completo }; } catch (err) {
    if (err instanceof Recibos.ReciboInvalido && err.status !== 409) throw new M.RechazoNegocio(err.message); // error de negocio: rechazado, sin reintento
    if (err instanceof Recibos.ReciboInvalido) throw new M.RechazoNegocio(err.message);
    throw err;
  }
});
M.registrarReceptor('clientes', 'remitos_facturados', async (conn, c, ctx) => {
  const r = await Cuentas.facturarRemitos(conn, { clienteId: c.cliente_id, facturaRef: c.factura_id_global, importe: c.importe, fecha: c.fecha, remitos: c.remitos, idOperacion: ctx.idOperacion });
  return { movimiento_id: r.movimientoId, trasladado: r.trasladado };
});
M.registrarReceptor('clientes', 'anulacion_remito', anulacion, { revierte: 'remito_emitido' });
