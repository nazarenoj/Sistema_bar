const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const afipConfig = require('../config/afipConfig');

const NEGOCIO_NOMBRE = process.env.TICKET_NEGOCIO_NOMBRE || 'Cafetería';

const MM_TO_PT = 2.83465;
const ANCHO = Math.round(80 * MM_TO_PT); // mismo ancho térmico 80mm que ticketService.js
const MARGEN = 14;
const ANCHO_UTIL = ANCHO - MARGEN * 2;

const TIPOS_COMPROBANTE = { 1: 'FACTURA A', 6: 'FACTURA B', 11: 'FACTURA C', 3: 'NOTA DE CRÉDITO A', 8: 'NOTA DE CRÉDITO B', 13: 'NOTA DE CRÉDITO C' };
const CONDICION_IVA_EMISOR_LABEL = {
  monotributista: 'Monotributista',
  responsable_inscripto: 'IVA Responsable Inscripto',
};
const DOC_TIPO_LABEL = { 80: 'CUIT', 96: 'DNI', 99: 'Consumidor Final' };
// Mismos códigos ARCA que CONDICIONES_IVA_RECEPTOR en CierreCuentaModal.jsx.
const CONDICION_IVA_RECEPTOR_LABEL = {
  5: 'Consumidor Final',
  1: 'Responsable Inscripto',
  6: 'Monotributista',
  4: 'Exento',
  7: 'No Categorizado',
};

const formatFecha = (fecha) => (fecha ? new Date(fecha).toLocaleString('es-AR', { hour12: false }) : '—');
const formatMoneda = (n) => `$${Number(n).toFixed(2)}`;

const linea = (doc) => {
  doc.moveTo(MARGEN, doc.y).lineTo(ANCHO - MARGEN, doc.y).stroke();
  doc.moveDown(0.5);
};

// Arma la URL con el payload del QR obligatorio (RG 4892). Antes de pasar a producción,
// reconfirmar el esquema JSON exacto y la URL base contra la especificación vigente de ARCA
// (la documentación se está migrando a arca.gob.ar y podría cambiar el prefijo aunque los web
// services no se muevan).
const armarUrlQr = (factura) => {
  const payload = {
    ver: 1,
    fecha: new Date(factura.fecha_cae || factura.fecha_emision).toISOString().slice(0, 10),
    cuit: Number(afipConfig.cuit),
    ptoVta: factura.punto_venta,
    tipoCmp: factura.tipo_comprobante,
    nroCmp: factura.numero,
    importe: Number(factura.importe_total),
    moneda: factura.moneda || 'PES',
    ctz: 1,
    tipoDocRec: factura.doc_tipo,
    nroDocRec: Number(factura.doc_nro),
    tipoCodAut: 'E',
    codAut: Number(factura.cae),
  };
  const base64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `https://www.afip.gob.ar/fe/qr/?p=${base64}`;
};

// Genera el PDF fiscal (con CAE y QR) de una cuenta ya facturada y lo escribe en el stream de la
// respuesta HTTP. Mismo ancho térmico 80mm que el ticket interno, para imprimirse en la misma
// impresora de mostrador que ya usa el local.
// `copia`: 'ORIGINAL' para la impresión al cerrar la cuenta, 'DUPLICADO' cuando se reimprime desde
// el historial (ver facturaController.getPdf vs ticketController.ticketCuentaMesa).
const generarFacturaPDF = async (res, factura, { items = [], copia = 'ORIGINAL' } = {}) => {
  const qrBuffer = await QRCode.toBuffer(armarUrlQr(factura), { margin: 1, width: 130 });

  const alto = Math.max(520, 390 + items.length * 26);
  const doc = new PDFDocument({ size: [ANCHO, alto], margin: MARGEN });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="factura-${factura.id}.pdf"`);
  doc.pipe(res);

  doc.font('Helvetica-Bold').fontSize(13).text(NEGOCIO_NOMBRE, { align: 'center' });
  doc.font('Helvetica').fontSize(8);
  if (afipConfig.razonSocial) doc.text(afipConfig.razonSocial, { align: 'center' });
  doc.text(`CUIT: ${afipConfig.cuit}`, { align: 'center' });
  doc.text(CONDICION_IVA_EMISOR_LABEL[afipConfig.condicionIvaEmisor] || '', { align: 'center' });
  if (afipConfig.domicilioComercial) doc.text(afipConfig.domicilioComercial, { align: 'center' });
  if (afipConfig.ingresosBrutos) doc.text(`Ingresos Brutos: ${afipConfig.ingresosBrutos}`, { align: 'center' });
  if (afipConfig.inicioActividades) {
    doc.text(`Inicio de actividades: ${new Date(afipConfig.inicioActividades).toLocaleDateString('es-AR')}`, { align: 'center' });
  }
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(9).text(copia.toUpperCase(), { align: 'center' });
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .text(TIPOS_COMPROBANTE[factura.tipo_comprobante] || 'COMPROBANTE', { align: 'center' });
  doc
    .font('Helvetica')
    .fontSize(9)
    .text(`Punto de Venta: ${String(factura.punto_venta).padStart(4, '0')}`, { align: 'center' })
    .text(`Comprobante N°: ${String(factura.numero).padStart(8, '0')}`, { align: 'center' });
  doc.moveDown(0.5);
  linea(doc);

  doc.fontSize(8.5);
  doc.text(`Fecha: ${formatFecha(factura.fecha_emision)}`);
  doc.text(`Receptor: ${DOC_TIPO_LABEL[factura.doc_tipo] || factura.doc_tipo} ${factura.doc_nro}`);
  doc.text(`Condición IVA: ${CONDICION_IVA_RECEPTOR_LABEL[factura.condicion_iva_receptor_id] || factura.condicion_iva_receptor_id}`);
  if (factura.receptor_nombre) doc.text(factura.receptor_nombre);
  if (factura.domicilio_receptor) doc.text(factura.domicilio_receptor);
  doc.moveDown(0.4);
  linea(doc);

  if (items.length) {
    doc.fontSize(8);
    for (const item of items) {
      doc.font('Helvetica-Bold').text(item.nombre, MARGEN, doc.y, { width: ANCHO_UTIL });
      doc.font('Helvetica');
      const y = doc.y;
      doc.text(`${item.cantidad} x ${formatMoneda(item.precio_unitario)}`, MARGEN, y, { width: ANCHO_UTIL * 0.55 });
      doc.text(formatMoneda(item.subtotal), MARGEN, y, { width: ANCHO_UTIL, align: 'right' });
      doc.moveDown(0.4);
    }
    linea(doc);
  }

  doc.fontSize(9);
  // "Total sin impuestos nacionales" va siempre, incluso en Factura C: ahí coincide con el TOTAL
  // porque el monotributista no discrimina IVA y este sistema no carga Otros Tributos (ImpTrib
  // queda en 0, ver afipService.calcularImportes), pero el renglón igual tiene que figurar.
  doc.text(`Total sin impuestos nacionales: ${formatMoneda(factura.importe_neto)}`, { align: 'right' });
  if (![11, 13].includes(factura.tipo_comprobante)) {
    doc.text(`IVA: ${formatMoneda(factura.importe_iva)}`, { align: 'right' });
  }
  doc.font('Helvetica-Bold').fontSize(11).text(`TOTAL: ${formatMoneda(factura.importe_total)}`, { align: 'right' });
  doc.moveDown(0.6);
  linea(doc);

  doc.font('Helvetica').fontSize(7.5);
  doc.text(`CAE: ${factura.cae}`);
  doc.text(`Vto. CAE: ${factura.cae_vencimiento ? new Date(factura.cae_vencimiento).toLocaleDateString('es-AR') : '—'}`);
  doc.moveDown(0.5);

  // doc.image() con x/y explícitos no mueve el cursor de texto (a diferencia de doc.text()),
  // así que hay que bajar doc.y a mano al alto real del QR antes de seguir escribiendo, o el
  // texto siguiente termina superpuesto con la parte inferior del código.
  const qrTamano = 100;
  const qrY = doc.y;
  doc.image(qrBuffer, (ANCHO - qrTamano) / 2, qrY, { width: qrTamano });
  doc.y = qrY + qrTamano + 10;

  doc.fontSize(8).text('¡Gracias por su visita!', { align: 'center' });

  doc.end();
};

module.exports = { generarFacturaPDF };
