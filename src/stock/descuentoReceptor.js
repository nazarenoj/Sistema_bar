const M = require('../mensajeria/servicio');
const Mov = require('./movimientoService');
const Receta = require('./recetaService');
const { hojasDeLinea } = require('./lineaVentaService');
const Lotes = require('./loteService');
const Porciones = require('./porcionService');
const Deposito = require('../models/depositoModel');
const Compromiso = require('./compromisoService');
const Notificacion = require('../models/notificacionModel');

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

// Costo unitario ponderado de varios movimientos de una misma hoja (uno por lote): null si alguno no tiene costo.
const ponderado = (partes) => {
  if (partes.some((p) => p.costo === null)) return { costo: null, provisorio: partes.some((p) => p.provisorio) };
  const total = partes.reduce((a, p) => a + p.cantidad, 0);
  return { costo: total ? partes.reduce((a, p) => a + p.cantidad * p.costo, 0) / total : null, provisorio: partes.some((p) => p.provisorio) };
};

// Descuenta una hoja (un ítem, `q` unidades base). Con control de lote reparte entre los lotes: el indicado si sirve y, si no,
// FEFO; cada reparto es un movimiento con su lote. Es idempotente: si la hoja ya tiene movimientos de esta operación, no repite.
const descontarHoja = async (conn, { item, deposito, q, base, mov, indicado }) => {
  const [previos] = await conn.query('SELECT cantidad, costo_unitario, costo_provisorio, lote_id FROM stock_movimientos WHERE operacion_clave = ? OR operacion_clave LIKE ?', [base, `${base}|L%`]);
  if (previos.length) {
    const p = ponderado(previos.map((x) => ({ cantidad: -Number(x.cantidad), costo: x.costo_unitario === null ? null : Number(x.costo_unitario), provisorio: !!x.costo_provisorio })));
    return { nuevo: false, ...p, lotes: [] };
  }
  if (!(await Lotes.controla(conn, item))) {
    const r = await unaVez(conn, { ...mov, item, deposito_id: deposito, cantidad: -Math.round(q * 1000) / 1000, operacion_clave: base });
    return { nuevo: r.nuevo, costo: r.costo, provisorio: r.provisorio, lotes: [] };
  }
  const { asignaciones, indicadoNoDisponible } = await Lotes.asignar(conn, item, deposito, q, { indicado });
  const partes = [];
  const lotes = [];
  for (const a of asignaciones) {
    const r = await unaVez(conn, {
      ...mov, item, deposito_id: deposito, cantidad: -Math.round(a.cantidad * 1000) / 1000, lote_id: a.lote?.id ?? null, origen_lote: a.origen, lote_indicado: indicado ?? null,
      operacion_clave: a.lote ? `${base}|L${a.lote.id}` : base,
    });
    partes.push({ cantidad: a.cantidad, costo: r.costo, provisorio: r.provisorio });
    lotes.push({ lote: a.lote?.codigo ?? null, cantidad: a.cantidad, origen: a.origen });
  }
  // El lote indicado no se pudo respetar: se asignó por FEFO y se avisa; la venta no se revierte (EX55, EX57).
  if (indicadoNoDisponible)
    await Notificacion.crear({ modulo: 'stock', tipo: 'lote_indicado_no_respetado', severidad: 'media', roles: ['administrador', 'encargado', 'deposito'], clave: `lote-indicado:${base}`,
      mensaje: `La venta pidió el lote ${indicadoNoDisponible.codigo} (${indicadoNoDisponible.motivo}): se asignó por FEFO.` });
  return { nuevo: true, ...ponderado(partes), lotes };
};

// Contenido: { doc_tipo, items: [{ linea, producto_id, cantidad, lote_indicado }], no_fiscal, user_id, id_compromiso }. Responde con la
// confirmación del descuento: por línea, el costo unitario con que descontó (CI de los movimientos; para un elaborado o un combo, la
// suma de sus componentes) y los lotes reales, que Ventas guarda como Costo_Aplicado con origen "Movimiento de Stock" (RN63).
M.registrarReceptor('stock', 'descuento_stock', async (conn, c, ctx) => {
  let aplicados = 0;
  const lineasCosto = [];
  // El descuento consume el compromiso vigente de la venta (RN59): el mismo hueco no se cuenta dos veces.
  if (c.id_compromiso) await Compromiso.consumir(conn, c.id_compromiso);
  for (const it of c.items) {
    const [[p]] = await conn.query('SELECT sector_id FROM productos WHERE id = ?', [it.producto_id]);
    const deposito = await Deposito.depositoDeSector(p?.sector_id ?? null, conn);
    let hojas;
    try { hojas = await hojasDeLinea(conn, { producto_id: it.producto_id, cantidad: it.cantidad, opciones: it.opciones, modalidad: c.modalidad }); } catch (err) {
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
      const r = await descontarHoja(conn, {
        item: { tipo, id: Number(id) }, deposito: deposito.id, q, base: clave(ctx.idOperacion, it.linea, tipo, id),
        indicado: k === `producto:${it.producto_id}` ? it.lote_indicado ?? null : null, // el lote indicado es del artículo vendido
        mov: { tipo: 'venta', motivo: 'venta', documento_tipo: c.doc_tipo ?? 'venta', documento: ctx.docIdGlobal, venta_no_fiscal: c.no_fiscal ? 1 : 0, user_id: c.user_id ?? null },
      });
      if (r.nuevo) aplicados++;
      detalle.push({ item: k, cantidad: q, costo_unitario: r.costo, provisorio: r.provisorio, lotes: r.lotes });
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
// descuento original sacó, en proporción a lo devuelto, al mismo depósito, lote y costo (RF08, RN66, RN74). Si el lote está
// bloqueado o vencido, el producto no vuelve a stock disponible: solo se admite la merma (EX56).
M.registrarReceptor('stock', 'reingreso_stock', async (conn, c, ctx) => {
  let aplicados = 0;
  const [[envio]] = await conn.query("SELECT contenido FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'descuento_stock' ORDER BY id LIMIT 1", [ctx.docIdGlobal]);
  const vendidos = envio ? JSON.parse(envio.contenido).items ?? [] : [];
  for (const it of c.items) {
    // La devolución de una porción nunca reingresa a la pieza ni a las porciones: siempre es merma (RF08, RN78).
    const porcion = await Porciones.esPorcion(conn, vendidos.find((v) => v.linea === it.linea)?.producto_id);
    const [originales] = await conn.query(
      "SELECT * FROM stock_movimientos WHERE documento = ? AND tipo = 'venta' AND operacion_clave LIKE ? ORDER BY insumo_id, producto_id, id", [ctx.docIdGlobal, `%|${it.linea}|%`]);
    for (const o of originales) {
      const q = Math.round(-Number(o.cantidad) * Number(it.cantidad) / Number(it.cantidad_original) * 1000) / 1000;
      if (!(q > 0)) continue;
      const item = o.insumo_id ? { tipo: 'insumo', id: o.insumo_id } : { tipo: 'producto', id: o.producto_id };
      const lote = o.lote_id ? await Lotes.porId(conn, o.lote_id) : null;
      const politica = lote ? (await Lotes.config(conn, item))?.vencido_politica : null;
      const soloMerma = !!lote && !Lotes.usable(lote, politica);
      const modo = soloMerma || porcion ? 'merma' : c.modo;
      const comun = { item, deposito_id: o.deposito_id, costo_unitario: o.costo_unitario, documento_tipo: 'devolucion', documento: ctx.docIdGlobal, venta_no_fiscal: o.venta_no_fiscal, costo_provisorio: o.costo_provisorio, lote_id: o.lote_id, user_id: c.user_id ?? null };
      if ((await unaVez(conn, { ...comun, tipo: 'devolucion', motivo: 'devolucion_venta', cantidad: q, operacion_clave: clave(ctx.idOperacion, it.linea, item.tipo, item.id, o.lote_id ? `|L${o.lote_id}` : '') })).nuevo) aplicados++;
      // Merma por devolución: ingreso al costo original más egreso "Devolución a merma", de modo que el costo de la venta se revierte y la pérdida queda valorizada.
      if (modo === 'merma')
        await unaVez(conn, { ...comun, tipo: 'egreso', motivo: 'devolucion_merma', cantidad: -q, operacion_clave: clave(ctx.idOperacion, it.linea, item.tipo, item.id, `${o.lote_id ? `|L${o.lote_id}` : ''}|merma`) });
    }
  }
  return { movimientos: aplicados, sin_efecto: aplicados === 0 };
}, { revierte: 'descuento_stock' });
