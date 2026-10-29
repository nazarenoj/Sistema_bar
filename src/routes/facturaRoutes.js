const { Router } = require('express');
const {
  getConfig, getHistorial, getOne, getPdf, reintentar, getEstadoAfip, getReporte, getClaves, liberarClave, validarNumeracion, getCaeaVigente, solicitarCaea, informarCaea, getLibroIva, controlArca,
} = require('../controllers/facturaController');

const { requierePermiso } = require('../middleware/requierePermiso');
const router = Router();

router.get('/config', requierePermiso('facturacion.ver'), getConfig);
router.get('/estado-afip', requierePermiso('facturacion.ver'), getEstadoAfip);
router.get('/reporte', requierePermiso('ventas.historial.exportar'), getReporte);
// Claves del secuenciador: las "Resolviendo", su liberación (con autorización de supervisor) y la validación contra ARCA.
router.get('/claves', requierePermiso('facturacion.claves.ver'), getClaves);
router.post('/claves/liberar', requierePermiso('facturacion.claves.resolver'), liberarClave);
router.post('/claves/validar', requierePermiso('facturacion.claves.resolver'), validarNumeracion);
router.get('/libro-iva', requierePermiso('ventas.historial.exportar'), getLibroIva);
router.get('/control-arca', requierePermiso('facturacion.ver'), controlArca);
router.get('/caea/vigente', requierePermiso('facturacion.ver'), getCaeaVigente);
router.post('/caea/solicitar', requierePermiso('facturacion.reintentar'), solicitarCaea);
router.post('/caea/informar', requierePermiso('facturacion.reintentar'), informarCaea);
router.get('/', requierePermiso('facturacion.ver'), getHistorial);
router.get('/:id', requierePermiso('facturacion.ver'), getOne);
router.get('/:id/pdf', requierePermiso('facturacion.ver'), getPdf);
router.post('/:id/reintentar', requierePermiso('facturacion.reintentar'), reintentar);

module.exports = router;
