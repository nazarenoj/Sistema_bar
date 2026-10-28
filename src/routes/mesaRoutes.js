const { Router } = require('express');
const {
  getAll, create, cerrarCuenta, confirmarTicket, remove, getPedidosActivos,
  updatePosicion, updateColor, updateTamano, combinar, separar,
} = require('../controllers/mesaController');
const { create: crearSilla } = require('../controllers/sillaController');
const { ticketCuentaMesa, comandaMesa } = require('../controllers/ticketController');

const { requierePermiso } = require('../middleware/requierePermiso');
const router = Router();

router.get('/', requierePermiso('ventas.pedidos.operar'), getAll);
router.post('/', requierePermiso('ventas.salon.configurar'), create);
router.post('/combinar', requierePermiso('ventas.salon.configurar'), combinar);
router.post('/grupos/:grupoId/separar', requierePermiso('ventas.salon.configurar'), separar);
router.get('/:id/pedidos-activos', requierePermiso('ventas.pedidos.operar'), getPedidosActivos);
router.get('/:id/ticket', requierePermiso('ventas.pedidos.operar'), ticketCuentaMesa);
router.get('/:id/comanda', requierePermiso('ventas.pedidos.operar'), comandaMesa);
router.patch('/:id/posicion', requierePermiso('ventas.salon.configurar'), updatePosicion);
router.patch('/:id/color', requierePermiso('ventas.salon.configurar'), updateColor);
router.patch('/:id/tamano', requierePermiso('ventas.salon.configurar'), updateTamano);
router.post('/:id/cerrar', requierePermiso('ventas.cuenta.cobrar'), cerrarCuenta);
router.post('/:id/confirmar-ticket', requierePermiso('ventas.cuenta.cobrar'), confirmarTicket);
router.post('/:id/sillas', requierePermiso('ventas.salon.configurar'), crearSilla);
router.delete('/:id', requierePermiso('ventas.salon.configurar'), remove);

module.exports = router;
