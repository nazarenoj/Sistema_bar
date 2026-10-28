const { Router } = require('express');
const c = require('../controllers/terminalController');
const { requierePermiso } = require('../middleware/requierePermiso');

const router = Router();
router.use(requierePermiso('usuarios.gestionar'));

router.get('/', c.sesiones);
router.post('/:id/cerrar', c.cerrarSesion);

module.exports = router;
