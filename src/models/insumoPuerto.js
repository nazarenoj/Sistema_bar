const Mov = require('../stock/movimientoService');
const Receta = require('../stock/recetaService');
require('../stock/descuentoReceptor'); // Stock aplica los mensajes de descuento y reingreso de Ventas
const puertos = require('../modulos/puertos');

// Implementación de Stock del puerto "stock" que define Ventas (Índice B.2): el descuento de
// insumos por receta al cerrar una venta. Sin Stock instalado, Ventas usa la implementación nula.
puertos.registrar('stock', {
  disponibilidad: async () => ({ bloqueado: false }), // el bloqueo por existencias llega con Stock C3
  recetaCambiada: (productoId, userId) => Receta.snapshot(productoId, userId),
  saldoInicial: (item, cantidad, conn, userId) => Mov.saldoInicial(item, cantidad, conn, userId),
});
