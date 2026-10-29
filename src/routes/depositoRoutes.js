const { Router } = require('express');
const Deposito = require('../models/depositoModel');
const { requierePermiso } = require('../middleware/requierePermiso');

// Depósitos (Stock RF03) y de cuál descuenta cada sector de comanda.
const router = Router();
const VER = requierePermiso('stock.insumos.ver');
const EDITAR = requierePermiso('stock.insumos.editar');
const manejar = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (err) { if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya existe un depósito con ese nombre.' }); next(err); } };
const nombreOk = (b) => typeof b.nombre === 'string' && b.nombre.trim() !== '';

router.get('/', VER, manejar(async (req, res) => res.json(await Deposito.getAll())));

// Sectores de comanda y su depósito (sin asignar = el predeterminado). Va antes de /:id.
router.get('/sectores', VER, manejar(async (req, res) => res.json(await Deposito.sectores())));
router.put('/sectores/:sectorId', EDITAR, manejar(async (req, res) => {
  const sector = Number(req.params.sectorId);
  if (req.body.deposito_id === null) return res.json({ sector_id: sector, quitado: await Deposito.quitarSector(sector) });
  const d = await Deposito.getById(req.body.deposito_id);
  if (!d || !d.activo) return res.status(400).json({ error: 'El depósito no existe o está inactivo.' });
  await Deposito.asignarSector(sector, d.id);
  res.json({ sector_id: sector, deposito_id: d.id });
}));

router.post('/', EDITAR, manejar(async (req, res) => {
  if (!nombreOk(req.body)) return res.status(400).json({ error: 'El campo "nombre" es obligatorio.' });
  res.status(201).json(await Deposito.create(req.body.nombre.trim()));
}));

router.put('/:id', EDITAR, manejar(async (req, res) => {
  if (!nombreOk(req.body)) return res.status(400).json({ error: 'El campo "nombre" es obligatorio.' });
  const d = await Deposito.getById(req.params.id);
  if (!d) return res.status(404).json({ error: 'Depósito no encontrado.' });
  if (d.predeterminado && req.body.activo === false) return res.status(409).json({ error: 'El depósito predeterminado no se puede desactivar: elegí otro como predeterminado primero.' });
  res.json(await Deposito.update(d.id, { nombre: req.body.nombre.trim(), activo: req.body.activo }));
}));

router.post('/:id/predeterminado', EDITAR, manejar(async (req, res) => {
  const d = await Deposito.setPredeterminado(req.params.id);
  return d ? res.json(d) : res.status(404).json({ error: 'Depósito no encontrado o inactivo.' });
}));

module.exports = router;
