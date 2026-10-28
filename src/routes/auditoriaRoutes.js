const { Router } = require('express');
const c = require('../controllers/auditoriaController');
const { requierePermiso } = require('../middleware/requierePermiso');

const router = Router();

router.get('/', requierePermiso('auditoria.ver'), c.listar);
router.get('/verificar', requierePermiso('auditoria.ver'), c.verificar);
router.get('/exportar', requierePermiso('auditoria.exportar'), c.exportar);

module.exports = router;
