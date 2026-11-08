const { Router } = require('express');
const Checkout = require('../ventas_online/checkoutService');
const Cuentas = require('../ventas_online/cuentaService');
const Tienda = require('../ventas_online/tiendaService');
const { limitePedidos } = require('../ventas_online/limites');

// Checkout y seguimiento del pedido en la parte pública (Ventas Online RF09). Se monta bajo /tienda/:codigo.
const router = Router({ mergeParams: true });
const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Tienda.TiendaInvalida) { const { status, ...extra } = err; return res.status(status ?? 400).json({ error: err.message, ...extra }); }
    next(err);
  }
};
const cuenta = async (req) => {
  const [esquema, token] = (req.headers.authorization ?? '').split(' ');
  return esquema === 'Bearer' && token ? Cuentas.verificar(token) : null;
};
// Un pedido solo lo ve quien lo hizo: su cuenta, o el invitado que conoce el correo con el que compró.
const localizar = async (req) => {
  const c = await cuenta(req);
  const [[p]] = await require('../config/db').query('SELECT id FROM onl_pedidos WHERE id_global = ?', [req.params.idGlobal]);
  const v = p ? await Checkout.obtener(p.id, { cuentaId: c?.id ?? null, email: req.query.email ?? req.body?.email ?? null }) : null;
  if (!v) throw Object.assign(new Tienda.TiendaInvalida('Pedido no encontrado.'), { status: 404, codigo: 'PEDIDO_NO_ENCONTRADO' });
  return v;
};

router.post('/checkout/resumen', manejar(async (req, res) => res.json(await Checkout.resumen(req.body?.carrito, req.body ?? {}, await cuenta(req)))));
router.post('/checkout', limitePedidos, manejar(async (req, res) => {
  const p = await Checkout.confirmar(req.body?.carrito, req.body ?? {}, await cuenta(req), { idSolicitud: req.get('X-ID-Solicitud') });
  res.status(p.repetido ? 200 : 201).json(p);
}));
router.get('/pedidos/:idGlobal', manejar(async (req, res) => res.json(await localizar(req))));
router.post('/pedidos/:idGlobal/renovar-reserva', manejar(async (req, res) => res.json(await Checkout.renovarReserva((await localizar(req)).id)))); 
router.post('/pedidos/:idGlobal/abandonar', manejar(async (req, res) => res.json(await Checkout.abandonar((await localizar(req)).id))));

module.exports = router;
