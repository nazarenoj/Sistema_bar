const PDFDocument = require('pdfkit');

// Renderer PDF de los reportes de ventas. A diferencia de facturaPdfService.js y ticketService.js
// (que son de 80 mm porque salen por la impresora térmica del mostrador), acá el documento es A4
// horizontal: un reporte de muchas filas y muchas columnas se lee en pantalla o en una impresora
// común, no en un rollo.
//
// pdfkit no trae tablas, así que la tabla se dibuja a mano: anchos proporcionales, encabezado
// repetido en cada página y filas cebradas.

const MARGEN = 30;
const NEGOCIO_NOMBRE = process.env.TICKET_NEGOCIO_NOMBRE || 'Cafetería';

const GRIS_ENCABEZADO = '#eef2ff';
const GRIS_CEBRA = '#f9fafb';
const GRIS_TEXTO = '#6b7280';
const GRIS_LINEA = '#d1d5db';

const formatFecha = (fecha) => (fecha ? new Date(fecha).toLocaleString('es-AR', { hour12: false }) : '—');
const formatMoneda = (n) => `$${Number(n || 0).toFixed(2)}`;
const formatNumero = (n) => String(n ?? '');

// Convierte un valor crudo al texto que va en la celda, según el tipo declarado en la columna.
const formatValor = (valor, tipo) => {
  if (valor === null || valor === undefined || valor === '') return tipo === 'moneda' ? formatMoneda(0) : '—';
  if (tipo === 'moneda') return formatMoneda(valor);
  if (tipo === 'fecha') return formatFecha(valor);
  if (tipo === 'numero') return formatNumero(valor);
  return String(valor);
};

const alineacion = (tipo) => (tipo === 'moneda' || tipo === 'numero' ? 'right' : 'left');

const anchoUtil = (doc) => doc.page.width - MARGEN * 2;

const linea = (doc, color = GRIS_LINEA) => {
  doc.save().strokeColor(color)
    .moveTo(MARGEN, doc.y).lineTo(doc.page.width - MARGEN, doc.y).stroke()
    .restore();
  doc.moveDown(0.4);
};

// Reparte el ancho disponible entre las columnas en proporción a su `ancho` declarado (que es un
// peso relativo, no puntos), para que la tabla siempre ocupe el ancho completo de la hoja.
const calcularAnchos = (doc, columnas) => {
  const total = columnas.reduce((suma, c) => suma + (c.ancho || 10), 0);
  const disponible = anchoUtil(doc);
  return columnas.map((c) => ((c.ancho || 10) / total) * disponible);
};

// Alto que va a ocupar una fila: el del texto más alto de sus celdas (pdfkit sabe medirlo antes
// de dibujar, así que se puede decidir el salto de página sin escribir nada).
const altoFila = (doc, columnas, anchos, textos, padding) => {
  const altos = textos.map((texto, i) =>
    doc.heightOfString(texto, { width: anchos[i] - padding * 2, align: alineacion(columnas[i].tipo) })
  );
  return Math.max(...altos, 10) + padding * 2;
};

const dibujarFila = (doc, columnas, anchos, textos, { alto, padding, negrita, fondo }) => {
  const y = doc.y;
  if (fondo) {
    doc.save().rect(MARGEN, y, anchoUtil(doc), alto).fill(fondo).restore();
  }
  let x = MARGEN;
  doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica');
  textos.forEach((texto, i) => {
    doc.text(texto, x + padding, y + padding, {
      width: anchos[i] - padding * 2,
      align: alineacion(columnas[i].tipo),
      lineBreak: true,
    });
    x += anchos[i];
  });
  doc.y = y + alto;
};

// Dibuja una hoja del documento como tabla. Devuelve el doc posicionado después de la tabla.
const dibujarTabla = (doc, hoja) => {
  const { columnas, filas } = hoja;
  const padding = 4;

  doc.font('Helvetica-Bold').fontSize(11).fillColor('black').text(hoja.nombre);
  doc.moveDown(0.3);

  doc.fontSize(7.5);
  const anchos = calcularAnchos(doc, columnas);
  const encabezados = columnas.map((c) => c.label);

  const pintarEncabezado = () => {
    const alto = altoFila(doc, columnas, anchos, encabezados, padding);
    dibujarFila(doc, columnas, anchos, encabezados, { alto, padding, negrita: true, fondo: GRIS_ENCABEZADO });
  };

  pintarEncabezado();

  if (!filas.length) {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(GRIS_TEXTO)
      .text('Sin datos para los filtros elegidos.', MARGEN + padding, doc.y + padding);
    doc.fillColor('black');
    doc.moveDown(1);
    return;
  }

  const limiteInferior = doc.page.height - MARGEN;
  filas.forEach((fila, indice) => {
    const textos = columnas.map((c) => formatValor(fila[c.key], c.tipo));
    const alto = altoFila(doc, columnas, anchos, textos, padding);

    // Si la fila no entra completa, se pasa de página y se repite el encabezado.
    if (doc.y + alto > limiteInferior) {
      doc.addPage();
      doc.fontSize(7.5);
      pintarEncabezado();
    }

    dibujarFila(doc, columnas, anchos, textos, {
      alto,
      padding,
      negrita: false,
      fondo: indice % 2 === 1 ? GRIS_CEBRA : null,
    });
  });

  doc.fillColor('black');
  doc.moveDown(1);
};

const dibujarEncabezadoDocumento = (doc, documento) => {
  doc.font('Helvetica-Bold').fontSize(15).text(documento.titulo);
  doc.font('Helvetica').fontSize(9).fillColor(GRIS_TEXTO);
  doc.text(NEGOCIO_NOMBRE);
  if (documento.subtitulo) doc.text(documento.subtitulo);
  doc.text(`Generado el ${formatFecha(new Date())}`);
  doc.fillColor('black');
  doc.moveDown(0.5);

  if (documento.filtros?.length) {
    doc.font('Helvetica-Bold').fontSize(8.5).text('Filtros aplicados');
    doc.font('Helvetica').fontSize(8).fillColor(GRIS_TEXTO);
    documento.filtros.forEach((f) => doc.text(`• ${f.label}: ${f.valor}`));
    doc.fillColor('black');
    doc.moveDown(0.5);
  }

  linea(doc);
};

// El resumen se dibuja en dos columnas para no comerse media hoja cuando tiene muchos renglones
// (desglose por método de pago + por estado de comprobante).
const dibujarResumen = (doc, resumen) => {
  if (!resumen?.length) return;

  doc.font('Helvetica-Bold').fontSize(11).text('Resumen');
  doc.moveDown(0.3);

  const anchoColumna = anchoUtil(doc) / 2;
  const yInicial = doc.y;
  let alturaMaxima = 0;

  resumen.forEach((item, i) => {
    const columna = i % 2;
    const renglon = Math.floor(i / 2);
    const x = MARGEN + columna * anchoColumna;
    const y = yInicial + renglon * 14;

    if (item.tipo === 'titulo') {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('black')
        .text(item.label, x, y, { width: anchoColumna - 10 });
    } else {
      doc.font('Helvetica').fontSize(8.5).fillColor(GRIS_TEXTO)
        .text(item.label, x, y, { width: anchoColumna * 0.6 });
      doc.font('Helvetica-Bold').fillColor('black')
        .text(formatValor(item.valor, item.tipo), x, y, { width: anchoColumna - 10, align: 'right' });
    }
    alturaMaxima = Math.max(alturaMaxima, y + 14);
  });

  doc.fillColor('black');
  doc.y = alturaMaxima + 4;
  linea(doc);
  doc.moveDown(0.3);
};

// Escribe el documento de reporte como PDF en el stream de la respuesta HTTP. Las cabeceras
// (Content-Type / Content-Disposition) las pone reporteService antes de llamar acá, igual que
// hace facturaController con facturaPdfService.
const generarReportePDF = (res, documento) => {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGEN });
  doc.pipe(res);

  dibujarEncabezadoDocumento(doc, documento);
  dibujarResumen(doc, documento.resumen);

  (documento.hojas || []).forEach((hoja, i) => {
    // Cada hoja después de la primera arranca en página nueva: son tablas con columnas distintas,
    // pegadas una debajo de la otra se leen como una sola tabla desalineada.
    if (i > 0) doc.addPage();
    dibujarTabla(doc, hoja);
  });

  doc.end();
};

module.exports = { generarReportePDF };
