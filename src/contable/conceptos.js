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

// En moneda extranjera los libros se llevan en pesos: se convierte a la cotización del comprobante y el detalle conserva el importe en divisa (RN10).
const lineasCompra = async (db, formulario, c, fecha) => {
  const out = [];
  const k = c.moneda && c.moneda !== 'ARS' && num(c.cotizacion) > 0 ? num(c.cotizacion) : 1;
  const en = (x) => r2(num(x) * k);
  const nota = k !== 1 ? ` (${c.moneda} a ${k})` : '';
  const cuerpo = en(num(c.neto_gravado) + num(c.no_gravado) + num(c.exento));
  const mercaderia = Math.min(en(c.neto_mercaderia), cuerpo); // lo que ingresa a Stock va a Insumos; el resto, a gasto
  const gasto = r2(cuerpo - mercaderia + en(num(c.impuestos_internos) + num(c.otros_tributos) + (num(c.iva) - num(c.iva_computable))));
  const percepciones = en(num(c.percepciones_iva) + num(c.percepciones_iibb));
  if (mercaderia > 0) out.push(...linea(await resolver(db, formulario, 'insumos', null, fecha), mercaderia, `Mercadería${nota}`));
  if (gasto > 0) out.push(...linea(await resolver(db, formulario, 'gasto', '*', fecha), gasto, `Compra o gasto${nota}`));
  if (num(c.iva_computable) > 0) out.push(...linea(await resolver(db, formulario, 'iva', null, fecha), en(c.iva_computable), `IVA crédito fiscal${nota}`));
  if (percepciones > 0) out.push(...linea(await resolver(db, formulario, 'percepcion', null, fecha), percepciones, `Percepciones${nota}`));
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
    // Cada medio de pago va a la caja o al banco que le corresponde; sin el detalle, todo por el criterio general.
    const medios = c.medios_detalle?.length ? c.medios_detalle : [{ clase: '*', importe: c.medios }];
    for (const m of medios) if (num(m.importe) > 0) out.push(...linea(await resolver(db, 'orden_pago', 'pago', m.clase, f), r2(num(m.importe)), 'Pago al proveedor'));
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
  construir: async (db, c, f) => linea(await resolver(db, 'vencimiento_saldo', 'vencimiento', c.tipo === 'vale' ? 'vale' : '*', f), r2(num(c.importe)), `Vencimiento de ${c.tipo ?? 'saldo'}`) });

// ---- Ventas: comisiones y remitos ----

registrar('comision_liquidada', { formulario: 'comision_vendedor', modulo: 'ventas', importe: (c) => c.total, relacionado: (c) => c.liquidacion_id_global,
  construir: async (db, c, f) => linea(await resolver(db, 'comision_vendedor', 'devengo', '*', f), r2(num(c.total)), 'Comisión de vendedores') });
// Un remito asignado a la cuenta de un cliente es deuda, no venta: debe en Deudores, haber en el transitorio «Remitos a facturar» (RF24).
registrar('remito_emitido', { formulario: 'remito_a_facturar', modulo: 'ventas', importe: (c) => c.importe, relacionado: (c) => c.remito_id_global,
  construir: async (db, c, f) => linea(await resolver(db, 'remito_a_facturar', 'remito', null, f), r2(num(c.importe)), `Remito ${c.remito_id_global ?? ''}`.trim()) });

// La factura que cancela remitos reconoce la venta y el IVA y baja el transitorio «Remitos a facturar» (RF24, RN35); la anulación de un remito invierte su deuda.
registrar('factura_remitos', { formulario: 'factura_de_remitos', modulo: 'ventas', importe: (c) => c.total, relacionado: (c) => c.factura_id_global,
  esperar: async (conn, c) => { for (const rm of c.remitos ?? []) await esperarMensajes(conn, rm.remito_id_global, ['remito_emitido'], 'un remito de la factura'); },
  construir: async (db, c, f) => {
    const out = [];
    const { neto: n, iva } = Auto.neto(c.lineas_contables);
    const remitos = r2((c.remitos ?? []).reduce((s, rm) => s + num(rm.importe), 0));
    if (remitos > 0) out.push(...linea(await resolver(db, 'factura_de_remitos', 'remitos', null, f), remitos, 'Remitos cancelados'));
    if (n > 0) out.push(...linea(await resolver(db, 'factura_de_remitos', 'ingreso', c.modalidad ?? 'mayorista', f), n, 'Venta de remitos'));
    if (iva > 0) out.push(...linea(await resolver(db, 'factura_de_remitos', 'iva', null, f), iva, 'IVA'));
    return out;
  } });
registrar('remito_anulado', { formulario: 'remito_a_facturar', modulo: 'ventas', reprocesable: false, importe: () => null,
  esperar: (conn, c) => esperarMensajes(conn, c.remito_id_global, ['remito_emitido'], 'el remito que se anula'),
  construir: async (db, c) => invertir(await lineasDelOriginal(db, 'remito_emitido', c.remito_id_global) ?? []) });

// ---- Stock: producción, costo de ventas y mermas ----

// Los insumos consumidos por una tanda pasan a Productos elaborados al costo real (RF20); la merma fuera de tolerancia se imputa aparte.
registrar('produccion_confirmada', { formulario: 'produccion', modulo: 'stock', importe: (c) => c.importe, relacionado: (c) => c.orden,
  construir: async (db, c, f) => linea(await resolver(db, 'produccion', 'produccion', null, f), r2(num(c.importe)), `Producción ${c.orden ?? ''}`.trim()) });
registrar('egreso_stock', { formulario: 'ajuste_stock', modulo: 'stock', importe: (c) => c.importe, relacionado: (c) => c.documento,
  construir: async (db, c, f) => linea(await resolver(db, 'ajuste_stock', 'egreso', c.motivo ?? '*', f), r2(num(c.importe)), `Egreso ${c.motivo ?? ''}`.trim()) });

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

// ---- Financiero y recibos (Contable RF03, RF18, RF19, RN32) ----

const medio = (c) => c.medio ?? 'caja';
registrar('gasto_registrado', { formulario: 'gasto', modulo: 'financiero', importe: (c) => c.importe, relacionado: (c) => c.gasto_id_global,
  construir: async (db, c, f) => {
    const iva = r2(num(c.iva)), neto = r2(num(c.importe) - iva), out = [];
    if (neto > 0) out.push(...linea(await resolver(db, 'gasto', 'gasto', medio(c), f), neto, c.categoria ?? 'Gasto'));
    if (iva > 0) out.push(...linea(await resolver(db, 'gasto', 'iva', medio(c), f), iva, 'IVA crédito fiscal'));
    return out;
  } });
registrar('gasto_anulado', { formulario: 'gasto', modulo: 'financiero', reprocesable: false, importe: () => null,
  esperar: (conn, c) => esperarMensajes(conn, c.gasto_id_global, ['gasto_registrado'], 'el gasto que se anula'),
  construir: async (db, c) => invertir(await lineasDelOriginal(db, 'gasto_registrado', c.gasto_id_global) ?? []) });

registrar('pago_comision', { formulario: 'pago_comision', modulo: 'financiero', importe: (c) => c.importe, relacionado: (c) => c.liquidacion_id_global,
  construir: async (db, c, f) => linea(await resolver(db, 'pago_comision', 'pago', medio(c), f), r2(num(c.importe)), 'Pago de comisiones') });
registrar('pago_comision_anulado', { formulario: 'pago_comision', modulo: 'financiero', reprocesable: false, importe: () => null,
  esperar: (conn, c) => esperarMensajes(conn, c.liquidacion_id_global, ['pago_comision'], 'el pago que se anula'),
  construir: async (db, c) => invertir(await lineasDelOriginal(db, 'pago_comision', c.liquidacion_id_global) ?? []) });

registrar('transferencia_cuentas', { formulario: 'transferencia_cuentas', modulo: 'financiero', importe: (c) => c.importe, relacionado: (c) => c.transferencia_id_global,
  construir: async (db, c, f) => linea(await resolver(db, 'transferencia_cuentas', 'traspaso', `${c.desde}>${c.hacia}`, f), r2(num(c.importe)), `Traspaso ${c.desde} a ${c.hacia}`) });

// Lo que descuenta el procesador de tarjetas o billeteras: comisión, IVA de la comisión y retenciones y percepciones.
registrar('liquidacion_tarjeta', { formulario: 'liquidacion_tarjeta', modulo: 'financiero', importe: (c) => r2(num(c.comision) + num(c.iva) + num(c.retenciones) + num(c.percepciones)), relacionado: (c) => c.liquidacion_id_global,
  construir: async (db, c, f) => {
    const out = [];
    for (const [comp, importe] of [['comision', num(c.comision)], ['iva', num(c.iva)], ['retencion', num(c.retenciones) + num(c.percepciones)]])
      if (r2(importe) > 0) out.push(...linea(await resolver(db, 'liquidacion_tarjeta', comp, null, f), r2(importe), `Liquidación ${c.referencia ?? ''}`.trim()));
    return out;
  } });

// Plataformas de delivery y marketplaces [ONL-MARKETPLACES]: la comisión es un gasto aparte y la liquidación cancela lo que la plataforma debía (RN24).
registrar('comision_de_plataforma', { formulario: 'comision_plataforma', modulo: 'financiero', importe: (c) => c.importe, relacionado: (c) => c.pedido_global,
  construir: async (db, c, f) => linea(await resolver(db, 'comision_plataforma', 'comision', null, f), r2(num(c.importe)), `Comisión ${c.plataforma ?? ''}`.trim()) });
registrar('liquidacion_de_plataforma', { formulario: 'liquidacion_plataforma', modulo: 'financiero', importe: (c) => c.importe, relacionado: (c) => c.id_liquidacion,
  construir: async (db, c, f) => linea(await resolver(db, 'liquidacion_plataforma', 'cobro', null, f), r2(num(c.importe)), `Liquidación ${c.plataforma ?? ''}`.trim()) });
registrar('diferencia_conciliacion', { formulario: 'diferencia_conciliacion', modulo: 'financiero', importe: (c) => c.importe, relacionado: (c) => c.id_liquidacion,
  construir: async (db, c, f) => linea(await resolver(db, 'diferencia_conciliacion', num(c.importe) > 0 ? 'faltante' : 'sobrante', null, f), r2(Math.abs(num(c.importe))), 'Diferencia de conciliación') });

// Cobro de un recibo de cuenta corriente: la caja o el banco contra Deudores, por forma de pago.
registrar('recibo_cobro', { formulario: 'recibo_cobro', modulo: 'clientes', importe: (c) => r2((c.valores ?? []).reduce((s, v) => s + num(v.importe), 0)), relacionado: (c) => c.recibo,
  construir: async (db, c, f) => {
    const out = [];
    for (const v of c.valores ?? []) out.push(...linea(await resolver(db, 'recibo_cobro', 'cobro', v.forma, f), r2(num(v.importe)), `Recibo ${c.recibo}`));
    return out;
  } });

module.exports = { lineasDelOriginal, invertir, formaDeEmision };
