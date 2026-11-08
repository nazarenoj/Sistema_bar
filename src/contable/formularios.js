// Formularios de imputación (Contable RF03): un formulario por tipo de documento o evento que informa cada módulo. Cada componente es una línea del asiento (debe y haber por defecto,
// dados por la clave semántica de la cuenta del plan). Un formulario de un módulo no instalado, o de una función desactivada, no se ofrece para crear reglas nuevas.
// [id, nombre, módulo, requisito, pasivoEnHaber, componentes: [[componente, debe, haber, criterio, descripción]]]
const F = (id, nombre, modulo, requisito, componentes, extra = {}) => ({ id, nombre, modulo, requisito, componentes: componentes.map(([componente, debe, haber, criterio, descripcion]) => ({ componente, debe, haber, criterio: criterio ?? null, descripcion })), ...extra });

const VENTA = [
  ['ingreso', 'deudores', 'ventas_salon', 'modalidad', 'Venta neta de IVA'],
  ['iva', 'deudores', 'iva_debito', null, 'IVA débito fiscal'],
  ['cobro', 'caja', 'deudores', 'forma_pago', 'Cobro por forma de pago'],
];
const NOTA_CREDITO = [
  ['ingreso', 'ventas_salon', 'deudores', 'modalidad', 'Devolución de venta neta de IVA'],
  ['iva', 'iva_debito', 'deudores', null, 'IVA débito fiscal revertido'],
  ['cobro', 'deudores', 'caja', 'forma_pago', 'Reintegro por forma de pago'],
];

const FORMULARIOS = [
  F('venta', 'Comprobante de venta', 'ventas', null, VENTA),
  F('nota_credito_venta', 'Nota de crédito de venta', 'ventas', null, NOTA_CREDITO),
  F('nota_debito_venta', 'Nota de débito de venta', 'ventas', null, VENTA.slice(0, 2)),
  F('venta_regularizada', 'Venta regularizada', 'ventas', null, VENTA),
  F('remito_a_facturar', 'Remito a facturar', 'ventas', { funcion: 'VEN-CC' }, [['remito', 'deudores', 'remitos_a_facturar', null, 'Remito asignado a la cuenta de un cliente']]),
  F('factura_de_remitos', 'Factura de remitos', 'ventas', { funcion: 'VEN-CC' }, [
    ['remitos', 'remitos_a_facturar', 'deudores', null, 'Cancela los remitos informados'],
    ['ingreso', 'deudores', 'ventas_salon', 'modalidad', 'Venta neta de IVA'], ['iva', 'deudores', 'iva_debito', null, 'IVA débito fiscal']]),
  F('emision_gift_card', 'Emisión de gift card', 'clientes', { funcion: 'CLI-FIDEL' }, [['emision', 'caja', 'gift_cards', 'forma_pago', 'Deuda hasta el canje']], { pasivoEnHaber: true }),
  F('emision_vale', 'Emisión de vale', 'clientes', { funcion: 'CLI-FIDEL' }, [['emision', 'caja', 'vales', null, 'Deuda hasta el canje']], { pasivoEnHaber: true }),
  F('canje_gift_card', 'Canje de gift card o vale', 'ventas', { funcion: 'CLI-FIDEL' }, [['canje', 'gift_cards', 'deudores', null, 'Cancela la deuda al canjear']]),
  F('vencimiento_saldo', 'Vencimiento de gift card o vale', 'clientes', { funcion: 'CLI-FIDEL' }, [['vencimiento', 'gift_cards', 'vencimiento_saldos', null, 'Saldo vencido a resultado']]),
  F('comision_vendedor', 'Comisión de vendedor', 'ventas', { funcion: 'VEN-COMISIONES' }, [['devengo', 'comisiones_vendedores', 'comisiones_a_pagar', null, 'Comisión devengada']], { pasivoEnHaber: true }),
  F('pago_comision', 'Pago de comisión', 'financiero', { funcion: 'VEN-COMISIONES' }, [['pago', 'comisiones_a_pagar', 'caja', 'medio', 'Pago de la comisión']]),
  F('comision_plataforma', 'Comisión de plataforma', 'financiero', { funcion: 'ONL-MARKETPLACES' }, [['comision', 'comisiones_plataformas', 'plataformas_a_cobrar', null, 'Comisión descontada en la liquidación']]),
  F('liquidacion_plataforma', 'Liquidación de plataforma', 'financiero', { funcion: 'ONL-MARKETPLACES' }, [['cobro', 'bancos', 'plataformas_a_cobrar', null, 'Acreditación de la plataforma']]),
  F('comprobante_compra', 'Comprobante de compra', 'compras', null, [
    ['gasto', 'compras', 'proveedores', 'categoria', 'Compra o gasto neto de IVA'],
    ['iva', 'iva_credito', 'proveedores', null, 'IVA crédito fiscal'],
    ['percepcion', 'retenciones_sufridas', 'proveedores', null, 'Percepciones sufridas']]),
  F('nota_credito_compra', 'Nota de crédito de compra', 'compras', null, [
    ['gasto', 'proveedores', 'compras', 'categoria', 'Compra o gasto revertido'],
    ['iva', 'proveedores', 'iva_credito', null, 'IVA crédito fiscal revertido'],
    ['percepcion', 'proveedores', 'retenciones_sufridas', null, 'Percepciones revertidas']]),
  F('orden_pago', 'Orden de pago', 'compras', null, [
    ['pago', 'proveedores', 'caja', 'medio', 'Pago al proveedor'],
    ['retencion', 'proveedores', 'retenciones_a_depositar', null, 'Retenciones practicadas']]),
  F('retencion_sufrida', 'Retención sufrida', 'clientes', null, [['retencion', 'retenciones_sufridas', 'deudores', null, 'Retención que practicó un cliente']]),
  F('costo_ventas', 'Costo de ventas', 'stock', null, [
    ['insumos', 'costo_insumos', 'insumos', 'categoria', 'Costo de insumos'],
    ['packaging', 'costo_packaging', 'packaging', 'categoria', 'Costo de packaging']]),
  F('merma_produccion', 'Merma de producción', 'stock', null, [['merma', 'mermas', 'insumos', 'motivo', 'Desperdicio, vencimientos y desvío fuera de tolerancia']]),
  F('produccion', 'Producción valorizada', 'stock', { funcion: 'STK-PRODUCCION' }, [['produccion', 'productos_elaborados', 'insumos', null, 'Insumos consumidos por el producto terminado']]),
  F('gasto', 'Gasto', 'financiero', null, [['gasto', 'compras', 'caja', 'categoria', 'Gasto pagado por caja o cuenta']]),
  F('diferencia_caja', 'Diferencia de caja', 'financiero', null, [
    ['faltante', 'diferencias_caja', 'caja', null, 'Faltante en el arqueo'],
    ['sobrante', 'caja', 'diferencias_caja', null, 'Sobrante en el arqueo']]),
  F('diferencia_cambio', 'Diferencia de cambio', 'financiero', null, [
    ['perdida', 'diferencias_cambio', 'bancos', null, 'Pérdida por tipo de cambio'],
    ['ganancia', 'bancos', 'diferencias_cambio_pos', null, 'Ganancia por tipo de cambio']]),
];

const porId = (id) => FORMULARIOS.find((f) => f.id === id) ?? null;
const componente = (formulario, comp) => porId(formulario)?.componentes.find((c) => c.componente === comp) ?? null;
// Los que se ofrecen para crear reglas nuevas: módulo instalado y función activa (`cumple` decide por requisito).
const disponibles = (instalado, funciones) => FORMULARIOS.filter((f) => (f.modulo === 'ventas' || f.modulo === 'usuarios' || instalado(f.modulo)) && (!f.requisito?.funcion || funciones.has(f.requisito.funcion)));

module.exports = { FORMULARIOS, porId, componente, disponibles };
