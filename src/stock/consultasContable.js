const pool = require('../config/db');
const Consultas = require('../modulos/consultas');
const Costos = require('./costoService');

// Lo que Stock responde a Contable (llamada n.º 18): el inventario valorizado y el movimiento de un documento de origen.
Consultas.registrar('stock', 'inventario', async () => {
  const v = await Costos.valorizado({});
  return { total: v.total, items: v.items.length, sin_costo: v.items.filter((i) => i.cantidad_sin_costo !== 0).length };
});

Consultas.registrar('stock', 'documento', async ({ id }) => {
  const [[m]] = await pool.query('SELECT COUNT(*) AS movimientos, MIN(motivo) AS motivo, SUM(-cantidad * COALESCE(costo_unitario, 0)) AS valor FROM stock_movimientos WHERE documento = ?', [id]);
  return Number(m.movimientos) ? { tipo: 'movimientos_de_stock', id_global: id, movimientos: Number(m.movimientos), motivo: m.motivo, valor: Math.round(Number(m.valor) * 100) / 100 } : null;
});
