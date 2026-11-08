const { Router } = require('express');
const pool = require('../config/db');
const Config = require('../contable/configService');
const Cuentas = require('../contable/cuentaService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const { manejar } = require('../contable/comun');

// Inicio de la contabilidad y plan de cuentas (Contable RF01, RF13).
const router = Router();
router.use(requiereModulo('contable'));
const VER = requierePermiso('contable.ver'), CONF = requierePermiso('contable.configurar'), PLAN = requierePermiso('contable.plan.editar');
const aud = (req, accion, id, detalle) => auditar(req, { modulo: 'contable', accion, entidad: 'cuenta', entidad_id: id, detalle });

router.get('/config', VER, manejar(async (req, res) => res.json(await Config.estado())));
router.post('/config/iniciar', CONF, manejar(async (req, res) => {
  const r = await Config.iniciar(req.body ?? {});
  await auditar(req, { modulo: 'contable', accion: 'iniciar_contabilidad', entidad: 'con_config', entidad_id: 1, detalle: `${r.fecha_inicio} ${r.perfil_rubro}` });
  res.json(r);
}));
router.put('/config', CONF, manejar(async (req, res) => {
  const r = await Config.actualizar(req.body ?? {});
  await auditar(req, { modulo: 'contable', accion: 'configurar', entidad: 'con_config', entidad_id: 1, detalle: JSON.stringify(req.body ?? {}) });
  res.json(r);
}));
router.get('/movimientos-previos', VER, manejar(async (req, res) => {
  const [filas] = await pool.query('SELECT modulo, tipo_documento, id_documento, fecha, importe FROM con_previos_inicio ORDER BY fecha DESC, id DESC LIMIT 500');
  res.json(filas);
}));

router.get('/cuentas', VER, manejar(async (req, res) => res.json(await Cuentas.listar(req.query))));
router.get('/cuentas/exportar', VER, manejar(async (req, res) => {
  if (req.query.formato === 'csv') { res.type('text/csv').attachment('plan-de-cuentas.csv'); return res.send(await Cuentas.csv()); }
  res.json(await Cuentas.exportar());
}));
router.post('/cuentas/importar', PLAN, manejar(async (req, res) => {
  const r = await Cuentas.importar(req.body?.cuentas);
  await aud(req, 'importar_plan', 'plan', `${r.importadas} cuentas`);
  res.json(r);
}));
router.post('/cuentas', PLAN, manejar(async (req, res) => { const r = await Cuentas.crear(req.body ?? {}); await aud(req, 'crear_cuenta', r.id, r.codigo); res.status(201).json(r); }));
router.put('/cuentas/:id', PLAN, manejar(async (req, res) => { const r = await Cuentas.editar(Number(req.params.id), req.body ?? {}); await aud(req, 'editar_cuenta', r.id, r.codigo); res.json(r); }));
router.post('/cuentas/:id/estado', PLAN, manejar(async (req, res) => { const r = await Cuentas.cambiarEstado(Number(req.params.id), !!req.body?.activa); await aud(req, 'estado_cuenta', r.id, r.estado); res.json(r); }));
router.delete('/cuentas/:id', PLAN, manejar(async (req, res) => { const r = await Cuentas.eliminar(Number(req.params.id)); await aud(req, 'eliminar_cuenta', req.params.id, ''); res.json(r); }));

module.exports = router;
