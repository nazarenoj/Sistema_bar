const { Router } = require('express');
const Ajustes = require('../clientes/ajusteService');
const Cuentas = require('../clientes/cuentaService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Propuestas de intereses por mora y de diferencia de cambio (Clientes y CC RF10, RF11, RN11, RN12). El sistema calcula y propone; emitir la nota (confirmar) o condonar
// (descartar) requiere permiso y queda auditado.
const router = Router();
router.use(requiereModulo('clientes'));
const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Ajustes.AjusteInvalido || err instanceof Cuentas.CuentaInvalida) { const { status, message, ...resto } = err; return res.status(status ?? 400).json({ error: message, ...resto }); }
    next(err);
  }
};

router.get('/', requierePermiso('clientes.ver'), manejar(async (req, res) => res.json(await Ajustes.listar(req.query))));
router.post('/calcular-mora', requierePermiso('clientes.ajustes.gestionar'), manejar(async (req, res) => res.json(await Ajustes.calcularMora({ cuentaId: req.body.cuenta_id ?? null }))));
router.post('/:id/confirmar', requierePermiso('clientes.ajustes.gestionar'), manejar(async (req, res) => {
  const r = await Ajustes.confirmar(Number(req.params.id), req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'clientes', accion: 'confirmar_ajuste', entidad: 'propuesta', entidad_id: req.params.id, detalle: `${r.propuesta.tipo} ${r.propuesta.importe}` });
  res.json(r);
}));
router.post('/:id/descartar', requierePermiso('clientes.ajustes.condonar'), manejar(async (req, res) => {
  const r = await Ajustes.descartar(Number(req.params.id), req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'clientes', accion: 'condonar_ajuste', entidad: 'propuesta', entidad_id: req.params.id, detalle: req.body.motivo });
  res.json(r);
}));

module.exports = router;
