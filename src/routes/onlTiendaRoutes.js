const { Router } = require('express');
const Tienda = require('../ventas_online/tiendaService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Administración de la tienda (Ventas Online RF01).
const router = Router();
router.use(requiereModulo('ventas_online'));

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Tienda.TiendaInvalida) return res.status(err.status ?? 400).json({ error: err.message, ...(err.codigo && { codigo: err.codigo }) });
    next(err);
  }
};

router.get('/tienda', requierePermiso('ventas_online.tienda.ver'), manejar(async (req, res) => res.json(await Tienda.config())));
router.put('/tienda', requierePermiso('ventas_online.tienda.configurar'), manejar(async (req, res) => {
  const t = await Tienda.actualizar(req.body ?? {});
  await auditar(req, { modulo: 'ventas_online', accion: 'configurar_tienda', entidad: 'onl_tienda', entidad_id: '1', detalle: `${t.codigo ?? 'sin código'} (${t.activa ? 'activa' : 'inactiva'})` });
  res.json(t);
}));
router.get('/paginas', requierePermiso('ventas_online.tienda.ver'), manejar(async (req, res) => res.json(await Tienda.paginas())));
router.put('/paginas/:slug', requierePermiso('ventas_online.tienda.configurar'), manejar(async (req, res) => {
  const p = await Tienda.guardarPagina(req.params.slug, req.body ?? {});
  await auditar(req, { modulo: 'ventas_online', accion: 'editar_pagina', entidad: 'onl_paginas', entidad_id: p.slug, detalle: p.titulo });
  res.json(p);
}));

module.exports = router;
