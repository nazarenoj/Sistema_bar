const { Router } = require('express');
const c = require('../controllers/usuarioController');
const { requierePermiso } = require('../middleware/requierePermiso');

const router = Router();
router.use(requierePermiso('usuarios.gestionar'));

router.get('/', c.listar);
router.post('/', c.crear);
router.put('/:id', c.actualizar);
router.post('/:id/desactivar', c.desactivar);
router.post('/:id/activar', c.activar);
router.post('/:id/desbloquear', c.desbloquear);
router.post('/:id/password', c.resetPassword);

module.exports = router;
