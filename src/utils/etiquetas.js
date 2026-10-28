// Etiquetas legibles de los códigos que se guardan en la base, compartidas por los controllers y
// los servicios de reportes para que no se dupliquen (antes estaban repetidas en
// facturaController.js y en el frontend).

const TIPO_COMPROBANTE_LABEL = { 1: 'Factura A', 6: 'Factura B', 11: 'Factura C' };

// Versión corta, para columnas angostas (la tabla del historial muestra solo la letra).
const TIPO_COMPROBANTE_LETRA = { 1: 'A', 6: 'B', 11: 'C' };

const METODO_PAGO_LABEL = {
  efectivo: 'Efectivo',
  mixto: 'Mixto',
  tarjeta_debito: 'Tarjeta débito',
  tarjeta_credito: 'Tarjeta crédito',
  transferencia: 'Transferencia',
  otro: 'Otro',
};

const ESTADO_FACTURA_LABEL = {
  pendiente: 'Pendiente',
  aprobada: 'Aprobada',
  rechazada: 'Rechazada',
  error: 'Error ARCA',
};

// Devuelve la etiqueta del mapa o, si el código no está mapeado, el código crudo (nunca vacío:
// en un reporte contable es peor perder el dato que mostrar un número sin traducir).
const etiqueta = (mapa, valor, fallback = '—') =>
  valor === null || valor === undefined || valor === '' ? fallback : (mapa[valor] ?? String(valor));

module.exports = {
  TIPO_COMPROBANTE_LABEL,
  TIPO_COMPROBANTE_LETRA,
  METODO_PAGO_LABEL,
  ESTADO_FACTURA_LABEL,
  etiqueta,
};
