const { Router } = require('express');
const Venta = require('../services/ventaService');
const { requierePermiso } = require('../middleware/requierePermiso');

const router = Router();

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
