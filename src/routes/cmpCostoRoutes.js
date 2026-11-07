const { Router } = require('express');
const Costos = require('../compras/costoService');
const Listas = require('../compras/listaProveedorService');
const { manejar } = require('../compras/comun');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Costo de reposición (Compras RF11) y listas de precios de proveedor (RF10).
const router = Router();
router.use(requiereModulo('compras'));
const VER = requierePermiso('compras.costos.ver');
const item = (req) => ({ tipo: req.params.tipo, id: Number(req.params.id) });

router.get('/costos', VER, manejar(async (req, res) => res.json(await Costos.consulta({ proveedorId: req.query.proveedor_id, limite: req.query.limite }))));
router.get('/costos/pendientes', VER, manejar(async (req, res) => res.json(await Costos.pendientes(req.query.estado))));
router.post('/costos/pendientes/:id/confirmar', requierePermiso('compras.costos.confirmar'), manejar(async (req, res) => {
  const r = await Costos.confirmar(Number(req.params.id), req.usuario.sub);
  await auditar(req, { modulo: 'compras', accion: 'confirmar_costo', entidad: 'cmp_costos_pendientes', entidad_id: String(r.id), detalle: `${r.item_tipo}:${r.item_id} a ${r.costo_propuesto}` });
  res.json(r);
}));
router.post('/costos/pendientes/:id/rechazar', requierePermiso('compras.costos.confirmar'), manejar(async (req, res) => {
  const r = await Costos.rechazar(Number(req.params.id), req.usuario.sub);
  await auditar(req, { modulo: 'compras', accion: 'rechazar_costo', entidad: 'cmp_costos_pendientes', entidad_id: String(r.id), detalle: `${r.item_tipo}:${r.item_id}` });
  res.json(r);
}));
router.get('/costos/:tipo/:id/historial', VER, manejar(async (req, res) => res.json(await Costos.historial(item(req)))));
router.put('/costos/:tipo/:id', requierePermiso('compras.costos.editar'), manejar(async (req, res) => {
  const r = await Costos.ajustar(item(req), req.body ?? {}, req.usuario.sub);
  await auditar(req, { modulo: 'compras', accion: 'ajustar_costo', entidad: 'cmp_costos_reposicion', entidad_id: `${r.item_tipo}:${r.item_id}`, detalle: `${r.costo} ${r.moneda}: ${r.fuente_ref}` });
  res.json(r);
}));

const GESTIONAR = requierePermiso('compras.listas.gestionar');
router.get('/listas', VER, manejar(async (req, res) => res.json(await Listas.listar({ proveedorId: req.query.proveedor_id, estado: req.query.estado }))));
router.get('/listas/:id', VER, manejar(async (req, res) => res.json(await Listas.obtener(Number(req.params.id)))));
router.post('/listas/vista-previa', GESTIONAR, manejar(async (req, res) => res.json(await Listas.vistaPrevia(req.body ?? {}))));
router.post('/listas', GESTIONAR, manejar(async (req, res) => {
  const l = await Listas.guardar(req.body ?? {}, req.usuario.sub);
  await auditar(req, { modulo: 'compras', accion: 'cargar_lista', entidad: 'cmp_listas_proveedor', entidad_id: String(l.id), detalle: `${l.proveedor}: ${l.lineas.length} líneas` });
  res.status(201).json(l);
}));

module.exports = router;
