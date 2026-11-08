const { Router } = require('express');
const Envios = require('../ventas_online/envioService');
const { TiendaInvalida } = require('../ventas_online/tiendaService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Zonas de delivery, capacidad por franja, preparación y despacho (Ventas Online RF11, RF26).
const router = Router();
router.use(requiereModulo('ventas_online'));
const CONFIGURAR = requierePermiso('ventas_online.envios.configurar');
const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof TiendaInvalida) { const { status, ...extra } = err; return res.status(status ?? 400).json({ error: err.message, ...extra }); }
    next(err);
  }
};

router.get('/zonas', requierePermiso('ventas_online.tienda.ver'), manejar(async (req, res) => res.json(await Envios.zonas())));
router.post('/zonas', CONFIGURAR, manejar(async (req, res) => {
  const z = await Envios.guardarZona(null, req.body ?? {});
  await auditar(req, { modulo: 'ventas_online', accion: 'crear_zona', entidad: 'onl_zonas', entidad_id: String(z.id), detalle: z.nombre });
  res.status(201).json(z);
}));
router.put('/zonas/:id', CONFIGURAR, manejar(async (req, res) => {
  const z = await Envios.guardarZona(Number(req.params.id), req.body ?? {});
  await auditar(req, { modulo: 'ventas_online', accion: 'editar_zona', entidad: 'onl_zonas', entidad_id: String(z.id), detalle: z.nombre });
  res.json(z);
}));
router.put('/envios/configuracion', CONFIGURAR, manejar(async (req, res) => {
  const c = await Envios.configurar(req.body ?? {});
  await auditar(req, { modulo: 'ventas_online', accion: 'configurar_envios', entidad: 'onl_tienda', entidad_id: '1', detalle: JSON.stringify(c) });
  res.json(c);
}));
router.put('/catalogo/:id/preparacion', CONFIGURAR, manejar(async (req, res) => res.json(await Envios.fijarPreparacion(Number(req.params.id), req.body?.prep_min))));

module.exports = router;
