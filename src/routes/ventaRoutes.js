const { Router } = require('express');
const Venta = require('../services/ventaService');
const Registro = require('../services/registroVentasService');
const Parametro = require('../models/parametroModel');
const pool = require('../config/db');
const { auditar } = require('../utils/auditar');
const { enviarReporte, FORMATOS_VALIDOS, FORMATO_POR_DEFECTO } = require('../services/reporteService');
const { TIPO_COMPROBANTE_LABEL, METODO_PAGO_LABEL, etiqueta } = require('../utils/etiquetas');
const { requierePermiso } = require('../middleware/requierePermiso');

const router = Router();

// Registro de ventas (RF19 a RF21): filtros combinables, orden, paginación (50 por página) y totales que
// excluyen las anuladas y restan las devoluciones (RN24). Un filtro sin resultados no es un error (EX18).
router.get('/', requierePermiso('ventas.historial.ver'), async (req, res, next) => {
  try {
    res.json(await Registro.listar(req.query));
  } catch (err) {
    if (err instanceof Registro.FiltroInvalido) return res.status(400).json({ error: err.message });
    next(err);
  }
});

const COLUMNAS_EXPORTAR = [
  { key: 'fecha', label: 'Fecha', tipo: 'fecha', ancho: 17 },
  { key: 'mesa', label: 'Mesa', tipo: 'texto', ancho: 10 },
  { key: 'estado', label: 'Estado', tipo: 'texto', ancho: 14 },
  { key: 'comprobante', label: 'Comprobante', tipo: 'texto', ancho: 16 },
  { key: 'numero', label: 'Número', tipo: 'texto', ancho: 14 },
  { key: 'formas', label: 'Formas de pago', tipo: 'texto', ancho: 20 },
  { key: 'usuario', label: 'Usuario', tipo: 'texto', ancho: 12 },
  { key: 'total', label: 'Total', tipo: 'moneda', ancho: 11 },
  { key: 'devuelto', label: 'Devuelto', tipo: 'moneda', ancho: 11 },
];
const ETIQUETA_MODALIDAD = { no_fiscal: 'No fiscal' };

// Exporta lo filtrado (csv, xlsx, pdf o json). Si supera el límite configurado se rechaza en vez de truncar (EX17).
router.get('/exportar', requierePermiso('ventas.historial.exportar'), async (req, res, next) => {
  const formato = req.query.formato || FORMATO_POR_DEFECTO;
  if (!FORMATOS_VALIDOS.includes(formato)) return res.status(400).json({ error: `"formato" debe ser uno de: ${FORMATOS_VALIDOS.join(', ')}.` });
  try {
    const { ventas, totales } = await Registro.paraExportar(req.query);
    const filas = ventas.map((v) => ({
      fecha: v.created_at, mesa: `Mesa ${v.numero_mesa}`, estado: v.estado,
      comprobante: v.condicion_fiscal === 'no_fiscal' ? ETIQUETA_MODALIDAD.no_fiscal : v.factura_id ? etiqueta(TIPO_COMPROBANTE_LABEL, v.tipo_comprobante) : 'Sin comprobante',
      numero: v.numero ? `${String(v.punto_venta).padStart(4, '0')}-${String(v.numero).padStart(8, '0')}` : v.numero_no_fiscal ? `NF ${v.numero_no_fiscal}` : '',
      formas: (v.formas || '').split(',').map((f) => etiqueta(METODO_PAGO_LABEL, f)).join(' + '), usuario: v.usuario || '', total: v.total, devuelto: v.devuelto,
    }));
    await enviarReporte(res, {
      titulo: 'Registro de ventas', subtitulo: `${req.query.desde || 'inicio'} a ${req.query.hasta || 'hoy'}`,
      filtros: Object.entries(req.query).filter(([k, v]) => v !== '' && !['formato'].includes(k)).map(([label, valor]) => ({ label, valor: String(valor) })),
      resumen: [{ label: 'Ventas', valor: totales.cantidad, tipo: 'numero' }, { label: 'Total vendido (neto de devoluciones)', valor: totales.total, tipo: 'moneda' },
        ...totales.por_forma_pago.map((p) => ({ label: `Por forma de pago: ${etiqueta(METODO_PAGO_LABEL, p.forma)}`, valor: p.total, tipo: 'moneda' }))],
      hojas: [{ nombre: 'Ventas', columnas: COLUMNAS_EXPORTAR, filas }],
    }, formato, `registro-ventas-${req.query.desde || 'inicio'}_a_${req.query.hasta || 'hoy'}`);
  } catch (err) {
    if (err instanceof Registro.FiltroInvalido) return res.status(400).json({ error: err.message, limite: err.limite });
    if (res.headersSent) return res.end();
    next(err);
  }
});

// Registra una reimpresión ya completada (RN22, EX14): el cliente la confirma cuando la salida terminó. No genera
// numeración ni toca ARCA (RN20): la copia sale de los datos congelados de la venta y de su comprobante.
router.post('/:idGlobal/reimpresiones', requierePermiso('ventas.reimprimir'), async (req, res, next) => {
  const formato = req.body.formato;
  if (!['ticket', 'a4', 'pdf'].includes(formato)) return res.status(400).json({ error: '"formato" debe ser ticket, a4 o pdf.' });
  const motivo = typeof req.body.motivo === 'string' ? req.body.motivo.trim() : '';
  try {
    if (!motivo && (await Parametro.todos()).reimpresion_motivo_obligatorio) return res.status(400).json({ error: 'El motivo de la reimpresión es obligatorio.' });
    const [[v]] = await pool.query('SELECT id FROM ventas WHERE id_global = ?', [req.params.idGlobal]);
    if (!v) return res.status(404).json({ error: 'Venta no encontrada.' });
    await pool.query('INSERT INTO reimpresiones (venta_id, user_id, username, formato, motivo) VALUES (?, ?, ?, ?, ?)', [v.id, req.usuario?.sub ?? null, req.usuario?.username ?? null, formato, motivo || null]);
    await auditar(req, { modulo: 'ventas', accion: 'reimpresion', entidad: 'venta', entidad_id: req.params.idGlobal, detalle: `${formato}${motivo ? `: ${motivo}` : ''}` });
    res.status(201).json({ message: 'Reimpresión registrada.' });
  } catch (err) { next(err); }
});

// Total cobrado por forma de pago (?desde=YYYY-MM-DD&hasta=YYYY-MM-DD); va antes de /:idGlobal.
router.get('/por-forma-pago', requierePermiso('ventas.historial.ver'), async (req, res, next) => {
  try {
    res.json(await Venta.porFormaPago(req.query));
  } catch (err) { next(err); }
});

// Ventas no fiscales sin factura aprobada (?dias=N: solo las de más de N días), RN84.
router.get('/no-fiscales-pendientes', requierePermiso('ventas.historial.ver'), async (req, res, next) => {
  try {
    res.json(await require('../services/caeaService').noFiscalesPendientes(Number(req.query.dias) || 0));
  } catch (err) { next(err); }
});

// Factura la venta no fiscal (regulariza). Cuerpo: tipo_comprobante, doc_tipo, doc_nro, condicion_iva_receptor_id.
router.post('/:idGlobal/regularizar', requierePermiso('ventas.cuenta.cobrar'), async (req, res, next) => {
  const b = req.body;
  if (![b.tipo_comprobante, b.doc_tipo, b.condicion_iva_receptor_id].every(Number.isInteger) || b.doc_nro === undefined || b.doc_nro === '')
    return res.status(400).json({ error: 'Faltan tipo_comprobante, doc_tipo, doc_nro y condicion_iva_receptor_id.' });
  try {
    const factura = await Venta.regularizar(req.params.idGlobal, b, { idIntento: req.get('X-ID-Solicitud'), userId: req.usuario?.sub });
    res.json({ message: 'Venta regularizada.', factura });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, codigo: err.codigo, factura_id: err.factura_id });
    if (err.factura_id) return res.status(502).json({ error: 'No se pudo emitir la factura ante ARCA.', detail: err.message, factura_id: err.factura_id });
    next(err);
  }
});

router.get('/:idGlobal', requierePermiso('ventas.historial.ver'), async (req, res, next) => {
  try {
    const venta = await Venta.obtener(req.params.idGlobal);
    if (!venta) return res.status(404).json({ error: 'Venta no encontrada.' });
    res.json(venta);
  } catch (err) { next(err); }
});

module.exports = router;
