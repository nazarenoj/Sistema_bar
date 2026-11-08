const { TiendaInvalida } = require('./tiendaService');

// Entrega del pedido (Ventas Online RF11, RF26): retiro en barra y delivery propio. El costo del delivery y las franjas se completan en I7.
const invalida = (m, status = 400, extra = {}) => Object.assign(new TiendaInvalida(m), { status, ...extra });

// -> { tipo, costo, gratis, datos }
const cotizar = async ({ tipo, direccion, subtotal }) => {
  void direccion; void subtotal;
  if (tipo === 'retiro') return { tipo, costo: 0, gratis: false, datos: {} };
  throw invalida('Ese método de entrega no está disponible.', 409, { codigo: 'ENTREGA_NO_DISPONIBLE' });
};

module.exports = { cotizar };
