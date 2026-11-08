const pool = require('../config/db');
const Consultas = require('../modulos/consultas');

// Lo que Compras responde a Contable (llamada n.º 18): la deuda con proveedores en pesos y el documento de un comprobante o una orden de pago.
Consultas.registrar('compras', 'proveedores', async () => {
  const [[r]] = await pool.query("SELECT COALESCE(SUM(v.saldo), 0) AS deuda FROM cmp_vencimientos v JOIN cmp_comprobantes c ON c.id = v.comprobante_id WHERE v.estado = 'pendiente' AND c.moneda = 'ARS' AND c.estado IN ('registrado', 'pendiente_recepcion', 'con_diferencias')");
  return { total: Math.round(Number(r.deuda) * 100) / 100 };
});

Consultas.registrar('compras', 'documento', async ({ tipo, id }) => {
  if (tipo.startsWith('orden_pago')) {
    const [[o]] = await pool.query('SELECT id_global, numero, estado FROM cmp_ordenes_pago WHERE id_global = ?', [id]);
    return o ? { tipo: 'orden_pago', id_global: o.id_global, numero: o.numero, estado: o.estado } : null;
  }
  const [[c]] = await pool.query('SELECT id_global, clase, tipo, total, estado FROM cmp_comprobantes WHERE id_global = ?', [id]);
  return c ? { tipo: 'comprobante', id_global: c.id_global, clase: c.clase, letra: c.tipo, total: Number(c.total), estado: c.estado } : null;
});
