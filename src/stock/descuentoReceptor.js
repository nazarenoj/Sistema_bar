const M = require('../mensajeria/servicio');
const Mov = require('./movimientoService');
const Receta = require('./recetaService');
const Deposito = require('../models/depositoModel');

// Stock como receptor idempotente de los mensajes de Ventas (Stock RN50, RN51, RF07, RF08): descuento por venta y
// reingreso por anulación o devolución. La idempotencia es por (ID_Operacion, línea, componente): cada movimiento
// lleva su `operacion_clave` única, así reprocesar un mensaje (o parte de él) no descuenta dos veces.

const clave = (op, linea, tipo, id, sufijo = '') => `${op}|${linea}|${tipo}:${id}${sufijo}`;

// Registra el movimiento salvo que su clave ya exista (ya se aplicó). Devuelve si lo registró y el costo con que quedó
// (el que ya tenía, si era un reproceso), para informarlo a Ventas.
const unaVez = async (conn, mov) => {
  try {
    const r = await Mov.registrar(conn, mov);
    return { nuevo: true, costo: r.costo_unitario, provisorio: !!r.costo_provisorio };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' && /operacion_clave/.test(err.message)) {
      const [[e]] = await conn.query('SELECT costo_unitario, costo_provisorio FROM stock_movimientos WHERE operacion_clave = ?', [mov.operacion_clave]);
      return { nuevo: false, costo: e?.costo_unitario === null || e?.costo_unitario === undefined ? null : Number(e.costo_unitario), provisorio: !!e?.costo_provisorio };
    }
    throw err;
  }
};

// Contenido: { doc_tipo, items: [{ linea, producto_id, cantidad }], no_fiscal, user_id }. Responde con la confirmación del
// descuento: por línea, el costo unitario con que descontó (CI de los movimientos; para un elaborado o un combo, la suma de sus
// componentes), que Ventas guarda como Costo_Aplicado con origen "Movimiento de Stock" (RN63).
M.registrarReceptor('stock', 'descuento_stock', async (conn, c, ctx) => {
  let aplicados = 0;
  const lineasCosto = [];
  for (const it of c.items) {
    const [[p]] = await conn.query('SELECT sector_id FROM productos WHERE id = ?', [it.producto_id]);
    const deposito = await Deposito.depositoDeSector(p?.sector_id ?? null, conn);
    let hojas;
    try { hojas = await Receta.hojas(conn, it.producto_id, it.cantidad); } catch (err) {
      if (err instanceof Receta.RecetaInvalida) throw new M.RechazoNegocio(err.message);
      throw err;
    }
    let total = 0;
    let conCosto = 0;
    let provisorio = false;
    const detalle = [];
    // En orden estable: dos descuentos concurrentes toman los locks de los ítems en el mismo orden.
    for (const [k, q] of [...hojas].sort(([a], [b]) => a.localeCompare(b))) {
      const [tipo, id] = k.split(':');
      const r = await unaVez(conn, {
        item: { tipo, id: Number(id) }, deposito_id: deposito.id, tipo: 'venta', motivo: 'venta', cantidad: -Math.round(q * 1000) / 1000,
        documento_tipo: c.doc_tipo ?? 'venta', documento: ctx.docIdGlobal, operacion_clave: clave(ctx.idOperacion, it.linea, tipo, id),
        venta_no_fiscal: c.no_fiscal ? 1 : 0, user_id: c.user_id ?? null,
      });
      if (r.nuevo) aplicados++;
      detalle.push({ item: k, cantidad: q, costo_unitario: r.costo, provisorio: r.provisorio });
      if (r.costo !== null) { total += q * r.costo; conCosto++; provisorio = provisorio || r.provisorio; }
    }
    const completo = conCosto === hojas.size;
    lineasCosto.push({
      linea: it.linea, costo_unitario: conCosto ? Math.round((total / it.cantidad) * 10000) / 10000 : null,
      origen_costo: conCosto ? 'movimiento_stock' : 'sin_costo', provisorio: conCosto > 0 && (provisorio || !completo), detalle,
    });
  }
  // La confirmación viaja a Ventas como mensaje (en la misma transacción), con el costo congelado de cada línea.
  await M.publicar(conn, { origen: 'stock', destino: 'ventas', tipo: 'costo_confirmado', docTipo: c.doc_tipo ?? 'venta', docIdGlobal: ctx.docIdGlobal, contenido: { doc_tipo: c.doc_tipo ?? 'venta', lineas: lineasCosto } });
  return { movimientos: aplicados, lineas: lineasCosto.length };
}, {});

// Contenido: { modo: 'reingreso' | 'merma', items: [{ linea, cantidad, cantidad_original }], user_id }. Revierte lo que el
// descuento original sacó, en proporción a lo devuelto, al mismo depósito y al costo con que salió (RF08, RN66).
M.registrarReceptor('stock', 'reingreso_stock', async (conn, c, ctx) => {
  let aplicados = 0;
  for (const it of c.items) {
    const [originales] = await conn.query(
      "SELECT * FROM stock_movimientos WHERE documento = ? AND tipo = 'venta' AND operacion_clave LIKE ? ORDER BY insumo_id, producto_id, id", [ctx.docIdGlobal, `%|${it.linea}|%`]);
    for (const o of originales) {
      const q = Math.round(-Number(o.cantidad) * Number(it.cantidad) / Number(it.cantidad_original) * 1000) / 1000;
      if (!(q > 0)) continue;
      const item = o.insumo_id ? { tipo: 'insumo', id: o.insumo_id } : { tipo: 'producto', id: o.producto_id };
      const comun = { item, deposito_id: o.deposito_id, costo_unitario: o.costo_unitario, documento_tipo: 'devolucion', documento: ctx.docIdGlobal, venta_no_fiscal: o.venta_no_fiscal, costo_provisorio: o.costo_provisorio, user_id: c.user_id ?? null };
      if ((await unaVez(conn, { ...comun, tipo: 'devolucion', motivo: 'devolucion_venta', cantidad: q, operacion_clave: clave(ctx.idOperacion, it.linea, item.tipo, item.id) })).nuevo) aplicados++;
      // Merma por devolución: ingreso al costo original más egreso "Devolución a merma", de modo que el costo de la venta se revierte y la pérdida queda valorizada.
      if (c.modo === 'merma')
        await unaVez(conn, { ...comun, tipo: 'egreso', motivo: 'devolucion_merma', cantidad: -q, operacion_clave: clave(ctx.idOperacion, it.linea, item.tipo, item.id, '|merma') });
    }
  }
  return { movimientos: aplicados, sin_efecto: aplicados === 0 };
}, { revierte: 'descuento_stock' });
