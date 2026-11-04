const { Router } = require('express');
const {
  create, moverMesa, dividir, addProductos, addProductosPorNombre, cerrarPedido, removePedido, removeItem,
  marcarItemEntregado, marcarPedidoEntregado, getHistorial, getReporte, getEstadisticas, getOne,
} = require('../controllers/pedidoController');
const { ticketPedido } = require('../controllers/ticketController');

const { requierePermiso } = require('../middleware/requierePermiso');
const pool = require('../config/db');
const Listas = require('../services/listaPrecioService');
const router = Router();

router.post('/', requierePermiso('ventas.pedidos.operar'), create);
router.get('/historial', requierePermiso('ventas.historial.ver'), getHistorial);
router.get('/estadisticas', requierePermiso('ventas.historial.ver'), getEstadisticas);
router.get('/reporte', requierePermiso('ventas.historial.exportar'), getReporte);
router.get('/:id', requierePermiso('ventas.pedidos.operar'), getOne);
router.get('/:id/ticket', requierePermiso('ventas.pedidos.operar'), ticketPedido);
router.post('/:id/productos', requierePermiso('ventas.pedidos.operar'), addProductos);
router.post('/:id/productos/nombre', requierePermiso('ventas.pedidos.operar'), addProductosPorNombre);
router.post('/:id/cerrar', requierePermiso('ventas.cuenta.cobrar'), cerrarPedido);
router.patch('/:id/mesa', requierePermiso('ventas.pedidos.operar'), moverMesa);
router.post('/:id/dividir', requierePermiso('ventas.pedidos.operar'), dividir);
router.patch('/:id/entregado', requierePermiso('ventas.pedidos.operar'), marcarPedidoEntregado);
router.patch('/:id/productos/:itemId/entregado', requierePermiso('ventas.pedidos.operar'), marcarItemEntregado);
// Quitar un ítem ya enviado a producción pide además el permiso propio (con autorización de supervisor si el rol no lo tiene permitido).
const siEnviado = async (req, res, next) => {
  try {
    const [[it]] = await pool.query('SELECT enviado_at FROM pedido_productos WHERE id = ?', [req.params.itemId]);
    return it?.enviado_at ? requierePermiso('ventas.pedidos.quitar_enviado')(req, res, next) : next();
  } catch (err) { next(err); }
};
router.delete('/:id/productos/:itemId', requierePermiso('ventas.pedidos.anular'), siEnviado, removeItem);
// Identificar al cliente del pedido (cliente_id o null para quitarlo): aplica su lista de precios si tiene una vigente (Ventas RN81).
router.put('/:id/cliente', requierePermiso('ventas.pedidos.operar'), async (req, res, next) => {
  const cid = req.body?.cliente_id ?? null;
  if (cid !== null && !Number.isInteger(cid)) return res.status(400).json({ error: '"cliente_id" debe ser un entero o null.' });
  try { res.json(await Listas.asignarCliente(Number(req.params.id), cid)); } catch (err) {
    if (err instanceof Listas.ListaInvalida) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});
router.delete('/:id', requierePermiso('ventas.pedidos.anular'), removePedido);

module.exports = router;
