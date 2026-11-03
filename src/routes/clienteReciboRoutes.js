const { Router } = require('express');
const Recibos = require('../clientes/reciboService');
const Cuentas = require('../clientes/cuentaService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Recibos de cobro e imputación (Clientes y CC RF06, RF07, RF17). El registro lleva clave de solicitud (RN39): un reintento no duplica el recibo ni consume otro número.
const router = Router();
router.use(requiereModulo('clientes'));
const VER = requierePermiso('clientes.ver');

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Recibos.ReciboInvalido || err instanceof Cuentas.CuentaInvalida) { const { status, message, ...resto } = err; return res.status(status ?? 400).json({ error: message, ...resto }); }
    next(err);
  }
};

router.get('/', VER, manejar(async (req, res) => res.json(await Recibos.listar({ cuenta_id: req.query.cuenta_id ? Number(req.query.cuenta_id) : undefined, estado: req.query.estado }))));
router.post('/', requierePermiso('clientes.recibos.registrar'), manejar(async (req, res) => {
  const r = await Recibos.registrar(req.body, { userId: req.usuario?.sub, idOperacion: req.get('X-ID-Solicitud') });
  if (!r.ya_procesado) await auditar(req, { modulo: 'clientes', accion: 'recibo', entidad: 'recibo', entidad_id: String(r.id), detalle: `${r.numero_completo} por ${r.total}` });
  res.status(r.ya_procesado ? 200 : 201).json(r);
}));
router.post('/imputar/:cuentaId', requierePermiso('clientes.recibos.registrar'), manejar(async (req, res) => res.json(await Recibos.imputar(Number(req.params.cuentaId), req.body, { userId: req.usuario?.sub }))));
router.post('/imputaciones/:id/desimputar', requierePermiso('clientes.recibos.desimputar'), manejar(async (req, res) => {
  const r = await Recibos.desimputar(Number(req.params.id), { motivo: req.body.motivo, userId: req.usuario?.sub });
  await auditar(req, { modulo: 'clientes', accion: 'desimputar', entidad: 'imputacion', entidad_id: req.params.id, detalle: req.body.motivo });
  res.json(r);
}));
router.get('/:id', VER, manejar(async (req, res) => res.json(await Recibos.obtener(Number(req.params.id)))));
router.get('/:id/pdf', VER, manejar(async (req, res) => res.type('application/pdf').send(await Recibos.pdf(Number(req.params.id)))));
router.post('/:id/anular', requierePermiso('clientes.recibos.anular'), manejar(async (req, res) => {
  const r = await Recibos.anular(Number(req.params.id), { motivo: req.body.motivo, userId: req.usuario?.sub });
  await auditar(req, { modulo: 'clientes', accion: 'anular_recibo', entidad: 'recibo', entidad_id: String(r.id), detalle: req.body.motivo });
  res.json(r);
}));

module.exports = router;
