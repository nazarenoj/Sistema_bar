const { Router } = require('express');
const c = require('../controllers/notificacionController');

// Todo usuario autenticado ve sus propias alertas (se filtran por rol en el controlador).
const router = Router();
router.get('/', c.listar);
router.post('/:id/leida', c.leida);
router.post('/:id/resuelta', c.resuelta);

module.exports = router;
