const { Router } = require('express');
const Vencimientos = require('../compras/vencimientoService');
const { manejar } = require('../compras/comun');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Cuenta corriente del proveedor, agenda de vencimientos y sus avisos (Compras RF02, RF05).
const router = Router();
router.use(requiereModulo('compras'));
const VER = requierePermiso('compras.cuentas.ver');

router.get('/proveedores/:id/cuenta', VER, manejar(async (req, res) => res.json(await Vencimientos.cuenta(Number(req.params.id), { moneda: req.query.moneda }))));
router.get('/deuda', VER, manejar(async (req, res) => res.json(await Vencimientos.deudaPorProveedor())));
router.get('/vencimientos', VER, manejar(async (req, res) => {
  const q = req.query;
  res.json(await Vencimientos.agenda({ desde: q.desde, hasta: q.hasta, proveedorId: q.proveedor_id, comprobanteId: q.comprobante_id, estado: q.estado, limite: q.limite }));
}));
router.put('/comprobantes/:id/vencimientos', requierePermiso('compras.vencimientos.editar'), manejar(async (req, res) => {
  const r = await Vencimientos.reemplazar(Number(req.params.id), req.body.vencimientos);
  await auditar(req, { modulo: 'compras', accion: 'cambiar_cuotas', entidad: 'cmp_comprobante', entidad_id: req.params.id, detalle: JSON.stringify(req.body.vencimientos) });
  res.json(r);
}));
router.post('/vencimientos/avisos', requierePermiso('compras.vencimientos.editar'), manejar(async (req, res) => res.json(await Vencimientos.avisos())));

module.exports = router;
