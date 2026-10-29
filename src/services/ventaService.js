const pool = require('../config/db');
const Mensajeria = require('../mensajeria/servicio');
const Funciones = require('../funciones/servicio');
const { idGlobal } = require('../utils/idGlobal');
const Caea = require('./caeaService');
const Factura = require('../models/facturaModel');
const afipService = require('./afipService');
const afipConfig = require('../config/afipConfig');
const TIPOS_NO_FISCAL = ['ticket', 'presupuesto', 'remito'];

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
const registrar = async (conn, { mesa_id, sesion_apertura, items, total, pagos, idSolicitud, userId, tipoNoFiscal = null, modalidad = 'salon', mozoId = null }) => {
  const id_global = await idGlobal();
  // Un no fiscal tiene numeración propia, diferenciada de la fiscal, y queda "pendiente de facturación" (RF12, RN84).
  const numeroNoFiscal = tipoNoFiscal ? await Caea.siguienteNumero(`NF:${tipoNoFiscal}`, conn) : null;
  const snap = await Funciones.instantanea('pedido');
  const detalle = items.map((i) => ({ producto_id: i.producto_id, nombre: i.nombre, cantidad: i.cantidad, precio_unitario: Number(i.precio_unitario) }));
  const [r] = await conn.query(
    'INSERT INTO ventas (id_global, mesa_id, sesion_apertura, total, detalle, id_solicitud, config_version, creado_por, condicion_fiscal, tipo_no_fiscal, numero_no_fiscal, modalidad, mozo_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id_global, mesa_id, sesion_apertura, total, JSON.stringify(detalle), idSolicitud ?? null, snap.version, userId ?? null, tipoNoFiscal ? 'no_fiscal' : 'fiscal', tipoNoFiscal, numeroNoFiscal, modalidad, mozoId]
  );
  for (const p of pagos) {
    await conn.query('INSERT INTO pago_venta (venta_id, metodo_pago, importe, referencia, recibido, vuelto) VALUES (?, ?, ?, ?, ?, ?)',
      [r.insertId, p.forma, p.importe, p.referencia, p.recibido, p.vuelto]);
  }
  for (const e of EFECTOS) {
    if (tipoNoFiscal && e.destino === 'contable') continue; // una venta no fiscal no se informa a Contable (RN84)
    await Mensajeria.publicar(conn, {
      origen: 'ventas', destino: e.destino, tipo: e.tipo, docTipo: 'venta', docIdGlobal: id_global, userId,
      solicitud: idSolicitud, contenido: { total, pagos, items: detalle },
    });
  }
  return { id: r.insertId, id_global, numero_no_fiscal: numeroNoFiscal };
};

// La venta con su estado de integración (Completa / Parcial, con la lista de efectos).
const obtener = async (id_global) => {
  const [[venta]] = await pool.query('SELECT * FROM ventas WHERE id_global = ?', [id_global]);
  if (!venta) return null;
  const [pagos] = await pool.query('SELECT metodo_pago, importe, referencia, recibido, vuelto FROM pago_venta WHERE venta_id = ?', [venta.id]);
  // La venta no cambia (RN19): su estado sale de lo devuelto.
  const [[{ devuelto }]] = await pool.query('SELECT COALESCE(SUM(total), 0) AS devuelto FROM devoluciones WHERE venta_id = ?', [venta.id]);
  const estado = Number(devuelto) === 0 ? 'cerrada' : Math.round(Number(devuelto) * 100) >= Math.round(Number(venta.total) * 100) ? 'anulada' : 'devuelta_parcial';
  const [reimpresiones] = await pool.query('SELECT username, formato, motivo, created_at FROM reimpresiones WHERE venta_id = ? ORDER BY id', [venta.id]);
  return { ...venta, detalle: JSON.parse(venta.detalle), pagos, devuelto: Number(devuelto), estado, reimpresiones, integracion: await Mensajeria.estadoIntegracion(id_global) };
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

// Emite la factura que regulariza una venta no fiscal (RN84). Con la factura aprobada la venta deja de estar
// pendiente; no se repite descuento de stock ni cobro: solo se publica "Venta regularizada" (hacia Contable).
// shortcut: si el primer intento falla y se reintenta con /facturas/:id/reintentar, el evento no se publica.
const regularizar = async (idGlobal, receptor, { idIntento, userId } = {}) => {
  const venta = await obtener(idGlobal);
  if (!venta) throw Object.assign(new Error('Venta no encontrada.'), { status: 404 });
  if (venta.condicion_fiscal !== 'no_fiscal') throw Object.assign(new Error('La venta no es un comprobante no fiscal.'), { status: 400 });
  let factura = await Factura.getBySesion(venta.mesa_id, venta.sesion_apertura);
  if (factura?.estado === 'aprobada') throw Object.assign(new Error('La venta ya está regularizada.'), { status: 409 });
  factura ||= await Factura.create({
    mesa_id: venta.mesa_id, sesion_apertura: venta.sesion_apertura, metodo_pago: venta.pagos.length > 1 ? 'mixto' : venta.pagos[0].metodo_pago,
    tipo_comprobante: receptor.tipo_comprobante, punto_venta: afipConfig.puntoVenta, doc_tipo: receptor.doc_tipo, doc_nro: String(receptor.doc_nro),
    condicion_iva_receptor_id: receptor.condicion_iva_receptor_id, receptor_nombre: receptor.receptor_nombre, domicilio_receptor: receptor.domicilio_receptor,
    importe_total: venta.total, entorno: afipConfig.entorno, creado_por: userId,
  });
  try {
    const resultado = await afipService.emitirFactura({
      tipoComprobante: factura.tipo_comprobante, docTipo: factura.doc_tipo, docNro: factura.doc_nro,
      condicionIvaReceptorId: factura.condicion_iva_receptor_id, importeTotal: Number(venta.total), idIntento, facturaId: factura.id,
    });
    await Factura.updateResultado(factura.id, resultado);
  } catch (err) {
    await Factura.updateResultado(factura.id, { estado: 'error', importeTotal: venta.total, observaciones: err.message });
    throw Object.assign(err, { factura_id: factura.id });
  }
  factura = await Factura.getById(factura.id);
  if (factura.estado === 'aprobada') {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await Mensajeria.publicar(conn, { origen: 'ventas', destino: 'contable', tipo: 'venta_regularizada', docTipo: 'venta', docIdGlobal: idGlobal, userId,
        contenido: { total: venta.total, pagos: venta.pagos, factura_id_global: factura.id_global } });
      await conn.commit();
    } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
    Mensajeria.despertar();
  }
  return factura;
};

module.exports = { regularizar, TIPOS_NO_FISCAL, registrar, obtener, validarPagos, metodoResumen, porFormaPago, PagoInvalido, EFECTOS };
