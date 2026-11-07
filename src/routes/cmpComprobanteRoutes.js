const express = require('express');
const Comprobantes = require('../compras/comprobanteService');
const Ingresos = require('../compras/ingresoService');
const { manejar, puede } = require('../compras/comun');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Comprobantes de compra (Compras RF03), períodos de IVA (RN12) y carga por foto o QR (CMP-FOTO).
const router = express.Router();
router.use(requiereModulo('compras'));
const VER = requierePermiso('compras.comprobantes.ver');
const REGISTRAR = requierePermiso('compras.comprobantes.registrar');
const archivo = express.raw({ type: ['image/jpeg', 'image/png', 'application/pdf'], limit: '12mb' });

const contexto = async (req) => ({
  userId: req.usuario.sub, idSolicitud: req.get('X-ID-Solicitud') ?? null, autorizanteId: req.autorizadoPor?.id ?? null,
  puedeCrearPresentacion: await puede(req, 'stock.movimientos.registrar'),
  auditar: (accion, detalle) => auditar(req, { modulo: 'compras', accion, resultado: /duplicado|repetido|proceso/.test(accion) ? 'denegado' : 'ok', entidad: 'cmp_comprobante', detalle }),
});
// Un casi duplicado lo confirma quien tiene el permiso, con su motivo (RN03, RN29).
const conPermisoDeParecido = async (req) => {
  if (req.body?.confirmar_casi_duplicado && !(await puede(req, 'compras.comprobantes.confirmar_parecido'))) {
    const e = new (require('../compras/comun').CompraInvalida)('Confirmar un casi duplicado necesita su permiso.'); e.status = 403; e.codigo = 'SIN_PERMISO'; throw e;
  }
};

router.get('/comprobantes', VER, manejar(async (req, res) => {
  const q = req.query;
  res.json(await Comprobantes.listar({ proveedorId: q.proveedor_id, desde: q.desde, hasta: q.hasta, clase: q.clase, estado: q.estado, periodo: q.periodo, limite: q.limite }));
}));
router.get('/comprobantes/:id', VER, manejar(async (req, res) => res.json(await Comprobantes.obtener(Number(req.params.id)))));
router.post('/comprobantes', REGISTRAR, manejar(async (req, res) => {
  await conPermisoDeParecido(req);
  const c = await Comprobantes.registrar(req.body, await contexto(req));
  await auditar(req, { modulo: 'compras', accion: 'registrar_comprobante', entidad: 'cmp_comprobante', entidad_id: String(c.id), detalle: `${c.clase} ${c.tipo} ${c.punto_venta}-${c.numero} ${c.total} (${c.estado})` });
  res.status(201).json(c);
}));
router.post('/comprobantes/foto', REGISTRAR, archivo, manejar(async (req, res) => res.json(await Comprobantes.leerFoto({ imagen: req.body, tipo: req.get('Content-Type') }))));
router.post('/comprobantes/qr', REGISTRAR, manejar(async (req, res) => res.json(await Comprobantes.leerQr(req.body?.texto))));
router.post('/comprobantes/:id/confirmar', REGISTRAR, manejar(async (req, res) => {
  await conPermisoDeParecido(req);
  const c = await Comprobantes.confirmarBorrador(Number(req.params.id), { ...(await contexto(req)), confirmar_casi_duplicado: req.body?.confirmar_casi_duplicado });
  await auditar(req, { modulo: 'compras', accion: 'confirmar_comprobante_borrador', entidad: 'cmp_comprobante', entidad_id: String(c.id) });
  res.json(c);
}));
router.post('/comprobantes/:id/anular', requierePermiso('compras.comprobantes.anular'), manejar(async (req, res) => {
  const c = await Comprobantes.anular(Number(req.params.id), req.body, { userId: req.usuario.sub });
  await auditar(req, { modulo: 'compras', accion: 'anular_comprobante', entidad: 'cmp_comprobante', entidad_id: String(c.id), detalle: req.body.motivo });
  res.json(c);
}));

// Vínculo con los ingresos de Stock y recepción con lotes y series (RF04, RF19, RF24).
const VINCULAR = requierePermiso('compras.ingresos.vincular');
router.get('/comprobantes/:id/ingresos-pendientes', VER, manejar(async (req, res) => res.json(await Ingresos.pendientes(Number(req.params.id)))));
router.get('/comprobantes/:id/vinculos', VER, manejar(async (req, res) => res.json(await Ingresos.vinculos(Number(req.params.id)))));
router.post('/comprobantes/:id/vincular', VINCULAR, manejar(async (req, res) => {
  const r = await Ingresos.vincular(Number(req.params.id), req.body.ingreso_ids, { userId: req.usuario.sub });
  await auditar(req, { modulo: 'compras', accion: 'vincular_ingreso', entidad: 'cmp_comprobante', entidad_id: req.params.id, detalle: JSON.stringify(req.body.ingreso_ids) });
  res.json(r);
}));
router.post('/comprobantes/:id/desvincular', VINCULAR, manejar(async (req, res) => {
  const r = await Ingresos.desvincular(Number(req.params.id), Number(req.body.vinculo_id), req.body, { userId: req.usuario.sub });
  await auditar(req, { modulo: 'compras', accion: 'desvincular_ingreso', entidad: 'cmp_comprobante', entidad_id: req.params.id, detalle: req.body.motivo });
  res.json(r);
}));
router.post('/comprobantes/:id/generar-ingreso', VINCULAR, manejar(async (req, res) => {
  const r = await Ingresos.generar(Number(req.params.id), req.body, { userId: req.usuario.sub, puedeLotes: await puede(req, 'compras.lotes.cargar') });
  await auditar(req, { modulo: 'compras', accion: 'generar_ingreso', entidad: 'cmp_comprobante', entidad_id: req.params.id, detalle: `depósito ${req.body.deposito_id}` });
  res.status(201).json(r);
}));
router.get('/reclamos', VER, manejar(async (req, res) => res.json(await Ingresos.reclamos())));

router.get('/periodos-iva', VER, manejar(async (req, res) => res.json(await Comprobantes.periodos())));
router.post('/periodos-iva/:periodo/cerrar', requierePermiso('compras.periodos.cerrar'), manejar(async (req, res) => {
  const p = await Comprobantes.cerrarPeriodo(req.params.periodo, req.usuario.sub);
  await auditar(req, { modulo: 'compras', accion: 'cerrar_periodo_iva', entidad: 'cmp_periodo', entidad_id: p.periodo });
  res.json(p);
}));

module.exports = router;
