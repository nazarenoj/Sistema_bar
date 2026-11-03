const ExcelJS = require('exceljs');
const { generarReportePDF } = require('./reportePdfService');

// Serializa un "documento de reporte" al formato que pidió el cliente. Los controllers no saben
// nada de CSV/XLSX/PDF/JSON: solo arman el documento y llaman a enviarReporte().
//
// Forma del documento:
//   {
//     titulo: 'Reporte de ventas facturadas',
//     subtitulo: 'Del 01/09/2026 al 29/09/2026',
//     filtros: [{ label: 'Método de pago', valor: 'Efectivo' }],
//     resumen: [{ label: 'Total vendido', valor: 1234.5, tipo: 'moneda' }, { label: 'Por método de pago', tipo: 'titulo' }],
//     hojas:   [{ nombre: 'Ventas', columnas: [{ key, label, tipo, ancho }], filas: [{...}] }],
//   }
//
// `tipo` ∈ 'texto' | 'numero' | 'moneda' | 'fecha' y es lo que decide el formato de celda en XLSX
// y la alineación/formato en PDF y CSV. En el resumen, 'titulo' marca un separador de sección.

const FORMATOS = {
  csv: { ext: 'csv', mime: 'text/csv; charset=utf-8' },
  xlsx: { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pdf: { ext: 'pdf', mime: 'application/pdf' },
  json: { ext: 'json', mime: 'application/json; charset=utf-8' },
};

const FORMATOS_VALIDOS = Object.keys(FORMATOS);
const FORMATO_POR_DEFECTO = 'csv';

// Arma un desglose para el bloque `resumen`: agrupa las filas por `clave`, suma el importe que
// devuelve `monto` y las ordena de mayor a menor, encabezadas por un renglón de tipo 'titulo'.
// Lo usan los dos reportes (por método de pago, por estado de comprobante, por tipo de
// comprobante), que solo se diferencian en de qué campo sale el importe.
const desglose = (titulo, filas, clave, monto) => {
  const acumulado = new Map();
  filas.forEach((fila) => {
    const k = clave(fila);
    const previo = acumulado.get(k) || { cantidad: 0, total: 0 };
    acumulado.set(k, { cantidad: previo.cantidad + 1, total: previo.total + Number(monto(fila)) });
  });
  if (!acumulado.size) return [];
  return [
    { label: titulo, tipo: 'titulo' },
    ...[...acumulado.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([k, v]) => ({ label: `${k} (${v.cantidad})`, valor: v.total, tipo: 'moneda' })),
  ];
};

const formatFecha = (fecha) => (fecha ? new Date(fecha).toLocaleString('es-AR', { hour12: false }) : '');

// Escapa un valor para CSV: si contiene coma, comilla o salto de línea hay que encomillarlo y
// duplicar las comillas internas (RFC 4180).
const csvCell = (valor) => {
  const texto = valor === null || valor === undefined ? '' : String(valor);
  return /[",\n\r]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
};

// Texto plano de una celda para CSV. Los montos van con punto decimal y sin símbolo para que Excel
// los reconozca como número; las fechas, en formato local es-AR como venían haciéndose.
const textoCelda = (valor, tipo) => {
  if (valor === null || valor === undefined || valor === '') return '';
  if (tipo === 'moneda') return Number(valor).toFixed(2);
  if (tipo === 'numero') return String(valor);
  if (tipo === 'fecha') return formatFecha(valor);
  return String(valor);
};

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

// Un solo archivo con todo: bloque de encabezado, resumen y después cada hoja como sección
// separada por una línea en blanco. Se mantiene el BOM + CRLF que ya usaba el reporte contable,
// que es lo que hace que Excel abra los acentos bien sin pedir nada al usuario.
const armarCsv = (documento) => {
  const lineas = [];

  lineas.push(csvCell(documento.titulo));
  if (documento.subtitulo) lineas.push(csvCell(documento.subtitulo));
  lineas.push(`${csvCell('Generado')},${csvCell(formatFecha(new Date()))}`);

  if (documento.filtros?.length) {
    lineas.push('');
    lineas.push(csvCell('Filtros aplicados'));
    documento.filtros.forEach((f) => lineas.push(`${csvCell(f.label)},${csvCell(f.valor)}`));
  }

  if (documento.resumen?.length) {
    lineas.push('');
    lineas.push(csvCell('Resumen'));
    documento.resumen.forEach((item) => {
      if (item.tipo === 'titulo') lineas.push(csvCell(item.label));
      else lineas.push(`${csvCell(item.label)},${csvCell(textoCelda(item.valor, item.tipo))}`);
    });
  }

  (documento.hojas || []).forEach((hoja) => {
    lineas.push('');
    lineas.push(csvCell(hoja.nombre));
    lineas.push(hoja.columnas.map((c) => csvCell(c.label)).join(','));
    hoja.filas.forEach((fila) => {
      lineas.push(hoja.columnas.map((c) => csvCell(textoCelda(fila[c.key], c.tipo))).join(','));
    });
  });

  return '﻿' + lineas.join('\r\n');
};

// ---------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------

// Los montos viajan como número (no como string formateado) para que sirva de respaldo real y se
// pueda procesar desde otro sistema sin parsear texto.
const valorJson = (valor, tipo) => {
  if (valor === null || valor === undefined || valor === '') return null;
  if (tipo === 'moneda') return Number(Number(valor).toFixed(2));
  if (tipo === 'numero') return Number(valor);
  if (tipo === 'fecha') return new Date(valor).toISOString();
  return valor;
};

// Los renglones de tipo 'titulo' no tienen valor propio: marcan el arranque de un desglose. En el
// JSON se convierten en el campo `seccion` de los renglones que siguen, porque si se descartaran,
// un "Aprobada (1)" quedaría sin decir de qué agrupación salió.
const resumenJson = (resumen = []) => {
  let seccion = null;
  return resumen.flatMap((item) => {
    if (item.tipo === 'titulo') {
      seccion = item.label;
      return [];
    }
    return [{ seccion, label: item.label, valor: valorJson(item.valor, item.tipo) }];
  });
};

const armarJson = (documento) => ({
  titulo: documento.titulo,
  subtitulo: documento.subtitulo ?? null,
  generado_en: new Date().toISOString(),
  filtros: documento.filtros ?? [],
  resumen: resumenJson(documento.resumen),
  hojas: Object.fromEntries(
    (documento.hojas || []).map((hoja) => [
      hoja.nombre,
      hoja.filas.map((fila) =>
        Object.fromEntries(hoja.columnas.map((c) => [c.key, valorJson(fila[c.key], c.tipo)]))
      ),
    ])
  ),
});

// ---------------------------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------------------------

const NUM_FMT_MONEDA = '"$"#,##0.00';
const NUM_FMT_FECHA = 'dd/mm/yyyy hh:mm';

const valorExcel = (valor, tipo) => {
  if (valor === null || valor === undefined || valor === '') return null;
  if (tipo === 'moneda') return Number(valor);
  if (tipo === 'numero') return Number(valor);
  if (tipo === 'fecha') return new Date(valor);
  return valor;
};

const numFmt = (tipo) => (tipo === 'moneda' ? NUM_FMT_MONEDA : tipo === 'fecha' ? NUM_FMT_FECHA : null);

const pintarEncabezado = (row) => {
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
  });
};

const armarHojaResumen = (workbook, documento) => {
  const hoja = workbook.addWorksheet('Resumen');
  hoja.columns = [{ width: 38 }, { width: 22 }];

  hoja.addRow([documento.titulo]).font = { bold: true, size: 14 };
  if (documento.subtitulo) hoja.addRow([documento.subtitulo]);
  hoja.addRow(['Generado', formatFecha(new Date())]);
  hoja.addRow([]);

  if (documento.filtros?.length) {
    hoja.addRow(['Filtros aplicados']).font = { bold: true };
    documento.filtros.forEach((f) => hoja.addRow([f.label, f.valor]));
    hoja.addRow([]);
  }

  if (documento.resumen?.length) {
    hoja.addRow(['Resumen']).font = { bold: true };
    documento.resumen.forEach((item) => {
      if (item.tipo === 'titulo') {
        hoja.addRow([item.label]).font = { bold: true, italic: true };
        return;
      }
      const row = hoja.addRow([item.label, valorExcel(item.valor, item.tipo)]);
      const formato = numFmt(item.tipo);
      if (formato) row.getCell(2).numFmt = formato;
    });
  }
};

const armarXlsx = async (documento, res) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Sistema Chepola';
  workbook.created = new Date();

  armarHojaResumen(workbook, documento);

  (documento.hojas || []).forEach((hoja) => {
    // ExcelJS rechaza los caracteres que Excel no admite en el nombre de una pestaña.
    const ws = workbook.addWorksheet(hoja.nombre.replace(/[*?:/\\[\]]/g, '').slice(0, 31));
    ws.columns = hoja.columnas.map((c) => ({
      header: c.label,
      key: c.key,
      width: Math.max(10, (c.ancho || 10) * 1.4),
      style: numFmt(c.tipo) ? { numFmt: numFmt(c.tipo) } : undefined,
    }));

    hoja.filas.forEach((fila) => {
      ws.addRow(Object.fromEntries(hoja.columnas.map((c) => [c.key, valorExcel(fila[c.key], c.tipo)])));
    });

    pintarEncabezado(ws.getRow(1));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    if (hoja.filas.length) {
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: hoja.columnas.length } };
    }
  });

  await workbook.xlsx.write(res);
};

// ---------------------------------------------------------------------------------------------

// Setea las cabeceras de descarga y escribe el documento en la respuesta.
// `nombreBase` va sin extensión: la pone el formato elegido.
const enviarReporte = async (res, documento, formato, nombreBase) => {
  const config = FORMATOS[formato] || FORMATOS[FORMATO_POR_DEFECTO];

  res.setHeader('Content-Type', config.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${nombreBase}.${config.ext}"`);

  if (formato === 'pdf') return generarReportePDF(res, documento);
  if (formato === 'xlsx') return armarXlsx(documento, res);
  if (formato === 'json') return res.send(JSON.stringify(armarJson(documento), null, 2));
  return res.send(armarCsv(documento));
};

module.exports = { enviarReporte, desglose, FORMATOS_VALIDOS, FORMATO_POR_DEFECTO, csvCell };
