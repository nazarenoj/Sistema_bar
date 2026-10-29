const pool = require('../config/db');

const getAll = async () => {
  const [rows] = await pool.query('SELECT * FROM insumos ORDER BY id ASC');
  return rows;
};

const getById = async (id) => {
  const [rows] = await pool.query('SELECT * FROM insumos WHERE id = ?', [id]);
  return rows[0] || null;
};

const getByNombre = async (nombre) => {
  const [rows] = await pool.query(
    'SELECT * FROM insumos WHERE nombre LIKE ?',
    [`%${nombre}%`]
  );
  return rows;
};

const create = async ({ nombre, unidad, costo_unitario, stock, disponible }) => {
  const [result] = await pool.query(
    'INSERT INTO insumos (nombre, unidad, costo_unitario, stock, disponible) VALUES (?, ?, ?, ?, ?)',
    [nombre, unidad, costo_unitario ?? null, stock ?? 0, disponible === false ? 0 : 1]
  );
  const [newRow] = await pool.query('SELECT * FROM insumos WHERE id = ?', [result.insertId]);
  return newRow[0];
};

// El stock no se edita a mano: solo se fija al crear el insumo y luego solo se descuenta
// automáticamente al vender productos que lo usan (igual que productos, ver decrementarStockPorVenta).
const update = async (id, { nombre, unidad, costo_unitario, disponible }) => {
  const [result] = await pool.query(
    'UPDATE insumos SET nombre = ?, unidad = ?, costo_unitario = ?, disponible = ? WHERE id = ?',
    [nombre, unidad, costo_unitario ?? null, disponible === false ? 0 : 1, id]
  );
  return result.affectedRows;
};

const remove = async (id) => {
  try {
    const [result] = await pool.query('DELETE FROM insumos WHERE id = ?', [id]);
    return result.affectedRows;
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
      const error = new Error('El insumo está siendo usado en la receta de uno o más productos y no puede eliminarse.');
      error.code = 'INSUMO_CON_PRODUCTOS';
      throw error;
    }
    throw err;
  }
};

// Descuenta stock de insumos según la receta (producto_insumos) de los productos vendidos.
// items: [{ producto_id, cantidad, ... }] — las mismas filas que ya usa Producto.decrementarStock.
// Nunca baja de 0 (GREATEST) para no dejar valores negativos si hay descuadres.
const decrementarStockPorVenta = async (items, conn) => {
  const cantidadPorProducto = new Map();
  for (const { producto_id, cantidad } of items) {
    cantidadPorProducto.set(producto_id, (cantidadPorProducto.get(producto_id) || 0) + cantidad);
  }
  const productoIds = [...cantidadPorProducto.keys()];
  if (!productoIds.length) return;

  const placeholders = productoIds.map(() => '?').join(',');
  const [recetas] = await conn.query(
    `SELECT producto_id, insumo_id, cantidad_consumida * COALESCE(factor_aplicado, 1) AS cantidad_consumida FROM producto_insumos WHERE producto_id IN (${placeholders})`,
    productoIds
  );

  const consumoPorInsumo = new Map();
  for (const { producto_id, insumo_id, cantidad_consumida } of recetas) {
    const vendidos = cantidadPorProducto.get(producto_id) || 0;
    const consumo = vendidos * Number(cantidad_consumida);
    consumoPorInsumo.set(insumo_id, (consumoPorInsumo.get(insumo_id) || 0) + consumo);
  }

  for (const [insumo_id, consumo] of consumoPorInsumo) {
    await conn.query('UPDATE insumos SET stock = GREATEST(stock - ?, 0) WHERE id = ?', [consumo, insumo_id]);
  }
};

// Reingresa los insumos de la receta de lo devuelto (el inverso de decrementarStockPorVenta).
const incrementarStockPorDevolucion = async (items, conn) => {
  const porProducto = new Map();
  for (const { producto_id, cantidad } of items) porProducto.set(producto_id, (porProducto.get(producto_id) || 0) + cantidad);
  if (!porProducto.size) return;
  const ids = [...porProducto.keys()];
  const [recetas] = await conn.query(`SELECT producto_id, insumo_id, cantidad_consumida * COALESCE(factor_aplicado, 1) AS cantidad_consumida FROM producto_insumos WHERE producto_id IN (${ids.map(() => '?').join(',')})`, ids);
  for (const { producto_id, insumo_id, cantidad_consumida } of recetas)
    await conn.query('UPDATE insumos SET stock = stock + ? WHERE id = ?', [porProducto.get(producto_id) * Number(cantidad_consumida), insumo_id]);
};

// --- Relación producto ↔ insumos (receta) ---

const getByProducto = async (producto_id, conn = pool) => {
  const [rows] = await conn.query(
    `SELECT pi.id, pi.insumo_id, pi.cantidad_consumida, pi.presentacion_id, pi.factor_aplicado, i.nombre, i.unidad
     FROM producto_insumos pi
     JOIN insumos i ON i.id = pi.insumo_id
     WHERE pi.producto_id = ?
     ORDER BY pi.id ASC`,
    [producto_id]
  );
  return rows;
};

const getLinea = async (id, conn = pool) => {
  const [rows] = await conn.query('SELECT * FROM producto_insumos WHERE id = ?', [id]);
  return rows[0] || null;
};

const addToProducto = async (producto_id, insumo_id, cantidad_consumida, conn = pool, { presentacion_id = null, factor_aplicado = null } = {}) => {
  const [result] = await conn.query(
    'INSERT INTO producto_insumos (producto_id, insumo_id, cantidad_consumida, presentacion_id, factor_aplicado) VALUES (?, ?, ?, ?, ?)',
    [producto_id, insumo_id, cantidad_consumida, presentacion_id, factor_aplicado]
  );
  const [rows] = await conn.query(
    `SELECT pi.id, pi.insumo_id, pi.cantidad_consumida, pi.presentacion_id, pi.factor_aplicado, i.nombre, i.unidad
     FROM producto_insumos pi JOIN insumos i ON i.id = pi.insumo_id WHERE pi.id = ?`,
    [result.insertId]
  );
  return rows[0];
};

const updateCantidad = async (id, cantidad_consumida, conn = pool) => {
  const [result] = await conn.query(
    'UPDATE producto_insumos SET cantidad_consumida = ? WHERE id = ?',
    [cantidad_consumida, id]
  );
  return result.affectedRows;
};

const removeFromProducto = async (id, conn = pool) => {
  const [result] = await conn.query('DELETE FROM producto_insumos WHERE id = ?', [id]);
  return result.affectedRows;
};

module.exports = {
  getAll, getById, getByNombre, create, update, remove, decrementarStockPorVenta, incrementarStockPorDevolucion,
  getByProducto, getLinea, addToProducto, updateCantidad, removeFromProducto,
};
