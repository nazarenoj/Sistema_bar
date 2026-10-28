const { Router } = require('express');
const { updatePosicion, remove } = require('../controllers/sillaController');

const { requierePermiso } = require('../middleware/requierePermiso');
const router = Router();

router.patch('/:id/posicion', requierePermiso('ventas.salon.configurar'), updatePosicion);
router.delete('/:id', requierePermiso('ventas.salon.configurar'), remove);

module.exports = router;
