const { Router } = require('express');
const Alergenos = require('../services/alergenoVentaService');
const { requierePermiso } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');
const { auditar } = require('../utils/auditar');

// Alérgenos en Ventas (RF31), con la función VEN-ALERGENOS: la lista de la instancia, lo declarado en cada artículo y en cada opción de
// modificador, y el menú del POS filtrado por alérgeno.
const router = Router();
const FUNCION = requiereFuncion('VEN-ALERGENOS');
const VER = [FUNCION, requierePermiso('ventas.catalogo.ver')];
const EDITAR = [FUNCION, requierePermiso('ventas.catalogo.editar')];

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Alergenos.AlergenoVentaInvalido) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

router.get('/', ...VER, manejar(async (req, res) => res.json(await Alergenos.catalogo())));
router.post('/', ...EDITAR, manejar(async (req, res) => res.status(201).json(await Alergenos.crear(req.body))));
router.put('/:id/activo', ...EDITAR, manejar(async (req, res) => res.json(await Alergenos.activar(Number(req.params.id), !!req.body.activo))));

// Menú del POS: ?excluir=gluten,lacteos deja solo los artículos sin esos alérgenos.
router.get('/menu', ...VER, manejar(async (req, res) => res.json(await Alergenos.menu({ excluir: String(req.query.excluir ?? '').split(',').map((s) => s.trim()).filter(Boolean) }))));

// Alérgenos de un artículo (con los derivados de Stock si están) y su declaración manual.
router.get('/articulos/:productoId', ...VER, manejar(async (req, res) => res.json(await Alergenos.calcularLinea(require('../config/db'), Number(req.params.productoId), []))));
router.put('/articulos/:productoId', ...EDITAR, manejar(async (req, res) => {
  const r = await Alergenos.declararArticulo(Number(req.params.productoId), req.body.alergenos);
  await auditar(req, { modulo: 'ventas', accion: 'alergenos_articulo', entidad: 'producto', entidad_id: req.params.productoId, detalle: r.map((a) => a.codigo).join(',') || 'sin alérgenos' });
  res.json(r);
}));
router.put('/opciones/:opcionId', ...EDITAR, manejar(async (req, res) => res.json(await Alergenos.declararOpcion(Number(req.params.opcionId), req.body.alergenos))));

module.exports = router;
