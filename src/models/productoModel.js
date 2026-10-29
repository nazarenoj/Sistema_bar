const pool = require('../config/db');

const getAll = async () => {
  const [rows] = await pool.query('SELECT * FROM productos ORDER BY id ASC');
  return rows;
};

const getById = async (id) => {
  const [rows] = await pool.query('SELECT * FROM productos WHERE id = ?', [id]);
  return rows[0] || null;
};

const getByNombre = async (nombre) => {
  const [rows] = await pool.query(
    'SELECT * FROM productos WHERE nombre LIKE ?',
    [`%${nombre}%`]
  );
  return rows;
};

// Campos del catálogo (B1) además de nombre, precio y descripción; todos opcionales salvo el tipo, que por defecto es estándar.
const CAMPOS = ['tipo', 'sku', 'codigo_barras', 'categoria_id', 'sector_id', 'producto_base_id',
  'alicuota_iva', 'agotado', 'tara', 'peso_minimo', 'peso_maximo'];
const extras = (d) => CAMPOS.filter((c) => d[c] !== undefined);

const create = async ({ nombre, precio, descripcion, stock, ...resto }) => {
  const cols = extras(resto);
  const [result] = await pool.query(
    `INSERT INTO productos (nombre, precio, descripcion, stock${cols.map((c) => `, ${c}`).join('')}) VALUES (?, ?, ?, ?${cols.map(() => ', ?').join('')})`,
    [nombre, precio, descripcion ?? null, stock ?? 0, ...cols.map((c) => resto[c])]
  );
  const [newRow] = await pool.query('SELECT * FROM productos WHERE id = ?', [result.insertId]);
  return newRow[0];
};

// El stock no se edita a mano: solo cambia al crear el producto o al cerrar pedidos (ver decrementarStock)
const update = async (id, { nombre, precio, descripcion, ...resto }) => {
  const cols = extras(resto);
  const [result] = await pool.query(
    `UPDATE productos SET nombre = ?, precio = ?, descripcion = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ?`,
    [nombre, precio, descripcion ?? null, ...cols.map((c) => resto[c]), id]
  );
  return result.affectedRows;
};

// --- Combos (Ventas RN03): los componentes son otros productos; sin ciclos y con profundidad máxima 3.
const PROFUNDIDAD_MAXIMA = 3;

const getComponentes = async (combo_id) => {
  const [rows] = await pool.query(
    `SELECT pc.id, pc.componente_id, pc.cantidad, p.nombre, p.tipo
     FROM producto_componentes pc JOIN productos p ON p.id = pc.componente_id
     WHERE pc.combo_id = ? ORDER BY pc.id`, [combo_id]);
  return rows;
};

// Reemplaza los componentes de un combo. Devuelve null si quedó bien o el motivo del rechazo (nada se guarda).
const setComponentes = async (combo_id, componentes) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM producto_componentes WHERE combo_id = ?', [combo_id]);
    for (const { componente_id, cantidad } of componentes) {
      await conn.query('INSERT INTO producto_componentes (combo_id, componente_id, cantidad) VALUES (?, ?, ?)', [combo_id, componente_id, cantidad]);
    }
    // Se mide con las filas nuevas ya escritas (misma transacción); si no cumple, se revierte.
    const [filas] = await conn.query('SELECT combo_id, componente_id FROM producto_componentes');
    const hijos = new Map();
    for (const f of filas) hijos.set(f.combo_id, [...(hijos.get(f.combo_id) || []), f.componente_id]);
    const nivel = (id, vis) => {
      if (vis.has(id)) return Infinity;
      const sig = new Set(vis).add(id);
      return (hijos.get(id) || []).reduce((m, h) => Math.max(m, 1 + nivel(h, sig)), 0);
    };
    // Se mide desde cada combo: alargar este puede pasarse de nivel en uno que lo contiene.
    const n = Math.max(...[...hijos.keys()].map((id) => nivel(id, new Set())));
    if (n === Infinity) { await conn.rollback(); return 'El combo se contiene a sí mismo (ciclo).'; }
    if (n > PROFUNDIDAD_MAXIMA) { await conn.rollback(); return `Los combos no pueden anidarse más de ${PROFUNDIDAD_MAXIMA} niveles.`; }
    await conn.commit();
    return null;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

// Descuenta stock según lo consumido en una lista de items { producto_id, cantidad } (se suman por producto).
// Nunca baja de 0 (GREATEST) para no dejar valores negativos si hay descuadres.
const decrementarStock = async (items, conn) => {
  const cantidadPorProducto = new Map();
  for (const { producto_id, cantidad } of items) {
    cantidadPorProducto.set(producto_id, (cantidadPorProducto.get(producto_id) || 0) + cantidad);
  }
  for (const [producto_id, cantidad] of cantidadPorProducto) {
    await conn.query(
      'UPDATE productos SET stock = GREATEST(stock - ?, 0) WHERE id = ?',
      [cantidad, producto_id]
    );
  }
};

// Reingresa al stock lo devuelto (items { producto_id, cantidad }), el inverso de decrementarStock.
const incrementarStock = async (items, conn) => {
  for (const { producto_id, cantidad } of items)
    await conn.query('UPDATE productos SET stock = stock + ? WHERE id = ?', [cantidad, producto_id]);
};

const remove = async (id) => {
  try {
    const [result] = await pool.query('DELETE FROM productos WHERE id = ?', [id]);
    return result.affectedRows;
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
      const error = new Error('El producto tiene pedidos asociados y no puede eliminarse.');
      error.code = 'PRODUCTO_CON_PEDIDOS';
      throw error;
    }
    throw err;
  }
};

module.exports = { getAll, getById, getByNombre, create, update, getComponentes, setComponentes, decrementarStock, incrementarStock, remove };
