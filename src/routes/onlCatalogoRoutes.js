const { Router } = require('express');
const Catalogo = require('../ventas_online/catalogoService');
const { TiendaInvalida } = require('../ventas_online/tiendaService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Publicación del catálogo y disponibilidad (Ventas Online RF02 a RF04).
const router = Router();
router.use(requiereModulo('ventas_online'));
const VER = requierePermiso('ventas_online.catalogo.ver'), GESTIONAR = requierePermiso('ventas_online.catalogo.gestionar');
const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof TiendaInvalida) return res.status(err.status ?? 400).json({ error: err.message, ...(err.codigo && { codigo: err.codigo }) });
    next(err);
  }
};

router.get('/catalogo', VER, manejar(async (req, res) => res.json(await Catalogo.administrar())));
router.put('/catalogo/:id', GESTIONAR, manejar(async (req, res) => {
  const r = await Catalogo.publicar(Number(req.params.id), req.body ?? {});
  await auditar(req, { modulo: 'ventas_online', accion: 'publicar_articulo', entidad: 'producto', entidad_id: String(r.producto_id), detalle: r.titulo ?? r.nombre });
  res.json(r);
}));
router.delete('/catalogo/:id', GESTIONAR, manejar(async (req, res) => {
  const r = await Catalogo.despublicar(Number(req.params.id));
  await auditar(req, { modulo: 'ventas_online', accion: 'despublicar_articulo', entidad: 'producto', entidad_id: String(r.producto_id), detalle: 'despublicado' });
  res.json(r);
}));
router.put('/catalogo/:id/disponibilidad', GESTIONAR, manejar(async (req, res) => {
  const r = await Catalogo.fijarDisponibilidad(Number(req.params.id), req.body ?? {});
  await auditar(req, { modulo: 'ventas_online', accion: 'disponibilidad_manual', entidad: 'producto', entidad_id: req.params.id, detalle: JSON.stringify(req.body ?? {}) });
  res.json(r);
}));
router.get('/precios/ajustes', VER, manejar(async (req, res) => res.json(await Catalogo.ajustes())));
router.put('/precios/ajustes', GESTIONAR, manejar(async (req, res) => {
  const r = await Catalogo.fijarAjustes(req.body ?? {});
  await auditar(req, { modulo: 'ventas_online', accion: 'ajustar_precios_online', entidad: 'onl_tienda', entidad_id: '1', detalle: JSON.stringify(r) });
  res.json(r);
}));
router.post('/sincronizar', GESTIONAR, manejar(async (req, res) => res.json(await Catalogo.sincronizar())));
router.get('/sincronizacion', VER, manejar(async (req, res) => res.json(await Catalogo.estadoSync())));

module.exports = router;
