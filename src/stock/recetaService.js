const pool = require('../config/db');
const Presentacion = require('../models/presentacionModel');

// Recetas (Stock RF09, RN64, RN65): dueño único de la explosión de una línea vendida. Un artículo se descuenta de dos
// maneras (Modo_Descuento): Propio (el ítem vendido) o Componentes (combos y elaborados: sus componentes, hasta las
// hojas). Ventas manda solo la línea vendida, nunca los componentes además del combo.
class RecetaInvalida extends Error {}
const invalida = (m, status = 400) => Object.assign(new RecetaInvalida(m), { status });

const PROFUNDIDAD_MAXIMA = 8;   // combos de hasta 3 niveles y sub-recetas de hasta 3; el tope evita ciclos en datos viejos
const PROFUNDIDAD_SUBRECETAS = 3;

const consumoSql = 'cantidad_consumida * COALESCE(factor_aplicado, 1) / (1 - merma_pct / 100)';

// Líneas de la receta de un artículo con lo que consume cada una por unidad producida, en unidad base y con su merma.
const lineas = async (productoId, conn = pool) => (await conn.query(
  `SELECT id, insumo_id, componente_producto_id, cantidad_consumida, presentacion_id, factor_aplicado, merma_pct, ${consumoSql} AS consumo
   FROM producto_insumos WHERE producto_id = ? ORDER BY id`, [productoId]))[0];

// Hojas de `cantidad` unidades de un artículo: Map 'insumo:ID' | 'producto:ID' -> cantidad en unidad base.
const hojas = async (conn, productoId, cantidad, acum = new Map(), nivel = 0) => {
  if (nivel > PROFUNDIDAD_MAXIMA) throw invalida('La receta es demasiado profunda o tiene un ciclo.');
  const [[p]] = await conn.query('SELECT id, tipo FROM productos WHERE id = ?', [productoId]);
  const suma = (k, q) => acum.set(k, (acum.get(k) ?? 0) + q);
  if (p?.tipo === 'combo') {
    const [comps] = await conn.query('SELECT componente_id, cantidad FROM producto_componentes WHERE combo_id = ?', [productoId]);
    if (comps.length) {
      for (const c of comps) await hojas(conn, c.componente_id, cantidad * Number(c.cantidad), acum, nivel + 1);
      return acum; // un combo virtual no tiene stock propio
    }
  } else if (p?.tipo === 'elaborado') {
    const ls = await lineas(productoId, conn);
    if (ls.length) {
      for (const l of ls) {
        if (l.insumo_id) suma(`insumo:${l.insumo_id}`, cantidad * Number(l.consumo));
        else await hojas(conn, l.componente_producto_id, cantidad * Number(l.consumo), acum, nivel + 1);
      }
      return acum;
    }
  }
  suma(`producto:${productoId}`, cantidad); // Modo Propio (o un combo/elaborado sin composición cargada)
  return acum;
};

// ---- Versiones (cada cambio de la receta guarda una) ----

const snapshot = async (productoId, userId = null, conn = pool) => {
  const ls = await lineas(productoId, conn);
  const [[{ v }]] = await conn.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM recetas_versiones WHERE producto_id = ?', [productoId]);
  await conn.query('INSERT INTO recetas_versiones (producto_id, version, lineas, user_id) VALUES (?, ?, ?, ?)', [productoId, v, JSON.stringify(ls), userId]);
  return v;
};

const versiones = async (productoId) => (await pool.query('SELECT version, lineas, user_id, created_at FROM recetas_versiones WHERE producto_id = ? ORDER BY version', [productoId]))[0]
  .map((r) => ({ ...r, lineas: JSON.parse(r.lineas) }));

const obtener = async (productoId) => {
  const [[p]] = await pool.query('SELECT id, nombre, tipo FROM productos WHERE id = ?', [productoId]);
  if (!p) return null;
  const [filas] = await pool.query(
    `SELECT pi.id, pi.insumo_id, pi.componente_producto_id, pi.cantidad_consumida, pi.presentacion_id, pi.factor_aplicado, pi.merma_pct, i.nombre AS insumo, i.unidad, sp.nombre AS subreceta
     FROM producto_insumos pi LEFT JOIN insumos i ON i.id = pi.insumo_id LEFT JOIN productos sp ON sp.id = pi.componente_producto_id WHERE pi.producto_id = ? ORDER BY pi.id`, [productoId]);
  const [[{ v }]] = await pool.query('SELECT COALESCE(MAX(version), 0) AS v FROM recetas_versiones WHERE producto_id = ?', [productoId]);
  const modo = p.tipo === 'combo' || (p.tipo === 'elaborado' && filas.length) ? 'componentes' : 'propio';
  return { producto: p, modo_descuento: modo, version: v, lineas: filas };
};

// Profundidad de sub-recetas por debajo de un artículo; lanza si vuelve a `raiz` (ciclo).
const profundidadSub = async (conn, productoId, raiz, nivel = 0) => {
  if (nivel > PROFUNDIDAD_SUBRECETAS) return nivel;
  const [subs] = await conn.query('SELECT componente_producto_id FROM producto_insumos WHERE producto_id = ? AND componente_producto_id IS NOT NULL', [productoId]);
  let max = nivel;
  for (const s of subs) {
    if (s.componente_producto_id === raiz) throw invalida('La receta se contiene a sí misma (ciclo de sub-recetas).');
    max = Math.max(max, await profundidadSub(conn, s.componente_producto_id, raiz, nivel + 1));
  }
  return max;
};

// Reemplaza la receta completa de un elaborado (todo o nada) y guarda la versión. Cada línea es un insumo o una
// sub-receta (otro elaborado), con cantidad por unidad producida, presentación opcional y porcentaje de merma.
const guardar = async (productoId, ls, { userId } = {}) => {
  if (!Array.isArray(ls)) throw invalida('"lineas" debe ser una lista.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.query('SELECT id, tipo FROM productos WHERE id = ? FOR UPDATE', [productoId]);
    if (!p) throw invalida('Artículo no encontrado.', 404);
    if (p.tipo !== 'elaborado') throw invalida('Solo un artículo de tipo "elaborado" tiene receta (los combos tienen componentes).', 409);
    const vistos = new Set();
    await conn.query('DELETE FROM producto_insumos WHERE producto_id = ?', [productoId]);
    for (const l of ls) {
      const esInsumo = Number.isInteger(l.insumo_id);
      const esSub = Number.isInteger(l.componente_producto_id);
      if (esInsumo === esSub) throw invalida('Cada línea es un insumo (insumo_id) o una sub-receta (componente_producto_id), no ambos.');
      if (!(Number(l.cantidad_consumida) > 0)) throw invalida('La cantidad de cada línea debe ser mayor que cero.');
      const merma = Number(l.merma_pct ?? 0);
      if (!(merma >= 0 && merma < 100)) throw invalida('La merma debe estar entre 0 y 100 (sin incluir 100).');
      const clave = esInsumo ? `i${l.insumo_id}` : `p${l.componente_producto_id}`;
      if (vistos.has(clave)) throw invalida('Hay componentes repetidos en la receta.');
      vistos.add(clave);
      let presentacion = null;
      if (esInsumo) {
        const [[i]] = await conn.query('SELECT id FROM insumos WHERE id = ?', [l.insumo_id]);
        if (!i) throw invalida(`El insumo ${l.insumo_id} no existe.`, 404);
        if (l.presentacion_id) {
          presentacion = await Presentacion.getById(l.presentacion_id, conn);
          const vigente = presentacion && (!presentacion.vigente_hasta || new Date(presentacion.vigente_hasta) > new Date());
          if (!presentacion || presentacion.insumo_id !== l.insumo_id || !vigente || !String(presentacion.usos).split(',').includes('receta'))
            throw invalida('La presentación debe ser una presentación vigente de uso "receta" de ese insumo.');
        }
      } else {
        if (l.componente_producto_id === productoId) throw invalida('Una receta no puede incluirse a sí misma.');
        const [[s]] = await conn.query('SELECT tipo FROM productos WHERE id = ?', [l.componente_producto_id]);
        if (!s) throw invalida(`El artículo ${l.componente_producto_id} no existe.`, 404);
        if (s.tipo !== 'elaborado') throw invalida('Una sub-receta debe ser un artículo elaborado.');
      }
      await conn.query(
        'INSERT INTO producto_insumos (producto_id, insumo_id, componente_producto_id, cantidad_consumida, presentacion_id, factor_aplicado, merma_pct) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [productoId, esInsumo ? l.insumo_id : null, esSub ? l.componente_producto_id : null, l.cantidad_consumida, presentacion?.id ?? null, presentacion?.factor ?? null, merma]);
    }
    if ((await profundidadSub(conn, productoId, productoId)) > PROFUNDIDAD_SUBRECETAS) throw invalida(`Las sub-recetas no pueden anidarse más de ${PROFUNDIDAD_SUBRECETAS} niveles.`);
    const version = await snapshot(productoId, userId, conn);
    await conn.commit();
    return { ...(await obtener(productoId)), version };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

module.exports = { RecetaInvalida, lineas, hojas, snapshot, versiones, obtener, guardar };
