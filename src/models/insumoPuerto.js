const Mov = require('../stock/movimientoService');
const Receta = require('../stock/recetaService');
const Costos = require('../stock/costoService');
const Compromiso = require('../stock/compromisoService');
require('../stock/descuentoReceptor'); // Stock aplica los mensajes de descuento y reingreso de Ventas
const Alergenos = require('../stock/alergenoService');
const Etiquetas = require('../stock/etiquetaService');
const puertos = require('../modulos/puertos');

// Implementación de Stock del puerto "stock" que define Ventas (Índice B.2): el descuento de
// insumos por receta al cerrar una venta. Sin Stock instalado, Ventas usa la implementación nula.
// Costo de inventario y de receta (RN62): CI o CP de un artículo, con su tipo, fecha y marcas "parcial" / "sin costo".
// Stock informa; la prioridad entre CR, CI y CP es de Ventas.
puertos.registrar('costoInventario', { costo: (productoId) => Costos.costoArticulo(productoId) });

puertos.registrar('stock', {
  disponibilidad: async () => ({ bloqueado: false }), // el bloqueo por existencias llega con Stock C3
  recetaCambiada: (productoId, userId) => Receta.snapshot(productoId, userId),
  // Compromiso de venta (RF36): items = filas con producto_id y cantidad, en el orden de la venta.
  comprometer: (items, ctx) => Compromiso.comprometer({ idSolicitud: ctx.idSolicitud, lineas: items.map((i, linea) => ({ linea, producto_id: i.producto_id, cantidad: i.cantidad, lote_indicado: i.lote_indicado ?? null })), reemplazaA: ctx.reemplazaA, userId: ctx.userId }),
  renovarCompromiso: (id) => Compromiso.renovar(id),
  liberarCompromiso: (id) => Compromiso.liberar(id),
  // Alérgenos de una línea de venta (RF39): { alergenos, incompletos }; Ventas los muestra y los publica.
  alergenosLinea: (productoId, opciones) => Alergenos.linea(productoId, opciones),
  // Etiqueta propia de peso (RN82, EX59): Stock valida prefijo y verificador y devuelve artículo y peso.
  validarEtiqueta: (codigo) => Etiquetas.validar(codigo),
  saldoInicial: (item, cantidad, conn, userId) => Mov.saldoInicial(item, cantidad, conn, userId),
});
