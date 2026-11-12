const pool = require('../config/db');
const Mesa = require('../models/mesaModel');
const Pedido = require('../models/pedidoModel');
const Venta = require('./ventaService');
const Comandas = require('./comandaService');
const Mensajeria = require('../mensajeria/servicio');
const logger = require('../utils/logger');
const Factura = require('../models/facturaModel');
const afipService = require('./afipService');
const afipConfig = require('../config/afipConfig');
const NotaFiscal = require('./notaFiscalService');

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
    // Con el descuento ya calculado por línea (promociones y cupón del carrito) se deja tal cual y se registran las promociones aplicadas; si no, se reparte el total entre las líneas.
    const porLinea = d.lineas.length && d.lineas.every((l) => l.descuento_linea !== undefined) && Math.abs(r2(d.lineas.reduce((x, l) => x + l.descuento_linea, 0)) - r2(d.descuento ?? 0)) < 0.01;
    if (porLinea) {
      const [items] = await conn.query('SELECT id FROM pedido_productos WHERE pedido_id = ? ORDER BY id', [pedido.id]);
      for (const [n, l] of d.lineas.entries()) {
        if (l.descuento_linea > 0) await conn.query('UPDATE pedido_productos SET importe_descuento = ? WHERE id = ?', [r2(l.descuento_linea), items[n].id]);
        for (const x of l.promociones ?? []) await conn.query('INSERT INTO promociones_aplicadas (clave, promocion_id, nombre, pedido_id, item_id, importe) VALUES (?, ?, ?, ?, ?, ?)', [d.idGlobal, x.promocion_id, x.nombre, pedido.id, items[n].id, x.importe]);
      }
    } else if (d.descuento > 0) {
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
      idCompromiso: d.idCompromiso ?? null, credito: d.credito ?? null, fid: d.clienteId ? { clienteId: d.clienteId, premio: null } : null, clienteId: d.clienteId ?? null, terminalId: d.terminalId ?? null });
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

// ---- Comprobantes, devoluciones y totales de un pedido online (Ventas RF17, RN67): operaciones elementales que Ventas Online le pide y que Ventas ejecuta ----

const movimiento = (idGlobal, tipo, importe, referencia, detalle = null) => pool.query('INSERT IGNORE INTO ventas_online_movs (pedido_global, tipo, importe, referencia, detalle, ts_ms) VALUES (?, ?, ?, ?, ?, ?)', [idGlobal, tipo, r2(importe), referencia, detalle, Date.now()]);
const ventaDe = async (idGlobal) => {
  const [[m]] = await pool.query('SELECT v.id, v.mesa_id, v.sesion_apertura, v.total FROM ventas_pedidos_online o JOIN ventas v ON v.id_global = o.venta_id_global WHERE o.pedido_global = ?', [idGlobal]);
  if (!m) throw falla('El pedido todavía no pasó a Ventas.', 409, 'SIN_VENTA');
  return m;
};

// Emite la factura del pedido por el importe pedido (el total, o el real después del pesaje). Repetir el intento devuelve el mismo comprobante.
const facturar = async ({ idGlobal, receptor, importe, idIntento }) => {
  const v = await ventaDe(idGlobal);
  let f = await Factura.getBySesion(v.mesa_id, v.sesion_apertura);
  if (f?.estado === 'aprobada') return { estado: 'aprobada', tipo_comprobante: f.tipo_comprobante, punto_venta: f.punto_venta, numero: Number(f.numero), cae: f.cae, importe: Number(f.importe_total), ya_procesado: true };
  const tipo = NotaFiscal.letraFactura(receptor);
  f ||= await Factura.create({ mesa_id: v.mesa_id, sesion_apertura: v.sesion_apertura, metodo_pago: 'cobro_online', tipo_comprobante: tipo, punto_venta: afipConfig.puntoVenta, doc_tipo: receptor.doc_tipo, doc_nro: String(receptor.doc_nro),
    condicion_iva_receptor_id: receptor.condicion_iva_receptor_id, receptor_nombre: receptor.nombre ?? null, domicilio_receptor: receptor.domicilio ?? null, importe_total: importe, entorno: afipConfig.entorno, creado_por: null });
  try {
    const r = await afipService.emitirFactura({ tipoComprobante: f.tipo_comprobante, docTipo: f.doc_tipo, docNro: f.doc_nro, condicionIvaReceptorId: f.condicion_iva_receptor_id, importeTotal: Number(importe), idIntento, facturaId: f.id });
    await Factura.updateResultado(f.id, r);
    if (r.estado !== 'aprobada') throw falla(`ARCA rechazó el comprobante: ${r.observaciones ?? 'sin detalle'}.`, 409, 'COMPROBANTE_RECHAZADO');
    await movimiento(idGlobal, 'factura', importe, String(r.numero), `${r.cae}`);
    return { estado: 'aprobada', tipo_comprobante: f.tipo_comprobante, punto_venta: afipConfig.puntoVenta, numero: r.numero, cae: r.cae, importe: Number(importe), ya_procesado: false };
  } catch (err) {
    if (!err.codigo) await Factura.updateResultado(f.id, { estado: 'error', importeTotal: importe, observaciones: err.message });
    throw err;
  }
};

// Nota de crédito que corrige la factura del pedido (diferencia de peso, cancelación, arrepentimiento): siempre antes del reintegro (RN52).
const notaCredito = async ({ idGlobal, receptor, importe, idIntento }) => {
  const v = await ventaDe(idGlobal);
  const f = await Factura.getBySesion(v.mesa_id, v.sesion_apertura);
  if (f?.estado !== 'aprobada') throw falla('El pedido no tiene una factura aprobada para corregir.', 409, 'SIN_FACTURA');
  const [[previa]] = await pool.query("SELECT referencia FROM ventas_online_movs WHERE pedido_global = ? AND tipo = 'nc' AND referencia = ?", [idGlobal, idIntento]);
  if (previa) return { estado: 'aprobada', ya_procesado: true };
  const r = await NotaFiscal.emitir({ tipo: 'nc', receptor, importe, asociado: { Tipo: f.tipo_comprobante, PtoVta: f.punto_venta, Nro: Number(f.numero) }, idIntento });
  if (r.estado !== 'aprobada') throw falla('ARCA rechazó la nota de crédito.', 409, 'COMPROBANTE_RECHAZADO');
  await movimiento(idGlobal, 'nc', importe, idIntento, `${r.tipo_comprobante}-${r.numero}`);
  return { estado: 'aprobada', tipo_comprobante: r.tipo_comprobante, punto_venta: r.punto_venta, numero: r.numero, cae: r.cae, importe: Number(importe), ya_procesado: false };
};

// Ventas Online avisa lo que reintegró o cobró de más en la pasarela: Ventas lo registra como devolución o cobro adicional (la clave evita duplicarlo).
const registrarDevolucion = async ({ idGlobal, importe, referencia, medio = 'pasarela' }) => { await ventaDe(idGlobal); await movimiento(idGlobal, 'devolucion', importe, referencia, medio); return { ok: true }; };
const registrarCobroAdicional = async ({ idGlobal, importe, referencia }) => { await ventaDe(idGlobal); await movimiento(idGlobal, 'cobro_adicional', importe, referencia); return { ok: true }; };

// Los totales de un pedido (llamada n.º 19): lo cobrado, lo reintegrado y lo facturado neto, tal como Ventas los registró (pagos, devoluciones y comprobantes).
const totales = async (idGlobal) => {
  const [[v]] = await pool.query('SELECT v.id, v.mesa_id, v.sesion_apertura FROM ventas_pedidos_online o JOIN ventas v ON v.id_global = o.venta_id_global WHERE o.pedido_global = ?', [idGlobal]);
  const suma = async (tipo) => Number((await pool.query('SELECT COALESCE(SUM(importe), 0) AS t FROM ventas_online_movs WHERE pedido_global = ? AND tipo = ?', [idGlobal, tipo]))[0][0].t);
  if (!v) return { cobrado: 0, reintegrado: 0, facturado_neto: 0 };
  const cobradoVenta = Number((await pool.query('SELECT COALESCE(SUM(importe), 0) AS t FROM pago_venta WHERE venta_id = ?', [v.id]))[0][0].t);
  const devuelto = Number((await pool.query('SELECT COALESCE(SUM(total), 0) AS t FROM devoluciones WHERE venta_id = ?', [v.id]))[0][0].t);
  const fac = async (nc) => Number((await pool.query(`SELECT COALESCE(SUM(importe_total), 0) AS t FROM facturas WHERE mesa_id = ? AND sesion_apertura = ? AND estado = 'aprobada' AND devolucion_id IS ${nc ? 'NOT ' : ''}NULL`, [v.mesa_id, v.sesion_apertura]))[0][0].t);
  return { cobrado: r2(cobradoVenta + await suma('cobro_adicional')), reintegrado: r2(devuelto + await suma('devolucion')), facturado_neto: r2(await fac(false) - await fac(true) - await suma('nc')) };
};

// Devolución de un pedido online (total o parcial, antes o después del despacho): la registra Ventas con su nota de crédito, el reingreso a Stock y el contramovimiento en Financiero (Ventas RF15).
// La nota de crédito siempre sale antes de que Ventas Online ejecute el reintegro en la pasarela (RN52); si no se pudo emitir queda para reintentar.
const devolverPedido = async ({ idGlobal, lineas, todo, motivo, reingreso = 'reingreso', idSolicitud, userId = null }) => {
  const [[m]] = await pool.query('SELECT venta_id_global FROM ventas_pedidos_online WHERE pedido_global = ?', [idGlobal]);
  if (!m?.venta_id_global) throw falla('El pedido todavía no pasó a Ventas.', 409, 'SIN_VENTA');
  const Devolucion = require('./devolucionService');
  let r;
  try { r = await Devolucion.devolver(m.venta_id_global, { items: lineas?.map((l) => ({ linea: l.linea - 1, cantidad: l.cantidad })), todo, motivo, reingreso }, { idSolicitud, userId, autorizadoPor: null, terminalId: null, autorizar: null }); } catch (err) {
    if (err instanceof Devolucion.DevolucionInvalida) throw falla(err.message, err.status ?? 400, 'DEVOLUCION_INVALIDA');
    throw err;
  }
  return { devolucion: r.devolucion, reintegros: r.reintegros, nota_credito: r.nota_credito ? { id: r.nota_credito.id, estado: r.nota_credito.estado, numero: r.nota_credito.numero, cae: r.nota_credito.cae } : null };
};
// Reintenta la emisión de una nota de crédito que ARCA no autorizó (EX35); devuelve su estado.
const reintentarNotaCredito = async (facturaId) => {
  const nc = await Factura.getById(facturaId);
  if (!nc) throw falla('Comprobante no encontrado.', 404, 'SIN_COMPROBANTE');
  if (nc.estado === 'aprobada') return { estado: 'aprobada', ya_procesado: true };
  const original = await Factura.getById(nc.comprobante_origen_id);
  try {
    const r = await afipService.emitirFactura({ tipoComprobante: nc.tipo_comprobante, docTipo: nc.doc_tipo, docNro: nc.doc_nro, condicionIvaReceptorId: nc.condicion_iva_receptor_id, importeTotal: Number(nc.importe_total), idIntento: `nc-reintento:${nc.id}`, facturaId: nc.id,
      comprobanteAsociado: { Tipo: original.tipo_comprobante, PtoVta: original.punto_venta, Nro: original.numero } });
    await Factura.updateResultado(nc.id, r);
    return { estado: r.estado, numero: r.numero };
  } catch (err) { await Factura.updateResultado(nc.id, { estado: 'error', importeTotal: nc.importe_total, observaciones: err.message }); return { estado: 'error', error: err.message }; }
};

module.exports = { recibir, avanceDe, productoEnvio, facturar, notaCredito, registrarDevolucion, registrarCobroAdicional, totales, devolverPedido, reintentarNotaCredito };
