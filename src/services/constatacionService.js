// Constatación de comprobantes recibidos en ARCA (Compras RF14 por la llamada n.º 14; Compras no tiene conexión propia con ARCA). El transporte es reemplazable: con el servicio de
// ARCA configurado responde si el CAE es válido; sin él lanza un error y Compras deja el comprobante «pendiente de constatar».
// shortcut: el cliente real del servicio de constatación (WSCDC) todavía no está conectado; hasta entonces responde que no está disponible. Se enchufa con usarTransporte.
let transporte = async () => { throw new Error('El servicio de constatación de ARCA no está disponible.'); };
const usarTransporte = (fn) => { transporte = fn; };

// -> { valido: boolean, detalle? }
const constatar = async ({ cuit_emisor: cuit, tipo_codigo: tipo, punto_venta: pv, numero, fecha, importe, cae }) => {
  if (!cae) return { valido: false, detalle: 'El comprobante no tiene CAE.' };
  return transporte({ cuit_emisor: cuit, tipo_codigo: tipo, punto_venta: pv, numero, fecha, importe, cae });
};

module.exports = { constatar, usarTransporte };
