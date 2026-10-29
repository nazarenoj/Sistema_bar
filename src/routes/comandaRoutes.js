const { Router } = require('express');
const Comandas = require('../services/comandaService');
const { generarComandaSector } = require('../services/ticketService');
const { requierePermiso } = require('../middleware/requierePermiso');

const router = Router();
const OPERAR = requierePermiso('ventas.pedidos.operar');
const actor = (req) => ({ id: req.usuario?.sub, username: req.usuario?.username, rol: req.usuario?.rol, terminal_id: req.usuario?.terminal_id, ip: req.ip });

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Comandas.ComandaInvalida) return res.status(err.status || 400).json({ error: err.message, codigo: 'COMANDA_INVALIDA' });
    next(err);
  }
};
const noEncontrada = (res) => res.status(404).json({ error: 'Comanda no encontrada.' });

// Envía a producción lo que falta de una mesa: una comanda por sector de destino.
router.post('/enviar', OPERAR, manejar(async (req, res) => {
  if (!Number.isInteger(req.body.mesa_id)) return res.status(400).json({ error: 'Falta "mesa_id".' });
  res.status(201).json(await Comandas.enviar(req.body.mesa_id, { userId: req.usuario?.sub }));
}));

// Cola y consulta: ?pendientes=1 son las que aún no se imprimieron; ?sector_id=N | sin; ?estado; ?mesa_id.
router.get('/', OPERAR, manejar(async (req, res) => res.json(await Comandas.listar(req.query))));
router.get('/:id', OPERAR, manejar(async (req, res) => {
  const c = await Comandas.obtener(req.params.id);
  return c ? res.json(c) : noEncontrada(res);
}));

router.get('/:id/pdf', OPERAR, manejar(async (req, res) => {
  const c = await Comandas.obtener(req.params.id);
  return c ? generarComandaSector(res, c) : noEncontrada(res);
}));

// La terminal avisa que la comanda salió por la impresora.
router.post('/:id/impresa', OPERAR, manejar(async (req, res) => (await Comandas.marcarImpresa(req.params.id)) ? res.json({ message: 'Comanda marcada como impresa.' }) : noEncontrada(res)));

router.post('/:id/reimprimir', OPERAR, manejar(async (req, res) => {
  const c = await Comandas.reimprimir(req.params.id, req.body.motivo, actor(req));
  return c ? res.json(c) : noEncontrada(res);
}));
router.post('/:id/redirigir', OPERAR, manejar(async (req, res) => {
  const c = await Comandas.redirigir(req.params.id, req.body.sector_id, req.body.motivo, actor(req));
  return c ? res.json(c) : noEncontrada(res);
}));
router.post('/:id/anular', requierePermiso('ventas.pedidos.anular'), manejar(async (req, res) => {
  const c = await Comandas.anular(req.params.id, req.body.motivo, actor(req));
  return c ? res.json(c) : noEncontrada(res);
}));

module.exports = router;
