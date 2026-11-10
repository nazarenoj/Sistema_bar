const M = require('../mensajeria/servicio');
const Funciones = require('../funciones/servicio');
const Cuentas = require('./cuentaService');
const Turnos = require('./turnoService');
const { r2, movimiento } = require('./comun');
const Contable = require('./aContable');

// Pago de liquidaciones de comisiones de vendedores (Financiero RF23, RN25): Ventas define el importe; Financiero lo registra como un egreso de la caja o cuenta elegida,
// con la categoría «Comisiones de vendedores» y vinculado a la liquidación. Sin VEN-COMISIONES no hay pago. Una liquidación anulada en Ventas genera el contramovimiento.
M.registrarReceptor('financiero', 'pago_comision', async (conn, c, ctx) => {
  if (!(await Funciones.estaActiva('VEN-COMISIONES', conn))) throw new M.RechazoNegocio('Pagar comisiones necesita la función VEN-COMISIONES.');
  if (!c.cuenta_id) throw new M.RechazoNegocio('Indicá de qué caja o cuenta sale el pago de la liquidación.');
  const [[cuenta]] = await conn.query('SELECT * FROM fin_cuentas WHERE id = ? FOR UPDATE', [Number(c.cuenta_id)]);
  if (!cuenta || !cuenta.activa) throw new M.RechazoNegocio('La caja o cuenta de pago no existe o está desactivada.');
  if (cuenta.moneda !== 'ARS') throw new M.RechazoNegocio('Las comisiones se pagan en pesos.');
  const importe = r2(c.total);
  const saldo = await Cuentas.saldoDe(cuenta.id, conn);
  const piso = Cuentas.ES_CAJA(cuenta.tipo) ? 0 : -Number(cuenta.limite_descubierto);
  if (r2(saldo - importe) < piso) throw new M.RechazoNegocio(`El pago dejaría "${cuenta.nombre}" sin fondos: el saldo disponible es ${r2(saldo - piso)}.`);
  const t = await Turnos.paraContramovimiento(conn, cuenta);
  if (Turnos.llevaTurno(cuenta) && !t.turnoId) throw new M.RechazoNegocio(`La caja "${cuenta.nombre}" no tiene un turno abierto.`);
  const [[cat]] = await conn.query("SELECT id FROM fin_categorias WHERE nombre = 'Comisiones de vendedores'");
  const id = await movimiento(conn, { cuentaId: cuenta.id, turnoId: t.turnoId, tipo: 'pago_comision', importe: -importe, moneda: cuenta.moneda, categoriaId: cat?.id ?? null, formaPago: c.medio_pago ?? null,
    idOperacion: ctx.idOperacion, docIdGlobal: ctx.docIdGlobal, motivo: `Liquidación de comisiones ${c.desde ?? ''} a ${c.hasta ?? ''}`.trim() });
  await Contable.publicar(conn, 'pago_comision', 'pago_comision', ctx.docIdGlobal, { liquidacion_id_global: ctx.docIdGlobal, importe, medio: Contable.claseDe(cuenta.tipo) });
  return { movimiento_id: id };
});

M.registrarReceptor('financiero', 'anulacion_pago_comision', async (conn, c, ctx) => {
  const [[orig]] = await conn.query("SELECT * FROM fin_movimientos WHERE doc_id_global = ? AND tipo = 'pago_comision' ORDER BY id LIMIT 1", [ctx.docIdGlobal]);
  if (!orig) throw new M.RechazoNegocio('La liquidación no tiene un pago registrado.');
  const [[cuenta]] = await conn.query('SELECT * FROM fin_cuentas WHERE id = ?', [orig.cuenta_id]);
  const t = await Turnos.paraContramovimiento(conn, cuenta);
  const id = await movimiento(conn, { cuentaId: cuenta.id, turnoId: t.turnoId, enEspera: t.enEspera, tipo: 'anulacion_pago_comision', importe: -Number(orig.importe), moneda: cuenta.moneda, categoriaId: orig.categoria_id,
    vinculoId: orig.id, idOperacion: ctx.idOperacion, docIdGlobal: ctx.docIdGlobal, motivo: c.motivo ?? 'Liquidación anulada en Ventas' });
  await Contable.publicar(conn, 'pago_comision_anulado', 'pago_comision', ctx.docIdGlobal, { liquidacion_id_global: ctx.docIdGlobal, motivo: c.motivo ?? 'Liquidación anulada en Ventas' }, { docVersion: 2, secuencia: 2 });
  return { movimiento_id: id };
}, { revierte: 'pago_comision' });
