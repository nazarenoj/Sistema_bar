// Ganchos entre los servicios de la tienda: el cobro avisa que un pedido quedó pagado y otros pasos (entrega a Ventas, notificaciones al cliente) se suscriben.
const alPagado = [];
const alCambiarEstado = [];
module.exports = {
  suscribirPagado: (fn) => alPagado.push(fn),
  suscribirEstado: (fn) => alCambiarEstado.push(fn),
  pagado: async (pedidoId) => { for (const fn of alPagado) await fn(pedidoId); },
  estado: async (pedidoId, estado, detalle) => { for (const fn of alCambiarEstado) await fn(pedidoId, estado, detalle); },
};
