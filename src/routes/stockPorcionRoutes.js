const { Router } = require('express');
const pool = require('../config/db');
const Porciones = require('../stock/porcionService');
const { requierePermiso } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');
const { auditar } = require('../utils/auditar');

// Venta por porción, fraccionamiento, envases por modalidad, insumos por modificador y agotados (Stock RF30, RF31, RF32, RF38).
const router = Router();
const CONFIGURAR = requierePermiso('stock.insumos.editar');
const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Porciones.PorcionInvalida) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

router.put('/porciones/:productoId', CONFIGURAR, manejar(async (req, res) => res.json(await Porciones.configurar(Number(req.params.productoId), req.body))));
router.delete('/porciones/:productoId', CONFIGURAR, manejar(async (req, res) => (await Porciones.quitar(Number(req.params.productoId))) ? res.status(204).end() : res.status(404).json({ error: 'No estaba configurado.' })));
router.post('/porciones/:productoId/ingresos', requierePermiso('stock.movimientos.registrar'), manejar(async (req, res) => res.status(201).json(await Porciones.ingresarPiezas(Number(req.params.productoId), req.body, { userId: req.usuario?.sub }))));
router.post('/porciones/:productoId/fraccionar', requiereFuncion('STK-PRODUCCION'), requierePermiso('stock.produccion.gestionar'), manejar(async (req, res) => {
  const f = await Porciones.fraccionar({ ...req.body, producto_id: Number(req.params.productoId) }, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'stock', accion: 'fraccionar', entidad: 'producto', entidad_id: String(f.producto_id), detalle: `${f.piezas} piezas en ${f.porciones} porciones` });
  res.status(201).json(f);
}));

router.get('/envases', requierePermiso('stock.movimientos.ver'), manejar(async (req, res) => res.json(await Porciones.envases())));
router.put('/envases', CONFIGURAR, manejar(async (req, res) => res.json(await Porciones.fijarEnvase(req.body))));
router.delete('/envases/:id', CONFIGURAR, manejar(async (req, res) => (await Porciones.quitarEnvase(Number(req.params.id))) ? res.status(204).end() : res.status(404).json({ error: 'No existe.' })));

router.get('/modificadores/:opcionId', requiereFuncion('VEN-MODIF'), requierePermiso('stock.movimientos.ver'), manejar(async (req, res) => res.json(await Porciones.modificador(req.params.opcionId))));
router.put('/modificadores/:opcionId', requiereFuncion('VEN-MODIF'), CONFIGURAR, manejar(async (req, res) => res.json(await Porciones.fijarModificador(req.params.opcionId, req.body.lineas))));

router.get('/agotados', requiereFuncion('VEN-KDS'), requierePermiso('stock.movimientos.ver'), manejar(async (req, res) =>
  res.json((await pool.query('SELECT a.producto_id, p.nombre, a.desde FROM item_agotado a JOIN productos p ON p.id = a.producto_id ORDER BY p.nombre'))[0])));

module.exports = router;
