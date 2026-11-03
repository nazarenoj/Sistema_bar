const afipService = require('./afipService');
const afipConfig = require('../config/afipConfig');

// Servicio de emisión de notas de débito y crédito para otros módulos (Ventas RF17; lo llama Clientes y CC, llamada n.º 12). Elige la letra según
// el receptor y lo que puede emitir el emisor, y pide el CAE con la misma clave de emisión para que un reintento no emita dos comprobantes (Clientes RN39).
// shortcut: la nota no se registra en la tabla `facturas` (está atada a una mesa y a una sesión): el CAE y el número quedan en el movimiento de la cuenta
// corriente. Falta llevarlas al libro IVA; sacar esto cuando `facturas` admita comprobantes sin venta.
const ND_DE = { 1: 2, 6: 7, 11: 12 }; // Factura A/B/C -> Nota de Débito A/B/C
const NC_DE = { 1: 3, 6: 8, 11: 13 }; // Factura A/B/C -> Nota de Crédito A/B/C

const letraFactura = (receptor) => {
  const validos = afipService.TIPOS_VALIDOS_POR_CONDICION[afipConfig.condicionIvaEmisor] ?? [];
  if (validos.includes(1) && receptor.condicion_iva_receptor_id === 1 && receptor.doc_tipo === 80) return 1;
  if (validos.includes(6)) return 6;
  return 11;
};

// receptor: { doc_tipo, doc_nro, condicion_iva_receptor_id }; asociado: { Tipo, PtoVta, Nro } del comprobante que corrige (opcional).
const emitir = async ({ tipo, receptor, importe, asociado = null, idIntento }) => {
  const base = letraFactura(receptor);
  const tipoComprobante = (tipo === 'nd' ? ND_DE : NC_DE)[base];
  const r = await afipService.emitirFactura({
    tipoComprobante, docTipo: receptor.doc_tipo, docNro: receptor.doc_nro, condicionIvaReceptorId: receptor.condicion_iva_receptor_id,
    importeTotal: importe, idIntento, comprobanteAsociado: asociado,
  });
  return { tipo_comprobante: tipoComprobante, punto_venta: afipConfig.puntoVenta, numero: r.numero, cae: r.cae, cae_vencimiento: r.caeVencimiento ?? null, estado: r.estado };
};

module.exports = { emitir };
