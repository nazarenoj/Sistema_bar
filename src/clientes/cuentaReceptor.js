const M = require('../mensajeria/servicio');
const Cuentas = require('./cuentaService');

// Clientes como receptor de los efectos que Ventas pide registrar en la cuenta (Clientes RF04, RF05, RF28, RN36, RN37). Cada uno se registra una sola
// vez por ID_Operacion (la mensajería guarda la operación procesada en la misma transacción); un error de negocio deja el mensaje Rechazado, con su
// motivo, en la Bandeja de pendientes, sin tocar la venta. Una anulación espera a que su débito original esté Confirmado (EX25).
const debito = (tipo) => async (conn, c, ctx) => {
  const r = await Cuentas.registrarDebito(conn, {
    tipo, clienteId: c.cliente_id, moneda: c.moneda ?? 'ARS', importe: c.importe, ref: c.venta_id_global ?? c.remito_id_global, fecha: c.fecha,
    idOperacion: ctx.idOperacion, reservaId: c.reserva_id ?? null, contingencia: !!c.contingencia, detalle: c.concepto ?? null,
    cotizacion: c.cotizacion ?? null, importeMonedaCuenta: c.importe_moneda_cuenta ?? null,
  });
  return { movimiento_id: r.movimientoId };
};

M.registrarReceptor('clientes', 'debito_venta', debito('venta'));
M.registrarReceptor('clientes', 'remito_emitido', debito('remito'));
const anulacion = (conn, c, ctx) => Cuentas.anularDebito(conn, { ref: c.venta_id_global ?? c.remito_id_global, idOperacion: ctx.idOperacion });
M.registrarReceptor('clientes', 'anulacion_debito', anulacion, { revierte: 'debito_venta' });
M.registrarReceptor('clientes', 'anulacion_remito', anulacion, { revierte: 'remito_emitido' });
