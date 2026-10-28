const { Router } = require('express');
const {
  getConfig, getHistorial, getOne, getPdf, reintentar, getEstadoAfip, getReporte,
} = require('../controllers/facturaController');

const { requierePermiso } = require('../middleware/requierePermiso');
const router = Router();

router.get('/config', requierePermiso('facturacion.ver'), getConfig);
router.get('/estado-afip', requierePermiso('facturacion.ver'), getEstadoAfip);
router.get('/reporte', requierePermiso('ventas.historial.exportar'), getReporte);
router.get('/', requierePermiso('facturacion.ver'), getHistorial);
router.get('/:id', requierePermiso('facturacion.ver'), getOne);
router.get('/:id/pdf', requierePermiso('facturacion.ver'), getPdf);
router.post('/:id/reintentar', requierePermiso('facturacion.reintentar'), reintentar);

module.exports = router;
