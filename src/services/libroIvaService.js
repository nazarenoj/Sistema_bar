const pool = require('../config/db');
const config = require('../config/afipConfig');
const wsfeClient = require('../afip/wsfeClient');

// Libro IVA Digital, ventas (Ventas RF13): los dos archivos de ancho fijo que se importan en el servicio de
// ARCA (comprobantes y alícuotas), y el control de lo emitido localmente contra lo registrado en ARCA.
// Importes sin coma, con dos decimales implícitos. Las posiciones siguen la RG 4597.
// shortcut: el formato está armado de la especificación pública y no se probó contra el importador de ARCA;
// validarlo con un archivo real antes de la primera presentación.
const NO_GRAVADO_OPERACION = 'N';
const importe = (n, largo = 15) => String(Math.round(Math.abs(Number(n)) * 100)).padStart(largo, '0');
const entero = (n, largo) => String(Math.trunc(Number(n))).padStart(largo, '0');
const texto = (s, largo) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '').toUpperCase().slice(0, largo).padEnd(largo, ' ');
const base = (tipo) => ({ 3: 1, 8: 6, 13: 11 }[tipo] ?? tipo);
// Código de alícuota de IVA (Id de WSFE): 3 = 0 %, 4 = 10,5 %, 5 = 21 %, 6 = 27 %, 8 = 5 %, 9 = 2,5 %.

const periodoValido = (p) => /^\d{6}$/.test(String(p)) && Number(String(p).slice(4)) >= 1 && Number(String(p).slice(4)) <= 12;

// Comprobantes aprobados del período (facturas y notas de crédito, con CAE o CAEA).
const comprobantes = async (periodo) => (await pool.query(
  `SELECT f.*, DATE_FORMAT(f.fecha_emision, '%Y%m%d') AS fecha FROM facturas f
   WHERE f.estado = 'aprobada' AND f.numero IS NOT NULL AND DATE_FORMAT(f.fecha_emision, '%Y%m') = ? ORDER BY f.tipo_comprobante, f.punto_venta, f.numero`, [periodo]))[0];

const generar = async (periodo) => {
  if (!periodoValido(periodo)) throw Object.assign(new Error('"periodo" debe ser AAAAMM.'), { status: 400 });
  const filas = await comprobantes(periodo);
  const cbte = [];
  const alicuotas = [];
  for (const f of filas) {
    const gravado = base(f.tipo_comprobante) !== 11; // la Factura C no discrimina IVA
    cbte.push([
      f.fecha, entero(f.tipo_comprobante, 3), entero(f.punto_venta, 5), entero(f.numero, 20), entero(f.numero, 20),
      entero(f.doc_tipo, 2), entero(f.doc_nro, 20), texto(f.receptor_nombre || 'CONSUMIDOR FINAL', 30),
      importe(f.importe_total), importe(0), importe(0), importe(0), importe(0), importe(0), importe(0), importe(0),
      'PES', '0001000000', gravado ? '1' : '0', gravado ? ' ' : NO_GRAVADO_OPERACION, importe(0), '00000000',
    ].join(''));
    if (gravado)
      alicuotas.push([entero(f.tipo_comprobante, 3), entero(f.punto_venta, 5), entero(f.numero, 20), importe(f.importe_neto), entero(config.ivaAlicuotaId, 4), importe(f.importe_iva)].join(''));
  }
  return {
    periodo, cantidad: filas.length,
    total: filas.reduce((a, f) => a + (base(f.tipo_comprobante) === f.tipo_comprobante ? 1 : -1) * Math.round(Number(f.importe_total) * 100), 0) / 100, // las notas de crédito restan
    comprobantes: cbte.join('\r\n') + (cbte.length ? '\r\n' : ''),
    alicuotas: alicuotas.join('\r\n') + (alicuotas.length ? '\r\n' : ''),
  };
};

const MAX_CONSULTAS = 500; // por corrida: cada comprobante es una consulta a ARCA

// Compara lo emitido localmente con lo registrado en ARCA y lista las diferencias (RF13):
//   - sin_registro_local: ARCA autorizó números de la clave que el sistema no tiene
//   - no_existe_en_arca / no_autorizado: el sistema tiene un comprobante que ARCA no tiene autorizado
//   - importe_distinto / cae_distinto
const controlar = async (periodo) => {
  if (!periodoValido(periodo)) throw Object.assign(new Error('"periodo" debe ser AAAAMM.'), { status: 400 });
  const locales = await comprobantes(periodo);
  const porClave = new Map();
  for (const f of locales) {
    const k = `${f.punto_venta}:${f.tipo_comprobante}`;
    if (!porClave.has(k)) porClave.set(k, []);
    porClave.get(k).push(f);
  }
  const claves = [];
  let consultas = 0;
  let incompleto = false;
  for (const [k, fs] of porClave) {
    const [pto, tipo] = k.split(':').map(Number);
    const diferencias = [];
    const modalidadCaea = fs.filter((f) => f.modalidad === 'CAEA');
    for (const f of fs.filter((x) => x.modalidad !== 'CAEA')) { // los CAEA se verifican con el informe, no por número
      if (consultas++ >= MAX_CONSULTAS) { incompleto = true; break; }
      const a = await wsfeClient.compConsultar(pto, tipo, f.numero);
      if (!a) diferencias.push({ numero: f.numero, tipo: 'no_existe_en_arca' });
      else if (a.resultado !== 'A') diferencias.push({ numero: f.numero, tipo: 'no_autorizado', detalle: `ARCA lo tiene con resultado ${a.resultado}` });
      else {
        if (a.cae && a.cae !== f.cae) diferencias.push({ numero: f.numero, tipo: 'cae_distinto', detalle: `local ${f.cae}, ARCA ${a.cae}` });
        if (a.importe !== undefined && Math.round(a.importe * 100) !== Math.round(Number(f.importe_total) * 100))
          diferencias.push({ numero: f.numero, tipo: 'importe_distinto', detalle: `local ${f.importe_total}, ARCA ${a.importe}` });
      }
    }
    // Números que ARCA autorizó después del último que tenemos registrado.
    const ultimoArca = await wsfeClient.compUltimoAutorizado(pto, tipo);
    const [[{ maxLocal }]] = await pool.query("SELECT MAX(numero) AS maxLocal FROM facturas WHERE punto_venta = ? AND tipo_comprobante = ? AND estado = 'aprobada' AND modalidad = 'CAE'", [pto, tipo]);
    if (modalidadCaea.length === 0 && maxLocal !== null && ultimoArca > Number(maxLocal))
      for (let n = Number(maxLocal) + 1; n <= Math.min(ultimoArca, Number(maxLocal) + 200); n++) diferencias.push({ numero: n, tipo: 'sin_registro_local' });
    claves.push({ punto_venta: pto, tipo_comprobante: tipo, locales: fs.length, ultimo_arca: ultimoArca, diferencias });
  }
  return { periodo, claves, diferencias: claves.reduce((a, c) => a + c.diferencias.length, 0), incompleto, consultado_en: new Date().toISOString() };
};

module.exports = { generar, controlar, comprobantes };
