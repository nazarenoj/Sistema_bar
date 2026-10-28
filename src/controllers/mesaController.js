const pool = require('../config/db');
const Mesa = require('../models/mesaModel');
const Pedido = require('../models/pedidoModel');
const Producto = require('../models/productoModel');
const puertos = require('../modulos/puertos');
const Factura = require('../models/facturaModel');
const Venta = require('../services/ventaService');
const Mensajeria = require('../mensajeria/servicio');
const afipService = require('../services/afipService');
const afipConfig = require('../config/afipConfig');
const logger = require('../utils/logger');

const getAll = async (req, res) => {
  const salon_id = parseInt(req.query.salon_id, 10);
  if (isNaN(salon_id))
    return res.status(400).json({ error: 'El parámetro "salon_id" es obligatorio y debe ser un entero.' });

  try {
    res.json(await Mesa.getAll(salon_id));
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const create = async (req, res) => {
  const { numero_mesa, salon_id } = req.body;

  if (numero_mesa === undefined || numero_mesa === null)
    return res.status(400).json({ error: 'El campo "numero_mesa" es obligatorio.' });
  if (!Number.isInteger(numero_mesa) || numero_mesa <= 0)
    return res.status(400).json({ error: '"numero_mesa" debe ser un entero positivo.' });
  if (!Number.isInteger(salon_id))
    return res.status(400).json({ error: 'El campo "salon_id" es obligatorio y debe ser un entero.' });

  try {
    const mesa = await Mesa.create(numero_mesa, salon_id);
    res.status(201).json(mesa);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(400).json({ error: `Ya existe la mesa número ${numero_mesa}.` });
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const cerrarCuenta = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id))
    return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });

  const { metodo_pago, tipo_comprobante, doc_tipo, doc_nro, condicion_iva_receptor_id, receptor_nombre, domicilio_receptor } = req.body;

  // Pago simple (`metodo_pago`: el total en una sola forma) o mixto (`pagos`: [{ forma, importe, referencia?, recibido? }]).
  if (!Array.isArray(req.body.pagos) && typeof metodo_pago !== 'string')
    return res.status(400).json({ error: 'Indicá "metodo_pago" o la lista "pagos".' });

  // Facturar es opcional: si "tipo_comprobante" viene null/undefined, la cuenta se cierra sin
  // emitir comprobante fiscal (sin fila en `facturas` ni llamado a ARCA), para no bloquear el
  // cierre si el dueño/empleado decide no facturar esa cuenta o si ARCA está fuera de servicio.
  const facturar = tipo_comprobante !== null && tipo_comprobante !== undefined;

  if (facturar) {
    const tiposValidos = afipService.TIPOS_VALIDOS_POR_CONDICION[afipConfig.condicionIvaEmisor];
    if (!Number.isInteger(tipo_comprobante) || !tiposValidos.includes(tipo_comprobante))
      return res.status(400).json({
        error: `"tipo_comprobante" inválido para la condición IVA configurada (${afipConfig.condicionIvaEmisor}). ` +
          `Válidos: ${tiposValidos.map((t) => afipService.TIPOS_COMPROBANTE[t]).join(', ')}.`,
      });
    if (!Number.isInteger(doc_tipo))
      return res.status(400).json({ error: '"doc_tipo" es obligatorio (80=CUIT, 96=DNI, 99=Consumidor Final).' });
    if (doc_nro === undefined || doc_nro === null || doc_nro === '')
      return res.status(400).json({ error: '"doc_nro" es obligatorio (usar "0" para consumidor final).' });
    // ARCA rechaza (error 10015) cualquier DocTipo distinto de 99 con DocNro <= 0.
    if (doc_tipo !== 99 && (!/^\d+$/.test(String(doc_nro)) || Number(doc_nro) <= 0))
      return res.status(400).json({ error: 'Para "doc_tipo" distinto de 99 (Consumidor Final), "doc_nro" debe ser un número mayor a 0.' });
    if (!Number.isInteger(condicion_iva_receptor_id))
      return res.status(400).json({ error: '"condicion_iva_receptor_id" es obligatorio y debe ser un entero.' });
  }

  const conn = await pool.getConnection();
  let mesa, pedidoIds, totalAcumulado, factura, venta, metodoPago;
  try {
    await conn.beginTransaction();

    // Bloquea la fila de la mesa para evitar cierres concurrentes
    const [mesaRows] = await conn.query('SELECT * FROM mesas WHERE id = ? FOR UPDATE', [id]);
    if (!mesaRows.length) {
      await conn.rollback();
      return res.status(404).json({ error: `Mesa con id ${id} no encontrada.` });
    }

    mesa = mesaRows[0];
    if (mesa.ticket_pendiente) {
      await conn.rollback();
      return res.status(400).json({ error: 'Esta mesa tiene un ticket pendiente de imprimir o descargar. Resolvé eso antes de cerrar la cuenta.' });
    }
    if (mesa.estado === 'libre') {
      await conn.rollback();
      return res.status(400).json({ error: 'La mesa ya está libre. No hay cuenta activa que cerrar.' });
    }

    const pedidosActivos = await Pedido.getActivosConDatosByMesa(id, conn);
    if (!pedidosActivos.length) {
      await conn.rollback();
      return res.status(400).json({ error: 'No hay pedidos activos en esta mesa.' });
    }

    pedidoIds = pedidosActivos.map(p => p.id);
    totalAcumulado = await Pedido.getTotalAcumulado(pedidoIds, conn);
    // Las reglas del receptor (tipo A, tope de consumidor final) se miran antes de cerrar la cuenta, no después.
    if (facturar) await afipService.validarReceptor({ tipoComprobante: tipo_comprobante, docTipo: doc_tipo, condicionIvaReceptorId: condicion_iva_receptor_id, importeTotal: totalAcumulado });

    const items = await Pedido.getItemsByPedidoIds(pedidoIds, conn);
    await Producto.decrementarStock(items, conn);
    await (await puertos.obtener('stock')).descontarPorVenta(items, conn);

    await Pedido.cerrarPedidosMesa(id, conn);
    const pagos = await Venta.validarPagos(conn, Array.isArray(req.body.pagos) ? req.body.pagos : [{ forma: metodo_pago, importe: totalAcumulado }], totalAcumulado);
    metodoPago = Venta.metodoResumen(pagos);
    await Pedido.setMetodoPago(id, pedidosActivos[0].sesion_apertura, metodoPago, conn);
    // La venta y los mensajes de sus efectos se graban en esta misma transacción (Ventas RN58).
    venta = await Venta.registrar(conn, {
      mesa_id: id, sesion_apertura: pedidosActivos[0].sesion_apertura, items, total: totalAcumulado, pagos,
      idSolicitud: req.get('X-ID-Solicitud'), userId: req.usuario?.sub ?? null,
    });
    // La mesa sigue "ocupada": recién se libera cuando se confirma que se imprimió/descargó el
    // comprobante (ver confirmarTicket), para no dejar la mesa disponible sin haberlo entregado.
    await Mesa.setTicketPendiente(id, true, conn);

    // Se crea la fila de facturas ya dentro de la transacción (estado 'pendiente'), aunque ARCA
    // todavía no respondió: así no se pierde el método de pago ni la trazabilidad si el pedido a
    // ARCA falla más abajo. Si se eligió no facturar, directamente no se crea esta fila.
    if (facturar) {
      factura = await Factura.create({
        mesa_id: id,
        sesion_apertura: pedidosActivos[0].sesion_apertura,
        metodo_pago: metodoPago,
        tipo_comprobante,
        punto_venta: afipConfig.puntoVenta,
        doc_tipo,
        doc_nro: String(doc_nro),
        condicion_iva_receptor_id,
        receptor_nombre: receptor_nombre || null,
        domicilio_receptor: domicilio_receptor || null,
        importe_total: totalAcumulado,
        entorno: afipConfig.entorno,
        creado_por: req.usuario?.sub ?? null,
      }, conn);
    }

    await conn.commit();
    Mensajeria.despertar();
  } catch (err) {
    await conn.rollback();
    if (err instanceof Venta.PagoInvalido) return res.status(400).json({ error: err.message, codigo: 'PAGO_INVALIDO' });
    if (err.status === 400) return res.status(400).json({ error: err.message, codigo: 'RECEPTOR_INVALIDO' });
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    return res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  } finally {
    conn.release();
  }

  // Fuera de la transacción y en su propio try/catch: si ARCA está caído, la cuenta ya quedó
  // cerrada igual (no hay rollback posible ni deseable acá). La factura queda 'error' y se puede
  // reintentar después desde el historial, sin bloquear la operación del local.
  if (facturar) {
    try {
      const resultado = await afipService.emitirFactura({
        tipoComprobante: tipo_comprobante,
        docTipo: doc_tipo,
        docNro: String(doc_nro),
        condicionIvaReceptorId: condicion_iva_receptor_id,
        importeTotal: totalAcumulado,
        idIntento: req.get('X-ID-Solicitud'),
      });
      await Factura.updateResultado(factura.id, resultado);
    } catch (err) {
      logger.error(`${req.method} ${req.originalUrl} - ARCA rechazó la factura ${factura.id} (mesa ${id}): ${err.message}`, { stack: err.stack });
      await Factura.updateResultado(factura.id, {
        estado: 'error',
        numero: null,
        cae: null,
        caeVencimiento: null,
        importeNeto: 0,
        importeIva: 0,
        importeTotal: totalAcumulado,
        observaciones: err.message,
      });
    }
  }

  res.json({
    message: `Cuenta cerrada para la mesa ${mesa.numero_mesa}. Imprimí o descargá el comprobante para liberarla.`,
    mesa_id: id,
    pedidos_cerrados: pedidoIds.length,
    total_acumulado: totalAcumulado,
    ticket_pendiente: true,
    venta_id_global: venta.id_global,
    factura: factura ? await Factura.getById(factura.id) : null,
  });
};

// Se llama después de imprimir o descargar el ticket de una cuenta ya cerrada: recién en este
// momento la mesa pasa a "libre" y queda disponible para nuevos pedidos.
const confirmarTicket = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id))
    return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });

  try {
    const mesa = await Mesa.getById(id);
    if (!mesa)
      return res.status(404).json({ error: `Mesa con id ${id} no encontrada.` });
    if (!mesa.ticket_pendiente)
      return res.status(400).json({ error: 'Esta mesa no tiene ningún ticket pendiente.' });

    await Mesa.setTicketPendiente(id, false);
    await Mesa.updateEstado(id, 'libre');

    res.json({ message: `Mesa ${mesa.numero_mesa} liberada.`, mesa_id: id });
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const remove = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id))
    return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });

  try {
    const mesa = await Mesa.getById(id);
    if (!mesa)
      return res.status(404).json({ error: `Mesa con id ${id} no encontrada.` });

    if (mesa.estado !== 'libre')
      return res.status(400).json({ error: `No se puede eliminar la mesa ${mesa.numero_mesa}: tiene una cuenta abierta o un ticket pendiente de imprimir/descargar.` });
    if (await Mesa.hasGrupo(id))
      return res.status(400).json({ error: `No se puede eliminar la mesa ${mesa.numero_mesa}: está combinada con otra. Separalas primero.` });

    // No borra el registro: lo desactiva para no perder los pedidos históricos que la referencian.
    await Mesa.remove(id);
    res.json({ message: `Mesa ${mesa.numero_mesa} eliminada correctamente.` });
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

// Devuelve TODOS los pedidos activos de la mesa (una mesa puede tener varios pedidos abiertos a la vez),
// cada uno con sus items, más la hora en que se abrió la cuenta (el primer pedido activo).
const getPedidosActivos = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id))
    return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });

  try {
    const mesa = await Mesa.getById(id);
    if (!mesa)
      return res.status(404).json({ error: `Mesa con id ${id} no encontrada.` });

    const pedidoRows = await Pedido.getActivosConDatosByMesa(id);

    if (!pedidoRows.length)
      return res.json({ pedidos: [], hora_apertura: null, total_acumulado: 0 });

    const pedidoIds = pedidoRows.map(p => p.id);
    const items = await Pedido.getItemsByPedidoIds(pedidoIds);

    const pedidos = pedidoRows.map(p => {
      const itemsPedido = items.filter(i => i.pedido_id === p.id);
      const subtotal = itemsPedido.reduce((sum, item) => sum + Number(item.subtotal), 0);
      const entregado = itemsPedido.length > 0 && itemsPedido.every(item => item.entregado);
      return { ...p, items: itemsPedido, subtotal: Math.round(subtotal * 100) / 100, entregado };
    });

    const total_acumulado = pedidos.reduce((sum, p) => sum + p.subtotal, 0);

    res.json({
      pedidos,
      hora_apertura: pedidoRows[0].fecha_creacion,
      total_acumulado: Math.round(total_acumulado * 100) / 100,
    });
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const updatePosicion = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id))
    return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });

  const { pos_x, pos_y } = req.body;
  if (!Number.isInteger(pos_x) || !Number.isInteger(pos_y))
    return res.status(400).json({ error: '"pos_x" y "pos_y" deben ser enteros.' });

  try {
    const mesa = await Mesa.getById(id);
    if (!mesa)
      return res.status(404).json({ error: `Mesa con id ${id} no encontrada.` });

    await Mesa.updatePosicion(id, pos_x, pos_y);
    res.json({ ...mesa, pos_x, pos_y });
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const updateColor = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id))
    return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });

  const { color_libre, color_ocupado } = req.body;

  try {
    const mesa = await Mesa.getById(id);
    if (!mesa)
      return res.status(404).json({ error: `Mesa con id ${id} no encontrada.` });

    await Mesa.updateColor(id, color_libre ?? null, color_ocupado ?? null);
    res.json({ ...mesa, color_libre: color_libre ?? null, color_ocupado: color_ocupado ?? null });
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const updateTamano = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id))
    return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });

  const { tamano } = req.body;
  if (!Number.isInteger(tamano) || tamano < 60 || tamano > 240)
    return res.status(400).json({ error: '"tamano" debe ser un entero entre 60 y 240.' });

  try {
    const mesa = await Mesa.getById(id);
    if (!mesa)
      return res.status(404).json({ error: `Mesa con id ${id} no encontrada.` });
    if (mesa.grupo_id !== null)
      return res.status(400).json({ error: `No se puede redimensionar la mesa ${mesa.numero_mesa}: está combinada con otra. Separalas primero.` });

    await Mesa.updateTamano(id, tamano);
    res.json({ ...mesa, tamano });
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const CODIGOS_COMBINAR = {
  MESA_NO_ENCONTRADA: 404,
  MESA_NO_LIBRE: 400,
  MESA_YA_COMBINADA: 400,
  SALON_DISTINTO: 400,
  GRUPO_NO_ENCONTRADO: 404,
  GRUPO_OCUPADO: 400,
};

const combinar = async (req, res) => {
  const { mesa_ids, numero_mesa, salon_id } = req.body;

  if (!Array.isArray(mesa_ids) || mesa_ids.length < 2 || !mesa_ids.every((id) => Number.isInteger(id)))
    return res.status(400).json({ error: '"mesa_ids" debe ser un arreglo de al menos 2 ids de mesa.' });
  if (typeof numero_mesa !== 'string' || numero_mesa.trim() === '')
    return res.status(400).json({ error: 'El campo "numero_mesa" (número combinado a mostrar) es obligatorio.' });
  if (!Number.isInteger(salon_id))
    return res.status(400).json({ error: 'El campo "salon_id" es obligatorio y debe ser un entero.' });

  try {
    const grupo = await Mesa.combinar(mesa_ids, numero_mesa.trim(), salon_id);
    res.status(201).json(grupo);
  } catch (err) {
    const status = CODIGOS_COMBINAR[err.code];
    if (status) return res.status(status).json({ error: err.message });
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const separar = async (req, res) => {
  const grupoId = parseInt(req.params.grupoId, 10);
  if (isNaN(grupoId))
    return res.status(400).json({ error: 'El parámetro "grupoId" debe ser un entero válido.' });

  try {
    await Mesa.separar(grupoId);
    res.json({ message: 'Mesas separadas correctamente.' });
  } catch (err) {
    const status = CODIGOS_COMBINAR[err.code];
    if (status) return res.status(status).json({ error: err.message });
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

module.exports = { getAll, create, cerrarCuenta, confirmarTicket, remove, getPedidosActivos, updatePosicion, updateColor, updateTamano, combinar, separar };
