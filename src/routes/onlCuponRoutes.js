const { Router } = require('express');
const Cupones = require('../ventas_online/cuponService');
const Cuentas = require('../ventas_online/cuentaService');
const { TiendaInvalida } = require('../ventas_online/tiendaService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Cupones, envío gratis y cuentas de cliente, del lado administrativo (Ventas Online RF07, RF08).
const router = Router();
router.use(requiereModulo('ventas_online'));
const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof TiendaInvalida) return res.status(err.status ?? 400).json({ error: err.message, ...(err.codigo && { codigo: err.codigo }) });
    next(err);
  }
};
const GESTIONAR = requierePermiso('ventas_online.cupones.gestionar');

router.get('/cupones', requierePermiso('ventas_online.tienda.ver'), manejar(async (req, res) => res.json(await Cupones.listar())));
router.post('/cupones', GESTIONAR, manejar(async (req, res) => {
  const c = await Cupones.crear(req.body ?? {});
  await auditar(req, { modulo: 'ventas_online', accion: 'crear_cupon', entidad: 'onl_cupones', entidad_id: String(c.id), detalle: c.codigo });
  res.status(201).json(c);
}));
router.put('/cupones/:id', GESTIONAR, manejar(async (req, res) => {
  const c = await Cupones.editar(Number(req.params.id), req.body ?? {});
  await auditar(req, { modulo: 'ventas_online', accion: 'editar_cupon', entidad: 'onl_cupones', entidad_id: String(c.id), detalle: `${c.codigo} (${c.activo ? 'activo' : 'inactivo'})` });
  res.json(c);
}));
router.put('/envio-gratis', GESTIONAR, manejar(async (req, res) => {
  const r = await Cupones.fijarEnvioGratis(req.body?.minimo ?? null);
  await auditar(req, { modulo: 'ventas_online', accion: 'envio_gratis', entidad: 'onl_tienda', entidad_id: '1', detalle: String(r.envio_gratis_desde) });
  res.json(r);
}));
router.get('/clientes', requierePermiso('ventas_online.clientes.ver'), manejar(async (req, res) => res.json(await Cuentas.listar())));
router.put('/clientes/:id/vinculo', requierePermiso('ventas_online.clientes.vincular'), manejar(async (req, res) => {
  const c = await Cuentas.vincular(Number(req.params.id), req.body?.cliente_id ?? null);
  await auditar(req, { modulo: 'ventas_online', accion: 'vincular_cliente', entidad: 'onl_clientes', entidad_id: String(c.id), detalle: String(req.body?.cliente_id ?? 'sin vínculo') });
  res.json(c);
}));

module.exports = router;
