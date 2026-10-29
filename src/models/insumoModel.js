const pool = require('../config/db');
const Mov = require('../stock/movimientoService');

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
    [nombre, unidad, costo_unitario ?? null, 0, disponible === false ? 0 : 1]
  );
  await Mov.saldoInicial({ tipo: 'insumo', id: result.insertId }, stock ?? 0);
  const [newRow] = await pool.query('SELECT * FROM insumos WHERE id = ?', [result.insertId]);
  return newRow[0];
};

// El stock no se edita a mano: cada cambio es un movimiento del libro de Stock (ver src/stock/movimientoService.js).
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
  getAll, getById, getByNombre, create, update, remove,
  getByProducto, getLinea, addToProducto, updateCantidad, removeFromProducto,
};
