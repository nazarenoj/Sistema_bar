const { Router } = require('express');
const Ordenes = require('../compras/ordenPagoService');
const Retenciones = require('../compras/retencionService');
const { manejar, puede } = require('../compras/comun');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso, validarAutorizacion } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Órdenes de pago, anticipos, pagos programados (Compras RF06 a RF08) y retenciones (RF09).
const router = Router();
router.use(requiereModulo('compras'));
const VER = requierePermiso('compras.ordenes.ver');
const CREAR = requierePermiso('compras.ordenes.crear');
const CONFIGURAR_RET = requierePermiso('compras.retenciones.configurar');

router.get('/ordenes-pago', VER, manejar(async (req, res) => {
  const q = req.query;
  res.json(await Ordenes.listar({ proveedorId: q.proveedor_id, estado: q.estado, tipo: q.tipo, desde: q.desde, hasta: q.hasta, limite: q.limite }));
}));
router.get('/ordenes-pago/:id', VER, manejar(async (req, res) => res.json(await Ordenes.obtener(Number(req.params.id)))));
router.post('/ordenes-pago/calcular', CREAR, manejar(async (req, res) => res.json(await Ordenes.calcular(req.body))));
router.post('/ordenes-pago', CREAR, manejar(async (req, res) => {
  const o = await Ordenes.crear(req.body, { userId: req.usuario.sub, idSolicitud: req.get('X-ID-Solicitud') ?? null, puedeModificarRetenciones: await puede(req, 'compras.retenciones.modificar') });
  await auditar(req, { modulo: 'compras', accion: 'crear_orden_pago', entidad: 'cmp_orden_pago', entidad_id: String(o.id), detalle: `N.º ${o.numero} ${o.tipo} ${o.medios_total} (${o.estado})${Array.isArray(req.body.retenciones) ? ' con retenciones modificadas' : ''}` });
  res.status(201).json(o);
}));
// La aprobación la da otro usuario con el permiso (RN09): supera el importe configurado o es una orden programada.
router.post('/ordenes-pago/:id/aprobar', CREAR, manejar(async (req, res) => {
  const a = await validarAutorizacion(req, 'compras.ordenes.aprobar');
  if (!a.ok) return res.status(a.status).json({ error: a.error, codigo: a.codigo });
  const o = await Ordenes.aprobar(Number(req.params.id), { userId: req.usuario.sub, supervisorId: a.supervisor.id });
  await auditar(req, { modulo: 'compras', accion: 'aprobar_orden_pago', entidad: 'cmp_orden_pago', entidad_id: String(o.id), detalle: `aprobó ${a.supervisor.username}` });
  res.json(o);
}));
router.post('/ordenes-pago/:id/ejecutar', requierePermiso('compras.ordenes.ejecutar'), manejar(async (req, res) => {
  const o = await Ordenes.ejecutar(Number(req.params.id), req.body ?? {}, { userId: req.usuario.sub });
  await auditar(req, { modulo: 'compras', accion: 'ejecutar_orden_pago', entidad: 'cmp_orden_pago', entidad_id: String(o.id), detalle: o.estado });
  res.json(o);
}));
router.post('/ordenes-pago/:id/anular', requierePermiso('compras.ordenes.anular'), manejar(async (req, res) => {
  const o = await Ordenes.anular(Number(req.params.id), req.body ?? {}, { userId: req.usuario.sub });
  await auditar(req, { modulo: 'compras', accion: 'anular_orden_pago', entidad: 'cmp_orden_pago', entidad_id: String(o.id), detalle: req.body?.motivo });
  res.json(o);
}));
router.post('/ordenes-pago/avisos-programadas', CREAR, manejar(async (req, res) => res.json(await Ordenes.avisarProgramadas())));
router.get('/anticipos', VER, manejar(async (req, res) => res.json(await Ordenes.anticipos({ proveedorId: req.query.proveedor_id }))));

router.get('/retenciones/regimenes', VER, manejar(async (req, res) => res.json(await Retenciones.regimenes())));
router.post('/retenciones/regimenes', CONFIGURAR_RET, manejar(async (req, res) => {
  const r = await Retenciones.crearRegimen(req.body);
  await auditar(req, { modulo: 'compras', accion: 'alta_regimen_retencion', entidad: 'cmp_regimen', entidad_id: String(r.id), detalle: r.codigo });
  res.status(201).json(r);
}));
router.put('/retenciones/regimenes/:id', CONFIGURAR_RET, manejar(async (req, res) => res.json(await Retenciones.actualizarRegimen(Number(req.params.id), req.body))));
router.post('/retenciones/regimenes/:id/padron', CONFIGURAR_RET, manejar(async (req, res) => res.json(await Retenciones.importarPadron(Number(req.params.id), req.body.contenido))));
router.get('/retenciones/certificados', VER, manejar(async (req, res) => res.json(await Retenciones.certificados({ regimenId: req.query.regimen_id, desde: req.query.desde, hasta: req.query.hasta, proveedorId: req.query.proveedor_id }))));
router.get('/retenciones/exportar', VER, manejar(async (req, res) => {
  const r = await Retenciones.exportar({ regimenId: req.query.regimen_id, desde: req.query.desde, hasta: req.query.hasta });
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="retenciones.csv"').send(r.csv);
}));

module.exports = router;
