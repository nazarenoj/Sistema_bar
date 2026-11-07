const { Router } = require('express');
const Turnos = require('../financiero/turnoService');
const { manejar, puede } = require('../financiero/comun');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Turnos de servicio y de caja (Financiero RF03). El saldo teórico solo lo ve quien tiene permiso (RN17).
const router = Router();
router.use(requiereModulo('financiero'));
const VER = requierePermiso('financiero.cajas.ver');
const OPERAR = requierePermiso('financiero.turnos.operar');
const CONFIGURAR = requierePermiso('financiero.cajas.configurar');

const opcionesDe = async (req) => ({ verTeorico: await puede(req, 'financiero.saldos.ver') });

router.get('/turnos-servicio', VER, manejar(async (req, res) => res.json(await Turnos.servicios())));
router.post('/turnos-servicio', CONFIGURAR, manejar(async (req, res) => res.status(201).json(await Turnos.crearServicio(req.body))));
router.put('/turnos-servicio/:id', CONFIGURAR, manejar(async (req, res) => res.json(await Turnos.actualizarServicio(Number(req.params.id), req.body))));

router.get('/turnos', VER, manejar(async (req, res) => {
  const q = req.query;
  res.json(await Turnos.listar({ estado: q.estado, cuentaId: q.cuenta_id, terminalId: q.terminal_id, desde: q.desde, hasta: q.hasta, limite: q.limite }, await opcionesDe(req)));
}));
// El turno abierto de la terminal de quien consulta (o de una caja): lo que la pantalla de cobro necesita para saber si hay que abrir uno.
router.get('/turnos/abierto', VER, manejar(async (req, res) => {
  const cuentaId = req.query.cuenta_id ? Number(req.query.cuenta_id) : (await Turnos.turnoDeTerminal(req.usuario.terminal_id)).caja_id;
  const t = cuentaId ? await Turnos.abiertoDe(cuentaId) : null;
  res.json(t ? await Turnos.vista(t, await opcionesDe(req)) : null);
}));
router.get('/turnos/:id', VER, manejar(async (req, res) => res.json(await Turnos.obtener(Number(req.params.id), await opcionesDe(req)))));

router.post('/turnos', OPERAR, manejar(async (req, res) => {
  const t = await Turnos.abrir({ cuentaId: req.body.cuenta_id, fondo: req.body.fondo_contado, userId: req.usuario.sub, terminalId: req.usuario.terminal_id ?? null });
  await auditar(req, { modulo: 'financiero', accion: 'abrir_turno', entidad: 'fin_turno', entidad_id: String(t.id), detalle: `${t.caja}, fondo ${t.fondo_apertura}` });
  res.status(201).json(t);
}));
router.post('/turnos/:id/movimientos', requierePermiso('financiero.movimientos.registrar'), manejar(async (req, res) => {
  const r = await Turnos.movimientoManual(Number(req.params.id), req.body, req.usuario.sub);
  await auditar(req, { modulo: 'financiero', accion: `${req.body.tipo}_manual`, entidad: 'fin_turno', entidad_id: req.params.id, detalle: `${req.body.importe}: ${req.body.motivo}` });
  res.status(201).json(r);
}));

module.exports = router;
