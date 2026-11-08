const Mov = require('../stock/movimientoService');
const Receta = require('../stock/recetaService');
const Costos = require('../stock/costoService');
const Compromiso = require('../stock/compromisoService');
require('../stock/descuentoReceptor'); // Stock aplica los mensajes de descuento y reingreso de Ventas
const Alergenos = require('../stock/alergenoService');
const Etiquetas = require('../stock/etiquetaService');
const Series = require('../stock/serieService');
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
  comprometer: async (items, ctx) => {
    const r = await Compromiso.comprometer({ idSolicitud: ctx.idSolicitud, lineas: items.map((i, linea) => ({ linea, producto_id: i.producto_id, cantidad: i.cantidad, lote_indicado: i.lote_indicado ?? null })), reemplazaA: ctx.reemplazaA, userId: ctx.userId });
    if (!r.ok || !items.some((i) => i.serie)) return r;
    // Las series de las líneas pasan de Disponible a Comprometida con el cierre (Ventas RN05); si alguna no sirve se informa su estado (EX33).
    const s = await Series.comprometerParaVenta(items.filter((i) => i.serie), `SER:${ctx.idSolicitud}`, { userId: ctx.userId });
    if (s.ok) return r;
    if (r.id_compromiso) await Compromiso.liberar(r.id_compromiso);
    return { ok: false, serie_no_disponible: s.no_disponible };
  },
  disponibleUnidades: (productoId) => Compromiso.disponibleUnidades(productoId),
  verificar: (items) => Compromiso.verificar(items.map((i, linea) => ({ linea, producto_id: i.producto_id, cantidad: i.cantidad }))),
  estadoSerie: (productoId, numero) => Series.estadoParaVenta(productoId, numero),
  liberarSeries: (idSolicitud) => Series.liberarPorCompromiso(`SER:${idSolicitud}`),
  seriesVigentes: () => Series.vigentes(),
  renovarCompromiso: (id) => Compromiso.renovar(id),
  liberarCompromiso: (id) => Compromiso.liberar(id),
  // Alérgenos de una línea de venta (RF39): { alergenos, incompletos }; Ventas los muestra y los publica.
  alergenosLinea: (productoId, opciones, opcionIds = []) => Alergenos.linea(productoId, opciones, undefined, opcionIds),
  // Etiqueta propia de peso (RN82, EX59): Stock valida prefijo y verificador y devuelve artículo y peso.
  validarEtiqueta: (codigo) => Etiquetas.validar(codigo),
  saldoInicial: (item, cantidad, conn, userId) => Mov.saldoInicial(item, cantidad, conn, userId),
});
