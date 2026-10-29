const Insumo = require('./insumoModel');
const puertos = require('../modulos/puertos');

// Implementación de Stock del puerto "stock" que define Ventas (Índice B.2): el descuento de
// insumos por receta al cerrar una venta. Sin Stock instalado, Ventas usa la implementación nula.
puertos.registrar('stock', {
  disponibilidad: async () => ({ bloqueado: false }), // el bloqueo por existencias llega con Stock C3
  descontarPorVenta: (items, conn) => Insumo.decrementarStockPorVenta(items, conn),
  reingresarPorDevolucion: (items, conn) => Insumo.incrementarStockPorDevolucion(items, conn),
});
