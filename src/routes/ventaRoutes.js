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

router.get('/:idGlobal', requierePermiso('ventas.historial.ver'), async (req, res, next) => {
  try {
    const venta = await Venta.obtener(req.params.idGlobal);
    if (!venta) return res.status(404).json({ error: 'Venta no encontrada.' });
    res.json(venta);
  } catch (err) { next(err); }
});

module.exports = router;
