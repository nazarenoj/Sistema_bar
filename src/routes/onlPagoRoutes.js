const { Router } = require('express');
const Pagos = require('../ventas_online/pagoService');
const Reintegros = require('../ventas_online/reintegroService');
const Pasarela = require('../ventas_online/pasarelaMP');
const { TiendaInvalida } = require('../ventas_online/tiendaService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Pagos, reintegros y configuración de la pasarela del lado administrativo (Ventas Online RF10, RF15).
const router = Router();
router.use(requiereModulo('ventas_online'));
const GESTIONAR = requierePermiso('ventas_online.pagos.gestionar');
const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof TiendaInvalida) { const { status, ...extra } = err; return res.status(status ?? 400).json({ error: err.message, ...extra }); }
    next(err);
  }
};

router.get('/pasarela', requierePermiso('ventas_online.pagos.configurar'), manejar(async (req, res) => res.json({ proveedor: Pasarela.proveedor().nombre, ...(await Pagos.estadoConfig()) })));
router.put('/pasarela', requierePermiso('ventas_online.pagos.configurar'), manejar(async (req, res) => {
  const r = await Pagos.configurar(req.body ?? {});
  await auditar(req, { modulo: 'ventas_online', accion: 'configurar_pasarela', entidad: 'onl_tienda', entidad_id: '1', detalle: 'credenciales actualizadas' });
  res.json(r);
}));
router.get('/pedidos/:id/pagos', requierePermiso('ventas_online.pedidos.ver'), manejar(async (req, res) => res.json({ pagos: await Pagos.pagosDe(Number(req.params.id)), reintegros: await Reintegros.listar({ pedidoId: Number(req.params.id) }) })));
router.post('/pedidos/:id/confirmar-transferencia', GESTIONAR, manejar(async (req, res) => {
  const r = await Pagos.confirmarTransferencia(Number(req.params.id), { referencia: req.body?.referencia, userId: req.usuario.sub });
  await auditar(req, { modulo: 'ventas_online', accion: 'confirmar_transferencia', entidad: 'onl_pedidos', entidad_id: req.params.id, detalle: String(req.body?.referencia) });
  res.json(r);
}));
router.post('/pedidos/:id/aceptar', GESTIONAR, manejar(async (req, res) => {
  const r = await Pagos.aceptarPedido(Number(req.params.id), { userId: req.usuario.sub });
  await auditar(req, { modulo: 'ventas_online', accion: 'aceptar_pedido', entidad: 'onl_pedidos', entidad_id: req.params.id, detalle: r.estado });
  res.json(r);
}));
router.post('/pagos/consultar-pendientes', GESTIONAR, manejar(async (req, res) => res.json(await Pagos.consultarPendientes())));

router.get('/reintegros', requierePermiso('ventas_online.pedidos.ver'), manejar(async (req, res) => res.json(await Reintegros.listar({ estado: req.query.estado }))));
router.post('/reintegros/reintentar', GESTIONAR, manejar(async (req, res) => res.json(await Reintegros.reintentarPendientes())));
router.post('/reintegros/:id/manual', requierePermiso('ventas_online.reintegros.manual'), manejar(async (req, res) => {
  const r = await Reintegros.resolverManual(Number(req.params.id), { medio: req.body?.medio, userId: req.usuario.sub });
  await auditar(req, { modulo: 'ventas_online', accion: 'reintegro_manual', entidad: 'onl_reintegros', entidad_id: req.params.id, detalle: r.medio_manual });
  res.json(r);
}));

module.exports = router;
