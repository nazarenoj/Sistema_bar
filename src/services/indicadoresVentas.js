const pool = require('../config/db');
const Tablero = require('../servicios/tableroService');

// Indicadores de Ventas para el tablero (Ventas RF45, RN47): se calculan con los datos de la instancia, excluyen las ventas anuladas (todo lo
// vendido fue devuelto) y restan lo devuelto. Un mozo con alcance "propias" ve solo lo suyo. Ventas es dueño de cada fórmula.
const NETA = 'v.total - COALESCE(dv.devuelto, 0)';
const BASE = `FROM ventas v LEFT JOIN (SELECT venta_id, SUM(total) AS devuelto FROM devoluciones GROUP BY venta_id) dv ON dv.venta_id = v.id
  WHERE v.created_at >= ? AND v.created_at <= ? AND COALESCE(dv.devuelto, 0) < v.total`;
const suyas = (u) => (u ? ' AND v.mozo_id = ?' : '');
const args = (d, h, u) => (u ? [d, h, u] : [d, h]);
const n = (x) => Math.round(Number(x ?? 0) * 100) / 100;

const ventasTotal = async ({ desde, hasta, usuarioId }) => {
  const [[r]] = await pool.query(`SELECT COALESCE(SUM(${NETA}), 0) AS total, COUNT(*) AS cantidad ${BASE}${suyas(usuarioId)}`, args(desde, hasta, usuarioId));
  return { valor: n(r.total), detalle: { ventas: Number(r.cantidad) } };
};
const ticketPromedio = async (c) => {
  const t = await ventasTotal(c);
  return { valor: t.detalle.ventas ? n(t.valor / t.detalle.ventas) : 0, detalle: t.detalle };
};
const porClave = async ({ desde, hasta, usuarioId }, expr) => {
  const [rows] = await pool.query(`SELECT ${expr} AS clave, COALESCE(SUM(${NETA}), 0) AS total ${BASE}${suyas(usuarioId)} GROUP BY clave ORDER BY clave`, args(desde, hasta, usuarioId));
  return { valor: n(rows.reduce((s, r) => s + Number(r.total), 0)), serie: rows.map((r) => ({ clave: String(r.clave), valor: n(r.total) })) };
};
const masVendidos = async ({ desde, hasta, usuarioId }) => {
  const [rows] = await pool.query(`SELECT v.detalle ${BASE}${suyas(usuarioId)}`, args(desde, hasta, usuarioId));
  const cant = new Map();
  for (const r of rows) for (const l of JSON.parse(r.detalle)) cant.set(l.nombre, (cant.get(l.nombre) ?? 0) + Number(l.cantidad));
  const serie = [...cant].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([clave, valor]) => ({ clave, valor }));
  return { valor: serie.reduce((s, x) => s + x.valor, 0), serie };
};
const porMozo = async (c) => {
  const [rows] = await pool.query(`SELECT COALESCE(u.username, 'sin asignar') AS clave, SUM(${NETA}) AS total ${BASE}${suyas(c.usuarioId)} GROUP BY clave ORDER BY total DESC`.replace('FROM ventas v', 'FROM ventas v LEFT JOIN users u ON u.id = v.mozo_id'), args(c.desde, c.hasta, c.usuarioId));
  return { valor: n(rows.reduce((s, r) => s + Number(r.total), 0)), serie: rows.map((r) => ({ clave: r.clave, valor: n(r.total) })) };
};
const promos = async ({ desde, hasta }) => {
  const [[r]] = await pool.query('SELECT COUNT(*) AS veces, COALESCE(SUM(importe), 0) AS importe FROM promociones_aplicadas WHERE created_at >= ? AND created_at <= ?', [desde, hasta]);
  return { valor: Number(r.veces), detalle: { descuento_total: n(r.importe) } };
};
const reservas = async ({ desde, hasta }) => {
  const [[r]] = await pool.query("SELECT SUM(estado = 'cumplida') AS cumplidas, SUM(estado = 'no_presento') AS no_presento FROM reservas_mesa WHERE fecha_hora >= ? AND fecha_hora <= ?", [desde, hasta]);
  const c = Number(r.cumplidas ?? 0), np = Number(r.no_presento ?? 0);
  return { valor: c + np ? n(c / (c + np) * 100) : 0, detalle: { cumplidas: c, no_presento: np } };
};
// Minutos entre que la comanda se pasó a "en preparación" y quedó "lista" (Ventas RF38).
const preparacion = async ({ desde, hasta }) => {
  const [[r]] = await pool.query(
    `SELECT AVG(TIMESTAMPDIFF(SECOND, a.created_at, l.created_at)) / 60 AS minutos, COUNT(*) AS comandas FROM comanda_avances a
     JOIN comanda_avances l ON l.comanda_id = a.comanda_id AND l.hasta = 'listo' AND l.retroceso = 0
     WHERE a.hasta = 'en_preparacion' AND a.retroceso = 0 AND l.created_at >= ? AND l.created_at <= ?`, [desde, hasta]);
  return { valor: n(r.minutos), detalle: { comandas: Number(r.comandas) } };
};
// Margen realizado (neto de IVA menos costo de la venta). "Parcial" si hay líneas sin costo o con costo provisorio.
const margen = async ({ desde, hasta, usuarioId }) => {
  const [ventas] = await pool.query(`SELECT v.id_global, v.detalle ${BASE}${suyas(usuarioId)}`, args(desde, hasta, usuarioId));
  const alic = new Map((await pool.query('SELECT id, alicuota_iva FROM productos'))[0].map((p) => [p.id, Number(p.alicuota_iva)]));
  let margen = 0, parcial = false;
  for (const v of ventas) {
    const costos = new Map((await pool.query('SELECT linea, costo_unitario, provisorio FROM lineas_costo WHERE doc_id_global = ?', [v.id_global]))[0].map((c) => [c.linea, c]));
    JSON.parse(v.detalle).forEach((l, i) => {
      const neto = (l.cantidad * l.precio_unitario - (l.importe_descuento ?? 0)) / (1 + (alic.get(l.producto_id) ?? 21) / 100);
      const c = costos.get(i);
      if (!c || c.costo_unitario === null) { parcial = true; return; }
      if (c.provisorio) parcial = true;
      margen += neto - Number(c.costo_unitario) * l.cantidad;
    });
  }
  return { valor: n(margen), parcial, ...(parcial && { nota: 'Margen parcial: hay ventas sin costo o con costo provisorio.' }) };
};

Tablero.registrar([
  { id: 'ventas.total', nombre: 'Ventas', modulo: 'ventas', permiso: 'ventas.historial.ver', alcance: true, comparable: true, unidad: '$', calcular: ventasTotal },
  { id: 'ventas.ticket_promedio', nombre: 'Ticket promedio', modulo: 'ventas', permiso: 'ventas.historial.ver', alcance: true, comparable: true, unidad: '$', calcular: ticketPromedio },
  { id: 'ventas.por_hora', nombre: 'Ventas por hora', modulo: 'ventas', permiso: 'ventas.historial.ver', alcance: true, unidad: '$', calcular: (c) => porClave(c, 'HOUR(v.created_at)') },
  { id: 'ventas.por_dia', nombre: 'Ventas por día', modulo: 'ventas', permiso: 'ventas.historial.ver', alcance: true, unidad: '$', calcular: (c) => porClave(c, 'DATE(v.created_at)') },
  { id: 'ventas.por_turno', nombre: 'Ventas por turno', modulo: 'ventas', permiso: 'ventas.historial.ver', alcance: true, unidad: '$', calcular: (c) => porClave(c, "IF(HOUR(v.created_at) < 15, 'mañana', 'tarde')") },
  { id: 'ventas.mas_vendidos', nombre: 'Productos más vendidos', modulo: 'ventas', permiso: 'ventas.historial.ver', alcance: true, unidad: 'u', calcular: masVendidos },
  { id: 'ventas.por_mozo', nombre: 'Ventas por mozo', modulo: 'ventas', permiso: 'ventas.historial.ver', alcance: true, unidad: '$', calcular: porMozo },
  { id: 'ventas.promociones', nombre: 'Promociones aplicadas', modulo: 'ventas', funcion: 'VEN-PROMOS', permiso: 'ventas.historial.ver', comparable: true, unidad: 'veces', calcular: promos },
  { id: 'ventas.reservas', nombre: 'Reservas cumplidas', modulo: 'ventas', funcion: 'VEN-RESERVAS', permiso: 'ventas.historial.ver', comparable: true, unidad: '%', calcular: reservas },
  { id: 'ventas.preparacion', nombre: 'Tiempo medio de preparación', modulo: 'ventas', funcion: 'VEN-KDS', permiso: 'ventas.historial.ver', comparable: true, unidad: 'min', calcular: preparacion },
  { id: 'ventas.margen_realizado', nombre: 'Margen realizado', modulo: 'ventas', algunoDe: ['stock', 'compras'], permiso: 'ventas.historial.ver', alcance: true, comparable: true, unidad: '$', calcular: margen },
]);
