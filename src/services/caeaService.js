const pool = require('../config/db');
const config = require('../config/afipConfig');
const registro = require('../instancias/registro');
const wsfeClient = require('../afip/wsfeClient');
const Parametro = require('../models/parametroModel');
const Notificacion = require('../models/notificacionModel');
const { auditar } = require('../utils/auditar');
const logger = require('../utils/logger');

// CAEA y numeración local (Ventas RF11, RN15, RN55). El CAEA se pide a ARCA por quincena y punto de venta;
// con él se emite sin consultar a ARCA en línea y después se informa cada comprobante (idempotente por número).
const SISTEMA = { username: 'sistema' };
const FECHA = (d) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
const COLUMNAS = `id, punto_venta, periodo, orden, caea, DATE_FORMAT(vigencia_desde, '%Y-%m-%d') AS vigencia_desde,
  DATE_FORMAT(vigencia_hasta, '%Y-%m-%d') AS vigencia_hasta, DATE_FORMAT(tope_informe, '%Y-%m-%d') AS tope_informe, sin_movimiento_informado`;

const periodoDe = (fecha = new Date()) => {
  const f = fecha instanceof Date ? fecha : new Date(fecha);
  return { periodo: `${f.getFullYear()}${String(f.getMonth() + 1).padStart(2, '0')}`, orden: f.getDate() <= 15 ? 1 : 2 };
};

// Contador atómico por clave (RN55): sale del servidor, sin ARCA. Con `conn` participa de la transacción
// del documento: si el cierre se revierte, el número no se pierde (queda sin saltos).
const siguienteNumero = async (clave, conn) => {
  const c = conn || await pool.getConnection();
  try {
    await c.query('INSERT INTO contadores_comprobante (clave, ultimo) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE ultimo = LAST_INSERT_ID(ultimo + 1)', [clave]);
    const [[{ n }]] = await c.query('SELECT LAST_INSERT_ID() AS n');
    return Number(n);
  } finally {
    if (!conn) c.release();
  }
};

// El CAEA vigente hoy para el punto de venta, o null (RN15).
const vigente = async (puntoVenta, fecha = new Date()) => {
  const hoy = FECHA(fecha);
  const [[c]] = await pool.query(`SELECT ${COLUMNAS} FROM caea WHERE punto_venta = ? AND vigencia_desde <= ? AND vigencia_hasta >= ? ORDER BY id DESC LIMIT 1`, [puntoVenta, hoy, hoy]);
  return c || null;
};

// Pide (o recupera, si ya estaba otorgado) el CAEA de un período y lo guarda.
const solicitar = async (puntoVenta, periodo, orden) => {
  const r = await wsfeClient.solicitarCAEA(periodo, orden);
  await pool.query(
    'INSERT IGNORE INTO caea (punto_venta, periodo, orden, caea, vigencia_desde, vigencia_hasta, tope_informe) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [puntoVenta, periodo, orden, r.caea, r.desde, r.hasta, r.tope]
  );
  await auditar(null, { modulo: 'facturacion', accion: 'caea_solicitado', entidad: 'caea', entidad_id: `${puntoVenta}:${periodo}:${orden}`, detalle: r.caea }, SISTEMA);
  const [[c]] = await pool.query(`SELECT ${COLUMNAS} FROM caea WHERE punto_venta = ? AND periodo = ? AND orden = ?`, [puntoVenta, periodo, orden]);
  return c;
};

const detalleInforme = (f, caea) => ({
  Concepto: 1, DocTipo: f.doc_tipo, DocNro: Number(f.doc_nro), CbteDesde: f.numero, CbteHasta: f.numero,
  CbteFch: FECHA(f.fecha_emision).replace(/-/g, ''), ImpTotal: Number(f.importe_total), ImpTotConc: 0,
  ImpNeto: Number(f.importe_neto), ImpOpEx: 0, ImpIVA: Number(f.importe_iva), ImpTrib: 0, MonId: 'PES', MonCotiz: 1,
  CondicionIVAReceptorId: f.condicion_iva_receptor_id, CAEA: caea,
  ...(f.tipo_comprobante !== 11 && { Iva: { AlicIva: [{ Id: config.ivaAlicuotaId, BaseImp: Number(f.importe_neto), Importe: Number(f.importe_iva) }] } }),
});

// Informa a ARCA los comprobantes emitidos con CAEA que aún no se informaron. Reenviar no duplica: solo
// se mandan los que no tienen `informado_ms`. Un fallo se cuenta y se reintenta en la próxima vuelta (EX06).
const informarPendientes = async () => {
  const [pendientes] = await pool.query(
    `SELECT f.*, c.caea AS codigo_caea FROM facturas f JOIN caea c ON c.id = f.caea_id
     WHERE f.modalidad = 'CAEA' AND f.estado = 'aprobada' AND f.informado_ms IS NULL ORDER BY f.id LIMIT 50`
  );
  let informados = 0;
  for (const f of pendientes) {
    try {
      await wsfeClient.informarCAEA({ PtoVta: f.punto_venta, CbteTipo: f.tipo_comprobante, item: detalleInforme(f, f.codigo_caea) });
      await pool.query('UPDATE facturas SET informado_ms = ? WHERE id = ?', [Date.now(), f.id]);
      informados++;
    } catch (err) {
      await pool.query('UPDATE facturas SET intentos_informe = intentos_informe + 1 WHERE id = ?', [f.id]);
      logger.warn(`[caea] no se pudo informar el comprobante ${f.id} (N° ${f.numero}): ${err.message}`);
    }
  }
  return informados;
};

// Un CAEA vencido sin comprobantes se informa "sin movimiento" (RF11).
const informarSinMovimiento = async () => {
  const [caeas] = await pool.query(
    `SELECT id, punto_venta, caea FROM caea c WHERE sin_movimiento_informado = 0 AND vigencia_hasta < CURDATE()
       AND NOT EXISTS (SELECT 1 FROM facturas f WHERE f.caea_id = c.id)`
  );
  for (const c of caeas) {
    try {
      await wsfeClient.sinMovimientoCAEA(c.punto_venta, c.caea);
      await pool.query('UPDATE caea SET sin_movimiento_informado = 1 WHERE id = ?', [c.id]);
    } catch (err) {
      logger.warn(`[caea] no se pudo informar sin movimiento el CAEA ${c.caea}: ${err.message}`);
    }
  }
  return caeas.length;
};

// Alerta al Administrador antes del plazo para informar, o apenas un informe falla (EX06); se resuelve sola.
const alertarInformes = async () => {
  const dias = (await Parametro.todos()).dias_alerta_informe_caea ?? 2;
  const [caeas] = await pool.query(
    `SELECT c.id, c.caea, DATE_FORMAT(c.tope_informe, '%Y-%m-%d') AS tope, COUNT(f.id) AS pendientes, COALESCE(MAX(f.intentos_informe), 0) AS intentos
     FROM caea c LEFT JOIN facturas f ON f.caea_id = c.id AND f.informado_ms IS NULL
     GROUP BY c.id, c.caea, c.tope_informe`
  );
  for (const c of caeas) {
    const clave = `caea-informe-${c.id}`;
    const cercaDelPlazo = c.tope && (new Date(c.tope) - Date.now()) / 86400000 <= dias;
    if (c.pendientes > 0 && (cercaDelPlazo || c.intentos > 0)) {
      await Notificacion.crear({ modulo: 'ventas', tipo: 'caea_sin_informar', severidad: 'alta', roles: ['administrador'], clave,
        mensaje: `Hay ${c.pendientes} comprobante(s) con CAEA ${c.caea} sin informar a ARCA (plazo: ${c.tope || 'sin dato'}).` });
    } else if (!c.pendientes) {
      await Notificacion.resolverPorClave(clave, 'Todos los comprobantes del CAEA fueron informados');
    }
  }
};

// Ventas no fiscales sin factura aprobada de su cuenta (RN84): "pendientes de facturación".
const noFiscalesPendientes = async (diasMinimos = 0) => {
  const [rows] = await pool.query(
    `SELECT v.id_global, v.mesa_id, v.total, v.tipo_no_fiscal, v.numero_no_fiscal, v.created_at,
            DATEDIFF(NOW(), v.created_at) AS dias
     FROM ventas v
     WHERE v.condicion_fiscal = 'no_fiscal'
       AND NOT EXISTS (SELECT 1 FROM facturas f WHERE f.mesa_id = v.mesa_id AND f.sesion_apertura = v.sesion_apertura AND f.estado = 'aprobada')
       AND DATEDIFF(NOW(), v.created_at) >= ?
     ORDER BY v.created_at`, [diasMinimos]);
  return rows;
};

const alertarNoFiscales = async () => {
  const dias = (await Parametro.todos()).dias_alerta_no_fiscal ?? 30;
  const viejas = await noFiscalesPendientes(dias);
  if (viejas.length)
    await Notificacion.crear({ modulo: 'ventas', tipo: 'no_fiscal_sin_regularizar', severidad: 'media', roles: ['administrador'], clave: 'no-fiscales-sin-regularizar',
      mensaje: `Hay ${viejas.length} venta(s) no fiscal(es) sin facturar hace más de ${dias} días.` });
  else await Notificacion.resolverPorClave('no-fiscales-sin-regularizar', 'No quedan ventas no fiscales vencidas');
  return viejas.length;
};

// Una vez por minuto por instancia: pide el CAEA del período si falta, informa los pendientes, los sin
// movimiento y revisa las alertas. Todo tolera que ARCA no responda.
const ultimaVuelta = new Map();
const mantenimiento = async () => {
  const { codigo } = registro.actual();
  if (Date.now() - (ultimaVuelta.get(codigo) ?? 0) < 60000) return;
  ultimaVuelta.set(codigo, Date.now());
  if (!(await vigente(config.puntoVenta))) {
    const { periodo, orden } = periodoDe();
    await solicitar(config.puntoVenta, periodo, orden).catch((e) => logger.warn(`[caea] no se pudo pedir el CAEA ${periodo}/${orden}: ${e.message}`));
  }
  await informarPendientes();
  await informarSinMovimiento();
  await alertarInformes();
  await alertarNoFiscales();
};

module.exports = { periodoDe, siguienteNumero, vigente, solicitar, informarPendientes, informarSinMovimiento, alertarInformes, noFiscalesPendientes, alertarNoFiscales, mantenimiento };
