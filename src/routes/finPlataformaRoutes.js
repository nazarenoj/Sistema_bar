const { Router } = require('express');
const Plataformas = require('../financiero/plataformaService');
const { manejar } = require('../financiero/comun');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Comisiones y liquidaciones de plataformas (Financiero RF24).
const router = Router();
router.use(requiereModulo('financiero'));
const VER = requierePermiso('financiero.plataformas.ver');

router.get('/plataformas/liquidaciones', VER, manejar(async (req, res) => res.json(await Plataformas.liquidaciones({ plataforma: req.query.plataforma, estado: req.query.estado }))));
router.get('/plataformas/comisiones', VER, manejar(async (req, res) => res.json(await Plataformas.comisiones({ plataforma: req.query.plataforma, desde: req.query.desde, hasta: req.query.hasta }))));
router.post('/plataformas/liquidaciones/:id/resolver', requierePermiso('financiero.plataformas.resolver'), manejar(async (req, res) => {
  const l = await Plataformas.resolver(Number(req.params.id), req.body ?? {});
  await auditar(req, { modulo: 'financiero', accion: 'resolver_liquidacion_plataforma', entidad: 'fin_plataforma_liquidaciones', entidad_id: String(l.id), detalle: l.nota });
  res.json(l);
}));

module.exports = router;
