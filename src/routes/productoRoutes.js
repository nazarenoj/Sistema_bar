const { Router } = require('express');
const {
  getAll,
  getOne,
  create,
  update,
  remove,
  getComponentes,
  setComponentes,
  getInsumosDeProducto,
  addInsumoAProducto,
  updateInsumoDeProducto,
  removeInsumoDeProducto,
} = require('../controllers/productoController');

const { requierePermiso } = require('../middleware/requierePermiso');
const router = Router();

router.get('/', requierePermiso('ventas.catalogo.ver'), getAll);
router.get('/:identifier', requierePermiso('ventas.catalogo.ver'), getOne);   // resuelve ID (numérico) o nombre (texto)
router.post('/', requierePermiso('ventas.catalogo.editar'), create);
router.put('/:id', requierePermiso('ventas.catalogo.editar'), update);
router.delete('/:id', requierePermiso('ventas.catalogo.editar'), remove);

// Combo (componentes)
router.get('/:id/componentes', requierePermiso('ventas.catalogo.ver'), getComponentes);
router.put('/:id/componentes', requierePermiso('ventas.catalogo.editar'), setComponentes);

// Receta (insumos que consume el producto)
router.get('/:id/insumos', requierePermiso('ventas.catalogo.ver'), getInsumosDeProducto);
router.post('/:id/insumos', requierePermiso('ventas.catalogo.editar'), addInsumoAProducto);
router.put('/:id/insumos/:insumoProductoId', requierePermiso('ventas.catalogo.editar'), updateInsumoDeProducto);
router.delete('/:id/insumos/:insumoProductoId', requierePermiso('ventas.catalogo.editar'), removeInsumoDeProducto);

module.exports = router;
