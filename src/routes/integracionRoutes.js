const { Router } = require('express');
const c = require('../controllers/integracionController');
const { requierePermiso } = require('../middleware/requierePermiso');
const soloAdministrador = require('../middleware/soloAdministrador');

const router = Router();

router.get('/pendientes', requierePermiso('integracion.pendientes.ver'), c.pendientes);
router.get('/documentos/:idGlobal', requierePermiso('integracion.pendientes.ver'), c.documento);
router.post('/pendientes/:id/reintentar', requierePermiso('integracion.pendientes.reintentar'), c.reintentar);
router.post('/pendientes/:id/descartar', requierePermiso('integracion.pendientes.descartar'), c.descartar);
router.post('/reenviar', soloAdministrador, c.reenviar); // solo Administrador (RF02)
router.post('/conciliar', requierePermiso('integracion.conciliar'), c.conciliar);

module.exports = router;
