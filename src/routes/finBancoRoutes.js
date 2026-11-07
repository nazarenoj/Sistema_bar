const express = require('express');
const Cheques = require('../financiero/chequeService');
const Conciliacion = require('../financiero/conciliacionService');
const { manejar } = require('../financiero/comun');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Cartera de cheques (Financiero RF07, RF08) y conciliación bancaria (RF09).
const router = express.Router();
router.use(requiereModulo('financiero'));
const VER = requierePermiso('financiero.movimientos.ver');
const CHEQUES = requierePermiso('financiero.cheques.gestionar');
const CONCILIAR = requierePermiso('financiero.conciliar');
const grande = express.json({ limit: '8mb' }); // extractos en Excel (base64)

const accion = (nombre, fn) => manejar(async (req, res) => {
  const r = await fn(req);
  await auditar(req, { modulo: 'financiero', accion: nombre, entidad: 'fin_cheque', entidad_id: String(r.id ?? req.params.id), detalle: JSON.stringify({ estado: r.estado, motivo: req.body?.motivo }) });
  res.json(r);
});

router.get('/cheques', VER, manejar(async (req, res) => {
  const q = req.query;
  res.json(await Cheques.listar({ estado: q.estado, origen: q.origen, desde: q.desde, hasta: q.hasta, vencidos: q.vencidos === '1', limite: q.limite }));
}));
router.get('/cheques/:id', VER, manejar(async (req, res) => res.json(await Cheques.obtener(Number(req.params.id)))));
router.post('/cheques', CHEQUES, manejar(async (req, res) => {
  const c = await Cheques.registrar(req.body, { userId: req.usuario.sub });
  await auditar(req, { modulo: 'financiero', accion: 'registrar_cheque', entidad: 'fin_cheque', entidad_id: String(c.id), detalle: `${c.origen} ${c.banco ?? c.identificador_red} ${c.numero ?? ''} ${c.importe}` });
  res.status(201).json(c);
}));
router.post('/cheques/:id/depositar', CHEQUES, accion('depositar_cheque', (req) => Cheques.depositar(Number(req.params.id), req.body, req.usuario.sub)));
router.post('/cheques/:id/endosar', CHEQUES, accion('endosar_cheque', (req) => Cheques.endosar(Number(req.params.id), req.body, req.usuario.sub)));
router.post('/cheques/:id/acreditar', CHEQUES, accion('acreditar_cheque', (req) => Cheques.acreditar(Number(req.params.id), req.body, req.usuario.sub)));
router.post('/cheques/:id/rechazar', CHEQUES, accion('rechazar_cheque', (req) => Cheques.rechazar(Number(req.params.id), req.body, req.usuario.sub)));
router.post('/cheques/:id/anular', CHEQUES, accion('anular_cheque', (req) => Cheques.anular(Number(req.params.id), req.body, req.usuario.sub)));

router.get('/extractos/lineas', VER, manejar(async (req, res) => {
  const q = req.query;
  res.json(await Conciliacion.listarLineas({ cuentaId: q.cuenta_id, estado: q.estado, desde: q.desde, hasta: q.hasta, limite: q.limite }));
}));
router.get('/extractos/movimientos-sin-conciliar', VER, manejar(async (req, res) => res.json(await Conciliacion.movimientosSinConciliar(req.query.cuenta_id, { desde: req.query.desde, hasta: req.query.hasta }))));
router.post('/extractos/importar', CONCILIAR, grande, manejar(async (req, res) => {
  const r = await Conciliacion.importar(req.body.cuenta_id, req.body);
  await auditar(req, { modulo: 'financiero', accion: 'importar_extracto', entidad: 'fin_cuenta', entidad_id: String(req.body.cuenta_id), detalle: `${r.importadas} importadas, ${r.duplicadas} ya estaban` });
  res.status(201).json(r);
}));
router.post('/extractos/lineas', CONCILIAR, manejar(async (req, res) => res.status(201).json(await Conciliacion.cargarManual(req.body.cuenta_id, req.body))));
router.post('/conciliacion/automatica', CONCILIAR, manejar(async (req, res) => {
  const r = await Conciliacion.automatica(req.body.cuenta_id, req.usuario.sub);
  await auditar(req, { modulo: 'financiero', accion: 'conciliacion_automatica', entidad: 'fin_cuenta', entidad_id: String(req.body.cuenta_id), detalle: JSON.stringify(r) });
  res.json(r);
}));
router.post('/conciliacion/lineas/:id/vincular', CONCILIAR, manejar(async (req, res) => {
  const l = await Conciliacion.vincular(Number(req.params.id), req.body.movimiento_ids, req.usuario.sub);
  await auditar(req, { modulo: 'financiero', accion: 'conciliar_linea', entidad: 'fin_extracto_linea', entidad_id: String(l.id), detalle: JSON.stringify(req.body.movimiento_ids) });
  res.json(l);
}));
router.post('/conciliacion/lineas/:id/desvincular', CONCILIAR, manejar(async (req, res) => res.json(await Conciliacion.desvincular(Number(req.params.id)))));
router.post('/conciliacion/lineas/:id/registrar', CONCILIAR, manejar(async (req, res) => {
  const r = await Conciliacion.registrarDesdeExtracto(Number(req.params.id), req.body, req.usuario.sub);
  await auditar(req, { modulo: 'financiero', accion: 'registrar_desde_extracto', entidad: 'fin_extracto_linea', entidad_id: req.params.id, detalle: req.body.tipo });
  res.status(201).json(r);
}));
router.get('/conciliacion/cierres', VER, manejar(async (req, res) => res.json(await Conciliacion.cierres(req.query.cuenta_id))));
router.post('/conciliacion/cierres', CONCILIAR, manejar(async (req, res) => {
  const c = await Conciliacion.cerrar(req.body, req.usuario.sub);
  await auditar(req, { modulo: 'financiero', accion: 'cerrar_conciliacion', entidad: 'fin_conciliacion', entidad_id: String(c.id), detalle: `${c.desde} a ${c.hasta}, saldo ${c.saldo_conciliado}` });
  res.status(201).json(c);
}));

module.exports = router;
