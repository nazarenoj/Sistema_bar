const pool = require('../config/db');
const { idGlobal } = require('../utils/idGlobal');
const { auditar } = require('../utils/auditar');

// Actualización de precios (Ventas RF14, RN17, EX12): por porcentaje, monto fijo o lista importada, sobre todo
// el catálogo o un filtro (categoría, selección). Se ve antes de confirmar, se puede programar y se revierte.
// shortcut: los precios nuevos se calculan al confirmar; una actualización programada aplica esa vista previa
// aunque el precio haya cambiado a mano en el medio. Recalcular al vencer si se necesita porcentaje sobre el precio de ese día.
class PreciosInvalidos extends Error {
  constructor(errores) { super(errores.map((e) => (e.fila ? `Fila ${e.fila}: ${e.error}` : e.error)).join(' | ')); this.errores = errores; }
}

const redondear = (n) => Math.round(n * 100) / 100;
const SISTEMA = { username: 'sistema' };

// "sku;precio" o "sku,precio" por línea (con o sin encabezado) a [{ fila, sku, precio }]. Con ";" la coma es el
// decimal ("250,5"), como en las planillas en castellano; con "," el decimal es el punto.
const separador = (linea) => (linea.includes(';') ? ';' : ',');
const leerCsv = (texto) => texto.split(/\r?\n/).map((linea, i) => ({ linea: linea.trim(), fila: i + 1 })).filter((x) => x.linea)
  .filter(({ linea, fila }) => !(fila === 1 && /[a-z]/i.test(linea.split(separador(linea))[1] ?? '')))
  .map(({ linea, fila }) => {
    const sep = separador(linea);
    const [sku, precio = ''] = linea.split(sep).map((x) => x.trim());
    return { fila, sku, precio: precio === '' ? NaN : Number(sep === ';' ? precio.replace(',', '.') : precio) };
  });

// Calcula qué cambiaría, sin guardar nada. Cualquier error invalida todo el lote (EX12).
const calcular = async (b, conn = pool) => {
  const errores = [];
  let filas = [];
  if (b.tipo === 'importacion') {
    const lista = typeof b.csv === 'string' ? leerCsv(b.csv) : b.items;
    if (!Array.isArray(lista) || !lista.length) throw new PreciosInvalidos([{ error: 'La lista importada está vacía o tiene un formato inválido.' }]);
    const vistos = new Set();
    for (const [i, it] of lista.entries()) {
      const fila = it.fila ?? i + 1;
      if (!Number.isFinite(Number(it.precio)) || Number(it.precio) < 0 || it.precio === null) { errores.push({ fila, error: 'el precio debe ser un número mayor o igual a cero' }); continue; }
      const codigo = String(it.sku ?? it.codigo_barras ?? '');
      const [[p]] = it.producto_id
        ? await conn.query('SELECT id, nombre, precio FROM productos WHERE id = ?', [it.producto_id])
        : await conn.query('SELECT id, nombre, precio FROM productos WHERE sku = ? OR codigo_barras = ? LIMIT 1', [codigo, codigo]);
      if (!p) { errores.push({ fila, error: `el artículo "${it.producto_id ?? codigo}" no existe` }); continue; }
      if (vistos.has(p.id)) { errores.push({ fila, error: `el artículo "${p.nombre}" está repetido` }); continue; }
      vistos.add(p.id);
      filas.push({ producto_id: p.id, nombre: p.nombre, precio_anterior: Number(p.precio), precio_nuevo: redondear(Number(it.precio)) });
    }
  } else if (b.tipo === 'porcentaje' || b.tipo === 'monto') {
    const valor = Number(b.valor);
    if (b.valor === '' || b.valor === null || b.valor === undefined || !Number.isFinite(valor)) throw new PreciosInvalidos([{ error: 'El valor debe ser un número.' }]);
    if (b.tipo === 'porcentaje' && valor <= -100) throw new PreciosInvalidos([{ error: 'El porcentaje debe ser mayor que -100.' }]);
    const donde = [];
    const params = [];
    if (b.filtro?.categoria_id) { donde.push('categoria_id = ?'); params.push(b.filtro.categoria_id); }
    if (Array.isArray(b.filtro?.productos)) {
      if (!b.filtro.productos.length) throw new PreciosInvalidos([{ error: 'La selección de productos está vacía.' }]);
      donde.push(`id IN (${b.filtro.productos.map(() => '?').join(',')})`); params.push(...b.filtro.productos);
    }
    const [productos] = await conn.query(`SELECT id, nombre, precio FROM productos ${donde.length ? `WHERE ${donde.join(' AND ')}` : ''} ORDER BY id`, params);
    for (const p of productos) {
      const nuevo = redondear(b.tipo === 'porcentaje' ? Number(p.precio) * (1 + valor / 100) : Number(p.precio) + valor);
      if (nuevo < 0) errores.push({ error: `"${p.nombre}" quedaría con precio negativo` });
      filas.push({ producto_id: p.id, nombre: p.nombre, precio_anterior: Number(p.precio), precio_nuevo: nuevo });
    }
  } else {
    throw new PreciosInvalidos([{ error: '"tipo" debe ser porcentaje, monto o importacion.' }]);
  }
  if (errores.length) throw new PreciosInvalidos(errores);
  filas = filas.filter((f) => f.precio_nuevo !== f.precio_anterior);
  if (!filas.length) throw new PreciosInvalidos([{ error: 'Ningún producto cambia de precio con esta actualización.' }]);
  return filas;
};

const aplicar = async (id, actor) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[a]] = await conn.query('SELECT * FROM actualizaciones_precio WHERE id = ? FOR UPDATE', [id]);
    if (!a || a.estado !== 'programada') { await conn.rollback(); return false; }
    const [items] = await conn.query('SELECT producto_id, precio_nuevo FROM actualizacion_precio_items WHERE actualizacion_id = ?', [id]);
    for (const i of items) await conn.query('UPDATE productos SET precio = ? WHERE id = ?', [i.precio_nuevo, i.producto_id]);
    await conn.query("UPDATE actualizaciones_precio SET estado = 'aplicada', aplicada_at = NOW() WHERE id = ?", [id]);
    await conn.commit();
    await auditar(null, { modulo: 'ventas', accion: 'precios_aplicados', entidad: 'actualizacion_precio', entidad_id: a.id_global, detalle: `${items.length} producto(s)` }, actor ?? SISTEMA);
    return true;
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const obtener = async (id_global) => {
  const [[a]] = await pool.query('SELECT * FROM actualizaciones_precio WHERE id_global = ?', [id_global]);
  if (!a) return null;
  const [items] = await pool.query('SELECT producto_id, nombre, precio_anterior, precio_nuevo FROM actualizacion_precio_items WHERE actualizacion_id = ?', [a.id]);
  return { ...a, items };
};

// Confirma una actualización: se aplica ya, o queda programada para `vigencia_desde`.
const crear = async (b, { userId, actor } = {}) => {
  const filas = await calcular(b);
  let vigencia = null;
  if (b.vigencia_desde) {
    vigencia = new Date(b.vigencia_desde);
    if (Number.isNaN(vigencia.getTime())) throw new PreciosInvalidos([{ error: '"vigencia_desde" no es una fecha válida.' }]);
  }
  const conn = await pool.getConnection();
  let id, id_global;
  try {
    await conn.beginTransaction();
    id_global = await idGlobal();
    const [r] = await conn.query(
      "INSERT INTO actualizaciones_precio (id_global, tipo, valor, filtro, estado, vigencia_desde, motivo, creada_por) VALUES (?, ?, ?, ?, 'programada', ?, ?, ?)",
      [id_global, b.tipo, b.tipo === 'importacion' ? null : Number(b.valor), b.filtro ? JSON.stringify(b.filtro).slice(0, 500) : null, vigencia, b.motivo ?? null, userId ?? null]);
    id = r.insertId;
    for (const f of filas)
      await conn.query('INSERT INTO actualizacion_precio_items (actualizacion_id, producto_id, nombre, precio_anterior, precio_nuevo) VALUES (?, ?, ?, ?, ?)', [id, f.producto_id, f.nombre, f.precio_anterior, f.precio_nuevo]);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  await auditar(null, { modulo: 'ventas', accion: 'precios_actualizacion_creada', entidad: 'actualizacion_precio', entidad_id: id_global, detalle: `${b.tipo} ${b.valor ?? ''} (${filas.length} producto(s))` }, actor ?? SISTEMA);
  if (!vigencia || vigencia <= new Date()) await aplicar(id, actor);
  return obtener(id_global);
};

// Revierte una actualización aplicada: vuelve el precio anterior solo donde nadie lo cambió después (si no, se avisa).
const revertir = async (id_global, motivo, actor) => {
  const conn = await pool.getConnection();
  let omitidos = [];
  try {
    await conn.beginTransaction();
    const [[a]] = await conn.query('SELECT * FROM actualizaciones_precio WHERE id_global = ? FOR UPDATE', [id_global]);
    if (!a) { await conn.rollback(); return null; }
    if (a.estado !== 'aplicada') throw new PreciosInvalidos([{ error: `Solo se revierte una actualización aplicada (esta está ${a.estado}).` }]);
    const [items] = await conn.query('SELECT producto_id, nombre, precio_anterior, precio_nuevo FROM actualizacion_precio_items WHERE actualizacion_id = ?', [a.id]);
    for (const i of items) {
      const [r] = await conn.query('UPDATE productos SET precio = ? WHERE id = ? AND precio = ?', [i.precio_anterior, i.producto_id, i.precio_nuevo]);
      if (!r.affectedRows) omitidos.push(i.nombre);
    }
    await conn.query("UPDATE actualizaciones_precio SET estado = 'revertida', revertida_at = NOW(), motivo = COALESCE(?, motivo) WHERE id = ?", [motivo ?? null, a.id]);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  await auditar(null, { modulo: 'ventas', accion: 'precios_revertidos', entidad: 'actualizacion_precio', entidad_id: id_global, detalle: motivo ?? '' }, actor ?? SISTEMA);
  return { ...(await obtener(id_global)), omitidos };
};

const cancelar = async (id_global, actor) => {
  const [r] = await pool.query("UPDATE actualizaciones_precio SET estado = 'cancelada' WHERE id_global = ? AND estado = 'programada'", [id_global]);
  if (r.affectedRows) await auditar(null, { modulo: 'ventas', accion: 'precios_cancelados', entidad: 'actualizacion_precio', entidad_id: id_global }, actor ?? SISTEMA);
  return r.affectedRows > 0;
};

const listar = async () => (await pool.query('SELECT id_global, tipo, valor, estado, vigencia_desde, aplicada_at, revertida_at, created_at FROM actualizaciones_precio ORDER BY id DESC LIMIT 100'))[0];

// Aplica las programadas cuya vigencia llegó (lo llama el trabajador).
const aplicarVencidas = async () => {
  const [vencidas] = await pool.query("SELECT id FROM actualizaciones_precio WHERE estado = 'programada' AND vigencia_desde IS NOT NULL AND vigencia_desde <= NOW()");
  let n = 0;
  for (const { id } of vencidas) if (await aplicar(id)) n++;
  return n;
};

module.exports = { calcular, crear, revertir, cancelar, obtener, listar, aplicarVencidas, PreciosInvalidos };
