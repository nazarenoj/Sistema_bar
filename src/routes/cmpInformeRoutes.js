const { Router } = require('express');
const Devoluciones = require('../compras/devolucionService');
const Informes = require('../compras/informeService');
const { manejar } = require('../compras/comun');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const { enviarReporte, FORMATOS_VALIDOS } = require('../servicios/reporteService');

// Devolución a proveedor y nota de crédito (Compras RF25) y consultas e informes (RF16).
const router = Router();
router.use(requiereModulo('compras'));

router.get('/devoluciones', requierePermiso('compras.devoluciones.ver'), manejar(async (req, res) => res.json(await Devoluciones.listar({ proveedorId: req.query.proveedor_id, estado: req.query.estado }))));
router.post('/comprobantes/:id/vincular-devoluciones', requierePermiso('compras.devoluciones.vincular'), manejar(async (req, res) => {
  const r = await Devoluciones.vincular(Number(req.params.id), req.body ?? {}, { userId: req.usuario.sub });
  await auditar(req, { modulo: 'compras', accion: 'vincular_devolucion', entidad: 'cmp_comprobante', entidad_id: String(r.comprobante_id), detalle: `${r.devoluciones.length} devoluciones, diferencia ${r.diferencia}` });
  res.json(r);
}));

router.get('/informes', requierePermiso('compras.informes.ver'), manejar(async (req, res) => res.json(Informes.tipos())));
router.get('/informes/:tipo', requierePermiso('compras.informes.ver'), manejar(async (req, res) => {
  const r = await Informes.ejecutar(req.params.tipo, req.query);
  if (!req.query.formato) return res.json(r);
  if (!FORMATOS_VALIDOS.includes(req.query.formato)) return res.status(400).json({ error: `"formato" debe ser uno de: ${FORMATOS_VALIDOS.join(', ')}.` });
  await auditar(req, { modulo: 'compras', accion: 'exportar_informe', entidad: 'informe_compras', entidad_id: r.tipo, detalle: req.query.formato });
  await enviarReporte(res, { titulo: r.titulo, subtitulo: '', filtros: [], resumen: [{ label: 'Filas', valor: r.filas.length, tipo: 'numero' }], hojas: [{ nombre: r.titulo.slice(0, 28), columnas: r.columnas, filas: r.filas }] }, req.query.formato, `compras-${r.tipo}`);
}));

module.exports = router;
