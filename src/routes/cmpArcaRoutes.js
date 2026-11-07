const { Router } = require('express');
const Arca = require('../compras/arcaService');
const { manejar } = require('../compras/comun');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Libro IVA Compras (Compras RF13) y controles contra ARCA (RF14).
const router = Router();
router.use(requiereModulo('compras'));
const LIBRO = requierePermiso('compras.libro_iva.ver'), CONTROLAR = requierePermiso('compras.arca.controlar');

router.get('/libro-iva', LIBRO, manejar(async (req, res) => {
  const l = await Arca.generarLibro(req.query.periodo);
  if (req.query.archivo === 'comprobantes') return res.type('text/plain').attachment(`LIBRO_IVA_COMPRAS_CBTE_${l.periodo}.txt`).send(l.comprobantes);
  if (req.query.archivo === 'alicuotas') return res.type('text/plain').attachment(`LIBRO_IVA_COMPRAS_ALICUOTAS_${l.periodo}.txt`).send(l.alicuotas);
  await auditar(req, { modulo: 'compras', accion: 'libro_iva', entidad: 'libro_iva_compras', entidad_id: l.periodo, detalle: `${l.cantidad} comprobantes` });
  res.json(l);
}));

router.post('/arca/mis-comprobantes', CONTROLAR, manejar(async (req, res) => {
  const r = await Arca.importarMisComprobantes(req.body ?? {}, req.usuario.sub);
  await auditar(req, { modulo: 'compras', accion: 'importar_mis_comprobantes', entidad: 'cmp_mis_comprobantes_imp', entidad_id: String(r.id), detalle: `${r.periodo}: ${r.cantidad} filas` });
  res.status(r.repetida ? 200 : 201).json(r);
}));
router.get('/arca/comparacion', CONTROLAR, manejar(async (req, res) => res.json(await Arca.comparar(req.query.periodo))));
router.post('/arca/constatar-pendientes', CONTROLAR, manejar(async (req, res) => res.json(await Arca.constatarPendientes(req.usuario.sub))));
router.post('/comprobantes/:id/constatar', CONTROLAR, manejar(async (req, res) => {
  const r = await Arca.constatar(Number(req.params.id), req.usuario.sub);
  await auditar(req, { modulo: 'compras', accion: 'constatar_comprobante', entidad: 'cmp_comprobante', entidad_id: String(r.id), detalle: r.constatacion });
  res.json(r);
}));
router.get('/comprobantes/:id/constataciones', CONTROLAR, manejar(async (req, res) => res.json(await Arca.historial(Number(req.params.id)))));

module.exports = router;
