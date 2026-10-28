const { Router } = require('express');
const {
  create, addProductos, addProductosPorNombre, cerrarPedido, removePedido, removeItem,
  marcarItemEntregado, marcarPedidoEntregado, getHistorial, getReporte, getEstadisticas, getOne,
} = require('../controllers/pedidoController');
const { ticketPedido } = require('../controllers/ticketController');

const { requierePermiso } = require('../middleware/requierePermiso');
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
router.patch('/:id/entregado', requierePermiso('ventas.pedidos.operar'), marcarPedidoEntregado);
router.patch('/:id/productos/:itemId/entregado', requierePermiso('ventas.pedidos.operar'), marcarItemEntregado);
router.delete('/:id/productos/:itemId', requierePermiso('ventas.pedidos.anular'), removeItem);
router.delete('/:id', requierePermiso('ventas.pedidos.anular'), removePedido);

module.exports = router;
