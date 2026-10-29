const pool = require('../config/db');
const Parametro = require('../models/parametroModel');
const { esFechaISO } = require('../utils/validaciones');

// Registro de ventas (Ventas RF19 a RF21, RN24, RN26). Lista sobre la tabla `ventas`, que es de solo
// lectura (RN19, RN25): el estado (cerrada / devuelta parcial / anulada) sale de lo devuelto.
const ESTADO_SQL = `CASE WHEN COALESCE(dv.devuelto, 0) = 0 THEN 'cerrada' WHEN dv.devuelto >= v.total THEN 'anulada' ELSE 'devuelta_parcial' END`;
const DESDE_SQL = `FROM ventas v
  JOIN mesas m ON m.id = v.mesa_id
  LEFT JOIN users u ON u.id = v.creado_por
  LEFT JOIN (SELECT venta_id, SUM(total) AS devuelto FROM devoluciones GROUP BY venta_id) dv ON dv.venta_id = v.id
  LEFT JOIN facturas f ON f.mesa_id = v.mesa_id AND f.sesion_apertura = v.sesion_apertura AND f.devolucion_id IS NULL`;
const ORDEN = { fecha: 'v.created_at', total: 'v.total', mesa: 'm.numero_mesa', numero: 'f.numero', usuario: 'u.username' };
const ESTADOS = ['cerrada', 'devuelta_parcial', 'anulada'];
const MODALIDADES = ['cae', 'caea', 'no_fiscal', 'sin_comprobante'];

class FiltroInvalido extends Error {}

// WHERE y parámetros del filtro, compartidos por la lista, los totales y la exportación (si se armaran dos
// veces, el archivo podría no coincidir con la pantalla).
const construir = (q = {}) => {
  const donde = [];
  const params = [];
  const falla = (m) => { throw new FiltroInvalido(m); };
  for (const c of ['desde', 'hasta']) if (q[c] !== undefined && q[c] !== '' && !esFechaISO(q[c])) falla(`"${c}" debe tener formato YYYY-MM-DD.`);
  if (q.desde) { donde.push('v.created_at >= ?'); params.push(`${q.desde} 00:00:00`); }
  if (q.hasta) { donde.push('v.created_at <= ?'); params.push(`${q.hasta} 23:59:59`); }
  if (q.estado) {
    if (!ESTADOS.includes(q.estado)) falla(`"estado" debe ser uno de: ${ESTADOS.join(', ')}.`);
    donde.push(`${ESTADO_SQL} = ?`); params.push(q.estado);
  } else if (q.incluir_anuladas !== '1') {
    donde.push(`${ESTADO_SQL} <> 'anulada'`); // los totales excluyen las anuladas salvo que el filtro las incluya (RN24)
  }
  if (q.forma_pago) { donde.push('EXISTS (SELECT 1 FROM pago_venta pv WHERE pv.venta_id = v.id AND pv.metodo_pago = ?)'); params.push(q.forma_pago); }
  if (q.modalidad) {
    if (!MODALIDADES.includes(q.modalidad)) falla(`"modalidad" debe ser uno de: ${MODALIDADES.join(', ')}.`);
    donde.push({
      cae: "f.id IS NOT NULL AND f.modalidad = 'CAE'", caea: "f.id IS NOT NULL AND f.modalidad = 'CAEA'",
      no_fiscal: "v.condicion_fiscal = 'no_fiscal'", sin_comprobante: "v.condicion_fiscal = 'fiscal' AND f.id IS NULL",
    }[q.modalidad]);
  }
  if (q.canal) { donde.push('v.modalidad = ?'); params.push(q.canal); } // salón, mostrador, para llevar, delivery o retiro
  if (q.estado_arca) { donde.push('f.estado = ?'); params.push(q.estado_arca); }
  if (q.mesa) { donde.push('m.numero_mesa = ?'); params.push(q.mesa); }
  if (q.usuario) { donde.push('u.username = ?'); params.push(q.usuario); }
  for (const [c, op] of [['importe_min', '>='], ['importe_max', '<=']]) {
    if (q[c] === undefined || q[c] === '') continue;
    if (!Number.isFinite(Number(q[c]))) falla(`"${c}" debe ser un número.`);
    donde.push(`v.total ${op} ?`); params.push(Number(q[c]));
  }
  if (q.pendiente_facturacion === '1') donde.push("v.condicion_fiscal = 'no_fiscal' AND (f.id IS NULL OR f.estado <> 'aprobada')");
  if (q.integracion_pendiente === '1') donde.push("EXISTS (SELECT 1 FROM mensajes_integracion mi WHERE mi.doc_id_global = v.id_global AND (mi.estado <> 'confirmado' OR mi.descartado = 1))");
  const orden = `ORDER BY ${ORDEN[q.sort] ?? ORDEN.fecha} ${q.order === 'asc' ? 'ASC' : 'DESC'}, v.id DESC`;
  return { where: donde.length ? `WHERE ${donde.join(' AND ')}` : '', params, orden };
};

const COLUMNAS = `v.modalidad AS canal, v.id_global, v.mesa_id, m.numero_mesa, v.total, v.created_at, v.condicion_fiscal, v.tipo_no_fiscal, v.numero_no_fiscal,
  u.username AS usuario, COALESCE(dv.devuelto, 0) AS devuelto, ${ESTADO_SQL} AS estado,
  f.id AS factura_id, f.tipo_comprobante, f.punto_venta, f.numero, f.estado AS estado_arca, f.modalidad, f.cae,
  (SELECT GROUP_CONCAT(pv.metodo_pago ORDER BY pv.id) FROM pago_venta pv WHERE pv.venta_id = v.id) AS formas,
  (SELECT COUNT(*) FROM reimpresiones r WHERE r.venta_id = v.id) AS reimpresiones`;

// Cantidad, total vendido (neto de devoluciones: las notas de crédito restan, RN24) y desglose por forma de pago (RF21).
const totales = async ({ where, params }) => {
  const [[t]] = await pool.query(`SELECT COUNT(*) AS cantidad, COALESCE(SUM(v.total - COALESCE(dv.devuelto, 0)), 0) AS total ${DESDE_SQL} ${where}`, params);
  const [pagos] = await pool.query(
    `SELECT pv.metodo_pago AS forma, SUM(pv.importe) AS total FROM pago_venta pv WHERE pv.venta_id IN (SELECT v.id ${DESDE_SQL} ${where}) GROUP BY pv.metodo_pago`, params);
  const [reintegros] = await pool.query(
    `SELECT r.metodo_pago AS forma, SUM(r.importe) AS total FROM devolucion_reintegros r JOIN devoluciones d ON d.id = r.devolucion_id
     WHERE d.venta_id IN (SELECT v.id ${DESDE_SQL} ${where}) GROUP BY r.metodo_pago`, params);
  const porForma = new Map(pagos.map((p) => [p.forma, Number(p.total)]));
  for (const r of reintegros) porForma.set(r.forma, (porForma.get(r.forma) ?? 0) - Number(r.total));
  return { cantidad: Number(t.cantidad), total: Number(t.total), por_forma_pago: [...porForma].map(([forma, total]) => ({ forma, total })).sort((a, b) => b.total - a.total) };
};

const listar = async (q = {}) => {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50)); // 50 filas por página (RN26)
  const f = construir(q);
  const [ventas] = await pool.query(`SELECT ${COLUMNAS} ${DESDE_SQL} ${f.where} ${f.orden} LIMIT ? OFFSET ?`, [...f.params, limit, (page - 1) * limit]);
  const tot = await totales(f);
  return { ventas, totales: tot, page, limit, total_paginas: Math.max(1, Math.ceil(tot.cantidad / limit)) };
};

// Todas las filas del filtro para exportar; si superan el límite no se trunca en silencio (EX17).
const paraExportar = async (q = {}) => {
  const f = construir(q);
  const max = (await Parametro.todos()).exportar_max_filas ?? 10000;
  const [ventas] = await pool.query(`SELECT ${COLUMNAS} ${DESDE_SQL} ${f.where} ${f.orden} LIMIT ?`, [...f.params, max + 1]);
  if (ventas.length > max) throw Object.assign(new FiltroInvalido(`El resultado supera el límite de ${max} filas: acotá el filtro o dividí por períodos.`), { limite: max });
  return { ventas, totales: await totales(f) };
};

module.exports = { listar, paraExportar, construir, FiltroInvalido };
