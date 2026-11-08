const Limitador = require('./limitador');
const Tienda = require('./tiendaService');

// Los límites de la parte pública, compartidos por las rutas (Ventas Online RN56): uno general por IP y uno de pedidos por hora que fija cada tienda.
const general = Limitador.crear({ ventanaMs: 60000, maximo: 120 });
const pedidos = Limitador.crear({ ventanaMs: 3600000, maximo: 20, mensaje: 'Hiciste demasiados pedidos seguidos. Probá más tarde.' });
const limitePedidos = pedidos.middleware(async () => (await Tienda.fila()).limite_pedidos_ip_hora);

module.exports = { general, pedidos, limitePedidos };
