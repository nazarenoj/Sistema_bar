const { Router } = require('express');
const Cocina = require('../services/cocinaService');
const { requierePermiso } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');

// Pantalla de cocina y barra (Ventas RF38), con la función VEN-KDS.
const router = Router();
const FUNCION = requiereFuncion('VEN-KDS');
const OPERAR = [FUNCION, requierePermiso('ventas.pedidos.operar')];
const actor = (req) => ({ id: req.usuario?.sub });

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Cocina.CocinaInvalida) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

// Lo que muestra la pantalla: ?sector_id=N|sin y ?avance=. Se puede consultar las veces que haga falta: al volver la pantalla muestra las pendientes sin duplicar (EX25).
router.get('/comandas', ...OPERAR, manejar(async (req, res) => res.json(await Cocina.comandas({ sector_id: req.query.sector_id, avance: req.query.avance }))));
router.post('/comandas/:id/avanzar', ...OPERAR, manejar(async (req, res) => res.json(await Cocina.avanzar(Number(req.params.id), { userId: actor(req).id }))));
router.post('/comandas/:id/retroceder', FUNCION, requierePermiso('ventas.cocina.retroceder'), manejar(async (req, res) => res.json(await Cocina.retroceder(Number(req.params.id), req.body.motivo, { userId: actor(req).id }, req))));
router.get('/tiempos', ...OPERAR, manejar(async (req, res) => res.json(await Cocina.tiempos(req.query))));

// Latido de la pantalla y estado de las pantallas (conectada o no).
router.post('/latido', FUNCION, manejar(async (req, res) => res.json(await Cocina.latido(req.usuario?.terminal_id))));
router.get('/pantallas', ...OPERAR, manejar(async (req, res) => res.json(await Cocina.pantallas())));

// Agotado manual (un usuario con permiso lo marca y lo quita) y configuración de la demora y del modo de venta de agotados.
router.put('/agotados/:productoId', FUNCION, requierePermiso('ventas.agotados.marcar'), manejar(async (req, res) => res.json(await Cocina.marcarAgotado(Number(req.params.productoId), req.body.agotado !== false, req))));
router.put('/configuracion', FUNCION, requierePermiso('ventas.catalogo.editar'), manejar(async (req, res) => res.json(await Cocina.configurar(req.body))));

module.exports = router;
