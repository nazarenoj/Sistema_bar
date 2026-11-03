const pool = require('../config/db');
const Consolidacion = require('../servicios/consolidacionService');

// Paquete de consolidación de Ventas (Ventas RF46, RN48): lo vendido en un día, agregado por producto y forma de pago, con anulaciones y
// devoluciones. Solo importes y cantidades: sin clientes, usuarios ni números de comprobante. Generarlo no modifica la operación.
const r2 = (x) => Math.round(Number(x ?? 0) * 100) / 100;

Consolidacion.registrarPaquete('ventas', {
  funcion: 'USU-CONSOL',
  generar: async (periodo) => {
    const d = `${periodo} 00:00:00`, h = `${periodo} 23:59:59`;
    const [ventas] = await pool.query(
      `SELECT v.id, v.total, v.detalle, COALESCE(dv.devuelto, 0) AS devuelto FROM ventas v
       LEFT JOIN (SELECT venta_id, SUM(total) AS devuelto FROM devoluciones GROUP BY venta_id) dv ON dv.venta_id = v.id
       WHERE v.created_at >= ? AND v.created_at <= ?`, [d, h]);
    const vivas = ventas.filter((v) => Number(v.devuelto) < Number(v.total));
    const prod = new Map();
    for (const v of vivas) for (const l of JSON.parse(v.detalle)) {
      const a = prod.get(l.nombre) ?? { producto: l.nombre, cantidad: 0, importe: 0 };
      a.cantidad += Number(l.cantidad); a.importe += l.cantidad * l.precio_unitario - (l.importe_descuento ?? 0); prod.set(l.nombre, a);
    }
    const [formas] = vivas.length ? await pool.query('SELECT metodo_pago AS forma, SUM(importe) AS importe FROM pago_venta WHERE venta_id IN (?) GROUP BY metodo_pago ORDER BY metodo_pago', [vivas.map((v) => v.id)]) : [[]];
    const [[dev]] = await pool.query('SELECT COALESCE(SUM(total), 0) AS total FROM devoluciones WHERE created_at >= ? AND created_at <= ?', [d, h]);
    return {
      ventas: vivas.length,
      importe: r2(vivas.reduce((s, v) => s + Number(v.total) - Number(v.devuelto), 0)),
      anulaciones: ventas.length - vivas.length,
      devoluciones: r2(dev.total),
      por_producto: [...prod.values()].sort((a, b) => a.producto.localeCompare(b.producto)).map((p) => ({ ...p, importe: r2(p.importe) })),
      por_forma_pago: formas.map((f) => ({ forma: f.forma, importe: r2(f.importe) })),
    };
  },
});
