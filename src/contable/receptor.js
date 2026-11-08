const M = require('../mensajeria/servicio');
const Config = require('./configService');
const { iso, fechaLocal } = require('./comun');

// Contable como receptor de los eventos de los demás módulos (Contable RF03, RN18, RN28, RN30, EX11). Un movimiento con fecha anterior al inicio de la contabilidad (o recibido antes de
// iniciarla) no se contabiliza: queda en «Movimientos anteriores al inicio». Los demás los toma `gancho.tomar`, que completa el checkpoint de asientos automáticos.
const TIPOS = ['venta_confirmada', 'venta_regularizada', 'venta_devuelta', 'cierre_turno', 'reapertura_turno', 'comprobante_compra', 'comprobante_compra_anulado', 'orden_pago', 'orden_pago_anulada', 'retencion_sufrida', 'pasivo_instrumento', 'vencimiento_instrumento', 'comision_liquidada', 'remito_emitido', 'costo_venta', 'merma_produccion'];
const MODULO_DE = { venta: 'ventas', cierre: 'financiero', reapertura: 'financiero', comprobante: 'compras', orden: 'compras', retencion: 'clientes', pasivo: 'clientes', vencimiento: 'clientes', comision: 'ventas', remito: 'ventas', costo: 'stock', merma: 'stock' };

const fechaDe = (c) => iso(c.fecha ?? c.fecha_emision ?? c.fecha_venta ?? c.fecha_operacion ?? c.cerrado_en ?? (c.fecha_ms ? new Date(Number(c.fecha_ms)) : null)) ?? fechaLocal();
const gancho = { tomar: null };

const registrarPrevio = async (conn, tipo, c, ctx, fecha) => {
  await conn.query('INSERT IGNORE INTO con_previos_inicio (modulo, tipo_documento, id_documento, id_operacion, fecha, importe) VALUES (?, ?, ?, ?, ?, ?)',
    [MODULO_DE[tipo.split('_')[0]] ?? 'otro', tipo, ctx.docIdGlobal ?? c.venta_id_global ?? '', ctx.idOperacion, fecha, c.total ?? c.importe ?? null]);
  return { previo_al_inicio: true };
};

for (const tipo of TIPOS) {
  M.registrarReceptor('contable', tipo, async (conn, c, ctx) => {
    const cfg = await Config.config(conn);
    const fecha = fechaDe(c);
    if (!cfg.fecha_inicio || fecha < iso(cfg.fecha_inicio)) return registrarPrevio(conn, tipo, c, ctx, fecha);
    if (!gancho.tomar) throw new M.RechazoNegocio('Sin regla de imputación para este evento.');
    return gancho.tomar(conn, tipo, c, ctx, fecha);
  });
}

module.exports = { TIPOS, gancho, fechaDe };
