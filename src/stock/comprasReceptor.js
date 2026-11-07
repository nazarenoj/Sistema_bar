const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const Mov = require('./movimientoService');
const Lotes = require('./loteService');
const Serie = require('./serieService');

// Stock frente a Compras (Compras RF04, RF19, RF24, RN33, RN37): expone hacia abajo los ingresos «Pendientes de factura» y su detalle, y recibe como mensajes la vinculación y
// desvinculación de un comprobante con un ingreso y la generación de un ingreso desde la factura (con sus lotes y series). Compras nunca escribe en las tablas de Stock.
const pendientesDeFactura = async ({ cuit, proveedor } = {}) => {
  const [filas] = await pool.query(
    `SELECT i.id_global, i.proveedor, i.comprobante_cuit, i.comprobante_clase, i.comprobante_tipo, i.comprobante_pto, i.comprobante_numero, i.created_at,
       (SELECT COUNT(*) FROM stock_movimientos m WHERE m.documento_tipo = 'ingreso' AND m.documento = i.id_global) AS lineas
     FROM stock_ingresos i WHERE i.compras_comprobante IS NULL AND i.motivo = 'compra' AND (i.comprobante_cuit = ? OR i.proveedor = ?) ORDER BY i.id DESC LIMIT 200`, [cuit ?? '', proveedor ?? '']);
  return filas.map((f) => ({ ingreso_id_global: f.id_global, proveedor: f.proveedor, comprobante: f.comprobante_numero ? `${f.comprobante_clase ?? ''} ${f.comprobante_tipo ?? ''} ${f.comprobante_pto ?? ''}-${f.comprobante_numero}`.trim() : null, lineas: Number(f.lineas), fecha: f.created_at }));
};

// Lo que entró en un ingreso, por ítem, en la unidad base: la base para comparar con la factura (EX06).
const detalle = async (idGlobal) => {
  const [[ing]] = await pool.query('SELECT id_global, deposito_id, proveedor, compras_comprobante FROM stock_ingresos WHERE id_global = ?', [idGlobal]);
  if (!ing) return null;
  const [movs] = await pool.query(
    `SELECT insumo_id, producto_id, SUM(cantidad) AS cantidad, MAX(costo_unitario) AS costo_unitario FROM stock_movimientos WHERE documento_tipo = 'ingreso' AND documento = ? GROUP BY insumo_id, producto_id`, [idGlobal]);
  return { ...ing, items: movs.map((m) => ({ item_tipo: m.insumo_id ? 'insumo' : 'producto', item_id: m.insumo_id ?? m.producto_id, cantidad: Number(m.cantidad), costo_unitario: m.costo_unitario === null ? null : Number(m.costo_unitario) })) };
};

// Si un ítem se maneja con lote o con número de serie (con las funciones de Stock activas).
const controles = async (item) => ({ lote: await Lotes.controla(pool, item).catch(() => false), serie: item.tipo === 'producto' ? await Serie.controla(pool, item.id).catch(() => false) : false });

const rechazo = (err) => (err && err.status && err.status < 500 && !(err instanceof M.RechazoNegocio) ? new M.RechazoNegocio(err.message) : err);

M.registrarReceptor('stock', 'vincular_ingreso', async (conn, c) => {
  const [[ing]] = await conn.query('SELECT id_global, compras_comprobante FROM stock_ingresos WHERE id_global = ? FOR UPDATE', [c.ingreso_id_global]);
  if (!ing) throw new M.RechazoNegocio('El ingreso no existe.');
  if (ing.compras_comprobante && ing.compras_comprobante !== c.comprobante_id_global) throw new M.RechazoNegocio('El ingreso ya está vinculado a otra factura.'); // EX19
  await conn.query('UPDATE stock_ingresos SET compras_comprobante = ? WHERE id_global = ?', [c.comprobante_id_global, c.ingreso_id_global]);
  return { vinculado: true };
});

M.registrarReceptor('stock', 'desvincular_ingreso', async (conn, c) => {
  await conn.query('UPDATE stock_ingresos SET compras_comprobante = NULL WHERE id_global = ? AND compras_comprobante = ?', [c.ingreso_id_global, c.comprobante_id_global]);
  return { desvinculado: true };
}, { revierte: 'vincular_ingreso' });

// Genera el ingreso desde la factura (RF04). Idempotente por el comprobante: un reintento devuelve el ingreso que ya se hizo. Los lotes viajan como líneas del mismo ítem; los ítems
// serializados entran con sus números de serie, uno por unidad (RF24). Un lote automático (CMP-RECEPCION-LOTES inactiva) toma el vencimiento por la vida útil del ítem (RN39).
M.registrarReceptor('stock', 'generar_ingreso', async (conn, c) => {
  const [[ya]] = await conn.query('SELECT id_global FROM stock_ingresos WHERE compras_comprobante = ? LIMIT 1', [c.comprobante_id_global]);
  if (ya) return { ingreso_id_global: ya.id_global, ya_generado: true };
  const hoy = new Date().toISOString().slice(0, 10);
  const comunes = c.lineas.filter((l) => !(l.series?.length));
  let ingreso = null;
  try {
    if (comunes.length) {
      ingreso = await Mov.ingresar({
        deposito_id: c.deposito_id, motivo: 'compra', proveedor: c.proveedor, comprobante: { ...c.comprobante, id_clave: c.comprobante?.id_clave },
        lineas: comunes.map((l) => ({ item: l.item, cantidad: l.cantidad, presentacion_id: l.presentacion_id ?? undefined, costo_unitario: l.costo_unitario,
          lote: l.lote ?? (l.lote_automatico ? { codigo: `AUTO-${hoy}-${String(c.comprobante_id_global).slice(-6)}`, fecha_elaboracion: hoy } : undefined) })),
      }, { userId: c.user_id ?? null });
      await conn.query('UPDATE stock_ingresos SET compras_comprobante = ? WHERE id_global = ?', [c.comprobante_id_global, ingreso.id_global]);
    }
    const series = [];
    for (const l of c.lineas.filter((x) => x.series?.length)) {
      const r = await Serie.ingresar({ producto_id: l.item.id, deposito_id: c.deposito_id, series: l.series, costo_unitario: l.costo_unitario, proveedor: c.proveedor }, { userId: c.user_id ?? null });
      series.push({ item_id: l.item.id, documento: r.documento, series: r.series });
    }
    return { ingreso_id_global: ingreso?.id_global ?? null, series };
  } catch (err) { throw rechazo(err); }
});

module.exports = { pendientesDeFactura, detalle, controles };
