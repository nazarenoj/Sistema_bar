const { Router } = require('express');
const Alergenos = require('../stock/alergenoService');
const { requierePermiso } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');
const { auditar } = require('../utils/auditar');

// Alérgenos por receta y de una línea de venta (Stock RF22, RF39), con la función STK-ALERGENOS.
const router = Router();
const FUNCION = requiereFuncion('STK-ALERGENOS');
const VER = [FUNCION, requierePermiso('stock.movimientos.ver')];
const GESTIONAR = [FUNCION, requierePermiso('stock.alergenos.gestionar')];
const QUITAR = [FUNCION, requierePermiso('stock.alergenos.quitar')];

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Alergenos.AlergenoInvalido) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};
const tipoItem = (req) => (req.params.tipo === 'insumo' || req.params.tipo === 'producto' ? req.params.tipo : null);

router.get('/', ...VER, manejar(async (req, res) => res.json(await Alergenos.catalogo())));
router.post('/', ...GESTIONAR, manejar(async (req, res) => res.status(201).json(await Alergenos.crear(req.body))));
router.put('/:id/activo', ...GESTIONAR, manejar(async (req, res) => (await Alergenos.activar(Number(req.params.id), req.body.activo !== false)) ? res.json({ message: 'Actualizado.' }) : res.status(404).json({ error: 'Alérgeno no encontrado.' })));

// Lo declarado en un insumo o artículo: [{ alergeno_id, tipo: 'contiene' | 'trazas' }] (vacío = revisado, sin alérgenos).
router.put('/item/:tipo/:id', ...GESTIONAR, manejar(async (req, res) => {
  const tipo = tipoItem(req);
  if (!tipo) return res.status(400).json({ error: 'El tipo debe ser insumo o producto.' });
  res.json(await Alergenos.declarar({ tipo, id: Number(req.params.id) }, req.body.alergenos));
}));
router.get('/item/:tipo/:id', ...VER, manejar(async (req, res) => {
  const tipo = tipoItem(req);
  if (!tipo) return res.status(400).json({ error: 'El tipo debe ser insumo o producto.' });
  res.json(await Alergenos.declarados({ tipo, id: Number(req.params.id) }));
}));

router.get('/articulo/:id', ...VER, manejar(async (req, res) => res.json(await Alergenos.articulo(Number(req.params.id)))));
// Una línea de venta: { producto_id, opciones: [{ insumo_id }] }.
router.post('/linea', ...VER, manejar(async (req, res) => res.json(await Alergenos.linea(Number(req.body.producto_id), req.body.opciones ?? []))));

router.post('/articulo/:id/quitar', ...QUITAR, manejar(async (req, res) => {
  const r = await Alergenos.quitar(Number(req.params.id), Number(req.body.alergeno_id), req.body.motivo, req.usuario?.sub);
  await auditar(req, { modulo: 'stock', accion: 'alergeno_quitado', entidad: 'producto', entidad_id: String(req.params.id), detalle: `alérgeno ${req.body.alergeno_id}: ${req.body.motivo}` });
  res.json(r);
}));
router.delete('/articulo/:id/quitar/:alergenoId', ...QUITAR, manejar(async (req, res) => res.json({ restituido: await Alergenos.restituir(Number(req.params.id), Number(req.params.alergenoId)) })));

module.exports = router;
