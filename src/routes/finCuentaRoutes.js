const { Router } = require('express');
const Cuentas = require('../financiero/cuentaService');
const { manejar, puede } = require('../financiero/comun');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Cajas, cuentas, categorías y configuración de Financiero (RF01, RF11). Los saldos solo los ve quien tiene permiso (RN17).
const router = Router();
router.use(requiereModulo('financiero'));
const VER = requierePermiso('financiero.cajas.ver');
const CONFIGURAR = requierePermiso('financiero.cajas.configurar');

router.get('/cuentas', VER, manejar(async (req, res) => res.json(await Cuentas.listar({ conSaldo: await puede(req, 'financiero.saldos.ver'), soloActivas: req.query.activas === '1' }))));
router.get('/cuentas/:id', VER, manejar(async (req, res) => res.json(await Cuentas.obtener(Number(req.params.id), { conSaldo: await puede(req, 'financiero.saldos.ver') }))));
router.post('/cuentas', CONFIGURAR, manejar(async (req, res) => {
  const c = await Cuentas.crear(req.body);
  await auditar(req, { modulo: 'financiero', accion: 'alta_cuenta', entidad: 'fin_cuenta', entidad_id: String(c.id), detalle: `${c.tipo} ${c.nombre} (${c.moneda})` });
  res.status(201).json(c);
}));
router.put('/cuentas/:id', CONFIGURAR, manejar(async (req, res) => {
  const c = await Cuentas.actualizar(Number(req.params.id), req.body);
  await auditar(req, { modulo: 'financiero', accion: 'modificacion_cuenta', entidad: 'fin_cuenta', entidad_id: String(c.id), detalle: JSON.stringify(Object.keys(req.body)) });
  res.json(c);
}));
router.post('/cuentas/:id/activar', CONFIGURAR, manejar(async (req, res) => res.json(await Cuentas.cambiarEstado(Number(req.params.id), true))));
router.post('/cuentas/:id/desactivar', CONFIGURAR, manejar(async (req, res) => {
  const c = await Cuentas.cambiarEstado(Number(req.params.id), false);
  await auditar(req, { modulo: 'financiero', accion: 'desactivar_cuenta', entidad: 'fin_cuenta', entidad_id: String(c.id) });
  res.json(c);
}));
router.delete('/cuentas/:id', CONFIGURAR, manejar(async (req, res) => {
  const r = await Cuentas.eliminar(Number(req.params.id));
  await auditar(req, { modulo: 'financiero', accion: 'baja_cuenta', entidad: 'fin_cuenta', entidad_id: req.params.id });
  res.json(r);
}));

router.get('/categorias', VER, manejar(async (req, res) => res.json(await Cuentas.categorias({ soloActivas: req.query.activas === '1' }))));
router.post('/categorias', CONFIGURAR, manejar(async (req, res) => res.status(201).json(await Cuentas.crearCategoria(req.body))));
router.put('/categorias/:id', CONFIGURAR, manejar(async (req, res) => res.json(await Cuentas.actualizarCategoria(Number(req.params.id), req.body))));

router.get('/config', VER, manejar(async (req, res) => res.json(await Cuentas.config())));
router.put('/config', CONFIGURAR, manejar(async (req, res) => {
  const c = await Cuentas.actualizarConfig(req.body);
  await auditar(req, { modulo: 'financiero', accion: 'cambio_configuracion', entidad: 'fin_config', entidad_id: '1', detalle: JSON.stringify(c) });
  res.json(c);
}));

module.exports = router;
