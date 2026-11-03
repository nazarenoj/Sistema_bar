const pool = require('../config/db');
const Tablero = require('../servicios/tableroService');

// Indicadores de Stock para el tablero (Stock RF33). Stock es dueño de las fórmulas; el tablero solo los muestra.
const n = (x) => Math.round(Number(x ?? 0) * 100) / 100;

// Valor de los egresos por mermas sobre el valor total de lo que salió (egresos y ventas), al costo de cada movimiento.
const mermas = async ({ desde, hasta }) => {
  const [[r]] = await pool.query(
    `SELECT COALESCE(SUM(IF(ms.clase_contable = 'merma', -m.cantidad * COALESCE(m.costo_unitario, 0), 0)), 0) AS merma, COALESCE(SUM(-m.cantidad * COALESCE(m.costo_unitario, 0)), 0) AS salidas
     FROM stock_movimientos m JOIN motivos_stock ms ON ms.codigo = m.motivo
     WHERE m.tipo IN ('egreso', 'venta') AND m.cantidad < 0 AND m.created_at >= ? AND m.created_at <= ?`, [desde, hasta]);
  return { valor: Number(r.salidas) ? n(Number(r.merma) / Number(r.salidas) * 100) : 0, detalle: { valor_mermas: n(r.merma), valor_salidas: n(r.salidas) } };
};
// Lotes con saldo que vencen dentro de los próximos días (parámetro `vencimiento_aviso_dias`, 7 por defecto).
const vencimientos = async () => {
  const dias = Number((await pool.query("SELECT valor FROM parametros WHERE clave = 'vencimiento_aviso_dias'"))[0][0]?.valor ?? 7);
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS lotes FROM lotes WHERE bloqueado = 0 AND fecha_vencimiento IS NOT NULL AND fecha_vencimiento >= CURDATE() AND fecha_vencimiento <= DATE_ADD(CURDATE(), INTERVAL ? DAY)`, [dias]);
  return { valor: Number(r.lotes), detalle: { dias } };
};

Tablero.registrar([
  { id: 'stock.mermas', nombre: 'Mermas %', modulo: 'stock', permiso: 'stock.insumos.ver', comparable: true, unidad: '%', calcular: mermas },
  { id: 'stock.vencimientos', nombre: 'Vencimientos próximos', modulo: 'stock', funcion: 'STK-LOTES', permiso: 'stock.insumos.ver', unidad: 'lotes', calcular: vencimientos },
]);
