const { Router } = require('express');
const Destinos = require('../financiero/destinoService');
const Movimientos = require('../financiero/movimientoService');
const { manejar } = require('../financiero/comun');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Destino de cada forma de pago (Financiero RF02) y consulta de movimientos (RF16).
const router = Router();
router.use(requiereModulo('financiero'));
const VER = requierePermiso('financiero.cajas.ver');
const CONFIGURAR = requierePermiso('financiero.cajas.configurar');

router.get('/destinos', VER, manejar(async (req, res) => res.json({ destinos: await Destinos.listar(), sin_destino: await Destinos.sinDestino() })));
router.put('/destinos', CONFIGURAR, manejar(async (req, res) => {
  const d = await Destinos.asignar(req.body);
  await auditar(req, { modulo: 'financiero', accion: 'asignar_destino', entidad: 'fin_destino', entidad_id: String(d.id), detalle: `${d.forma} → ${d.cuenta_nombre ?? d.modo}` });
  res.json(d);
}));
router.delete('/destinos/:id', CONFIGURAR, manejar(async (req, res) => {
  const r = await Destinos.quitar(Number(req.params.id));
  await auditar(req, { modulo: 'financiero', accion: 'quitar_destino', entidad: 'fin_destino', entidad_id: req.params.id });
  res.json(r);
}));
router.get('/movimientos', requierePermiso('financiero.movimientos.ver'), manejar(async (req, res) => {
  const q = req.query;
  res.json(await Movimientos.listar({ cuentaId: q.cuenta_id, tipo: q.tipo, desde: q.desde, hasta: q.hasta, turnoId: q.turno_id, docIdGlobal: q.venta, limite: q.limite, antesDe: q.antes_de }));
}));

module.exports = router;
