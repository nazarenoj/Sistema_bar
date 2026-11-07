const { Router } = require('express');
const Transferencias = require('../financiero/transferenciaService');
const Acreditaciones = require('../financiero/acreditacionService');
const { manejar } = require('../financiero/comun');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Transferencias, retiros a caja fuerte (RF05), acreditaciones pendientes y liquidaciones del procesador (RF06).
const router = Router();
router.use(requiereModulo('financiero'));
const VER = requierePermiso('financiero.movimientos.ver');

router.get('/transferencias', VER, manejar(async (req, res) => {
  const q = req.query;
  res.json(await Transferencias.listar({ cuentaId: q.cuenta_id, clase: q.clase, desde: q.desde, hasta: q.hasta, limite: q.limite }));
}));
router.post('/transferencias', requierePermiso('financiero.transferencias.registrar'), manejar(async (req, res) => {
  const b = req.body;
  const t = await Transferencias.transferir({ origenId: b.origen_id, destinoId: b.destino_id, importe: b.importe, motivo: b.motivo, userId: req.usuario.sub, terminalId: req.usuario.terminal_id ?? null });
  await auditar(req, { modulo: 'financiero', accion: t.clase, entidad: 'fin_transferencia', entidad_id: String(t.id), detalle: `${t.importe} de ${t.origen_id} a ${t.destino_id}: ${b.motivo}` });
  res.status(201).json(t);
}));

router.get('/acreditaciones', VER, manejar(async (req, res) => res.json(await Acreditaciones.listar({ estado: req.query.estado, cuentaId: req.query.cuenta_id, hasta: req.query.hasta }))));
router.get('/liquidaciones', VER, manejar(async (req, res) => res.json(await Acreditaciones.listarLiquidaciones({ cuentaId: req.query.cuenta_id, limite: req.query.limite }))));
router.get('/liquidaciones/:id', VER, manejar(async (req, res) => res.json(await Acreditaciones.obtener(Number(req.params.id)))));
router.post('/liquidaciones', requierePermiso('financiero.liquidaciones.registrar'), manejar(async (req, res) => {
  const l = await Acreditaciones.liquidar(req.body, req.usuario.sub);
  await auditar(req, { modulo: 'financiero', accion: 'liquidacion', entidad: 'fin_liquidacion', entidad_id: String(l.id), detalle: `${l.referencia}: bruto ${l.bruto}, neto ${l.neto}` });
  res.status(201).json(l);
}));

module.exports = router;
