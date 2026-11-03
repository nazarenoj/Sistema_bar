const pool = require('../config/db');
const Consolidacion = require('../servicios/consolidacionService');

// Paquete de consolidación de Stock (Stock RF34): existencias valorizadas a la fecha de corte por ítem y mermas del día por motivo. Sin lotes,
// series ni movimientos individuales. El valor sale de los movimientos al costo de cada uno.
const r2 = (x) => Math.round(Number(x ?? 0) * 100) / 100;

Consolidacion.registrarPaquete('stock', {
  funcion: 'USU-CONSOL',
  generar: async (periodo) => {
    const [ex] = await pool.query(
      `SELECT i.nombre, SUM(m.cantidad) AS cantidad, SUM(m.cantidad * COALESCE(m.costo_unitario, 0)) AS valor FROM stock_movimientos m JOIN insumos i ON i.id = m.insumo_id
       WHERE m.created_at <= ? GROUP BY i.id, i.nombre HAVING ABS(SUM(m.cantidad)) > 0.0005 ORDER BY i.nombre`, [`${periodo} 23:59:59`]);
    const [me] = await pool.query(
      `SELECT ms.nombre AS motivo, -SUM(m.cantidad) AS cantidad, -SUM(m.cantidad * COALESCE(m.costo_unitario, 0)) AS valor FROM stock_movimientos m JOIN motivos_stock ms ON ms.codigo = m.motivo
       WHERE m.tipo = 'egreso' AND ms.clase_contable = 'merma' AND m.created_at >= ? AND m.created_at <= ? GROUP BY ms.nombre ORDER BY ms.nombre`, [`${periodo} 00:00:00`, `${periodo} 23:59:59`]);
    return {
      existencias: ex.map((e) => ({ item: e.nombre, cantidad: r2(e.cantidad), valor: r2(e.valor) })),
      mermas: me.map((m) => ({ motivo: m.motivo, cantidad: r2(m.cantidad), valor: r2(m.valor) })),
    };
  },
});
