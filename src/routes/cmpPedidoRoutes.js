const { Router } = require('express');
const Pedidos = require('../compras/pedidoService');
const { manejar } = require('../compras/comun');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Pedidos a proveedores (Compras RF12) y pedido sugerido (RF20).
const router = Router();
router.use(requiereModulo('compras'));
const VER = requierePermiso('compras.pedidos.ver'), ARMAR = requierePermiso('compras.pedidos.armar'), CONFIRMAR = requierePermiso('compras.pedidos.confirmar'), ENVIAR = requierePermiso('compras.pedidos.enviar');
const ctx = (req) => ({ userId: req.usuario.sub });
const aud = (req, accion, p, detalle) => auditar(req, { modulo: 'compras', accion, entidad: 'cmp_pedido', entidad_id: String(p.id), detalle: detalle ?? `${p.proveedor} (${p.estado})` });

router.get('/pedidos', VER, manejar(async (req, res) => res.json(await Pedidos.listar({ proveedorId: req.query.proveedor_id, estado: req.query.estado, limite: req.query.limite }))));
router.get('/pedidos/sugerencia', VER, manejar(async (req, res) => res.json(await Pedidos.sugerencia({ depositoId: req.query.deposito_id ? Number(req.query.deposito_id) : undefined }))));
router.post('/pedidos/desde-sugerencia', CONFIRMAR, manejar(async (req, res) => {
  const p = await Pedidos.crearDesdeSugerencia(req.body ?? {}, ctx(req));
  await aud(req, 'crear_pedido_sugerido', p);
  res.status(201).json(p);
}));
router.get('/pedidos/:id', VER, manejar(async (req, res) => res.json(await Pedidos.obtener(Number(req.params.id)))));
router.get('/pedidos/:id/pdf', VER, manejar(async (req, res) => { res.type('application/pdf').send(await Pedidos.pdf(Number(req.params.id))); }));
router.post('/pedidos', ARMAR, manejar(async (req, res) => {
  const p = await Pedidos.crear(req.body ?? {}, ctx(req));
  await aud(req, 'crear_pedido', p);
  res.status(201).json(p);
}));
router.put('/pedidos/:id', ARMAR, manejar(async (req, res) => {
  const p = await Pedidos.editar(Number(req.params.id), req.body ?? {}, ctx(req));
  await aud(req, 'editar_pedido', p);
  res.json(p);
}));
router.post('/pedidos/:id/confirmar', CONFIRMAR, manejar(async (req, res) => {
  const p = await Pedidos.confirmar(Number(req.params.id), ctx(req));
  await aud(req, 'confirmar_pedido', p);
  res.json(p);
}));
router.post('/pedidos/:id/enviar', ENVIAR, manejar(async (req, res) => {
  const p = await Pedidos.enviar(Number(req.params.id), req.body ?? {});
  await aud(req, 'enviar_pedido', p, `${p.proveedor} a ${p.enviado_a}`);
  res.json(p);
}));
router.post('/pedidos/:id/reemplazar', ENVIAR, manejar(async (req, res) => {
  const p = await Pedidos.reemplazar(Number(req.params.id), req.body ?? {}, ctx(req));
  await aud(req, 'reemplazar_pedido', p, `reemplaza al ${p.reemplaza_id}`);
  res.status(201).json(p);
}));
router.post('/pedidos/:id/cancelar', CONFIRMAR, manejar(async (req, res) => {
  const p = await Pedidos.cancelar(Number(req.params.id), req.body ?? {});
  await aud(req, 'cancelar_pedido', p, p.motivo_cancelacion);
  res.json(p);
}));
router.post('/pedidos/:id/recepcion', ARMAR, manejar(async (req, res) => {
  const p = await Pedidos.marcarRecepcion(Number(req.params.id), req.body ?? {});
  await aud(req, 'recepcion_pedido', p);
  res.json(p);
}));

module.exports = router;
