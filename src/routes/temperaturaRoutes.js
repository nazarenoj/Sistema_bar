const { Router } = require('express');
const Temp = require('../stock/temperaturaService');
const { requierePermiso } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');
const { auditar } = require('../utils/auditar');

// Temperaturas y controles de inocuidad (Stock RF25), con la función STK-TEMP.
const router = Router();
const FUNCION = requiereFuncion('STK-TEMP');
const VER = [FUNCION, requierePermiso('stock.movimientos.ver')];
const REGISTRAR = [FUNCION, requierePermiso('stock.temperaturas.registrar')];
const CONFIGURAR = [FUNCION, requierePermiso('stock.temperaturas.configurar')];
const id = (req) => Number(req.params.id);

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Temp.TemperaturaInvalida) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

router.post('/puntos', ...CONFIGURAR, manejar(async (req, res) => res.status(201).json(await Temp.crearPunto(req.body))));
router.get('/puntos', ...VER, manejar(async (req, res) => res.json(await Temp.listarPuntos())));
router.put('/puntos/:id', ...CONFIGURAR, manejar(async (req, res) => res.json(await Temp.modificarPunto(id(req), req.body))));

// Lectura: { valor, origen: 'terminal' | 'app' }. Fuera de rango queda pendiente de acción correctiva.
router.post('/puntos/:id/registros', ...REGISTRAR, manejar(async (req, res) => res.status(201).json(await Temp.registrar(id(req), req.body.valor, { userId: req.usuario?.sub, origen: req.body.origen }))));
router.get('/registros', ...VER, manejar(async (req, res) => res.json(await Temp.registros({ ...req.query, punto_id: req.query.punto_id ? Number(req.query.punto_id) : undefined }))));
router.post('/registros/:id/accion', ...REGISTRAR, manejar(async (req, res) => {
  const r = await Temp.accionCorrectiva(id(req), req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'stock', accion: 'temperatura_accion_correctiva', entidad: 'registro_temperatura', entidad_id: r.id_global, detalle: `${req.body.tipo}: ${req.body.detalle}` });
  res.json(r);
}));

router.post('/listas', ...CONFIGURAR, manejar(async (req, res) => res.status(201).json(await Temp.crearLista(req.body))));
router.get('/listas', ...VER, manejar(async (req, res) => res.json(await Temp.listas())));
router.post('/listas/:id/verificaciones', ...REGISTRAR, manejar(async (req, res) => res.status(201).json(await Temp.verificar(id(req), req.body.respuestas, { userId: req.usuario?.sub, origen: req.body.origen }))));

module.exports = router;
