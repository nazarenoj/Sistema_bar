const { Router } = require('express');
const Cancelaciones = require('../ventas_online/cancelacionService');
const { TiendaInvalida } = require('../ventas_online/tiendaService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Cancelaciones, devoluciones y arrepentimiento del lado administrativo (Ventas Online RF15).
const router = Router();
router.use(requiereModulo('ventas_online'));
const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof TiendaInvalida) { const { status, ...extra } = err; return res.status(status ?? 400).json({ error: err.message, ...extra }); }
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message, ...(err.codigo && { codigo: err.codigo }) });
    next(err);
  }
};

router.post('/pedidos/:id/cancelar', requierePermiso('ventas_online.pedidos.cancelar'), manejar(async (req, res) => {
  const r = await Cancelaciones.cancelar(Number(req.params.id), { motivo: req.body?.motivo, userId: req.usuario.sub });
  await auditar(req, { modulo: 'ventas_online', accion: 'cancelar_pedido', entidad: 'onl_pedidos', entidad_id: req.params.id, detalle: String(req.body?.motivo) });
  res.json(r);
}));
router.post('/pedidos/:id/devolucion', requierePermiso('ventas_online.pedidos.devolver'), manejar(async (req, res) => {
  const r = await Cancelaciones.devolver(Number(req.params.id), { ...(req.body ?? {}), userId: req.usuario.sub });
  await auditar(req, { modulo: 'ventas_online', accion: 'devolver_pedido', entidad: 'onl_pedidos', entidad_id: req.params.id, detalle: `${r.devolucion_tipo} ${r.total_devuelto}: ${req.body?.motivo}` });
  res.status(201).json(r);
}));
router.get('/pedidos/:id/devoluciones', requierePermiso('ventas_online.pedidos.ver'), manejar(async (req, res) => res.json(await Cancelaciones.listar(Number(req.params.id)))));
router.post('/devoluciones/reintentar', requierePermiso('ventas_online.pedidos.devolver'), manejar(async (req, res) => res.json(await Cancelaciones.reintentarPendientes())));
router.get('/arrepentimientos', requierePermiso('ventas_online.pedidos.ver'), manejar(async (req, res) => res.json(await Cancelaciones.arrepentimientos())));

module.exports = router;
