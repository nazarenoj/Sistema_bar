const pool = require('../config/db');
const afipConfig = require('../config/afipConfig');
const Mensajeria = require('../mensajeria/servicio');
const Parametro = require('../models/parametroModel');
const Producto = require('../models/productoModel');
const Factura = require('../models/facturaModel');
const puertos = require('../modulos/puertos');
const afipService = require('./afipService');
const Venta = require('./ventaService');
const { idGlobal } = require('../utils/idGlobal');

// Anulación y devolución de ventas (Ventas RF15, RF49, RN19, RN76). Cada devolución es un documento propio:
// la venta original no se modifica. Anular es devolver todo lo que quede. Si la venta tenía factura aprobada
// se emite la nota de crédito por el servicio de emisión; si ARCA falla la devolución no se revierte y la
// nota queda pendiente de reintento (/api/facturas/:id/reintentar).
class DevolucionInvalida extends Error {}

const NC_DE = { 1: 3, 6: 8, 11: 13 }; // Factura A/B/C -> Nota de Crédito A/B/C
const centavos = (n) => Math.round(Number(n) * 100);

// Reparto por defecto del reintento: proporcional a lo pagado con cada forma, con el redondeo en la última (RN76).
const repartoOriginal = (pagos, totalVenta, total) => {
  const salida = [];
  let asignado = 0;
  pagos.forEach((p, i) => {
    const importe = i === pagos.length - 1 ? (centavos(total) - asignado) / 100 : Math.round(centavos(total) * Number(p.importe) / Number(totalVenta)) / 100;
    asignado += centavos(importe);
    salida.push({ forma: p.metodo_pago, importe });
  });
  return salida;
};

// ¿Devolver con una forma de pago distinta de las originales? Pide supervisor mientras el parámetro lo exija (RN76.3).
const necesitaAutorizacion = async (venta, reintegro) => {
  if (!Array.isArray(reintegro) || !reintegro.length) return false;
  if (!((await Parametro.todos()).reintegro_otra_forma_requiere_supervisor ?? 1)) return false;
  const originales = new Set(venta.pagos.map((p) => p.metodo_pago));
  return reintegro.some((r) => !originales.has(r.forma));
};

const yaDevuelto = async (conn, ventaId) => {
  const [rows] = await conn.query(
    'SELECT di.linea, SUM(di.cantidad) AS cantidad FROM devolucion_items di JOIN devoluciones d ON d.id = di.devolucion_id WHERE d.venta_id = ? GROUP BY di.linea', [ventaId]);
  return new Map(rows.map((r) => [r.linea, Number(r.cantidad)]));
};

// items: [{ linea, cantidad }] o `todo: true` para anular lo que quede.
const devolver = async (idGlobalVenta, { items, todo, motivo, reingreso = 'reingreso', reintegro }, { idSolicitud, userId, autorizadoPor } = {}) => {
  if (typeof motivo !== 'string' || !motivo.trim()) throw new DevolucionInvalida('El motivo es obligatorio.');
  if (!['reingreso', 'merma'].includes(reingreso)) throw new DevolucionInvalida('"reingreso" debe ser reingreso o merma.');
  const venta = await Venta.obtener(idGlobalVenta);
  if (!venta) throw Object.assign(new DevolucionInvalida('Venta no encontrada.'), { status: 404 });

  const conn = await pool.getConnection();
  let devolucion, itemsDev, reintegros, nc;
  try {
    await conn.beginTransaction();
    // Se serializa sobre la venta: dos devoluciones simultáneas no pueden devolver dos veces lo mismo.
    await conn.query('SELECT id FROM ventas WHERE id = ? FOR UPDATE', [venta.id]);
    const devuelto = await yaDevuelto(conn, venta.id);

    const pedidas = todo
      ? venta.detalle.map((l, linea) => ({ linea, cantidad: l.cantidad - (devuelto.get(linea) ?? 0) })).filter((i) => i.cantidad > 0)
      : items;
    if (!Array.isArray(pedidas) || !pedidas.length) throw new DevolucionInvalida(todo ? 'No queda nada por devolver en esta venta.' : 'Indicá los ítems a devolver.');

    itemsDev = pedidas.map(({ linea, cantidad }) => {
      const l = venta.detalle[linea];
      if (!l || !Number.isInteger(cantidad) || cantidad <= 0) throw new DevolucionInvalida('Ítem de devolución inválido.');
      if (cantidad > l.cantidad - (devuelto.get(linea) ?? 0)) throw new DevolucionInvalida(`No se puede devolver más de lo vendido y no devuelto de "${l.nombre}".`);
      return { linea, producto_id: l.producto_id, nombre: l.nombre, cantidad, precio_unitario: l.precio_unitario };
    });
    if (new Set(itemsDev.map((i) => i.linea)).size !== itemsDev.length) throw new DevolucionInvalida('Hay líneas repetidas.');
    const total = itemsDev.reduce((a, i) => a + centavos(i.precio_unitario) * i.cantidad, 0) / 100;

    // Reintegro: el reparto original salvo que el usuario elija otro (RF49).
    reintegros = reintegro?.length ? reintegro : repartoOriginal(venta.pagos, venta.total, total);
    const [formas] = await conn.query('SELECT codigo FROM formas_pago WHERE activa = 1');
    const activas = new Set(formas.map((f) => f.codigo));
    for (const r of reintegros) {
      if (!activas.has(r.forma)) throw new DevolucionInvalida(`La forma de reintegro "${r.forma}" no existe o está desactivada.`);
      if (!(Number(r.importe) > 0)) throw new DevolucionInvalida('Cada importe de reintegro debe ser mayor a cero.');
    }
    if (reintegros.reduce((a, r) => a + centavos(r.importe), 0) !== centavos(total))
      throw new DevolucionInvalida(`El reintegro (${reintegros.reduce((a, r) => a + Number(r.importe), 0)}) debe sumar lo devuelto (${total}).`);

    const restante = venta.detalle.reduce((a, l, i) => a + l.cantidad - (devuelto.get(i) ?? 0), 0);
    const tipo = itemsDev.reduce((a, i) => a + i.cantidad, 0) === restante ? 'total' : 'parcial';
    const id_global = await idGlobal();
    const [r] = await conn.query(
      'INSERT INTO devoluciones (id_global, venta_id, tipo, total, motivo, reingreso, id_solicitud, creado_por, autorizado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id_global, venta.id, tipo, total, motivo.trim(), reingreso, idSolicitud ?? null, userId ?? null, autorizadoPor ?? null]);
    for (const i of itemsDev)
      await conn.query('INSERT INTO devolucion_items (devolucion_id, linea, producto_id, nombre, cantidad, precio_unitario) VALUES (?, ?, ?, ?, ?, ?)',
        [r.insertId, i.linea, i.producto_id, i.nombre, i.cantidad, i.precio_unitario]);
    for (const x of reintegros)
      await conn.query('INSERT INTO devolucion_reintegros (devolucion_id, metodo_pago, importe) VALUES (?, ?, ?)', [r.insertId, x.forma, x.importe]);

    // Reingreso al stock (la merma no reingresa). Hasta C3 el stock se mueve directo, como en el cierre.
    if (reingreso === 'reingreso') {
      await Producto.incrementarStock(itemsDev, conn);
      await (await puertos.obtener('stock')).reingresarPorDevolucion(itemsDev, conn);
    }

    // Nota de crédito: solo si la venta tenía una factura aprobada que corregir.
    const original = await Factura.getBySesion(venta.mesa_id, venta.sesion_apertura, conn);
    if (original?.estado === 'aprobada') {
      nc = await Factura.create({
        mesa_id: venta.mesa_id, sesion_apertura: venta.sesion_apertura, metodo_pago: reintegros.length > 1 ? 'mixto' : reintegros[0].forma,
        tipo_comprobante: NC_DE[original.tipo_comprobante], punto_venta: original.punto_venta, doc_tipo: original.doc_tipo, doc_nro: original.doc_nro,
        condicion_iva_receptor_id: original.condicion_iva_receptor_id, receptor_nombre: original.receptor_nombre, domicilio_receptor: original.domicilio_receptor,
        importe_total: total, entorno: afipConfig.entorno, creado_por: userId, devolucion_id: r.insertId, comprobante_origen_id: original.id,
      }, conn);
      nc.original = original;
    }

    // Efectos en otros módulos: el contramovimiento del cobro y el evento contable (no para una venta no fiscal, RN84).
    const contenido = { venta_id_global: idGlobalVenta, total, tipo, reingreso, reintegros, items: itemsDev };
    for (const destino of [{ m: 'financiero', t: 'cobro_revertido' }, { m: 'contable', t: 'venta_devuelta' }]) {
      if (venta.condicion_fiscal === 'no_fiscal' && destino.m === 'contable') continue;
      await Mensajeria.publicar(conn, { origen: 'ventas', destino: destino.m, tipo: destino.t, docTipo: 'devolucion', docIdGlobal: id_global, userId, solicitud: idSolicitud, contenido });
    }
    await conn.commit();
    devolucion = { id: r.insertId, id_global, tipo, total, reingreso };
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY' && /solicitud/.test(err.message)) throw new DevolucionInvalida('Esta devolución ya fue registrada con esa clave de solicitud.');
    throw err;
  } finally {
    conn.release();
  }
  Mensajeria.despertar();

  // Fuera de la transacción: si ARCA falla, la devolución ya está y la nota de crédito queda para reintentar.
  let notaCredito = null;
  if (nc) {
    try {
      const resultado = await afipService.emitirFactura({
        tipoComprobante: nc.tipo_comprobante, docTipo: nc.doc_tipo, docNro: nc.doc_nro, condicionIvaReceptorId: nc.condicion_iva_receptor_id,
        importeTotal: devolucion.total, idIntento: idSolicitud, facturaId: nc.id,
        comprobanteAsociado: { Tipo: nc.original.tipo_comprobante, PtoVta: nc.original.punto_venta, Nro: nc.original.numero },
      });
      await Factura.updateResultado(nc.id, resultado);
    } catch (err) {
      await Factura.updateResultado(nc.id, { estado: 'error', importeTotal: devolucion.total, observaciones: err.message });
    }
    notaCredito = await Factura.getById(nc.id);
  }
  return { devolucion, reintegros, nota_credito: notaCredito };
};

const listar = async (idGlobalVenta) => {
  const [devs] = await pool.query(
    `SELECT d.* FROM devoluciones d JOIN ventas v ON v.id = d.venta_id WHERE v.id_global = ? ORDER BY d.id`, [idGlobalVenta]);
  for (const d of devs) {
    d.items = (await pool.query('SELECT linea, producto_id, nombre, cantidad, precio_unitario FROM devolucion_items WHERE devolucion_id = ?', [d.id]))[0];
    d.reintegros = (await pool.query('SELECT metodo_pago, importe FROM devolucion_reintegros WHERE devolucion_id = ?', [d.id]))[0];
    d.nota_credito = (await pool.query('SELECT id, estado, numero, cae, tipo_comprobante FROM facturas WHERE devolucion_id = ?', [d.id]))[0][0] ?? null;
  }
  return devs;
};

module.exports = { devolver, listar, necesitaAutorizacion, DevolucionInvalida, NC_DE };
