const { Router } = require('express');
const Presentacion = require('../models/presentacionModel');
const { requierePermiso } = require('../middleware/requierePermiso');

// Presentaciones de los ítems de Stock (RF02): se compra por caja, se receta en gramos, se vende por porción.
const router = Router();
const VER = requierePermiso('stock.insumos.ver');
const EDITAR = requierePermiso('stock.insumos.editar');
const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Presentacion.PresentacionInvalida) return res.status(err.status || 400).json({ error: err.message, codigo: 'PRESENTACION_INVALIDA' });
    next(err);
  }
};

router.get('/', VER, manejar(async (req, res) => res.json(await Presentacion.listar({ insumo_id: req.query.insumo_id, vigentes: req.query.vigentes === '1' }))));
router.get('/:id', VER, manejar(async (req, res) => {
  const p = await Presentacion.getById(req.params.id);
  return p ? res.json({ ...p, en_uso: await Presentacion.enUso(p.id) }) : res.status(404).json({ error: 'Presentación no encontrada.' });
}));

router.post('/', EDITAR, manejar(async (req, res) => res.status(201).json(await Presentacion.create(req.body))));

// Si la presentación ya se usó, no se edita: devuelve la versión nueva (`nueva_version: true`) y la anterior vence (EX46).
router.put('/:id', EDITAR, manejar(async (req, res) => {
  const p = await Presentacion.editar(req.params.id, req.body);
  return p ? res.json(p) : res.status(404).json({ error: 'Presentación no encontrada.' });
}));

router.post('/:id/baja', EDITAR, manejar(async (req, res) =>
  (await Presentacion.darDeBaja(req.params.id)) ? res.json({ message: 'Presentación dada de baja.' }) : res.status(404).json({ error: 'Presentación no encontrada o ya dada de baja.' })));

module.exports = router;
