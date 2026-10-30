const { Router } = require('express');
const Produccion = require('../stock/produccionService');
const { TomaBloqueada } = require('../stock/tomaAlcance');
const { LoteInvalido } = require('../stock/loteService');
const { MovimientoInvalido } = require('../stock/movimientoService');
const { RecetaInvalida } = require('../stock/recetaService');
const { requierePermiso } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');
const { auditar } = require('../utils/auditar');

// Órdenes de producción, ficha técnica e informe de rendimiento (Stock RF10, RF11, RF23, RF24), con la función STK-PRODUCCION.
const router = Router();
const GESTIONAR = [requiereFuncion('STK-PRODUCCION'), requierePermiso('stock.produccion.gestionar')];
const id = (req) => Number(req.params.id);

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof TomaBloqueada) return res.status(err.status).json({ error: err.message, codigo: err.detalle?.codigo ?? 'TOMA_BLOQUEADA', detalle: err.detalle });
    if ([Produccion.ProduccionInvalida, LoteInvalido, MovimientoInvalido, RecetaInvalida].some((c) => err instanceof c)) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};
const noEncontrada = (res) => res.status(404).json({ error: 'Orden no encontrada.' });

router.post('/ordenes', ...GESTIONAR, manejar(async (req, res) => {
  const o = await Produccion.crear(req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'stock', accion: 'orden_produccion_creada', entidad: 'orden_produccion', entidad_id: o.id_global });
  res.status(201).json(o);
}));
router.get('/ordenes', ...GESTIONAR, manejar(async (req, res) => res.json(await Produccion.listar({ estado: req.query.estado }))));
router.get('/ordenes/:id', ...GESTIONAR, manejar(async (req, res) => { const o = await Produccion.obtener(id(req)); return o ? res.json(o) : noEncontrada(res); }));
router.put('/ordenes/:id/consumos', ...GESTIONAR, manejar(async (req, res) => res.json(await Produccion.ajustar(id(req), req.body.consumos))));
router.post('/ordenes/:id/confirmar', ...GESTIONAR, manejar(async (req, res) => {
  const o = await Produccion.confirmar(id(req), req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'stock', accion: 'orden_produccion_confirmada', entidad: 'orden_produccion', entidad_id: o.id_global });
  res.json(o);
}));
router.post('/ordenes/:id/cancelar', ...GESTIONAR, manejar(async (req, res) => (await Produccion.cancelar(id(req))) ? res.json({ message: 'Orden cancelada.' }) : res.status(409).json({ error: 'Solo se cancela una orden en borrador.' })));

router.get('/informe', ...GESTIONAR, manejar(async (req, res) => res.json(await Produccion.informe(req.query))));
router.get('/ficha/:productoId', ...GESTIONAR, manejar(async (req, res) => { const f = await Produccion.fichaTecnica(Number(req.params.productoId)); return f ? res.json(f) : res.status(404).json({ error: 'Producto no encontrado.' }); }));
router.put('/ficha/:productoId', ...GESTIONAR, manejar(async (req, res) => res.json(await Produccion.configurar(Number(req.params.productoId), req.body))));

module.exports = router;
