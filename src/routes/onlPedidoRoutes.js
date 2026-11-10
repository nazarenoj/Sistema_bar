const { Router } = require('express');
const Gestion = require('../ventas_online/gestionService');
const Envios = require('../ventas_online/envioService');
const { TiendaInvalida } = require('../ventas_online/tiendaService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Panel de pedidos de la tienda (Ventas Online RF12): listado y detalle, estados, lista de preparación y sincronía con cocina y barra.
const router = Router();
router.use(requiereModulo('ventas_online'));
const VER = requierePermiso('ventas_online.pedidos.ver'), GESTIONAR = requierePermiso('ventas_online.pedidos.gestionar');
const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof TiendaInvalida) { const { status, ...extra } = err; return res.status(status ?? 400).json({ error: err.message, ...extra }); }
    next(err);
  }
};

router.get('/pedidos', VER, manejar(async (req, res) => { await Gestion.sincronizarCocina().catch(() => {}); res.json(await Gestion.listar(req.query)); }));
router.get('/preparacion', VER, manejar(async (req, res) => res.json(await Gestion.preparacion())));
router.post('/pedidos/sincronizar-cocina', GESTIONAR, manejar(async (req, res) => res.json(await Gestion.sincronizarCocina())));
router.post('/pedidos/entregar-pendientes', GESTIONAR, manejar(async (req, res) => res.json(await Gestion.entregarPendientes())));
// Autorizar la reserva de un pedido que superó el tope sin pago (RN56): un supervisor, con motivo.
router.post('/pedidos/:id/autorizar-reserva', requierePermiso('ventas_online.pedidos.autorizar_reserva'), manejar(async (req, res) => {
  const p = await require('../ventas_online/checkoutService').autorizarReserva(Number(req.params.id), { motivo: req.body?.motivo, userId: req.usuario.sub });
  await auditar(req, { modulo: 'ventas_online', accion: 'autorizar_reserva', entidad: 'onl_pedidos', entidad_id: req.params.id, detalle: req.body.motivo });
  res.json(p);
}));
router.get('/pedidos/:id', VER, manejar(async (req, res) => { await Gestion.sincronizarCocina().catch(() => {}); res.json(await Gestion.detalle(Number(req.params.id))); }));
router.post('/pedidos/:id/estado', GESTIONAR, manejar(async (req, res) => {
  const p = await Gestion.cambiarEstado(Number(req.params.id), req.body?.estado, { userId: req.usuario.sub, motivo: req.body?.motivo });
  await auditar(req, { modulo: 'ventas_online', accion: 'estado_pedido', entidad: 'onl_pedidos', entidad_id: req.params.id, detalle: p.estado });
  res.json(p);
}));
router.post('/pedidos/:id/con-faltante', GESTIONAR, manejar(async (req, res) => {
  const p = await Gestion.marcarConFaltante(Number(req.params.id), { motivo: req.body?.motivo, userId: req.usuario.sub });
  await auditar(req, { modulo: 'ventas_online', accion: 'pedido_con_faltante', entidad: 'onl_pedidos', entidad_id: req.params.id, detalle: String(req.body?.motivo) });
  res.json(p);
}));
router.post('/pedidos/:id/entregar-a-ventas', GESTIONAR, manejar(async (req, res) => res.json(await Gestion.entregarAVentas(Number(req.params.id)))));
// El delivery se despacha con permiso propio y solo con el pago acreditado (RF11, RN37).
router.post('/pedidos/:id/despachar', requierePermiso('ventas_online.envios.despachar'), manejar(async (req, res) => {
  await Envios.verificarDespacho(Number(req.params.id));
  const p = await Gestion.cambiarEstado(Number(req.params.id), 'despachado', { userId: req.usuario.sub, motivo: 'Salió el delivery' });
  await auditar(req, { modulo: 'ventas_online', accion: 'despachar_pedido', entidad: 'onl_pedidos', entidad_id: req.params.id, detalle: 'delivery propio' });
  res.json({ id: p.id, estado: p.estado });
}));

module.exports = router;
