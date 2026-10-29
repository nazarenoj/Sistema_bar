const PDFDocument = require('pdfkit');

const NEGOCIO_NOMBRE = process.env.TICKET_NEGOCIO_NOMBRE || 'Cafetería';

const MM_TO_PT = 2.83465;
const ANCHO = Math.round(80 * MM_TO_PT); // ticket de 80mm, ancho típico de impresora térmica
const MARGEN = 14;
const ANCHO_UTIL = ANCHO - MARGEN * 2;

const formatFecha = (fecha) =>
  fecha ? new Date(fecha).toLocaleString('es-AR', { hour12: false }) : '—';
const formatMoneda = (n) => `$${Number(n).toFixed(2)}`;

const linea = (doc) => {
  doc.moveTo(MARGEN, doc.y).lineTo(ANCHO - MARGEN, doc.y).stroke();
  doc.moveDown(0.5);
};

const imprimirItem = (doc, item) => {
  doc.font('Helvetica-Bold').fontSize(8.5).text(item.nombre, MARGEN, doc.y, { width: ANCHO_UTIL });
  doc.font('Helvetica').fontSize(8);
  const y = doc.y;
  const detalle = `${item.cantidad} x ${formatMoneda(item.precio_unitario)}`;
  doc.text(detalle, MARGEN, y, { width: ANCHO_UTIL * 0.55 });
  doc.text(formatMoneda(item.subtotal), MARGEN, y, { width: ANCHO_UTIL, align: 'right' });
  doc.moveDown(0.4);
};

// Genera el PDF del ticket (comprobante interno, no fiscal) de una silla/pedido y lo escribe
// directamente en el stream de la respuesta HTTP. La altura de página se estima según la
// cantidad de productos; si algún ticket es más largo de lo previsto, pdfkit agrega otra página.
const generarTicketPedido = (res, { pedido, items, sillaNumero, sillasTotales }) => {
  const alto = Math.max(320, 210 + items.length * 30);
  const doc = new PDFDocument({ size: [ANCHO, alto], margin: MARGEN });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="ticket-pedido-${pedido.id}.pdf"`);
  doc.pipe(res);

  doc.font('Helvetica-Bold').fontSize(13).text(NEGOCIO_NOMBRE, { align: 'center' });
  doc.font('Helvetica').fontSize(7.5).text('Comprobante interno, no válido como factura', { align: 'center' });
  doc.moveDown(0.6);
  linea(doc);

  doc.fontSize(9);
  doc.text(`Mesa: ${pedido.numero_mesa_grupo ?? pedido.numero_mesa}`);
  doc.text(`Silla: ${sillaNumero} de ${sillasTotales}`);
  doc.text(`Pedido #${pedido.id}`);
  doc.text(`Apertura: ${formatFecha(pedido.fecha_creacion)}`);
  doc.text(`Cierre:   ${formatFecha(pedido.fecha_cierre)}`);
  doc.moveDown(0.5);
  linea(doc);

  if (!items.length) {
    doc.fontSize(9).text('Sin productos.');
  } else {
    for (const item of items) imprimirItem(doc, item);
  }

  doc.moveDown(0.3);
  linea(doc);

  doc.font('Helvetica-Bold').fontSize(11).text(`TOTAL: ${formatMoneda(pedido.total)}`, { align: 'right' });

  doc.moveDown(1);
  doc.font('Helvetica').fontSize(8).text('¡Gracias por su visita!', { align: 'center' });

  doc.end();
};

// Genera el PDF del ticket consolidado de toda la cuenta de una mesa (todas las sillas de una
// misma sesión), agrupando los productos por silla y con el total general al final.
const generarTicketCuenta = (res, { mesa, pedidos, items }) => {
  const alto = Math.max(360, 220 + pedidos.length * 40 + items.length * 26);
  const doc = new PDFDocument({ size: [ANCHO, alto], margin: MARGEN });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="ticket-mesa-${mesa.id}.pdf"`);
  doc.pipe(res);

  doc.font('Helvetica-Bold').fontSize(13).text(NEGOCIO_NOMBRE, { align: 'center' });
  doc.font('Helvetica').fontSize(7.5).text('Comprobante interno, no válido como factura', { align: 'center' });
  doc.moveDown(0.6);
  linea(doc);

  doc.fontSize(9);
  doc.text(`Mesa: ${mesa.numero_mesa_grupo ?? mesa.numero_mesa}`);
  doc.text(`Sillas: ${pedidos.length}`);
  doc.moveDown(0.5);
  linea(doc);

  let granTotal = 0;
  pedidos.forEach((pedido, idx) => {
    const itemsPedido = items.filter((i) => i.pedido_id === pedido.id);
    granTotal += Number(pedido.total);

    doc.font('Helvetica-Bold').fontSize(9.5).text(`Silla ${idx + 1}`);
    doc.font('Helvetica').fontSize(7.5).text(
      `Apertura ${formatFecha(pedido.fecha_creacion)}  ·  Cierre ${formatFecha(pedido.fecha_cierre)}`
    );
    doc.moveDown(0.3);

    if (!itemsPedido.length) {
      doc.fontSize(8.5).text('Sin productos.');
    } else {
      for (const item of itemsPedido) imprimirItem(doc, item);
    }

    doc.font('Helvetica-Oblique').fontSize(8).text(`Subtotal silla: ${formatMoneda(pedido.total)}`, { align: 'right' });
    doc.moveDown(0.5);
    if (idx < pedidos.length - 1) linea(doc);
  });

  doc.moveDown(0.2);
  linea(doc);
  doc.font('Helvetica-Bold').fontSize(12).text(`TOTAL: ${formatMoneda(granTotal)}`, { align: 'right' });

  doc.moveDown(1);
  doc.font('Helvetica').fontSize(8).text('¡Gracias por su visita!', { align: 'center' });

  doc.end();
};

// Genera el PDF de la comanda (para cocina/barra) con los pedidos activos de una mesa: solo
// nombres, cantidades y aclaraciones, sin precios ni totales, ya que no es un comprobante para
// el cliente sino una lista de preparación. A diferencia del ticket, se puede pedir en cualquier
// momento con la cuenta todavía abierta (no hace falta cerrar silla ni cuenta primero).
const generarComandaMesa = (res, { mesa, pedidos, items }) => {
  const alto = Math.max(300, 180 + pedidos.length * 30 + items.length * 24);
  const doc = new PDFDocument({ size: [ANCHO, alto], margin: MARGEN });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="comanda-mesa-${mesa.id}.pdf"`);
  doc.pipe(res);

  doc.font('Helvetica-Bold').fontSize(14).text('COMANDA', { align: 'center' });
  doc.font('Helvetica').fontSize(7.5).text(formatFecha(new Date()), { align: 'center' });
  doc.moveDown(0.6);
  linea(doc);

  doc.font('Helvetica-Bold').fontSize(12).text(`Mesa: ${mesa.numero_mesa_grupo ?? mesa.numero_mesa}`);
  doc.moveDown(0.4);
  linea(doc);

  pedidos.forEach((pedido, idx) => {
    const itemsPedido = items.filter((i) => i.pedido_id === pedido.id);
    if (!itemsPedido.length) return;

    if (pedidos.length > 1) {
      doc.font('Helvetica-Bold').fontSize(9.5).text(`Silla ${idx + 1}`);
      doc.moveDown(0.2);
    }

    for (const item of itemsPedido) {
      doc.font('Helvetica-Bold').fontSize(10).text(`${item.cantidad} x ${item.nombre}`, MARGEN, doc.y, { width: ANCHO_UTIL });
      if (item.descripcion) {
        doc.font('Helvetica-Oblique').fontSize(8).text(item.descripcion, MARGEN, doc.y, { width: ANCHO_UTIL });
      }
      doc.moveDown(0.4);
    }

    if (idx < pedidos.length - 1) doc.moveDown(0.2);
  });

  if (!items.length) {
    doc.font('Helvetica').fontSize(9).text('Sin productos.');
  }

  doc.moveDown(0.5);
  linea(doc);

  doc.end();
};

// Comanda de un sector (Ventas RF07): lo que ese sector tiene que preparar de un envío, sin precios.
const MODALIDAD_LABEL = { salon: 'Salón', mostrador: 'Mostrador', para_llevar: 'Para llevar', delivery: 'Delivery', retiro: 'Retiro' };
const generarComandaSector = (res, comanda) => {
  const alto = Math.max(260, 170 + comanda.items.length * 34);
  const doc = new PDFDocument({ size: [ANCHO, alto], margin: MARGEN });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="comanda-${comanda.id}.pdf"`);
  doc.pipe(res);

  doc.font('Helvetica-Bold').fontSize(14).text(`COMANDA · ${(comanda.sector ?? 'SIN SECTOR').toUpperCase()}`, { align: 'center' });
  if (comanda.reimpresiones > 0) doc.font('Helvetica-Bold').fontSize(9).text(`REIMPRESIÓN ${comanda.reimpresiones}`, { align: 'center' });
  if (comanda.estado === 'anulada') doc.font('Helvetica-Bold').fontSize(10).text('*** ANULADA ***', { align: 'center' });
  doc.font('Helvetica').fontSize(7.5).text(formatFecha(comanda.created_at), { align: 'center' });
  doc.moveDown(0.6);
  linea(doc);

  doc.font('Helvetica-Bold').fontSize(11).text(MODALIDAD_LABEL[comanda.modalidad] ?? comanda.modalidad);
  if (comanda.modalidad === 'salon') doc.text(`Mesa: ${comanda.numero_mesa}`);
  if (comanda.referencia) doc.font('Helvetica').fontSize(9).text(comanda.referencia);
  doc.moveDown(0.4);
  linea(doc);

  for (const item of comanda.items) {
    doc.font('Helvetica-Bold').fontSize(10).text(`${Number(item.cantidad)} x ${item.nombre}`, MARGEN, doc.y, { width: ANCHO_UTIL });
    if (item.observaciones) doc.font('Helvetica-Oblique').fontSize(8.5).text(item.observaciones, MARGEN, doc.y, { width: ANCHO_UTIL });
    doc.moveDown(0.4);
  }
  linea(doc);
  doc.end();
};

module.exports = { generarTicketPedido, generarTicketCuenta, generarComandaMesa, generarComandaSector };
