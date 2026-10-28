const { Router } = require('express');
const {
  getAll,
  getOne,
  create,
  update,
  remove,
} = require('../controllers/insumoController');

const { requierePermiso } = require('../middleware/requierePermiso');
const router = Router();

router.get('/', requierePermiso('stock.insumos.ver'), getAll);
router.get('/:identifier', requierePermiso('stock.insumos.ver'), getOne);   // resuelve ID (numérico) o nombre (texto)
router.post('/', requierePermiso('stock.insumos.editar'), create);
router.put('/:id', requierePermiso('stock.insumos.editar'), update);
router.delete('/:id', requierePermiso('stock.insumos.editar'), remove);

module.exports = router;
