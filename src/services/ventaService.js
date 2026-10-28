const pool = require('../config/db');
const Mensajeria = require('../mensajeria/servicio');
const Funciones = require('../funciones/servicio');
const { idGlobal } = require('../utils/idGlobal');

// Efectos de una venta cerrada en otros módulos (Ventas RN58). Cada uno es un mensaje de la bandeja de
// salida; si el módulo receptor no está instalado, no se genera (Mensajeria.publicar). El descuento de
// stock sigue siendo directo hasta que exista el módulo Stock (C3).
const EFECTOS = [
  { destino: 'financiero', tipo: 'cobro_registrado' },
  { destino: 'contable', tipo: 'venta_confirmada' },
];

class PagoInvalido extends Error {}

const centavos = (n) => Math.round(Number(n) * 100);

// Valida los pagos de una cuenta contra las formas de pago configuradas (RF09, RN16): forma activa,
// referencia si la forma la pide, vuelto solo donde se admite, y la suma de lo aplicado igual al total.
// `pagos`: [{ forma, importe, referencia?, recibido? }]. Devuelve los pagos normalizados con su vuelto.
const validarPagos = async (conn, pagos, total) => {
  if (!Array.isArray(pagos) || !pagos.length) throw new PagoInvalido('Indicá al menos una forma de pago.');
  const [formas] = await conn.query('SELECT * FROM formas_pago WHERE activa = 1');
  const porCodigo = new Map(formas.map((f) => [f.codigo, f]));
  const normalizados = pagos.map((p) => {
    const f = porCodigo.get(p.forma);
    if (!f) throw new PagoInvalido(`La forma de pago "${p.forma}" no existe o está desactivada.`);
    if (!(Number(p.importe) > 0)) throw new PagoInvalido(`El importe de "${f.nombre}" debe ser mayor a cero.`);
    const referencia = typeof p.referencia === 'string' ? p.referencia.trim() || null : null;
    if (f.requiere_referencia && !referencia) throw new PagoInvalido(`"${f.nombre}" requiere una referencia.`);
    let vuelto = 0;
    if (p.recibido !== undefined && p.recibido !== null) {
      if (!f.admite_vuelto) throw new PagoInvalido(`"${f.nombre}" no admite vuelto.`);
      if (centavos(p.recibido) < centavos(p.importe)) throw new PagoInvalido(`Lo recibido en "${f.nombre}" es menor que el importe.`);
      vuelto = (centavos(p.recibido) - centavos(p.importe)) / 100;
    }
    return { forma: f.codigo, importe: Number(p.importe), referencia, recibido: p.recibido ?? null, vuelto };
  });
  const suma = normalizados.reduce((a, p) => a + centavos(p.importe), 0);
  if (suma !== centavos(total)) throw new PagoInvalido(`La suma de los pagos (${suma / 100}) no coincide con el total de la cuenta (${Number(total)}).`);
  return normalizados;
};

// Lo que se guarda en pedidos y facturas: el código de la forma, o 'mixto' si hay varias.
const metodoResumen = (pagos) => (pagos.length > 1 ? 'mixto' : pagos[0].forma);

// Registra la venta de una cuenta cerrada. Va con la `conn` de la transacción del cierre: si el cierre
// se revierte, no queda ni la venta ni sus mensajes. Un efecto que falle después nunca revierte la venta.
const registrar = async (conn, { mesa_id, sesion_apertura, items, total, pagos, idSolicitud, userId }) => {
  const id_global = await idGlobal();
  const snap = await Funciones.instantanea('pedido');
  const detalle = items.map((i) => ({ producto_id: i.producto_id, nombre: i.nombre, cantidad: i.cantidad, precio_unitario: Number(i.precio_unitario) }));
  const [r] = await conn.query(
    'INSERT INTO ventas (id_global, mesa_id, sesion_apertura, total, detalle, id_solicitud, config_version, creado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id_global, mesa_id, sesion_apertura, total, JSON.stringify(detalle), idSolicitud ?? null, snap.version, userId ?? null]
  );
  for (const p of pagos) {
    await conn.query('INSERT INTO pago_venta (venta_id, metodo_pago, importe, referencia, recibido, vuelto) VALUES (?, ?, ?, ?, ?, ?)',
      [r.insertId, p.forma, p.importe, p.referencia, p.recibido, p.vuelto]);
  }
  for (const e of EFECTOS) {
    await Mensajeria.publicar(conn, {
      origen: 'ventas', destino: e.destino, tipo: e.tipo, docTipo: 'venta', docIdGlobal: id_global, userId,
      solicitud: idSolicitud, contenido: { total, pagos, items: detalle },
    });
  }
  return { id: r.insertId, id_global };
};

// La venta con su estado de integración (Completa / Parcial, con la lista de efectos).
const obtener = async (id_global) => {
  const [[venta]] = await pool.query('SELECT * FROM ventas WHERE id_global = ?', [id_global]);
  if (!venta) return null;
  const [pagos] = await pool.query('SELECT metodo_pago, importe, referencia, recibido, vuelto FROM pago_venta WHERE venta_id = ?', [venta.id]);
  return { ...venta, detalle: JSON.parse(venta.detalle), pagos, integracion: await Mensajeria.estadoIntegracion(id_global) };
};

// Total cobrado por forma de pago en un rango de fechas (cierre de caja y reportes, RF09).
const porFormaPago = async ({ desde, hasta } = {}) => {
  const [rows] = await pool.query(
    `SELECT pv.metodo_pago AS forma, COUNT(*) AS pagos, SUM(pv.importe) AS total
     FROM pago_venta pv JOIN ventas v ON v.id = pv.venta_id
     WHERE (? IS NULL OR v.created_at >= ?) AND (? IS NULL OR v.created_at < DATE_ADD(?, INTERVAL 1 DAY))
     GROUP BY pv.metodo_pago ORDER BY total DESC`, [desde ?? null, desde ?? null, hasta ?? null, hasta ?? null]);
  return rows;
};

module.exports = { registrar, obtener, validarPagos, metodoResumen, porFormaPago, PagoInvalido, EFECTOS };
