const { Router } = require('express');
const c = require('../controllers/terminalController');
const { requierePermiso } = require('../middleware/requierePermiso');

const router = Router();
router.use(requierePermiso('usuarios.gestionar'));

router.get('/', c.listar);
router.post('/', c.crear);
router.put('/:id', c.actualizar);

module.exports = router;
