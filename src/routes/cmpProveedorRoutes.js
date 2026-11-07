const { Router } = require('express');
const Proveedores = require('../compras/proveedorService');
const { manejar, puede } = require('../compras/comun');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Proveedores, rubros y configuración de Compras (RF01, RF17, RF23).
const router = Router();
router.use(requiereModulo('compras'));
const VER = requierePermiso('compras.proveedores.ver');
const GESTIONAR = requierePermiso('compras.proveedores.gestionar');
const CONFIG = requierePermiso('compras.config');

router.get('/proveedores', VER, manejar(async (req, res) => res.json(await Proveedores.listar({ q: req.query.q, estado: req.query.estado, rubroId: req.query.rubro_id, tipo: req.query.tipo, limite: req.query.limite }))));
router.get('/proveedores/:id', VER, manejar(async (req, res) => res.json(await Proveedores.obtener(Number(req.params.id)))));
router.post('/proveedores', GESTIONAR, manejar(async (req, res) => {
  const p = await Proveedores.crear(req.body, { userId: req.usuario.sub });
  await auditar(req, { modulo: 'compras', accion: 'alta_proveedor', entidad: 'proveedor', entidad_id: String(p.id), detalle: `${p.cuit} ${p.razon_social}` });
  res.status(201).json(p);
}));
router.put('/proveedores/:id', GESTIONAR, manejar(async (req, res) => {
  const p = await Proveedores.actualizar(Number(req.params.id), req.body, { puedeEntrega: await puede(req, 'compras.entrega.editar') });
  await auditar(req, { modulo: 'compras', accion: 'modificacion_proveedor', entidad: 'proveedor', entidad_id: String(p.id), detalle: JSON.stringify(Object.keys(req.body)) });
  res.json(p);
}));
router.post('/proveedores/:id/activar', GESTIONAR, manejar(async (req, res) => res.json(await Proveedores.cambiarEstado(Number(req.params.id), true))));
router.post('/proveedores/:id/desactivar', GESTIONAR, manejar(async (req, res) => {
  const p = await Proveedores.cambiarEstado(Number(req.params.id), false);
  await auditar(req, { modulo: 'compras', accion: 'desactivar_proveedor', entidad: 'proveedor', entidad_id: String(p.id) });
  res.json(p);
}));
router.post('/proveedores/:id/verificar-arca', GESTIONAR, manejar(async (req, res) => res.json(await Proveedores.verificarArca(Number(req.params.id)))));

router.get('/rubros', VER, manejar(async (req, res) => res.json(await Proveedores.rubros())));
router.post('/rubros', CONFIG, manejar(async (req, res) => res.status(201).json(await Proveedores.crearRubro(req.body))));
router.put('/rubros/:id', CONFIG, manejar(async (req, res) => res.json(await Proveedores.actualizarRubro(Number(req.params.id), req.body))));

router.get('/config', VER, manejar(async (req, res) => res.json(await Proveedores.config())));
router.put('/config', CONFIG, manejar(async (req, res) => {
  const c = await Proveedores.actualizarConfig(req.body);
  await auditar(req, { modulo: 'compras', accion: 'cambio_configuracion', entidad: 'cmp_config', entidad_id: '1', detalle: JSON.stringify(c) });
  res.json(c);
}));

module.exports = router;
