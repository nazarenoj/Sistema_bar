const { Router } = require('express');
const Receta = require('../stock/recetaService');
const { requierePermiso } = require('../middleware/requierePermiso');

// Recetas de los artículos elaborados (Stock RF09): insumos y sub-recetas, con merma y versiones.
const router = Router();
const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Receta.RecetaInvalida) return res.status(err.status || 400).json({ error: err.message, codigo: 'RECETA_INVALIDA' });
    next(err);
  }
};

router.get('/:productoId', requierePermiso('stock.insumos.ver'), manejar(async (req, res) => {
  const r = await Receta.obtener(req.params.productoId);
  return r ? res.json(r) : res.status(404).json({ error: 'Artículo no encontrado.' });
}));

router.get('/:productoId/versiones', requierePermiso('stock.insumos.ver'), manejar(async (req, res) => res.json(await Receta.versiones(req.params.productoId))));

// Reemplaza la receta completa. Cuerpo: lineas [{ insumo_id | componente_producto_id, cantidad_consumida, presentacion_id?, merma_pct? }].
router.put('/:productoId', requierePermiso('stock.insumos.editar'), manejar(async (req, res) =>
  res.json(await Receta.guardar(Number(req.params.productoId), req.body.lineas, { userId: req.usuario?.sub }))));

module.exports = router;
