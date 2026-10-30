const { Router } = require('express');
const Etiquetas = require('../stock/etiquetaService');
const { requierePermiso } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');
const { auditar } = require('../utils/auditar');

// Etiquetas y etiqueta propia de peso (Stock RF27, RN82), con la función STK-ETIQUETAS.
const router = Router();
const FUNCION = requiereFuncion('STK-ETIQUETAS');
const VER = [FUNCION, requierePermiso('stock.movimientos.ver')];
const GESTIONAR = [FUNCION, requierePermiso('stock.etiquetas.gestionar')];
const uid = (req) => ({ userId: req.usuario?.sub });

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Etiquetas.EtiquetaInvalida) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

// Ventas lee la etiqueta de la balanza y la valida acá (EX59): { valida, producto_id, peso } o { valida: false, motivo }.
router.get('/validar/:codigo', ...VER, manejar(async (req, res) => res.json(await Etiquetas.validar(req.params.codigo))));

router.put('/prefijo', ...GESTIONAR, manejar(async (req, res) => {
  const r = await Etiquetas.configurarPrefijo(req.body.prefijo);
  await auditar(req, { modulo: 'stock', accion: 'etiqueta_prefijo', entidad: 'parametro', entidad_id: 'etiqueta_prefijo', detalle: r.prefijo });
  res.json(r);
}));
router.put('/articulos/:id/codigo', ...GESTIONAR, manejar(async (req, res) => res.json(await Etiquetas.asignarCodigo(Number(req.params.id), req.body.codigo))));
router.post('/articulos/:id/peso', ...GESTIONAR, manejar(async (req, res) => res.status(201).json(await Etiquetas.generarPeso(Number(req.params.id), req.body.peso, uid(req)))));
router.get('/articulos/:id/interno', ...VER, manejar(async (req, res) => res.json(await Etiquetas.generarInterno(Number(req.params.id)))));

router.get('/plantillas', ...VER, manejar(async (req, res) => res.json(await Etiquetas.plantillas())));
router.put('/plantillas', ...GESTIONAR, manejar(async (req, res) => res.json(await Etiquetas.guardarPlantilla(req.body))));

router.post('/articulos/:id/gondola', ...GESTIONAR, manejar(async (req, res) => res.status(201).json(await Etiquetas.gondola(Number(req.params.id), req.body, uid(req)))));
router.post('/articulos/:id/elaborado', ...GESTIONAR, manejar(async (req, res) => res.status(201).json(await Etiquetas.elaborado(Number(req.params.id), req.body, uid(req)))));
router.get('/desactualizadas', ...VER, manejar(async (req, res) => res.json(await Etiquetas.desactualizadas())));

module.exports = router;
