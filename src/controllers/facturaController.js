const Factura = require('../models/facturaModel');
const Pedido = require('../models/pedidoModel');
const afipService = require('../services/afipService');
const afipConfig = require('../config/afipConfig');
const { generarFacturaPDF } = require('../services/facturaPdfService');
const logger = require('../utils/logger');
const { enviarReporte, desglose, FORMATOS_VALIDOS, FORMATO_POR_DEFECTO } = require('../services/reporteService');
const { TIPO_COMPROBANTE_LABEL, METODO_PAGO_LABEL, etiqueta } = require('../utils/etiquetas');
const { esFechaISO } = require('../utils/validaciones');

const TIPOS_POR_CONDICION = {
  monotributista: [{ tipo_comprobante: 11, nombre: 'Factura C' }],
  responsable_inscripto: [
    { tipo_comprobante: 1, nombre: 'Factura A' },
    { tipo_comprobante: 6, nombre: 'Factura B' },
  ],
};

// Le dice al frontend qué tipos de comprobante ofrecer al cerrar una cuenta, según la condición
// IVA configurada del emisor (ver AFIP_CONDICION_IVA_EMISOR). Único lugar donde esa regla vive.
const getConfig = (req, res) => {
  res.json({
    entorno: afipConfig.entorno,
    condicion_iva_emisor: afipConfig.condicionIvaEmisor,
    tipos_comprobante: TIPOS_POR_CONDICION[afipConfig.condicionIvaEmisor],
  });
};

const getHistorial = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

  try {
    const { rows, total } = await Factura.getHistorial(page, limit);
    res.json({
      facturas: rows,
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

const getOne = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });

  try {
    const factura = await Factura.getById(id);
    if (!factura) return res.status(404).json({ error: `Factura con id ${id} no encontrada.` });
    res.json(factura);
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const getPdf = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });

  try {
    const factura = await Factura.getById(id);
    if (!factura) return res.status(404).json({ error: `Factura con id ${id} no encontrada.` });
    if (factura.estado !== 'aprobada')
      return res.status(400).json({ error: 'Esta factura todavía no tiene CAE aprobado.' });

    const pedidos = await Pedido.getPedidosSesion(factura.mesa_id, factura.sesion_apertura);
    const items = await Pedido.getItemsByPedidoIds(pedidos.map((p) => p.id));
    // Se accede a esta ruta desde el historial (no desde el cierre de cuenta recién hecho), así
    // que cualquier impresión acá es una reimpresión de archivo: se marca DUPLICADO.
    await generarFacturaPDF(res, factura, { items, copia: 'DUPLICADO' });
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

// Reintenta la emisión de una factura que quedó pendiente/rechazada/con error (por ejemplo, tras
// una caída de ARCA al cerrar la cuenta). No vuelve a tocar pedidos ni stock: eso ya ocurrió al
// cerrar la cuenta, acá solo se reintenta el trámite ante ARCA.
const reintentar = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });

  try {
    const factura = await Factura.getById(id);
    if (!factura) return res.status(404).json({ error: `Factura con id ${id} no encontrada.` });
    if (factura.estado === 'aprobada')
      return res.status(400).json({ error: 'Esta factura ya fue aprobada, no hace falta reintentar.' });

    try {
      const resultado = await afipService.emitirFactura({
        tipoComprobante: factura.tipo_comprobante,
        docTipo: factura.doc_tipo,
        docNro: factura.doc_nro,
        condicionIvaReceptorId: factura.condicion_iva_receptor_id,
        importeTotal: Number(factura.importe_total),
        idIntento: req.get('X-ID-Solicitud'),
      });
      await Factura.updateResultado(id, resultado);
      return res.json({ message: 'Factura reintentada.', factura: await Factura.getById(id) });
    } catch (err) {
      logger.error(`${req.method} ${req.originalUrl} - ARCA rechazó el reintento de la factura ${id}: ${err.message}`, { stack: err.stack });
      await Factura.updateResultado(id, {
        estado: 'error',
        numero: null,
        cae: null,
        caeVencimiento: null,
        importeNeto: factura.importe_neto,
        importeIva: factura.importe_iva,
        importeTotal: factura.importe_total,
        observaciones: err.message,
      });
      return res.status(502).json({ error: 'No se pudo emitir la factura ante ARCA.', detail: err.message });
    }
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};


const COLUMNAS_REPORTE = [
  { key: 'fecha', label: 'Fecha', tipo: 'fecha', ancho: 17 },
  { key: 'comprobante', label: 'Comprobante', tipo: 'texto', ancho: 13 },
  { key: 'punto_venta', label: 'Punto de Venta', tipo: 'texto', ancho: 11 },
  { key: 'numero', label: 'Número', tipo: 'texto', ancho: 11 },
  { key: 'mesa', label: 'Mesa', tipo: 'texto', ancho: 9 },
  { key: 'metodo_pago', label: 'Método de Pago', tipo: 'texto', ancho: 14 },
  { key: 'neto', label: 'Neto', tipo: 'moneda', ancho: 12 },
  { key: 'iva', label: 'IVA', tipo: 'moneda', ancho: 12 },
  { key: 'total', label: 'Total', tipo: 'moneda', ancho: 12 },
  { key: 'cae', label: 'CAE', tipo: 'texto', ancho: 16 },
];

// Reporte contable de ventas ya facturadas (con CAE aprobado ante ARCA) en un rango de fechas,
// para que el dueño se lo pase al contador. Se puede bajar en csv, xlsx, pdf o json.
const getReporte = async (req, res) => {
  const { desde, hasta } = req.query;

  if (desde !== undefined && !esFechaISO(desde))
    return res.status(400).json({ error: '"desde" debe tener formato YYYY-MM-DD.' });
  if (hasta !== undefined && !esFechaISO(hasta))
    return res.status(400).json({ error: '"hasta" debe tener formato YYYY-MM-DD.' });
  if (desde && hasta && desde > hasta)
    return res.status(400).json({ error: '"desde" no puede ser posterior a "hasta".' });

  const formato = req.query.formato || FORMATO_POR_DEFECTO;
  if (!FORMATOS_VALIDOS.includes(formato))
    return res.status(400).json({ error: `"formato" debe ser uno de: ${FORMATOS_VALIDOS.join(', ')}.` });

  try {
    const facturas = await Factura.getVentasFacturadas(desde || null, hasta || null);

    const filas = facturas.map((f) => ({
      fecha: f.fecha_emision,
      comprobante: etiqueta(TIPO_COMPROBANTE_LABEL, f.tipo_comprobante),
      punto_venta: String(f.punto_venta).padStart(4, '0'),
      numero: String(f.numero).padStart(8, '0'),
      mesa: `Mesa ${f.numero_mesa}`,
      metodo_pago: etiqueta(METODO_PAGO_LABEL, f.metodo_pago),
      neto: f.importe_neto,
      iva: f.importe_iva,
      total: f.importe_total,
      cae: f.cae,
    }));

    // Antes el total iba como una fila "TOTAL" pegada al final del CSV; ahora es un bloque de
    // resumen, así que aparece en los cuatro formatos y no ensucia la tabla de datos.
    const resumen = [
      { label: 'Comprobantes emitidos', valor: facturas.length, tipo: 'numero' },
      { label: 'Total facturado', valor: facturas.reduce((acc, f) => acc + Number(f.importe_total), 0), tipo: 'moneda' },
      { label: 'Total neto', valor: facturas.reduce((acc, f) => acc + Number(f.importe_neto), 0), tipo: 'moneda' },
      { label: 'Total IVA', valor: facturas.reduce((acc, f) => acc + Number(f.importe_iva), 0), tipo: 'moneda' },
      ...desglose('Por tipo de comprobante', facturas, (f) => etiqueta(TIPO_COMPROBANTE_LABEL, f.tipo_comprobante), (f) => f.importe_total),
      ...desglose('Por método de pago', facturas, (f) => etiqueta(METODO_PAGO_LABEL, f.metodo_pago, 'Sin registrar'), (f) => f.importe_total),
    ];

    const filtros = [
      { label: 'Desde', valor: desde || 'inicio del historial' },
      { label: 'Hasta', valor: hasta || 'hoy' },
      { label: 'Comprobantes', valor: 'Solo aprobados por ARCA (con CAE)' },
    ];

    await enviarReporte(res, {
      titulo: 'Reporte de ventas facturadas',
      subtitulo: `Del ${desde || 'inicio'} al ${hasta || 'hoy'}`,
      filtros,
      resumen,
      hojas: [{ nombre: 'Ventas facturadas', columnas: COLUMNAS_REPORTE, filas }],
    }, formato, `reporte-ventas-facturadas-${desde || 'inicio'}_a_${hasta || 'hoy'}`);
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    // pdf y xlsx van en streaming: si ya salieron cabeceras, no se puede cambiar el status.
    if (res.headersSent) return res.end();
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const getEstadoAfip = async (req, res) => {
  try {
    res.json(await afipService.estadoServicio());
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(502).json({ error: 'No se pudo consultar el estado de ARCA.', detail: err.message });
  }
};

module.exports = { getConfig, getHistorial, getOne, getPdf, reintentar, getEstadoAfip, getReporte };
