const pool = require('../config/db');

// Depósitos (Stock RF03): varios por instancia, siempre uno predeterminado y activo.
const getAll = async () => (await pool.query('SELECT * FROM depositos ORDER BY predeterminado DESC, nombre'))[0];
const getById = async (id, conn = pool) => (await conn.query('SELECT * FROM depositos WHERE id = ?', [id]))[0][0] ?? null;
const getPredeterminado = async (conn = pool) => (await conn.query('SELECT * FROM depositos WHERE predeterminado = 1 LIMIT 1'))[0][0];

const create = async (nombre) => {
  const [r] = await pool.query('INSERT INTO depositos (nombre) VALUES (?)', [nombre]);
  return getById(r.insertId);
};

// Cambia el predeterminado de forma atómica: nunca quedan cero ni dos.
const setPredeterminado = async (id) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const d = await getById(id, conn);
    if (!d || !d.activo) { await conn.rollback(); return null; }
    await conn.query('UPDATE depositos SET predeterminado = 0 WHERE predeterminado = 1');
    await conn.query('UPDATE depositos SET predeterminado = 1 WHERE id = ?', [id]);
    await conn.commit();
    return getById(id);
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const update = async (id, { nombre, activo }) => {
  await pool.query('UPDATE depositos SET nombre = ?, activo = ? WHERE id = ?', [nombre, activo === false ? 0 : 1, id]);
  return getById(id);
};

// De qué depósito descuenta un sector de comanda: el asignado, o el predeterminado (RF03).
const depositoDeSector = async (sectorId, conn = pool) => {
  if (sectorId !== null && sectorId !== undefined) {
    const [[a]] = await conn.query('SELECT d.* FROM sector_deposito sd JOIN depositos d ON d.id = sd.deposito_id WHERE sd.sector_id = ? AND d.activo = 1', [sectorId]);
    if (a) return a;
  }
  return getPredeterminado(conn);
};

const asignarSector = async (sectorId, depositoId) => {
  await pool.query('INSERT INTO sector_deposito (sector_id, deposito_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE deposito_id = VALUES(deposito_id)', [sectorId, depositoId]);
};
const quitarSector = async (sectorId) => (await pool.query('DELETE FROM sector_deposito WHERE sector_id = ?', [sectorId]))[0].affectedRows > 0;
const sectores = async () => (await pool.query('SELECT s.id AS sector_id, s.nombre AS sector, sd.deposito_id FROM sectores_comanda s LEFT JOIN sector_deposito sd ON sd.sector_id = s.id ORDER BY s.nombre'))[0];

// Configuración del ítem por depósito (stock mínimo y punto de reposición, RF01).
const configItem = async (insumoId) => (await pool.query(
  'SELECT c.deposito_id, d.nombre AS deposito, c.stock_minimo, c.punto_reposicion FROM item_deposito_config c JOIN depositos d ON d.id = c.deposito_id WHERE c.insumo_id = ? ORDER BY d.nombre', [insumoId]))[0];
const setConfigItem = async (insumoId, depositoId, { stock_minimo, punto_reposicion }) => {
  await pool.query(
    'INSERT INTO item_deposito_config (insumo_id, deposito_id, stock_minimo, punto_reposicion) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE stock_minimo = VALUES(stock_minimo), punto_reposicion = VALUES(punto_reposicion)',
    [insumoId, depositoId, stock_minimo, punto_reposicion]);
};

module.exports = { getAll, getById, getPredeterminado, create, setPredeterminado, update, depositoDeSector, asignarSector, quitarSector, sectores, configItem, setConfigItem };
