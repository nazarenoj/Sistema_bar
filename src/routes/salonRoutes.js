const { Router } = require('express');
const { getAll, create, update, remove } = require('../controllers/salonController');

const { requierePermiso } = require('../middleware/requierePermiso');
const router = Router();

router.get('/', requierePermiso('ventas.pedidos.operar'), getAll);
router.post('/', requierePermiso('ventas.salon.configurar'), create);
router.put('/:id', requierePermiso('ventas.salon.configurar'), update);
router.delete('/:id', requierePermiso('ventas.salon.configurar'), remove);

module.exports = router;
