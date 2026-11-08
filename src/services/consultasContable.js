const pool = require('../config/db');
const Consultas = require('../modulos/consultas');

// Lo que Ventas responde a Contable (llamada n.º 18): los remitos pendientes de facturar y el documento de una venta, devolución, remito o liquidación.
Consultas.registrar('ventas', 'remitos_pendientes', async () => {
  const [[r]] = await pool.query("SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS cantidad FROM remitos WHERE estado = 'emitido' AND facturacion = 'pendiente' AND cuenta_asignada = 1");
  return { total: Math.round(Number(r.total) * 100) / 100, cantidad: Number(r.cantidad) };
});

Consultas.registrar('ventas', 'documento', async ({ tipo, id }) => {
  const buscar = async (tabla, extra, rotulo) => {
    const [[d]] = await pool.query(`SELECT id_global, total ${extra} FROM ${tabla} WHERE id_global = ?`, [id]);
    return d ? { tipo: rotulo, id_global: d.id_global, total: Number(d.total) } : null;
  };
  if (tipo === 'venta_devuelta') return buscar('devoluciones', '', 'devolucion');
  if (tipo === 'remito_emitido') return buscar('remitos', '', 'remito');
  if (tipo === 'comision_liquidada') return buscar('comision_liquidaciones', '', 'liquidacion_comision');
  return buscar('ventas', '', 'venta');
});
