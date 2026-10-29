const { Router } = require('express');
const Precios = require('../services/precioService');
const { requierePermiso } = require('../middleware/requierePermiso');

const router = Router();
const PERMISO = requierePermiso('ventas.precios.actualizar');

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Precios.PreciosInvalidos) return res.status(400).json({ error: err.message, errores: err.errores, codigo: 'PRECIOS_INVALIDOS' });
    next(err);
  }
};
const actor = (req) => ({ id: req.usuario?.sub, username: req.usuario?.username, rol: req.usuario?.rol, ip: req.ip });

// Vista previa: lo que cambiaría, sin guardar nada. Cuerpo: tipo (porcentaje | monto | importacion), valor,
// filtro { categoria_id, productos: [ids] }; o, para importacion, items [{ sku | producto_id, precio }] o csv "sku,precio".
router.post('/vista-previa', PERMISO, manejar(async (req, res) => res.json({ cambios: await Precios.calcular(req.body) })));

// Confirma. Con `vigencia_desde` queda programada; si no, se aplica ya.
router.post('/actualizaciones', PERMISO, manejar(async (req, res) =>
  res.status(201).json(await Precios.crear(req.body, { userId: req.usuario?.sub, actor: actor(req) }))));

router.get('/actualizaciones', requierePermiso('ventas.catalogo.ver'), manejar(async (req, res) => res.json(await Precios.listar())));

router.get('/actualizaciones/:idGlobal', requierePermiso('ventas.catalogo.ver'), manejar(async (req, res) => {
  const a = await Precios.obtener(req.params.idGlobal);
  return a ? res.json(a) : res.status(404).json({ error: 'Actualización no encontrada.' });
}));

router.post('/actualizaciones/:idGlobal/revertir', PERMISO, manejar(async (req, res) => {
  const r = await Precios.revertir(req.params.idGlobal, req.body.motivo, actor(req));
  return r ? res.json(r) : res.status(404).json({ error: 'Actualización no encontrada.' });
}));

router.post('/actualizaciones/:idGlobal/cancelar', PERMISO, manejar(async (req, res) =>
  (await Precios.cancelar(req.params.idGlobal, actor(req))) ? res.json({ message: 'Actualización cancelada.' }) : res.status(409).json({ error: 'Solo se cancela una actualización programada.' })));

module.exports = router;
