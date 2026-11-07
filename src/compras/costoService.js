const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const puertos = require('../modulos/puertos');
const Comprobantes = require('./comprobanteService');
const Proveedores = require('./proveedorService');
const { invalida, r2, r4, hoy, iso } = require('./comun');

// Costo de reposición (Compras RF11, RF21, RN05 a RN07, RN27, RN40). El CR es cuánto cuesta reponer una unidad base: sale de la última factura o lista, es neto de IVA computable, de
// bonificaciones y de percepciones e incluye los impuestos no recuperables. Compras es su dueña; sirve para decidir precios y no es el costo de inventario ni el de la venta.
// La actualización por factura o lista sigue la regla configurada (siempre, solo si aumenta o con confirmación) y una variación mayor al umbral siempre pide confirmación (EX10).
const clave = (i) => ({ tipo: i.tipo ?? i.item_tipo, id: Number(i.id ?? i.item_id) });

const vista = (c) => ({ item_tipo: c.item_tipo, item_id: c.item_id, nombre: c.nombre ?? null, costo: Number(c.costo), moneda: c.moneda, fecha: iso(c.fecha), fuente: c.fuente, fuente_ref: c.fuente_ref, proveedor_principal_id: c.proveedor_principal_id, proveedor: c.proveedor ?? null });

const nombreDe = `COALESCE((SELECT nombre FROM insumos WHERE id = c.item_id AND c.item_tipo = 'insumo'), (SELECT nombre FROM productos WHERE id = c.item_id AND c.item_tipo = 'producto'))`;
const consulta = async ({ proveedorId, limite = 500 } = {}) => (await pool.query(
  `SELECT c.*, ${nombreDe} AS nombre, p.razon_social AS proveedor FROM cmp_costos_reposicion c LEFT JOIN cmp_proveedores p ON p.id = c.proveedor_principal_id ${proveedorId ? 'WHERE c.proveedor_principal_id = ?' : ''} ORDER BY nombre LIMIT ?`,
  proveedorId ? [Number(proveedorId), Math.min(Number(limite) || 500, 2000)] : [Math.min(Number(limite) || 500, 2000)]))[0].map(vista);
const actual = async (item, db = pool) => (await db.query('SELECT * FROM cmp_costos_reposicion WHERE item_tipo = ? AND item_id = ?', [item.tipo, item.id]))[0][0] ?? null;
const historial = async (item) => (await pool.query('SELECT costo, moneda, fuente, fuente_ref, fecha, ts_ms FROM cmp_costos_historial WHERE item_tipo = ? AND item_id = ? ORDER BY id DESC LIMIT 200', [item.tipo, item.id]))[0]
  .map((h) => ({ ...h, costo: Number(h.costo), fecha: iso(h.fecha), ts_ms: Number(h.ts_ms) }));

// ---- Aplicar un costo ----

const publicar = async (conn, item, c) => {
  for (const [destino, tipo] of [['ventas', 'costo_reposicion_actualizado'], ['stock', 'costo_referencia_actualizado']]) {
    const doc = `${item.tipo}:${item.id}`;
    const [[{ v }]] = await conn.query('SELECT COALESCE(MAX(doc_version), 0) + 1 AS v FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = ?', [doc, tipo]);
    await M.publicar(conn, { origen: 'compras', destino, tipo, docTipo: 'costo', docIdGlobal: doc, docVersion: v, contenido: { item_tipo: item.tipo, item_id: item.id, costo: c.costo, moneda: c.moneda, fecha: c.fecha } });
  }
};

const fijar = async (conn, item, { costo, moneda, fuente, ref, proveedorId, userId }) => {
  const f = hoy();
  const previo = await actual(item, conn);
  await conn.query(
    `INSERT INTO cmp_costos_reposicion (item_tipo, item_id, costo, moneda, fecha, fuente, fuente_ref, proveedor_principal_id, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE costo = VALUES(costo), moneda = VALUES(moneda), fecha = VALUES(fecha), fuente = VALUES(fuente), fuente_ref = VALUES(fuente_ref), proveedor_principal_id = COALESCE(VALUES(proveedor_principal_id), proveedor_principal_id), updated_ms = VALUES(updated_ms)`,
    [item.tipo, item.id, costo, moneda, f, fuente, ref ?? null, proveedorId ?? previo?.proveedor_principal_id ?? null, Date.now()]);
  await conn.query('INSERT INTO cmp_costos_historial (item_tipo, item_id, costo, moneda, fuente, fuente_ref, fecha, user_id, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.tipo, item.id, costo, moneda, fuente, ref ?? null, f, userId ?? null, Date.now()]);
  await publicar(conn, item, { costo, moneda, fecha: f });
};

// Una factura o una lista propone un costo: se aplica, queda pendiente de confirmación o no cambia nada, según la regla y el umbral.
const proponer = async (conn, item, { costo, moneda, fuente, ref, proveedorId }) => {
  costo = r4(costo);
  if (!(costo > 0)) return { accion: 'sin_cambio' };
  const cfg = await Proveedores.config(conn);
  const previo = await actual(item, conn);
  if (!previo || previo.moneda !== moneda || Number(previo.costo) === 0) { await fijar(conn, item, { costo, moneda, fuente, ref, proveedorId }); return { accion: 'aplicado' }; }
  const anterior = Number(previo.costo);
  if (costo === anterior) return { accion: 'sin_cambio' };
  const variacion = r2((costo - anterior) / anterior * 100);
  let motivo = null;
  if (Math.abs(variacion) > cfg.variacion_costo_pct) motivo = `variación de ${variacion}% mayor al umbral de ${cfg.variacion_costo_pct}%`; // EX10: evita cargar el precio de la caja como precio unitario
  else if (cfg.actualizacion_costo === 'con_confirmacion') motivo = 'la regla pide confirmar cada cambio';
  else if (cfg.actualizacion_costo === 'solo_si_aumenta' && costo < anterior) return { accion: 'sin_cambio', motivo: 'solo se actualiza si aumenta' };
  if (!motivo) { await fijar(conn, item, { costo, moneda, fuente, ref, proveedorId }); return { accion: 'aplicado', variacion }; }
  await conn.query("INSERT INTO cmp_costos_pendientes (item_tipo, item_id, costo_propuesto, costo_actual, variacion_pct, moneda, fuente, fuente_ref, proveedor_id, motivo, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [item.tipo, item.id, costo, anterior, variacion, moneda, fuente, ref ?? null, proveedorId ?? null, motivo, Date.now()]);
  return { accion: 'pendiente', variacion, motivo };
};

const pendientes = async (estado = 'pendiente') => (await pool.query(
  `SELECT c.*, ${nombreDe} AS nombre, p.razon_social AS proveedor FROM cmp_costos_pendientes c LEFT JOIN cmp_proveedores p ON p.id = c.proveedor_id WHERE c.estado = ? ORDER BY c.id DESC LIMIT 500`, [estado]))[0]
  .map((c) => ({ id: c.id, item_tipo: c.item_tipo, item_id: c.item_id, nombre: c.nombre, costo_propuesto: Number(c.costo_propuesto), costo_actual: c.costo_actual === null ? null : Number(c.costo_actual), variacion_pct: c.variacion_pct === null ? null : Number(c.variacion_pct),
    moneda: c.moneda, fuente: c.fuente, fuente_ref: c.fuente_ref, proveedor: c.proveedor, motivo: c.motivo, estado: c.estado }));

const resolver = async (id, confirmar, userId) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.query("SELECT * FROM cmp_costos_pendientes WHERE id = ? FOR UPDATE", [id]);
    if (!p) throw invalida('Cambio de costo no encontrado.', 404);
    if (p.estado !== 'pendiente') throw invalida(`El cambio ya está ${p.estado}.`, 409);
    if (confirmar) await fijar(conn, { tipo: p.item_tipo, id: p.item_id }, { costo: Number(p.costo_propuesto), moneda: p.moneda, fuente: p.fuente, ref: p.fuente_ref, proveedorId: p.proveedor_id, userId });
    await conn.query('UPDATE cmp_costos_pendientes SET estado = ?, resuelto_por = ? WHERE id = ?', [confirmar ? 'confirmado' : 'rechazado', userId ?? null, id]);
    await conn.commit();
    M.despertar();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return (await pendientes(confirmar ? 'confirmado' : 'rechazado')).find((x) => x.id === id);
};

// Ajuste manual con motivo (queda en el historial como «manual»).
const ajustar = async (item, { costo, moneda = 'ARS', motivo, proveedor_id: proveedorId }, userId) => {
  if (!(Number(costo) > 0)) throw invalida('El costo debe ser mayor a cero.');
  if (typeof motivo !== 'string' || motivo.trim().length < 3) throw invalida('El motivo es obligatorio.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await fijar(conn, item, { costo: r4(costo), moneda: String(moneda).toUpperCase(), fuente: 'manual', ref: motivo.trim().slice(0, 60), proveedorId, userId });
    await conn.commit();
    M.despertar();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return vista(await actual(item));
};

// ---- Desde una factura (RN05) ----

// El costo neto por unidad base de una línea: sin bonificaciones ni percepciones, con el IVA que no se computa (comprobantes B y C, o una instancia que no es Responsable Inscripto) y los impuestos internos.
const costoDeLinea = (l, c) => {
  const base = l.costo_unidad_base !== null ? Number(l.costo_unidad_base) : Number(l.precio_unitario) * (1 - Number(l.bonificacion_pct) / 100) / (Number(l.factor_aplicado) || 1);
  const neto = Number(c.neto_gravado);
  const noRecuperable = neto > 0 ? (Number(c.iva) - Number(c.iva_computable) + Number(c.impuestos_internos)) / neto : 0;
  return r4(base * (1 + noRecuperable));
};

// Una nota de credito por bonificacion o descuento posterior (`ajuste_costo`) baja el costo por unidad de la compra que es la fuente vigente del CR (RN38); la que solo devuelve
// cantidades al mismo precio no lo cambia. El credito por unidad se resta del CR y se aplica con la regla de RN06 (confirmacion si supera el umbral, EX10).
const ajustarPorNota = async (conn, comp, d) => {
  const [[c]] = await conn.query('SELECT * FROM cmp_comprobantes WHERE id = ?', [comp.id]);
  const [lineas] = await conn.query("SELECT * FROM cmp_comprobante_lineas WHERE comprobante_id = ? AND tipo = 'mercaderia' AND item_id IS NOT NULL", [comp.id]);
  for (const l of lineas) {
    const previo = await actual({ tipo: l.item_tipo, id: l.item_id }, conn);
    if (!previo || previo.fuente !== 'factura' || previo.moneda !== c.moneda || previo.proveedor_principal_id !== c.proveedor_id) continue;
    const credito = costoDeLinea(l, c);
    if (credito > 0 && credito < Number(previo.costo)) await proponer(conn, { tipo: l.item_tipo, id: l.item_id }, { costo: Number(previo.costo) - credito, moneda: c.moneda, fuente: 'factura', ref: `NC-${c.punto_venta}-${c.numero}`.slice(0, 60), proveedorId: c.proveedor_id });
  }
  void d;
};

Comprobantes.alRegistrar(async (conn, comp, d) => {
  if (comp.clase === 'NOTA_CREDITO') { if (d?.ajuste_costo === true) await ajustarPorNota(conn, comp, d); return; }
  if (!['FACTURA', 'TICKET'].includes(comp.clase)) return;
  const [[c]] = await conn.query('SELECT * FROM cmp_comprobantes WHERE id = ?', [comp.id]);
  const [lineas] = await conn.query("SELECT * FROM cmp_comprobante_lineas WHERE comprobante_id = ? AND tipo = 'mercaderia' AND item_id IS NOT NULL", [comp.id]);
  for (const l of lineas) await proponer(conn, { tipo: l.item_tipo, id: l.item_id }, { costo: costoDeLinea(l, c), moneda: c.moneda, fuente: 'factura', ref: `FC-${c.punto_venta}-${c.numero}`.slice(0, 60), proveedorId: c.proveedor_id });
});

// El puerto «Costo de reposición» que define Ventas y Compras implementa (RF21, RN27): el CR neto, por unidad base, con su moneda y fecha; un ítem sin costo responde «sin costo» (null).
puertos.registrar('costoReposicion', {
  costo: async (item) => {
    const i = clave(item);
    const c = await actual(i);
    return c ? { costo: Number(c.costo), moneda: c.moneda, fecha: iso(c.fecha) } : null;
  },
});

module.exports = { clave, consulta, actual, historial, proponer, pendientes, confirmar: (id, u) => resolver(id, true, u), rechazar: (id, u) => resolver(id, false, u), ajustar, costoDeLinea };
