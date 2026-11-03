const { Router } = require('express');
const Movil = require('../services/movilService');
const { requierePermiso, permisosDe } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');

// Toma de pedidos desde el dispositivo del mozo (Ventas RF39), con la función VEN-MOVIL. El dispositivo es una terminal registrada como
// "dispositivo móvil"; el mozo entra con su usuario y la terminal. El dispositivo no guarda operaciones sin conexión (RN66).
const router = Router();
const FUNCION = requiereFuncion('VEN-MOVIL');

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Movil.OperacionInvalida) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

// Una operación. Aplicada o rechazada responde 200 con el estado; lo rechazado trae el estado actual para mostrarlo como "NO aplicado".
router.post('/operaciones', FUNCION, requierePermiso('ventas.pedidos.operar'), manejar(async (req, res) => res.json(await Movil.aplicar(req, req.body))));
// El dispositivo consulta por su ID_Operacion antes de reenviar lo que mandó cuando se cortó la conexión.
router.get('/operaciones/:id', FUNCION, requierePermiso('ventas.pedidos.operar'), manejar(async (req, res) => res.json(await Movil.estadoDe(req.params.id))));
router.get('/conflictos', FUNCION, requierePermiso('ventas.pedidos.operar'), manejar(async (req, res) => {
  const { niveles } = await permisosDe(req);
  res.json(await Movil.conflictos(req.usuario.sub, { todos: niveles['ventas.movil.supervisar'] === 'permitido' }));
}));
router.post('/latido', FUNCION, manejar(async (req, res) => res.json(await Movil.latido(req.usuario?.terminal_id))));

module.exports = router;
