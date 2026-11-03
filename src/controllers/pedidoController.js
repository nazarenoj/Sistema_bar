const pool = require('../config/db');
const Mesa = require('../models/mesaModel');
const Pedido = require('../models/pedidoModel');
const Venta = require('../services/ventaService');
const { validarAutorizacion, permisosDe } = require('../middleware/requierePermiso');
const Cocina = require('../services/cocinaService');
const Franjas = require('../services/franjaService');
const SerieVenta = require('../services/serieVentaService');
const Mensajeria = require('../mensajeria/servicio');
const Producto = require('../models/productoModel');
const puertos = require('../modulos/puertos');
const logger = require('../utils/logger');
const Funciones = require('../funciones/servicio');
const Modificadores = require('../services/modificadorService');
const AlergenosVenta = require('../services/alergenoVentaService');
const Listas = require('../services/listaPrecioService');
const Promociones = require('../services/promocionService');
const Modulos = require('../modulos/registro');
const { enviarReporte, desglose, FORMATOS_VALIDOS, FORMATO_POR_DEFECTO } = require('../servicios/reporteService');
const { esFechaISO } = require('../utils/validaciones');
const {
  TIPO_COMPROBANTE_LABEL, METODO_PAGO_LABEL, ESTADO_FACTURA_LABEL, etiqueta,
} = require('../utils/etiquetas');

const MODALIDADES = ['salon', 'mostrador', 'para_llevar', 'delivery', 'retiro'];
const ORIGENES = ['local']; // ventas_online y plataforma llegan con el módulo Ventas Online

// Abre un pedido (Ventas RF05). De salón: en una mesa (y, si se indica, una silla; una silla tiene un solo pedido abierto, RN10).
// Mostrador/barra, para llevar, delivery y retiro: sin mesa. Siempre con mozo o vendedor (por defecto, quien lo abre).
const create = async (req, res) => {
  const { mesa_id, modalidad = 'salon', origen = 'local', silla_id, referencia } = req.body;
  let { mozo_id } = req.body;

  if (!MODALIDADES.includes(modalidad))
    return res.status(400).json({ error: `"modalidad" debe ser una de: ${MODALIDADES.join(', ')}.` });
  if (!ORIGENES.includes(origen))
    return res.status(400).json({ error: `"origen" debe ser: ${ORIGENES.join(', ')} (los demás orígenes necesitan Ventas Online).` });
  if (referencia !== undefined && (typeof referencia !== 'string' || referencia.length > 255))
    return res.status(400).json({ error: '"referencia" debe ser un texto de hasta 255 caracteres.' });

  try {
    if (mozo_id === undefined || mozo_id === null) mozo_id = req.usuario?.sub ?? null;
    else {
      const [[mozo]] = await pool.query('SELECT id FROM users WHERE id = ? AND activo = 1', [mozo_id]);
      if (!mozo) return res.status(400).json({ error: 'El mozo o vendedor indicado no existe o está dado de baja.' });
    }

    let mesa;
    if (modalidad === 'salon') {
      if (!(await Funciones.estaActiva('VEN-SALON')))
        return res.status(409).json({ error: 'El Modo Salón está desactivado: abrí el pedido como mostrador, para llevar, delivery o retiro.', codigo: 'FUNCION_DESACTIVADA', funcion: 'VEN-SALON' });
      if (mesa_id === undefined || mesa_id === null)
        return res.status(400).json({ error: 'El campo "mesa_id" es obligatorio.' });
      if (!Number.isInteger(mesa_id) || mesa_id <= 0)
        return res.status(400).json({ error: '"mesa_id" debe ser un entero positivo.' });
      mesa = await Mesa.getById(mesa_id);
      if (!mesa || !mesa.activa || mesa.es_virtual)
        return res.status(404).json({ error: `Mesa con id ${mesa_id} no encontrada.` });
      if (mesa.ticket_pendiente)
        return res.status(400).json({ error: 'Esta mesa tiene un ticket pendiente de imprimir o descargar. Resolvé eso antes de abrir un nuevo pedido.' });
      if (silla_id !== undefined && silla_id !== null) {
        const [[silla]] = await pool.query('SELECT id FROM mesa_sillas WHERE id = ? AND mesa_id = ?', [silla_id, mesa_id]);
        if (!silla) return res.status(400).json({ error: 'La silla indicada no pertenece a esa mesa.' });
        const [[abierto]] = await pool.query("SELECT id FROM pedidos WHERE silla_id = ? AND estado = 'activo' LIMIT 1", [silla_id]);
        if (abierto) return res.status(409).json({ error: 'Esa silla ya tiene un pedido abierto.', codigo: 'SILLA_OCUPADA', pedido_id: abierto.id });
      }
    } else {
      mesa = await Mesa.createVirtual();
    }

    const pedido = await Pedido.create(mesa.id, { modalidad, origen, mozo_id, silla_id: modalidad === 'salon' ? silla_id ?? null : null, referencia: referencia?.trim() || null });

    if (await Funciones.estaActiva('VEN-LISTAS')) pedido.lista_precio_id = await Listas.alAbrirPedido(pedido.id, req.usuario?.terminal_id);

    if (mesa.estado === 'libre')
      await Mesa.updateEstado(mesa.id, 'ocupado');

    res.status(201).json(pedido);
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

// Mueve un pedido de salón a otra mesa (RF06). Toma la cuenta de la mesa destino si ya está ocupada.
const moverMesa = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { mesa_id } = req.body;
  if (isNaN(id) || !Number.isInteger(mesa_id) || mesa_id <= 0)
    return res.status(400).json({ error: 'Indicá el pedido y la "mesa_id" de destino (enteros positivos).' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const pedido = await Pedido.getById(id, conn);
    if (!pedido) { await conn.rollback(); return res.status(404).json({ error: `Pedido con id ${id} no encontrado.` }); }
    if (pedido.estado !== 'activo' || pedido.modalidad !== 'salon') { await conn.rollback(); return res.status(400).json({ error: 'Solo se mueve un pedido de salón que siga abierto.' }); }
    if (pedido.mesa_id === mesa_id) { await conn.rollback(); return res.status(400).json({ error: 'El pedido ya está en esa mesa.' }); }
    const destino = await Mesa.getById(mesa_id, conn);
    if (!destino || !destino.activa || destino.es_virtual) { await conn.rollback(); return res.status(404).json({ error: `Mesa con id ${mesa_id} no encontrada.` }); }
    if (destino.ticket_pendiente) { await conn.rollback(); return res.status(400).json({ error: 'La mesa destino tiene un ticket pendiente.' }); }

    const [[sesion]] = await conn.query("SELECT sesion_apertura FROM pedidos WHERE mesa_id = ? AND estado = 'activo' ORDER BY id LIMIT 1", [mesa_id]);
    await conn.query('UPDATE pedidos SET mesa_id = ?, sesion_apertura = COALESCE(?, NOW()), silla_id = NULL WHERE id = ?', [mesa_id, sesion?.sesion_apertura ?? null, id]);
    await Mesa.updateEstado(mesa_id, 'ocupado', conn);
    const [[quedan]] = await conn.query("SELECT COUNT(*) n FROM pedidos WHERE mesa_id = ? AND estado = 'activo'", [pedido.mesa_id]);
    if (!quedan.n) await Mesa.updateEstado(pedido.mesa_id, 'libre', conn);
    await conn.commit();
    res.json(await Pedido.getById(id));
  } catch (err) {
    await conn.rollback();
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  } finally {
    conn.release();
  }
};

// Divide la cuenta por ítem (RF06): pasa ítems (o parte de su cantidad) a otro pedido de la misma mesa, o a uno nuevo.
// Cuerpo: items [{ item_id, cantidad }], destino_pedido_id (opcional).
const dividir = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { items, destino_pedido_id } = req.body;
  if (isNaN(id) || !Array.isArray(items) || !items.length || items.some((i) => !Number.isInteger(i.item_id) || !Number.isInteger(i.cantidad) || i.cantidad <= 0))
    return res.status(400).json({ error: 'Indicá "items": [{ item_id, cantidad }] con enteros positivos.' });

  try {
    const origen = await Pedido.getById(id);
    if (!origen) return res.status(404).json({ error: `Pedido con id ${id} no encontrado.` });
    if (origen.estado !== 'activo') return res.status(400).json({ error: 'Solo se divide un pedido abierto.' });
    let destinoId = destino_pedido_id;
    if (destinoId === undefined || destinoId === null) {
      destinoId = (await Pedido.create(origen.mesa_id, { modalidad: origen.modalidad, origen: origen.origen, mozo_id: origen.mozo_id })).id;
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const destino = await Pedido.getById(destinoId, conn);
      if (!destino || destino.estado !== 'activo' || destino.id === origen.id || destino.mesa_id !== origen.mesa_id)
        throw Object.assign(new Error('El pedido destino debe ser otro pedido abierto de la misma mesa.'), { status: 400 });
      for (const { item_id, cantidad } of items) {
        const item = await Pedido.getItem(item_id, conn);
        if (!item || item.pedido_id !== id) throw Object.assign(new Error(`El ítem ${item_id} no está en este pedido.`), { status: 404 });
        if (cantidad > item.cantidad) throw Object.assign(new Error(`No se pueden pasar ${cantidad} de "${item.nombre}": hay ${item.cantidad}.`), { status: 400 });
        if (cantidad === item.cantidad) {
          await conn.query('UPDATE pedido_productos SET pedido_id = ? WHERE id = ?', [destinoId, item_id]);
        } else {
          await conn.query('UPDATE pedido_productos SET cantidad = cantidad - ? WHERE id = ?', [cantidad, item_id]);
          await conn.query(
            'INSERT INTO pedido_productos (pedido_id, producto_id, cantidad, nombre, descripcion, precio_unitario, entregado, observaciones) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [destinoId, item.producto_id, cantidad, item.nombre, item.descripcion, item.precio_unitario, item.entregado, item.observaciones ?? null]);
        }
      }
      await conn.commit();
    } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
    res.json({ origen_id: id, destino_id: destinoId, items: await Pedido.getItems(destinoId) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

// Lógica común de validación y cierre de transacción para ambos endpoints de productos
const _resolverYAgregarProductos = async (pedido_id, productosConDatos, res, advertencias = []) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const pedido = await Pedido.getById(pedido_id, conn);
    if (!pedido) {
      await conn.rollback();
      return res.status(404).json({ error: `Pedido con id ${pedido_id} no encontrado.` });
    }
    if (pedido.estado === 'finalizado') {
      await conn.rollback();
      return res.status(400).json({ error: 'No se pueden añadir productos a un pedido finalizado.' });
    }
    if (pedido.mesa_estado === 'libre') {
      await conn.rollback();
      return res.status(400).json({ error: 'No se pueden añadir productos: la mesa de este pedido ya está libre.' });
    }

    await Pedido.addProductos(pedido_id, productosConDatos, conn);
    await conn.commit();

    res.status(201).json({
      message: `${productosConDatos.length} producto(s) añadidos al pedido ${pedido_id}.`,
      pedido_id,
      productos: productosConDatos,
      ...(advertencias.length && { advertencias }),
    });
  } catch (err) {
    await conn.rollback();
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  } finally {
    conn.release();
  }
};

const addProductos = async (req, res) => {
  const pedido_id = parseInt(req.params.id, 10);
  if (isNaN(pedido_id))
    return res.status(400).json({ error: 'El parámetro "id" del pedido debe ser un entero válido.' });

  const { productos } = req.body;

  if (!Array.isArray(productos) || productos.length === 0)
    return res.status(400).json({ error: 'El campo "productos" debe ser un array no vacío.' });

  for (let i = 0; i < productos.length; i++) {
    const { producto_id, cantidad, observaciones, lote_indicado, opciones, serie } = productos[i];
    if (serie !== undefined && serie !== null && (typeof serie !== 'string' || serie.length > 80))
      return res.status(400).json({ error: `productos[${i}]: "serie" debe ser un texto de hasta 80 caracteres.` });
    if (opciones !== undefined && (!Array.isArray(opciones) || opciones.some((o) => !Number.isInteger(o) || o <= 0)))
      return res.status(400).json({ error: `productos[${i}]: "opciones" debe ser una lista de ids de opción.` });
    if (lote_indicado !== undefined && lote_indicado !== null && (typeof lote_indicado !== 'string' || lote_indicado.length > 60))
      return res.status(400).json({ error: `productos[${i}]: "lote_indicado" debe ser un texto de hasta 60 caracteres.` });
    if (observaciones !== undefined && (typeof observaciones !== 'string' || observaciones.length > 255))
      return res.status(400).json({ error: `productos[${i}]: "observaciones" debe ser un texto de hasta 255 caracteres.` });
    if (!producto_id || !Number.isInteger(producto_id) || producto_id <= 0)
      return res.status(400).json({ error: `productos[${i}]: "producto_id" debe ser un entero positivo.` });
    if (!cantidad || !Number.isInteger(cantidad) || cantidad <= 0)
      return res.status(400).json({ error: `productos[${i}]: "cantidad" debe ser un entero mayor a cero.` });
  }

  // Resuelve precio, nombre y descripcion por ID
  const conn = await pool.getConnection();
  let productosConDatos;
  let advertencias;
  try {
    productosConDatos = [];
    const conLotes = (await Funciones.estaActiva('STK-LOTES')) && (await Modulos.estaInstalado('stock')); // sin eso el campo no se ofrece
    const conModif = await Funciones.estaActiva('VEN-MODIF');
    const conAlergenos = await Funciones.estaActiva('VEN-ALERGENOS');
    const conListas = await Funciones.estaActiva('VEN-LISTAS');
    // Con la pantalla de cocina, un agotado (manual o de Stock) se puede vender con permiso si el modo es "advertir" (Ventas RN35).
    const conFranja = await Funciones.estaActiva('VEN-FRANJA');
    const conKds = await Funciones.estaActiva('VEN-KDS');
    const modoAgotado = conKds ? await Cocina.modoAgotado() : 'bloquear';
    const puedeAgotado = conKds && modoAgotado === 'advertir' && (await permisosDe(req)).niveles['ventas.agotados.vender'] === 'permitido';
    advertencias = [];
    const seriesDelPedido = new Set();
    for (const { producto_id, cantidad, observaciones, lote_indicado, opciones, serie } of productos) {
      const [rows] = await conn.query(
        'SELECT id, nombre, descripcion, precio, agotado, agotado_auto, tipo FROM productos WHERE id = ?',
        [producto_id]
      );
      if (!rows.length) {
        conn.release();
        return res.status(404).json({ error: `Producto con id ${producto_id} no encontrado.` });
      }
      // Fuera de su franja un ítem no se ofrece (Ventas RN45); lo ya agregado conserva su precio y puede enviarse.
      if (conFranja) {
        const fr = await Franjas.disponible(conn, producto_id);
        if (!fr.disponible) {
          conn.release();
          return res.status(409).json({ error: `"${rows[0].nombre}" no se ofrece en este horario (${fr.franjas.join(', ')}).`, codigo: 'FUERA_DE_FRANJA', franjas: fr.franjas });
        }
      }
      if (rows[0].agotado) {
        if (!puedeAgotado) {
          conn.release();
          return res.status(409).json({ error: `El producto "${rows[0].nombre}" está agotado.`, codigo: 'PRODUCTO_AGOTADO' });
        }
        advertencias.push(`"${rows[0].nombre}" está agotado: se vendió con tu permiso.`);
      } else if (conKds && rows[0].agotado_auto) {
        advertencias.push(`"${rows[0].nombre}" figura sin existencias en Stock: la marca avisa y no bloquea la venta.`); // Stock RF32, Ventas RN01
      }
      // Artículo con número de serie (RN05, EX33): exige la serie, que no puede estar vendida ni en otro pedido abierto.
      let serieLinea = null;
      try {
        serieLinea = await SerieVenta.validarEnPedido(conn, { producto: rows[0], serie, cantidad, pedidoId: pedido_id });
        if (serieLinea) {
          if (seriesDelPedido.has(`${producto_id}:${serieLinea}`)) throw Object.assign(new SerieVenta.SerieVentaInvalida(`La serie ${serieLinea} está repetida en el pedido.`), { status: 409 });
          seriesDelPedido.add(`${producto_id}:${serieLinea}`);
        }
      } catch (err) {
        conn.release();
        if (err instanceof SerieVenta.SerieVentaInvalida) return res.status(err.status ?? 400).json({ error: err.message, ...(err.codigo && { codigo: err.codigo }), ...(err.estado && { estado: err.estado }) });
        throw err;
      }
      // Las opciones elegidas ajustan el precio, que queda fijado al agregar el ítem (Ventas RN41).
      let modificadores = [];
      if (opciones?.length) {
        if (!conModif) { conn.release(); return res.status(409).json({ error: 'Los modificadores no están activos en esta instancia.', codigo: 'FUNCION_INACTIVA' }); }
        try { modificadores = await Modificadores.resolver(conn, producto_id, opciones); } catch (err) {
          conn.release();
          if (err instanceof Modificadores.ModificadorInvalido) return res.status(err.status ?? 400).json({ error: err.message });
          throw err;
        }
      }
      const ajuste = modificadores.reduce((a, m) => a + Number(m.ajuste_precio_aplicado), 0);
      // Precio de la lista del pedido (VEN-LISTAS); sin precio en la lista se usa el base y se advierte (EX23).
      let precioBase = Number(rows[0].precio);
      let listaId = null;
      if (conListas) {
        const pr = await Listas.precioDe(conn, pedido_id, producto_id, rows[0].nombre, precioBase);
        precioBase = pr.precio;
        listaId = pr.lista_precio_id;
        if (pr.advertencia) advertencias.push(pr.advertencia);
      }
      productosConDatos.push({
        producto_id,
        cantidad,
        nombre: rows[0].nombre,
        descripcion: rows[0].descripcion,
        modificadores,
        serie: serieLinea,
        alergenos: conAlergenos ? await AlergenosVenta.calcularLinea(conn, producto_id, modificadores.map((m) => m.opcion_id)) : null,
        lista_precio_id: listaId,
        precio_unitario: Math.round((precioBase + ajuste) * 100) / 100,
        observaciones: observaciones?.trim() || null,
        lote_indicado: conLotes ? lote_indicado?.trim() || null : null,
      });
    }
  } catch (err) {
    conn.release();
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    return res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
  conn.release();

  await _resolverYAgregarProductos(pedido_id, productosConDatos, res, advertencias);
};

const addProductosPorNombre = async (req, res) => {
  const pedido_id = parseInt(req.params.id, 10);
  if (isNaN(pedido_id))
    return res.status(400).json({ error: 'El parámetro "id" del pedido debe ser un entero válido.' });

  const { productos } = req.body;

  if (!Array.isArray(productos) || productos.length === 0)
    return res.status(400).json({ error: 'El campo "productos" debe ser un array no vacío.' });

  for (let i = 0; i < productos.length; i++) {
    const { nombre, cantidad, observaciones } = productos[i];
    if (observaciones !== undefined && (typeof observaciones !== 'string' || observaciones.length > 255))
      return res.status(400).json({ error: `productos[${i}]: "observaciones" debe ser un texto de hasta 255 caracteres.` });
    if (!nombre || typeof nombre !== 'string' || nombre.trim() === '')
      return res.status(400).json({ error: `productos[${i}]: "nombre" debe ser un texto no vacío.` });
    if (!cantidad || !Number.isInteger(cantidad) || cantidad <= 0)
      return res.status(400).json({ error: `productos[${i}]: "cantidad" debe ser un entero mayor a cero.` });
  }

  // Resuelve producto_id, precio y descripcion por nombre (coincidencia exacta, insensible a mayúsculas)
  const conn = await pool.getConnection();
  let productosConDatos;
  try {
    productosConDatos = [];
    for (const { nombre, cantidad, observaciones } of productos) {
      const [rows] = await conn.query(
        'SELECT id, nombre, descripcion, precio, agotado FROM productos WHERE nombre = ?',
        [nombre.trim()]
      );
      if (!rows.length) {
        conn.release();
        return res.status(404).json({ error: `Producto con nombre "${nombre}" no encontrado.` });
      }
      if (rows[0].agotado) {
        conn.release();
        return res.status(409).json({ error: `El producto "${rows[0].nombre}" está agotado.`, codigo: 'PRODUCTO_AGOTADO' });
      }
      productosConDatos.push({
        producto_id: rows[0].id,
        cantidad,
        nombre: rows[0].nombre,
        descripcion: rows[0].descripcion,
        precio_unitario: Number(rows[0].precio),
        observaciones: observaciones?.trim() || null,
      });
    }
  } catch (err) {
    conn.release();
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    return res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
  conn.release();

  await _resolverYAgregarProductos(pedido_id, productosConDatos, res);
};

// Cierra un único pedido (no toda la mesa). Si era el último pedido activo, libera la mesa.
const cerrarPedido = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id))
    return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });

  let idCompromiso = null;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const pedido = await Pedido.getById(id, conn);
    if (!pedido) {
      await conn.rollback();
      return res.status(404).json({ error: `Pedido con id ${id} no encontrado.` });
    }
    if (pedido.estado === 'finalizado') {
      await conn.rollback();
      return res.status(400).json({ error: 'Este pedido ya está cerrado.' });
    }

    await Promociones.aplicar(conn, [id], { clave: `pedido:${id}` });
    const items = await Pedido.getItems(id, conn);
    if (!items.length) {
      await conn.rollback();
      return res.status(400).json({ error: 'No se puede cerrar un pedido sin productos. Eliminalo en su lugar.' });
    }

    idCompromiso = await Venta.comprometerStock(items, { idSolicitud: req.get('X-ID-Solicitud'), userId: req.usuario?.sub ?? null, autorizar: () => validarAutorizacion(req, 'ventas.cuenta.cobrar') });
    // El descuento de stock viaja como mensaje en la misma transacción que el cierre de la silla.
    await Venta.publicarDescuento(conn, { docTipo: 'pedido', docIdGlobal: pedido.id_global, items, userId: req.usuario?.sub ?? null, idCompromiso, modalidad: pedido.modalidad ?? null });
    await Pedido.cerrarPedidoIndividual(id, conn);

    // Si era la última silla activa de la mesa, la cuenta quedó completa: la mesa sigue "ocupada"
    // hasta que se imprima/descargue el ticket consolidado (ver Mesa.setTicketPendiente).
    const pedidosActivosRestantes = await Pedido.getActivosByMesa(pedido.mesa_id, conn);
    let ticketPendiente = false;
    if (!pedidosActivosRestantes.length) {
      await Mesa.setTicketPendiente(pedido.mesa_id, true, conn);
      ticketPendiente = true;
    }

    await conn.commit();
    Mensajeria.despertar();

    const total = items.reduce((sum, item) => sum + Number(item.subtotal), 0);
    res.json({
      message: `Pedido ${id} cerrado.`,
      pedido_id: id,
      total: Math.round(total * 100) / 100,
      ticket_pendiente: ticketPendiente,
    });
  } catch (err) {
    await conn.rollback();
    await Venta.liberarCompromiso(idCompromiso);
    await Venta.liberarSeries(req.get('X-ID-Solicitud'));
    if (['SIN_DISPONIBLE', 'STOCK_NO_RESPONDE', 'LOTE_NO_DISPONIBLE', 'SERIE_NO_DISPONIBLE'].includes(err.codigo)) return res.status(409).json({ error: err.message, codigo: err.codigo, detalle: err.detalle });
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  } finally {
    conn.release();
  }
};

// Elimina un pedido activo (cancelación). No se puede eliminar un pedido ya finalizado.
const removePedido = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id))
    return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const pedido = await Pedido.getById(id, conn);
    if (!pedido) {
      await conn.rollback();
      return res.status(404).json({ error: `Pedido con id ${id} no encontrado.` });
    }
    if (pedido.estado === 'finalizado') {
      await conn.rollback();
      return res.status(400).json({ error: 'No se puede eliminar un pedido ya cerrado.' });
    }

    await Pedido.remove(id, conn);

    const pedidosActivosRestantes = await Pedido.getActivosByMesa(pedido.mesa_id, conn);
    let mesaLiberada = false;
    if (!pedidosActivosRestantes.length) {
      await Mesa.updateEstado(pedido.mesa_id, 'libre', conn);
      mesaLiberada = true;
    }

    await conn.commit();

    res.json({ message: `Pedido ${id} eliminado.`, pedido_id: id, mesa_liberada: mesaLiberada });
  } catch (err) {
    await conn.rollback();
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  } finally {
    conn.release();
  }
};

// Quita un producto (item) de un pedido activo
const removeItem = async (req, res) => {
  const pedido_id = parseInt(req.params.id, 10);
  const item_id = parseInt(req.params.itemId, 10);
  if (isNaN(pedido_id) || isNaN(item_id))
    return res.status(400).json({ error: 'Los parámetros "id" e "itemId" deben ser enteros válidos.' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const pedido = await Pedido.getById(pedido_id, conn);
    if (!pedido) {
      await conn.rollback();
      return res.status(404).json({ error: `Pedido con id ${pedido_id} no encontrado.` });
    }
    if (pedido.estado === 'finalizado') {
      await conn.rollback();
      return res.status(400).json({ error: 'No se pueden quitar productos de un pedido ya cerrado.' });
    }

    const item = await Pedido.getItem(item_id, conn);
    if (!item || item.pedido_id !== pedido_id) {
      await conn.rollback();
      return res.status(404).json({ error: `Producto con id ${item_id} no encontrado en este pedido.` });
    }

    const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo.trim().slice(0, 255) : '';
    if (item.enviado_at && !motivo) {
      await conn.rollback();
      return res.status(400).json({ error: 'El ítem ya se envió a producción: indicá el motivo para quitarlo.', codigo: 'MOTIVO_OBLIGATORIO' });
    }
    await conn.query(
      'INSERT INTO item_anulaciones (pedido_id, producto_id, nombre, cantidad, precio_unitario, motivo, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [pedido_id, item.producto_id, item.nombre, item.cantidad, item.precio_unitario, motivo || null, req.usuario?.sub ?? null]);
    await Pedido.removeItem(item_id, conn);
    await conn.commit();

    res.json({ message: `Producto quitado del pedido ${pedido_id}.`, pedido_id, item_id });
  } catch (err) {
    await conn.rollback();
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  } finally {
    conn.release();
  }
};

// Marca (o desmarca) un producto puntual como entregado. Seguimiento de servicio: no afecta el
// total ni requiere que el pedido esté activo.
const marcarItemEntregado = async (req, res) => {
  const pedido_id = parseInt(req.params.id, 10);
  const item_id = parseInt(req.params.itemId, 10);
  if (isNaN(pedido_id) || isNaN(item_id))
    return res.status(400).json({ error: 'Los parámetros "id" e "itemId" deben ser enteros válidos.' });

  const { entregado } = req.body;
  if (typeof entregado !== 'boolean')
    return res.status(400).json({ error: 'El campo "entregado" debe ser true o false.' });

  try {
    const item = await Pedido.getItem(item_id);
    if (!item || item.pedido_id !== pedido_id)
      return res.status(404).json({ error: `Producto con id ${item_id} no encontrado en este pedido.` });

    await Pedido.setItemEntregado(item_id, entregado);
    res.json({ message: 'Producto actualizado.', pedido_id, item_id, entregado });
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

// Marca (o desmarca) TODOS los productos de un pedido (silla) de una sola vez.
const marcarPedidoEntregado = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id))
    return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });

  const { entregado } = req.body;
  if (typeof entregado !== 'boolean')
    return res.status(400).json({ error: 'El campo "entregado" debe ser true o false.' });

  try {
    const pedido = await Pedido.getById(id);
    if (!pedido)
      return res.status(404).json({ error: `Pedido con id ${id} no encontrado.` });

    await Pedido.setPedidoEntregado(id, entregado);
    res.json({ message: 'Pedido actualizado.', pedido_id: id, entregado });
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const ESTADOS_FACTURA_VALIDOS = ['pendiente', 'aprobada', 'rechazada', 'error'];

// Valida los filtros del historial y devuelve `{ error }` o `{ filtros }`. La comparte la consulta
// paginada de la pantalla con la del reporte exportable: el reporte tiene que aceptar exactamente
// los mismos filtros que la tabla, ni más ni menos.
const validarFiltrosHistorial = (req) => {
  const { desde, hasta, metodo_pago, estado_factura, con_factura, sort, order } = req.query;
  const numero_mesa = req.query.numero_mesa !== undefined ? parseInt(req.query.numero_mesa, 10) : undefined;

  if (desde !== undefined && !esFechaISO(desde))
    return { error: '"desde" debe tener formato YYYY-MM-DD.' };
  if (hasta !== undefined && !esFechaISO(hasta))
    return { error: '"hasta" debe tener formato YYYY-MM-DD.' };
  if (desde && hasta && desde > hasta)
    return { error: '"desde" no puede ser posterior a "hasta".' };
  if (req.query.numero_mesa !== undefined && (isNaN(numero_mesa) || numero_mesa <= 0))
    return { error: '"numero_mesa" debe ser un entero positivo.' };
  if (estado_factura !== undefined && !ESTADOS_FACTURA_VALIDOS.includes(estado_factura))
    return { error: `"estado_factura" debe ser uno de: ${ESTADOS_FACTURA_VALIDOS.join(', ')}.` };
  if (con_factura !== undefined && !['si', 'no'].includes(con_factura))
    return { error: '"con_factura" debe ser "si" o "no".' };
  if (sort !== undefined && !Pedido.SORT_CAMPOS_VALIDOS.includes(sort))
    return { error: `"sort" debe ser uno de: ${Pedido.SORT_CAMPOS_VALIDOS.join(', ')}.` };
  if (order !== undefined && !['asc', 'desc'].includes(order))
    return { error: '"order" debe ser "asc" o "desc".' };

  return { filtros: { desde, hasta, numero_mesa, metodo_pago, estado_factura, con_factura, sort, order } };
};

const getHistorial = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

  const { error, filtros } = validarFiltrosHistorial(req);
  if (error) return res.status(400).json({ error });

  try {
    const { rows, total } = await Pedido.getHistorial(page, limit, filtros);
    res.json({
      pedidos: rows,
      total,
      page,
      limit,
      total_paginas: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

// Tope de filas del reporte exportable: más que esto no se arma en memoria, se le pide al usuario
// que acote el rango de fechas. Para una cafetería son varios meses de ventas.
const MAX_FILAS_REPORTE = 5000;

// Columnas de la hoja principal: las mismas que muestra la tabla del historial, más los datos
// fiscales que ya vienen pegados al pedido por el LEFT JOIN con facturas.
const COLUMNAS_VENTAS = [
  { key: 'id', label: '#', tipo: 'numero', ancho: 6 },
  { key: 'mesa', label: 'Mesa', tipo: 'texto', ancho: 10 },
  { key: 'sesion_apertura', label: 'Apertura mesa', tipo: 'fecha', ancho: 17 },
  { key: 'fecha_creacion', label: 'Apertura silla', tipo: 'fecha', ancho: 17 },
  { key: 'fecha_cierre', label: 'Cierre silla', tipo: 'fecha', ancho: 17 },
  { key: 'hora_cierre_mesa', label: 'Cierre mesa', tipo: 'fecha', ancho: 17 },
  { key: 'comprobante', label: 'Comprobante', tipo: 'texto', ancho: 13 },
  { key: 'estado_comprobante', label: 'Estado comp.', tipo: 'texto', ancho: 11 },
  { key: 'punto_venta', label: 'Pto. Vta.', tipo: 'texto', ancho: 9 },
  { key: 'numero', label: 'Número', tipo: 'texto', ancho: 11 },
  { key: 'cae', label: 'CAE', tipo: 'texto', ancho: 15 },
  { key: 'metodo_pago', label: 'Método de pago', tipo: 'texto', ancho: 13 },
  { key: 'neto', label: 'Neto', tipo: 'moneda', ancho: 11 },
  { key: 'iva', label: 'IVA', tipo: 'moneda', ancho: 11 },
  { key: 'total', label: 'Total', tipo: 'moneda', ancho: 11 },
];

const COLUMNAS_ITEMS = [
  { key: 'pedido_id', label: 'Pedido #', tipo: 'numero', ancho: 8 },
  { key: 'mesa', label: 'Mesa', tipo: 'texto', ancho: 10 },
  { key: 'fecha_cierre', label: 'Cierre silla', tipo: 'fecha', ancho: 17 },
  { key: 'producto', label: 'Producto', tipo: 'texto', ancho: 28 },
  { key: 'cantidad', label: 'Cantidad', tipo: 'numero', ancho: 9 },
  { key: 'precio_unitario', label: 'Precio unit.', tipo: 'moneda', ancho: 12 },
  { key: 'subtotal', label: 'Subtotal', tipo: 'moneda', ancho: 12 },
];

const filaVenta = (p) => ({
  id: p.id,
  mesa: `Mesa ${p.numero_mesa}`,
  sesion_apertura: p.sesion_apertura,
  fecha_creacion: p.fecha_creacion,
  fecha_cierre: p.fecha_cierre,
  hora_cierre_mesa: p.hora_cierre_mesa,
  comprobante: p.factura_id ? etiqueta(TIPO_COMPROBANTE_LABEL, p.tipo_comprobante) : 'Sin factura (ticket)',
  estado_comprobante: p.factura_id ? etiqueta(ESTADO_FACTURA_LABEL, p.factura_estado) : '—',
  punto_venta: p.factura_punto_venta ? String(p.factura_punto_venta).padStart(4, '0') : '',
  numero: p.factura_numero ? String(p.factura_numero).padStart(8, '0') : '',
  cae: p.cae || '',
  metodo_pago: etiqueta(METODO_PAGO_LABEL, p.metodo_pago),
  // Neto e IVA solo existen si ARCA autorizó el comprobante; en una cuenta cerrada con ticket
  // quedan vacíos a propósito (poner 0 daría a entender que se facturó por cero).
  neto: p.factura_id ? p.importe_neto : null,
  iva: p.factura_id ? p.importe_iva : null,
  total: p.total,
});

const armarResumen = (pedidos) => {
  const totalVendido = pedidos.reduce((acc, p) => acc + Number(p.total), 0);
  const facturados = pedidos.filter((p) => p.factura_id && p.factura_estado === 'aprobada');
  // Las sillas de una misma mesa comparten sesion_apertura: esa combinación es "la cuenta".
  const cuentas = new Set(pedidos.map((p) => `${p.mesa_id}|${p.sesion_apertura}`)).size;

  return [
    { label: 'Cuentas cerradas', valor: cuentas, tipo: 'numero' },
    { label: 'Pedidos (sillas)', valor: pedidos.length, tipo: 'numero' },
    { label: 'Total vendido', valor: totalVendido, tipo: 'moneda' },
    { label: 'Promedio por cuenta', valor: cuentas ? totalVendido / cuentas : 0, tipo: 'moneda' },
    { label: 'Neto facturado ante ARCA', valor: facturados.reduce((acc, p) => acc + Number(p.importe_neto || 0), 0), tipo: 'moneda' },
    { label: 'IVA facturado ante ARCA', valor: facturados.reduce((acc, p) => acc + Number(p.importe_iva || 0), 0), tipo: 'moneda' },
    ...desglose('Por método de pago', pedidos, (p) => etiqueta(METODO_PAGO_LABEL, p.metodo_pago, 'Sin registrar'), (p) => p.total),
    ...desglose(
      'Por estado de comprobante',
      pedidos,
      (p) => (p.factura_id ? etiqueta(ESTADO_FACTURA_LABEL, p.factura_estado) : 'Sin factura (ticket)'),
      (p) => p.total
    ),
  ];
};

// Describe en texto los filtros aplicados, para que el archivo diga de qué recorte de datos salió.
const describirFiltros = ({ desde, hasta, numero_mesa, metodo_pago, estado_factura, con_factura }) => {
  const filtros = [];
  if (desde) filtros.push({ label: 'Desde', valor: desde });
  if (hasta) filtros.push({ label: 'Hasta', valor: hasta });
  if (numero_mesa) filtros.push({ label: 'Mesa', valor: `Mesa ${numero_mesa}` });
  if (metodo_pago) filtros.push({ label: 'Método de pago', valor: etiqueta(METODO_PAGO_LABEL, metodo_pago) });
  if (con_factura) filtros.push({ label: 'Facturación ARCA', valor: con_factura === 'si' ? 'Con factura ARCA' : 'Sin factura (solo ticket)' });
  if (estado_factura) filtros.push({ label: 'Estado comprobante', valor: etiqueta(ESTADO_FACTURA_LABEL, estado_factura) });
  if (!filtros.length) filtros.push({ label: 'Filtros', valor: 'Ninguno (historial completo)' });
  return filtros;
};

// Exporta el historial de cuentas cerradas que coincide con los filtros de la pantalla, en el
// formato pedido (csv/xlsx/pdf/json). A diferencia de /historial, no pagina: el archivo trae todas
// las filas que coinciden, con un tope de MAX_FILAS_REPORTE.
const getReporte = async (req, res) => {
  const { error, filtros } = validarFiltrosHistorial(req);
  if (error) return res.status(400).json({ error });

  const formato = req.query.formato || FORMATO_POR_DEFECTO;
  if (!FORMATOS_VALIDOS.includes(formato))
    return res.status(400).json({ error: `"formato" debe ser uno de: ${FORMATOS_VALIDOS.join(', ')}.` });

  const incluirItems = req.query.incluir_items !== '0';

  try {
    const pedidos = await Pedido.getHistorialCompleto(filtros, MAX_FILAS_REPORTE);
    if (pedidos.length > MAX_FILAS_REPORTE) {
      return res.status(400).json({
        error: `El reporte supera las ${MAX_FILAS_REPORTE} filas. Acotá el rango de fechas u otro filtro.`,
      });
    }

    const hojas = [{ nombre: 'Ventas', columnas: COLUMNAS_VENTAS, filas: pedidos.map(filaVenta) }];

    if (incluirItems && pedidos.length) {
      const porId = new Map(pedidos.map((p) => [p.id, p]));
      const items = await Pedido.getItemsByPedidoIds(pedidos.map((p) => p.id));
      hojas.push({
        nombre: 'Ítems',
        columnas: COLUMNAS_ITEMS,
        filas: items.map((it) => {
          const pedido = porId.get(it.pedido_id);
          return {
            pedido_id: it.pedido_id,
            mesa: pedido ? `Mesa ${pedido.numero_mesa}` : '',
            fecha_cierre: pedido?.fecha_cierre ?? null,
            producto: it.nombre,
            cantidad: it.cantidad,
            precio_unitario: it.precio_unitario,
            subtotal: it.subtotal,
          };
        }),
      });
    }

    const rango = filtros.desde || filtros.hasta
      ? `Del ${filtros.desde || 'inicio'} al ${filtros.hasta || 'hoy'}`
      : 'Historial completo';
    const nombreBase = `historial-ventas-${filtros.desde || 'inicio'}_a_${filtros.hasta || 'hoy'}`;

    await enviarReporte(res, {
      titulo: 'Reporte de historial de ventas',
      subtitulo: rango,
      filtros: describirFiltros(filtros),
      resumen: armarResumen(pedidos),
      hojas,
    }, formato, nombreBase);
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    // Si el generador ya empezó a escribir el archivo (pdf/xlsx hacen streaming) no se puede
    // cambiar el status: se corta la respuesta y el navegador descarta la descarga.
    if (res.headersSent) return res.end();
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const TIPOS_ESTADISTICA_VALIDOS = ['dia', 'semana', 'mes'];
const DIAS_SEMANA = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

// Ventas cerradas agrupadas por hora (tipo=dia) o por día (tipo=semana/mes), con el porcentaje
// que representa cada bucket sobre el total del período, para graficar en el Historial.
const getEstadisticas = async (req, res) => {
  const { tipo } = req.query;
  const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);

  if (!TIPOS_ESTADISTICA_VALIDOS.includes(tipo))
    return res.status(400).json({ error: `"tipo" debe ser uno de: ${TIPOS_ESTADISTICA_VALIDOS.join(', ')}.` });
  if (!esFechaISO(fecha))
    return res.status(400).json({ error: '"fecha" debe tener formato YYYY-MM-DD.' });

  try {
    const { desde, hasta, rows } = await Pedido.getEstadisticas(tipo, fecha);
    const porClave = new Map(rows.map((r) => [String(r.clave), { cantidad: r.cantidad, total: Number(r.total) }]));

    let datos;
    if (tipo === 'dia') {
      datos = Array.from({ length: 24 }, (_, hora) => {
        const d = porClave.get(String(hora)) || { cantidad: 0, total: 0 };
        return { clave: hora, etiqueta: `${String(hora).padStart(2, '0')}h`, ...d };
      });
    } else {
      datos = [];
      const cursor = new Date(`${desde}T00:00:00`);
      const fin = new Date(`${hasta}T00:00:00`);
      while (cursor <= fin) {
        const clave = cursor.toISOString().slice(0, 10);
        const d = porClave.get(clave) || { cantidad: 0, total: 0 };
        const etiqueta = tipo === 'semana' ? `${DIAS_SEMANA[cursor.getDay()]} ${cursor.getDate()}` : `${cursor.getDate()}`;
        datos.push({ clave, etiqueta, ...d });
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    const totalPeriodo = datos.reduce((sum, d) => sum + d.total, 0);
    datos = datos.map((d) => ({
      ...d,
      porcentaje: totalPeriodo > 0 ? Math.round((d.total / totalPeriodo) * 1000) / 10 : 0,
    }));

    res.json({ tipo, desde, hasta, total_periodo: Math.round(totalPeriodo * 100) / 100, datos });
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const getOne = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id))
    return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });

  try {
    const pedido = await Pedido.getById(id);
    if (!pedido)
      return res.status(404).json({ error: `Pedido con id ${id} no encontrado.` });

    const items = await Pedido.getItems(id);
    res.json({ pedido, items });
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

module.exports = {
  create,
  moverMesa,
  dividir,
  addProductos,
  addProductosPorNombre,
  cerrarPedido,
  removePedido,
  removeItem,
  marcarItemEntregado,
  marcarPedidoEntregado,
  getHistorial,
  getReporte,
  getEstadisticas,
  getOne,
};
