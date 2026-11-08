const { Router } = require('express');
const Carrito = require('../ventas_online/carritoService');
const Cuentas = require('../ventas_online/cuentaService');
const { TiendaInvalida } = require('../ventas_online/tiendaService');

// Carrito y cuentas de la parte pública (Ventas Online RF06, RF08). Se monta bajo /tienda/:codigo, ya dentro de la instancia de la tienda.
const router = Router({ mergeParams: true });

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof TiendaInvalida) { const { status, ...extra } = err; return res.status(status ?? 400).json({ error: err.message, ...extra }); }
    next(err);
  }
};
// La cuenta, si viene un token de la tienda; sin él se compra como invitado.
const cuenta = async (req, res, next) => {
  try {
    const [esquema, token] = (req.headers.authorization ?? '').split(' ');
    req.cuenta = esquema === 'Bearer' && token ? await Cuentas.verificar(token) : null;
    next();
  } catch (err) { next(err); }
};
const exigirCuenta = (req, res, next) => (req.cuenta ? next() : res.status(401).json({ error: 'Iniciá sesión en la tienda.', codigo: 'SIN_SESION' }));
router.use(cuenta);

router.post('/carrito', manejar(async (req, res) => res.status(201).json(await Carrito.agregar(null, req.body ?? {}, req.cuenta))));
router.get('/carrito/:token', manejar(async (req, res) => res.json(await Carrito.mostrar(req.params.token, req.cuenta))));
router.post('/carrito/:token/items', manejar(async (req, res) => res.status(201).json(await Carrito.agregar(req.params.token, req.body ?? {}, req.cuenta))));
router.put('/carrito/:token/items/:linea', manejar(async (req, res) => res.json(await Carrito.modificar(req.params.token, req.params.linea, req.body?.cantidad, req.cuenta))));
router.delete('/carrito/:token/items/:linea', manejar(async (req, res) => res.json(await Carrito.quitar(req.params.token, req.params.linea, req.cuenta))));
router.put('/carrito/:token/cupon', manejar(async (req, res) => res.json(await Carrito.ponerCupon(req.params.token, req.body?.codigo, req.cuenta))));
router.delete('/carrito/:token/cupon', manejar(async (req, res) => res.json(await Carrito.sacarCupon(req.params.token, req.cuenta))));
router.post('/carrito/:token/asociar', exigirCuenta, manejar(async (req, res) => res.json(await Carrito.asociar(req.params.token, req.cuenta))));

router.post('/cuenta/registro', manejar(async (req, res) => res.status(201).json(await Cuentas.registrar(req.body ?? {}))));
router.post('/cuenta/ingresar', manejar(async (req, res) => res.json(await Cuentas.ingresar(req.body ?? {}))));
router.post('/cuenta/recuperar', manejar(async (req, res) => res.json(await Cuentas.solicitarReset(req.body?.email))));
router.post('/cuenta/restablecer', manejar(async (req, res) => res.json(await Cuentas.restablecer(req.body ?? {}))));
router.get('/cuenta', exigirCuenta, manejar(async (req, res) => res.json(Cuentas.publica(req.cuenta))));
router.put('/cuenta', exigirCuenta, manejar(async (req, res) => res.json(await Cuentas.actualizar(req.cuenta.id, req.body ?? {}))));

module.exports = router;
