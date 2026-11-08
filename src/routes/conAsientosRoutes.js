const { Router } = require('express');
const Asientos = require('../contable/asientoService');
const Auto = require('../contable/automaticos');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const { manejar } = require('../contable/comun');

// Diario, asientos automáticos y reprocesamiento (Contable RF04, RF14).
const router = Router();
router.use(requiereModulo('contable'));
const VER = requierePermiso('contable.ver'), REPROCESAR = requierePermiso('contable.reprocesar'), REGLAS = requierePermiso('contable.reglas.editar');
const aud = (req, accion, entidad, id, detalle) => auditar(req, { modulo: 'contable', accion, entidad, entidad_id: id, detalle });

router.get('/asientos', VER, manejar(async (req, res) => res.json(await Asientos.listar(req.query))));
router.get('/asientos/:id', VER, manejar(async (req, res) => res.json(await Asientos.vista(Number(req.params.id)))));
router.get('/modos', VER, manejar(async (req, res) => res.json(await Auto.modos())));
router.put('/modos/:formulario', REGLAS, manejar(async (req, res) => { const r = await Auto.fijarModo(req.params.formulario, req.body?.modo); await aud(req, 'modo_formulario', 'formulario', req.params.formulario, req.body.modo); res.json(r); }));
router.post('/reprocesar', REPROCESAR, manejar(async (req, res) => {
  const r = await Auto.reprocesar({ desde: req.body?.desde, hasta: req.body?.hasta, confirmar: !!req.body?.confirmar }, req.usuario.sub);
  if (r.confirmado) await aud(req, 'reprocesar', 'asiento', 'lote', `${r.asientos_con_cambios} asientos`);
  res.json(r);
}));

module.exports = router;
