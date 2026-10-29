const Mov = require('../stock/movimientoService');
const puertos = require('../modulos/puertos');

// Implementación de Stock del puerto "stock" que define Ventas (Índice B.2): el descuento de
// insumos por receta al cerrar una venta. Sin Stock instalado, Ventas usa la implementación nula.
puertos.registrar('stock', {
  disponibilidad: async () => ({ bloqueado: false }), // el bloqueo por existencias llega con Stock C3
  descontarPorVenta: (items, conn, ctx) => Mov.descontarPorVenta(items, conn, ctx),
  reingresarPorDevolucion: (items, conn, ctx) => Mov.reingresarPorDevolucion(items, conn, ctx),
  saldoInicial: (item, cantidad, conn, userId) => Mov.saldoInicial(item, cantidad, conn, userId),
});
