const pool = require('../config/db');
const Silla = require('./sillaModel');

const getAll = async (salon_id) => {
  const [rows] = await pool.query(
    `SELECT m.*, g.numero_mesa AS numero_mesa_grupo, g.mesa_master_id
     FROM mesas m
     LEFT JOIN mesa_grupos g ON m.grupo_id = g.id
     WHERE m.salon_id = ? AND m.activa = 1 AND m.es_virtual = 0
     ORDER BY m.numero_mesa ASC`,
    [salon_id]
  );
  if (!rows.length) return rows;

  // Sillas dibujadas (fijas, configurables en modo edición), agrupadas por mesa
  const sillas = await Silla.getByMesas(rows.map((m) => m.id));
  const sillasPorMesa = new Map();
  for (const s of sillas) {
    if (!sillasPorMesa.has(s.mesa_id)) sillasPorMesa.set(s.mesa_id, []);
    sillasPorMesa.get(s.mesa_id).push(s);
  }

  return rows.map((m) => ({ ...m, sillas: sillasPorMesa.get(m.id) || [] }));
};

const getById = async (id, conn = pool) => {
  const [rows] = await conn.query('SELECT * FROM mesas WHERE id = ?', [id]);
  return rows[0] || null;
};

// El número de mesa no tiene un UNIQUE a nivel de base (ver alter_mesas_borrado_logico.sql):
// una mesa eliminada conserva su número en la fila inactiva, así que la unicidad solo se exige
// entre mesas activas.
const create = async (numero_mesa, salon_id) => {
  const [existentes] = await pool.query(
    'SELECT id FROM mesas WHERE numero_mesa = ? AND activa = 1',
    [numero_mesa]
  );
  if (existentes.length) {
    const err = new Error(`Ya existe la mesa número ${numero_mesa}.`);
    err.code = 'ER_DUP_ENTRY';
    throw err;
  }

  // Ubica la mesa nueva en una grilla de 4 columnas para que no aparezca apilada sobre otras
  const [result] = await pool.query(
    'INSERT INTO mesas (numero_mesa, salon_id) VALUES (?, ?)',
    [numero_mesa, salon_id]
  );
  const id = result.insertId;
  const pos_x = (id % 4) * 170;
  const pos_y = Math.floor(id / 4) * 150;
  await pool.query('UPDATE mesas SET pos_x = ?, pos_y = ? WHERE id = ?', [pos_x, pos_y, id]);
  const [rows] = await pool.query('SELECT * FROM mesas WHERE id = ?', [id]);
  return rows[0];
};

// Mesa propia de un pedido que no es de salón (mostrador, para llevar, delivery, retiro): oculta en el salón y
// cerrada al terminar la cuenta (ver confirmarTicket). Así usa el mismo cierre, venta y factura que una mesa.
const createVirtual = async () => {
  const [[salon]] = await pool.query('SELECT id FROM salones ORDER BY id LIMIT 1');
  const [r] = await pool.query("INSERT INTO mesas (numero_mesa, salon_id, estado, es_virtual) VALUES (0, ?, 'ocupado', 1)", [salon.id]);
  return getById(r.insertId);
};

const updateEstado = async (id, estado, conn = pool) => {
  await conn.query('UPDATE mesas SET estado = ? WHERE id = ?', [estado, id]);
};

// Marca/desmarca que la mesa tiene un ticket pendiente de imprimir o descargar. Mientras esté
// marcado, la mesa sigue "ocupada" aunque no tenga pedidos activos (ver mesaController.cerrarCuenta).
const setTicketPendiente = async (id, pendiente, conn = pool) => {
  await conn.query('UPDATE mesas SET ticket_pendiente = ? WHERE id = ?', [pendiente ? 1 : 0, id]);
};

const updatePosicion = async (id, pos_x, pos_y) => {
  const [result] = await pool.query('UPDATE mesas SET pos_x = ?, pos_y = ? WHERE id = ?', [pos_x, pos_y, id]);
  return result.affectedRows;
};

const updateColor = async (id, color_libre, color_ocupado) => {
  const [result] = await pool.query(
    'UPDATE mesas SET color_libre = ?, color_ocupado = ? WHERE id = ?',
    [color_libre, color_ocupado, id]
  );
  return result.affectedRows;
};

const updateTamano = async (id, tamano) => {
  const [result] = await pool.query('UPDATE mesas SET tamano = ? WHERE id = ?', [tamano, id]);
  return result.affectedRows;
};

const hasGrupo = async (id) => {
  const mesa = await getById(id);
  return mesa ? mesa.grupo_id !== null : false;
};

// Borrado lógico: no se borra la fila para no romper la FK de los pedidos históricos que la
// referencian. La mesa deja de listarse (ver getAll) pero su historial se sigue viendo igual.
const remove = async (id) => {
  const [result] = await pool.query('UPDATE mesas SET activa = 0 WHERE id = ?', [id]);
  return result.affectedRows;
};

// Combina N mesas libres y sin grupo previo en un solo grupo, con la mesa de menor id
// como "maestra": todas las operaciones de pedidos/cuenta del grupo se hacen sobre su id.
const combinar = async (mesaIds, numeroMesa, salonId) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const placeholders = mesaIds.map(() => '?').join(',');
    const [rows] = await conn.query(
      `SELECT * FROM mesas WHERE id IN (${placeholders}) FOR UPDATE`,
      mesaIds
    );

    if (rows.length !== mesaIds.length) {
      const err = new Error('Alguna de las mesas seleccionadas no existe.');
      err.code = 'MESA_NO_ENCONTRADA';
      throw err;
    }

    for (const mesa of rows) {
      if (mesa.estado !== 'libre') {
        const err = new Error(`La mesa ${mesa.numero_mesa} no está libre.`);
        err.code = 'MESA_NO_LIBRE';
        throw err;
      }
      if (mesa.grupo_id !== null) {
        const err = new Error(`La mesa ${mesa.numero_mesa} ya forma parte de un grupo.`);
        err.code = 'MESA_YA_COMBINADA';
        throw err;
      }
      if (mesa.salon_id !== salonId) {
        const err = new Error('Todas las mesas a combinar deben pertenecer al mismo salón.');
        err.code = 'SALON_DISTINTO';
        throw err;
      }
    }

    const masterId = Math.min(...rows.map((m) => m.id));
    const [result] = await conn.query(
      'INSERT INTO mesa_grupos (salon_id, numero_mesa, mesa_master_id) VALUES (?, ?, ?)',
      [salonId, numeroMesa, masterId]
    );
    const grupoId = result.insertId;

    await conn.query(
      `UPDATE mesas SET grupo_id = ? WHERE id IN (${placeholders})`,
      [grupoId, ...mesaIds]
    );

    await conn.commit();
    const [grupoRows] = await pool.query('SELECT * FROM mesa_grupos WHERE id = ?', [grupoId]);
    return grupoRows[0];
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

// Deshace un grupo de mesas combinadas; sólo si la mesa maestra está libre (sin cuenta abierta)
const separar = async (grupoId) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [grupoRows] = await conn.query('SELECT * FROM mesa_grupos WHERE id = ? FOR UPDATE', [grupoId]);
    if (!grupoRows.length) {
      const err = new Error('El grupo de mesas indicado no existe.');
      err.code = 'GRUPO_NO_ENCONTRADO';
      throw err;
    }

    const grupo = grupoRows[0];
    const [masterRows] = await conn.query('SELECT * FROM mesas WHERE id = ?', [grupo.mesa_master_id]);
    if (masterRows[0].estado !== 'libre') {
      const err = new Error('No se puede separar un grupo con una cuenta abierta. Cerrá la cuenta primero.');
      err.code = 'GRUPO_OCUPADO';
      throw err;
    }

    await conn.query('UPDATE mesas SET grupo_id = NULL WHERE grupo_id = ?', [grupoId]);
    await conn.query('DELETE FROM mesa_grupos WHERE id = ?', [grupoId]);

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

module.exports = { createVirtual,
  getAll,
  getById,
  create,
  updateEstado,
  setTicketPendiente,
  updatePosicion,
  updateColor,
  updateTamano,
  hasGrupo,
  remove,
  combinar,
  separar,
};
