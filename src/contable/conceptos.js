const Auto = require('./automaticos');
const { r2, cts } = require('./comun');

// Conceptos de los demás módulos que Contable imputa (Contable RF03, RF17 a RF21, RF24, RF25): compras y órdenes de pago, retenciones sufridas, diferencias de caja, gift cards y vales, comisiones,
// remitos a facturar, costo de ventas y mermas. Cada concepto se toma solo si su módulo fuente lo publica; sin la fuente el formulario no existe y nada se imputa (RN31).
const { linea, resolver, registrar, esperarMensajes } = Auto;
const num = (x) => Number(x ?? 0);
// Un contraasiento a fecha actual (RN20): invierte las líneas del asiento original si éste es de un solo documento.
const invertir = (lineas) => lineas.map((l) => ({ cuenta_id: l.cuenta_id, debe: l.haber, haber: l.debe, detalle: l.detalle }));

// Las líneas con que se contabilizó un documento (por su ID_Operacion) o, si el original se contabilizó dentro de un asiento resumido, nada: ese caso se corrige con un asiento manual.
const lineasDelOriginal = async (db, tipoOriginal, idDocumento) => {
  const [[o]] = await db.query('SELECT asiento_id FROM con_asiento_origen WHERE tipo_documento = ? AND id_documento = ? ORDER BY id LIMIT 1', [tipoOriginal, idDocumento]);
  if (!o) return null; // el original es anterior al inicio de la contabilidad (EX11): no hay nada que contrarrestar
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM con_asiento_origen WHERE asiento_id = ?', [o.asiento_id]);
  if (Number(n) > 1) return null;
  const [lineas] = await db.query('SELECT cuenta_id, debe, haber, detalle FROM con_asiento_lineas WHERE asiento_id = ?', [o.asiento_id]);
  return lineas.map((l) => ({ ...l, debe: num(l.debe), haber: num(l.haber) }));
};

// ---- Compras ----

const lineasCompra = async (db, formulario, c, fecha) => {
  const out = [];
  const gasto = r2(num(c.neto_gravado) + num(c.no_gravado) + num(c.exento) + num(c.impuestos_internos) + num(c.otros_tributos) + (num(c.iva) - num(c.iva_computable)));
  const percepciones = r2(num(c.percepciones_iva) + num(c.percepciones_iibb));
  if (gasto > 0) out.push(...linea(await resolver(db, formulario, 'gasto', '*', fecha), gasto, 'Compra o gasto'));
  if (num(c.iva_computable) > 0) out.push(...linea(await resolver(db, formulario, 'iva', null, fecha), r2(num(c.iva_computable)), 'IVA crédito fiscal'));
  if (percepciones > 0) out.push(...linea(await resolver(db, formulario, 'percepcion', null, fecha), percepciones, 'Percepciones'));
  return out;
};
// El comprobante de compra se registra al cargarse la factura; una nota de crédito invierte las cuentas por su propio formulario (RN11).
registrar('comprobante_compra', { formulario: 'comprobante_compra', modulo: 'compras', importe: (c) => c.total, relacionado: (c) => c.comprobante_id_global,
  construir: (db, c, f) => lineasCompra(db, c.clase === 'NOTA_CREDITO' ? 'nota_credito_compra' : 'comprobante_compra', c, f) });
registrar('comprobante_compra_anulado', { formulario: 'comprobante_compra', modulo: 'compras', reprocesable: false, importe: () => null,
  esperar: (conn, c) => esperarMensajes(conn, c.comprobante_id_global, ['comprobante_compra'], 'el comprobante que se anula'),
  construir: async (db, c) => invertir(await lineasDelOriginal(db, 'comprobante_compra', c.comprobante_id_global) ?? []) });

// Orden de pago: cancela la deuda con el proveedor contra los medios de pago y las retenciones practicadas.
registrar('orden_pago', { formulario: 'orden_pago', modulo: 'compras', importe: (c) => c.deuda_aplicada,
  construir: async (db, c, f) => {
    const out = [];
    if (num(c.medios) > 0) out.push(...linea(await resolver(db, 'orden_pago', 'pago', '*', f), r2(num(c.medios)), 'Pago al proveedor'));
    if (num(c.retenciones) > 0) out.push(...linea(await resolver(db, 'orden_pago', 'retencion', null, f), r2(num(c.retenciones)), 'Retenciones practicadas'));
    return out;
  } });
registrar('orden_pago_anulada', { formulario: 'orden_pago', modulo: 'compras', reprocesable: false, importe: () => null,
  esperar: (conn, c) => esperarMensajes(conn, c.orden_id_global, ['orden_pago'], 'la orden de pago que se anula'),
  construir: async (db, c) => invertir(await lineasDelOriginal(db, 'orden_pago', c.orden_id_global) ?? []) });

// ---- Clientes: retenciones sufridas ----

registrar('retencion_sufrida', { formulario: 'retencion_sufrida', modulo: 'clientes', importe: (c) => c.importe, relacionado: (c) => c.recibo,
  construir: async (db, c, f) => linea(await resolver(db, 'retencion_sufrida', 'retencion', null, f), r2(num(c.importe)), `${c.impuesto ?? 'Retención'} ${c.nro_certificado ?? ''}`.trim()) });

// ---- Financiero: diferencias de caja y reaperturas ----

// Cada cierre del turno informa la diferencia de su versión; un cierre posterior a una reapertura corrige solo el cambio respecto de lo ya contabilizado (RN20, EX14).
registrar('cierre_turno', { formulario: 'diferencia_caja', modulo: 'financiero', importe: (c) => c.diferencia,
  construir: async (db, c, f, ctx) => {
    const [previos] = await db.query("SELECT o.contenido FROM con_asiento_origen o WHERE o.tipo_documento = 'cierre_turno' AND o.id_documento = ? AND o.id_operacion <> ?", [ctx.docIdGlobal, ctx.idOperacion]);
    const ya = previos.reduce((s, p) => s + num(JSON.parse(p.contenido ?? '{}').diferencia), 0);
    const delta = r2(num(c.diferencia) - ya);
    if (delta === 0) return [];
    const regla = await resolver(db, 'diferencia_caja', delta < 0 ? 'faltante' : 'sobrante', '*', f);
    return linea(regla, Math.abs(delta), `Arqueo ${c.caja ?? ''}`.trim());
  } });
// La reapertura no es un asiento: el nuevo cierre corrige la diferencia. Se confirma sin asiento y queda en el listado de origen.
registrar('reapertura_turno', { formulario: 'diferencia_caja', modulo: 'financiero', reprocesable: false, importe: () => null, construir: async () => [] });

// ---- Clientes: gift cards y vales ----

// Quien recibe el dinero de una gift card es la forma de pago de la venta que la vendió, tomada del exceso de cobro sobre el comprobante (RF25).
const formaDeEmision = async (db, ventaIdGlobal, importe) => {
  const [[o]] = await db.query("SELECT contenido FROM con_asiento_origen WHERE id_documento = ? AND tipo_documento IN ('venta_confirmada', 'venta_regularizada') ORDER BY id LIMIT 1", [ventaIdGlobal]);
  if (!o?.contenido) return '*';
  const v = JSON.parse(o.contenido);
  const { total } = Auto.neto(v.lineas_contables);
  let resto = cts(total), pendiente = cts(importe);
  for (const p of v.pagos ?? []) {
    const forma = p.forma ?? p.metodo_pago;
    const importePago = cts(p.importe);
    const tomado = Math.min(importePago, resto);
    resto -= tomado;
    const exceso = importePago - tomado;
    if (exceso > 0 && pendiente > 0 && forma !== 'cuenta_corriente') return forma;
  }
  return '*';
};
registrar('pasivo_instrumento', { formulario: 'emision_gift_card', modulo: 'clientes', importe: (c) => c.importe, relacionado: (c) => c.venta_id_global,
  esperar: (conn, c) => esperarMensajes(conn, c.venta_id_global, ['venta_confirmada', 'venta_regularizada'], 'la venta del instrumento'),
  construir: async (db, c, f) => {
    if (c.tipo === 'vale') return linea(await resolver(db, 'emision_vale', 'emision', '*', f), r2(num(c.importe)), 'Emisión de vale');
    return linea(await resolver(db, 'emision_gift_card', 'emision', await formaDeEmision(db, c.venta_id_global, c.importe), f), r2(num(c.importe)), 'Emisión de gift card');
  } });
registrar('vencimiento_instrumento', { formulario: 'vencimiento_saldo', modulo: 'clientes', importe: (c) => c.importe,
  construir: async (db, c, f) => linea(await resolver(db, 'vencimiento_saldo', 'vencimiento', '*', f), r2(num(c.importe)), `Vencimiento de ${c.tipo ?? 'saldo'}`) });

// ---- Ventas: comisiones y remitos ----

registrar('comision_liquidada', { formulario: 'comision_vendedor', modulo: 'ventas', importe: (c) => c.total, relacionado: (c) => c.liquidacion_id_global,
  construir: async (db, c, f) => linea(await resolver(db, 'comision_vendedor', 'devengo', '*', f), r2(num(c.total)), 'Comisión de vendedores') });
// Un remito asignado a la cuenta de un cliente es deuda, no venta: debe en Deudores, haber en el transitorio «Remitos a facturar» (RF24).
registrar('remito_emitido', { formulario: 'remito_a_facturar', modulo: 'ventas', importe: (c) => c.importe, relacionado: (c) => c.remito_id_global,
  construir: async (db, c, f) => linea(await resolver(db, 'remito_a_facturar', 'remito', null, f), r2(num(c.importe)), `Remito ${c.remito_id_global ?? ''}`.trim()) });

// ---- Stock: costo de ventas y mermas ----

// El costo de la venta es el costo unitario congelado en el movimiento de Stock que la descontó, por categoría de artículo; Contable no lo recalcula (RN11).
registrar('costo_venta', { formulario: 'costo_ventas', modulo: 'stock', importe: (c) => c.total_costo, relacionado: (c) => c.documento,
  construir: async (db, c, f) => {
    const out = [];
    for (const [comp, importe] of [['insumos', r2(num(c.insumos))], ['packaging', r2(num(c.packaging))]])
      if (importe > 0) out.push(...linea(await resolver(db, 'costo_ventas', comp, '*', f), importe, 'Costo de ventas'));
    return out;
  } });
registrar('merma_produccion', { formulario: 'merma_produccion', modulo: 'stock', importe: (c) => c.importe,
  construir: async (db, c, f) => linea(await resolver(db, 'merma_produccion', 'merma', c.motivo ?? '*', f), r2(num(c.importe)), `Merma ${c.motivo ?? ''}`.trim()) });

module.exports = { lineasDelOriginal, invertir, formaDeEmision };
