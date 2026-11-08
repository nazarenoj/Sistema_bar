const { Router } = require('express');
const Consol = require('../contable/consolidacion');
const requiereModulo = require('../middleware/requiereModulo');
const requiereFuncion = require('../middleware/requiereFuncion');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const { enviarReporte, FORMATOS_VALIDOS } = require('../servicios/reporteService');
const { manejar } = require('../contable/comun');

// Consolidación contable en la Casa Central (Contable RF22, RF23). Los paquetes se publican e importan por /api/consolidacion (Usuarios); acá, las equivalencias y el balance consolidado.
const router = Router();
router.use(requiereModulo('contable'), requiereFuncion('CON-CONSOL'));
const VER = requierePermiso('contable.ver'), CONFIGURAR = requierePermiso('contable.consolidacion.configurar'), EXPORTAR = requierePermiso('contable.exportar');
const SI_EXPORTA = (req, res, next) => (req.query.formato ? EXPORTAR(req, res, next) : next());

router.get('/consolidacion/equivalencias/:sucursal', VER, manejar(async (req, res) => res.json(await Consol.equivalencias(req.params.sucursal))));
router.put('/consolidacion/equivalencias/:sucursal', CONFIGURAR, manejar(async (req, res) => {
  const r = await Consol.fijarEquivalencias(req.params.sucursal, req.body?.equivalencias);
  await auditar(req, { modulo: 'contable', accion: 'equivalencias_consolidacion', entidad: 'sucursal', entidad_id: req.params.sucursal, detalle: `${r.length} cuenta(s)` });
  res.json(r);
}));
router.get('/consolidacion/balance', VER, SI_EXPORTA, manejar(async (req, res) => {
  const b = await Consol.consolidado(req.query);
  if (!req.query.formato) return res.json(b);
  if (!FORMATOS_VALIDOS.includes(req.query.formato)) return res.status(400).json({ error: `"formato" debe ser uno de: ${FORMATOS_VALIDOS.join(', ')}.` });
  await auditar(req, { modulo: 'contable', accion: 'exportar', entidad: 'libro', entidad_id: 'balance-consolidado', detalle: req.query.formato });
  await enviarReporte(res, Consol.exportable(b), req.query.formato, `balance-consolidado-${b.periodo}`);
}));

module.exports = router;
