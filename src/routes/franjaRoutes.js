const { Router } = require('express');
const Franjas = require('../services/franjaService');
const { requierePermiso } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');
const { auditar } = require('../utils/auditar');

// Disponibilidad del menú por franja horaria (Ventas RF29), con la función VEN-FRANJA.
const router = Router();
const FUNCION = requiereFuncion('VEN-FRANJA');
const VER = [FUNCION, requierePermiso('ventas.catalogo.ver')];
const EDITAR = [FUNCION, requierePermiso('ventas.catalogo.editar')];

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Franjas.FranjaInvalida) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

router.get('/', ...VER, manejar(async (req, res) => res.json(await Franjas.listar())));
// Lo que el POS ofrece ahora.
router.get('/menu', ...VER, manejar(async (req, res) => res.json(await Franjas.menu())));
router.post('/', ...EDITAR, manejar(async (req, res) => {
  const f = await Franjas.crear(req.body);
  await auditar(req, { modulo: 'ventas', accion: 'franja_crear', entidad: 'franja_menu', entidad_id: String(f.id), detalle: f.nombre });
  res.status(201).json(f);
}));
router.delete('/:id', ...EDITAR, manejar(async (req, res) => (await Franjas.quitar(Number(req.params.id))) ? res.status(204).end() : res.status(404).json({ error: 'Franja no encontrada.' })));

module.exports = router;
