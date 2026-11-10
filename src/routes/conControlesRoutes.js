const { Router } = require('express');
const Controles = require('../contable/controlService');
const Apertura = require('../contable/aperturaService');
const Origen = require('../contable/origenService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const { manejar } = require('../contable/comun');

// Controles cruzados, asiento de apertura y navegación al origen (Contable RF11, RF13).
const router = Router();
router.use(requiereModulo('contable'));
const VER = requierePermiso('contable.ver'), EJECUTAR = requierePermiso('contable.controles.ejecutar'), APERTURA = requierePermiso('contable.apertura.registrar');
const aud = (req, accion, entidad, id, detalle) => auditar(req, { modulo: 'contable', accion, entidad, entidad_id: id, detalle });

router.get('/controles', VER, manejar(async (req, res) => res.json(await Controles.ultimo() ?? { controles: [] })));
router.get('/controles/historial', VER, manejar(async (req, res) => res.json(await Controles.historial(req.query))));
router.get('/controles/:id', VER, manejar(async (req, res) => res.json(await Controles.ejecucion(Number(req.params.id)))));
router.post('/controles/ejecutar', EJECUTAR, manejar(async (req, res) => {
  const r = await Controles.ejecutar({ usuarioId: req.usuario.sub });
  await aud(req, 'controles_cruzados', 'control', r.id, `${r.con_diferencias} diferencia(s)`);
  res.json(r);
}));

router.get('/apertura', VER, manejar(async (req, res) => res.json(await Apertura.propuesta())));
router.post('/apertura', APERTURA, manejar(async (req, res) => {
  const a = await Apertura.registrar(req.body ?? {}, req.usuario.sub, req.get('x-id-solicitud') ?? null);
  await aud(req, 'asiento_apertura', 'asiento', a.id, `n.º ${a.numero}`);
  res.status(201).json(a);
}));

router.get('/asientos/:id/origen', VER, manejar(async (req, res) => res.json(await Origen.deAsiento(Number(req.params.id)))));

module.exports = router;
