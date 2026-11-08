// Ganchos entre los servicios de la tienda: el cobro avisa que un pedido quedó pagado y otros pasos (entrega a Ventas, avisos al cliente, facturación) se suscriben. Se ejecutan por prioridad
// (menor primero): primero el pedido pasa a Ventas, recién después se factura.
const alPagado = [], alCambiarEstado = [], alFacturado = [];
const agregar = (lista, fn, prioridad = 0) => { lista.push({ fn, prioridad }); lista.sort((a, b) => a.prioridad - b.prioridad); };
const correr = async (lista, ...args) => { for (const { fn } of lista) await fn(...args); };
module.exports = {
  suscribirPagado: (fn, prioridad) => agregar(alPagado, fn, prioridad),
  suscribirEstado: (fn, prioridad) => agregar(alCambiarEstado, fn, prioridad),
  suscribirFacturado: (fn, prioridad) => agregar(alFacturado, fn, prioridad),
  pagado: (pedidoId) => correr(alPagado, pedidoId),
  estado: (pedidoId, estado, detalle) => correr(alCambiarEstado, pedidoId, estado, detalle),
  facturado: (pedidoId) => correr(alFacturado, pedidoId),
};
