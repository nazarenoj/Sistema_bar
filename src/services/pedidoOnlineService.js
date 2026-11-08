const pool = require('../config/db');
const Mesa = require('../models/mesaModel');
const Pedido = require('../models/pedidoModel');
const Venta = require('./ventaService');
const Comandas = require('./comandaService');
const Mensajeria = require('../mensajeria/servicio');
const logger = require('../utils/logger');

// Ventas recibe un pedido online ya pagado (Ventas RF25, Ventas Online RN44): lo abre como un pedido de origen «ventas_online» (retiro o delivery) con sus líneas y opciones, lo manda a
// la comanda de cocina o barra y registra la venta con el Pago_Online como forma de pago «Cobro online (pasarela)» (o la que corresponda). Es la única que informa el cobro a Financiero.
// Es idempotente por el ID_Global del pedido online: repetir la entrega devuelve la venta original y nunca duplica comanda, venta ni descuento de stock. Si falla a mitad de camino se retoma
// donde quedó (el pedido, la comanda y la venta son pasos que se recuerdan).
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const falla = (m, status = 409, codigo = 'ENTREGA_INVALIDA') => Object.assign(new Error(m), { status, codigo });

// El artículo «Envío» con que se cobra el delivery propio: un servicio de Ventas sin stock.
const productoEnvio = async (conn) => {
  const [[p]] = await conn.query("SELECT id, nombre FROM productos WHERE sku = 'ENVIO-ONLINE'");
  if (p) return p;
  const [r] = await conn.query("INSERT INTO productos (nombre, precio, tipo, sku) VALUES ('Envío (delivery)', 0, 'servicio', 'ENVIO-ONLINE')");
  return { id: r.insertId, nombre: 'Envío (delivery)' };
};

// Fase 1: la mesa virtual, el pedido y sus líneas (con la parte del descuento del cupón que le toca a cada una).
const abrirPedido = async (d) => {
  const mesa = await Mesa.createVirtual();
  const pedido = await Pedido.create(mesa.id, { modalidad: d.modalidad, origen: 'ventas_online', mozo_id: null, referencia: String(d.referencia ?? '').slice(0, 255) || null });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const productos = [];
    for (const l of d.lineas) {
      const mods = [];
      for (const o of l.opciones ?? []) {
        const [[g]] = await conn.query('SELECT grupo_id FROM opciones_modificador WHERE id = ?', [o.id]);
        if (g) mods.push({ opcion_id: o.id, grupo_id: g.grupo_id, nombre: o.nombre, ajuste_precio_aplicado: o.ajuste });
      }
      productos.push({ producto_id: l.producto_id, cantidad: l.cantidad, nombre: l.titulo, precio_unitario: l.precio_unitario, observaciones: l.observaciones ?? null, modificadores: mods });
    }
    if (d.envio > 0) { const e = await productoEnvio(conn); productos.push({ producto_id: e.id, cantidad: 1, nombre: e.nombre, precio_unitario: d.envio, observaciones: null }); }
    await Pedido.addProductos(pedido.id, productos, conn);
    if (d.descuento > 0) {
      const [items] = await conn.query('SELECT id, cantidad, precio_unitario FROM pedido_productos WHERE pedido_id = ? ORDER BY id', [pedido.id]);
      const lineasMercaderia = items.slice(0, d.lineas.length);
      const bruto = lineasMercaderia.reduce((a, i) => a + Number(i.cantidad) * Number(i.precio_unitario), 0);
      let resto = r2(d.descuento);
      for (const [n, i] of lineasMercaderia.entries()) {
        const parte = n === lineasMercaderia.length - 1 ? resto : r2(d.descuento * (Number(i.cantidad) * Number(i.precio_unitario)) / bruto);
        resto = r2(resto - parte);
        await conn.query('UPDATE pedido_productos SET importe_descuento = ? WHERE id = ?', [parte, i.id]);
      }
    }
    await conn.query('INSERT INTO ventas_pedidos_online (pedido_global, pedido_id, mesa_id, transaccion, created_ms) VALUES (?, ?, ?, ?, ?)', [d.idGlobal, pedido.id, mesa.id, d.transaccion ?? null, Date.now()]);
    await conn.commit();
    return { pedido_id: pedido.id, mesa_id: mesa.id };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const recibir = async (d) => {
  if (!d.idGlobal || !Array.isArray(d.lineas) || !d.lineas.length) throw falla('Falta el pedido o sus líneas.', 400);
  const [[previo]] = await pool.query('SELECT * FROM ventas_pedidos_online WHERE pedido_global = ?', [d.idGlobal]);
  if (previo?.venta_id_global) return { venta_id_global: previo.venta_id_global, pedido_id: previo.pedido_id, ya_procesado: true };
  const pagos = (d.pagos ?? []).map((p) => ({ forma: p.forma, importe: r2(p.importe), referencia: p.referencia ?? null, recibido: null, vuelto: 0, ...(p.forma === 'vale' && { instrumento: p.instrumento ?? null, puntos: !!p.puntos, retencion_id: p.retencion_id ?? null }) }));
  const suma = r2(pagos.reduce((a, p) => a + p.importe, 0));
  if (Math.abs(suma - r2(d.total)) > 0.004) throw falla(`Los pagos (${suma}) no suman el total del pedido (${r2(d.total)}).`, 400, 'PAGOS_NO_CIERRAN');
  const m = previo ?? { ...(await abrirPedido(d)), comanda_enviada: 0 };
  if (!m.comanda_enviada) {
    try { await Comandas.enviar(m.mesa_id, { userId: null }); } catch (err) { if (!/No hay ítems nuevos/.test(err.message)) throw err; }
    await pool.query('UPDATE ventas_pedidos_online SET comanda_enviada = 1 WHERE pedido_global = ?', [d.idGlobal]);
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const pedidos = await Pedido.getActivosConDatosByMesa(m.mesa_id, conn);
    const idsPedido = pedidos.map((p) => p.id);
    const items = await Pedido.getItemsByPedidoIds(idsPedido, conn);
    const total = r2(items.reduce((a, i) => a + Number(i.subtotal), 0));
    if (Math.abs(total - r2(d.total)) > 0.004) throw falla(`El pedido suma ${total} y el total online es ${r2(d.total)}.`, 409, 'TOTAL_DISTINTO');
    const sesion = pedidos[0].sesion_apertura;
    await Pedido.cerrarPedidosMesa(m.mesa_id, conn);
    await Pedido.setMetodoPago(m.mesa_id, sesion, pagos.length > 1 ? 'mixto' : pagos[0].forma, conn);
    const venta = await Venta.registrar(conn, { mesa_id: m.mesa_id, sesion_apertura: sesion, items, total, pagos, idSolicitud: `online:${d.idGlobal}`, userId: null, modalidad: d.modalidad,
      idCompromiso: d.idCompromiso ?? null, credito: d.credito ?? null, fid: d.clienteId ? { clienteId: d.clienteId, premio: null } : null, clienteId: d.clienteId ?? null, terminalId: null });
    await Mesa.updateEstado(m.mesa_id, 'libre', conn);
    await conn.query('UPDATE ventas_pedidos_online SET venta_id_global = ? WHERE pedido_global = ?', [venta.id_global, d.idGlobal]);
    await conn.commit();
    Mensajeria.despertar();
    return { venta_id_global: venta.id_global, pedido_id: m.pedido_id, ya_procesado: false };
  } catch (err) { await conn.rollback(); logger.error(`[ventas] pedido online ${d.idGlobal}: ${err.message}`); throw err; } finally { conn.release(); }
};

// Avance de las comandas de un pedido online en cocina o barra (Ventas Online RN36): el menos avanzado de todos los sectores.
const AVANCES = ['pendiente', 'en_preparacion', 'listo', 'entregado'];
const avanceDe = async (pedidoGlobal) => {
  const [[m]] = await pool.query('SELECT mesa_id FROM ventas_pedidos_online WHERE pedido_global = ?', [pedidoGlobal]);
  if (!m) return null;
  const [cs] = await pool.query("SELECT avance FROM comandas WHERE mesa_id = ? AND estado = 'emitida'", [m.mesa_id]);
  if (!cs.length) return null;
  return AVANCES[Math.min(...cs.map((c) => AVANCES.indexOf(c.avance)))];
};

module.exports = { recibir, avanceDe, productoEnvio };
