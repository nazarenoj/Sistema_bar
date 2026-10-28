const { Router } = require('express');
const { getAllBySalon, create, updatePosicion, update, remove } = require('../controllers/estructuraController');

const { requierePermiso } = require('../middleware/requierePermiso');
const router = Router();

router.get('/', requierePermiso('ventas.pedidos.operar'), getAllBySalon);
router.post('/', requierePermiso('ventas.salon.configurar'), create);
router.patch('/:id/posicion', requierePermiso('ventas.salon.configurar'), updatePosicion);
router.put('/:id', requierePermiso('ventas.salon.configurar'), update);
router.delete('/:id', requierePermiso('ventas.salon.configurar'), remove);

module.exports = router;
