const crypto = require('crypto');
const pool = require('../config/db');

// Sin 0/O ni 1/I: el código se tipea a mano en el equipo.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const generarCodigo = () =>
  Array.from(crypto.randomBytes(8), (b) => ALFABETO[b % ALFABETO.length]).join('');

const getByCodigo = async (codigo) => {
  const [rows] = await pool.query('SELECT * FROM terminales WHERE codigo = ?', [codigo]);
  return rows[0] || null;
};

const getById = async (id) => {
  const [rows] = await pool.query('SELECT * FROM terminales WHERE id = ?', [id]);
  return rows[0] || null;
};

// "segundos_sin_contacto" se calcula con la hora de la base; el controller lo compara con el
// parámetro terminal_sin_contacto_seg.
const listar = async () => {
  const [rows] = await pool.query(
    `SELECT t.*, TIMESTAMPDIFF(SECOND, t.ultimo_contacto, NOW()) AS segundos_sin_contacto,
            (SELECT COUNT(*) FROM sesiones s WHERE s.terminal_id = t.id AND s.fin IS NULL) AS sesiones_abiertas
     FROM terminales t ORDER BY t.nombre`
  );
  return rows;
};

const crear = async ({ nombre, tipo, inactividad_min }) => {
  const codigo = generarCodigo();
  const [r] = await pool.query(
    'INSERT INTO terminales (nombre, codigo, tipo, inactividad_min) VALUES (?, ?, ?, ?)',
    [nombre, codigo, tipo, inactividad_min ?? null]
  );
  return { id: r.insertId, codigo };
};

const COLUMNAS_EDITABLES = ['nombre', 'tipo', 'activa', 'inactividad_min'];
const actualizar = async (id, cambios) => {
  const claves = Object.keys(cambios).filter((k) => COLUMNAS_EDITABLES.includes(k));
  if (!claves.length) return 0;
  const [r] = await pool.query(
    `UPDATE terminales SET ${claves.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    [...claves.map((k) => cambios[k]), id]
  );
  return r.affectedRows;
};

const tocar = async (id) => {
  await pool.query('UPDATE terminales SET ultimo_contacto = NOW() WHERE id = ?', [id]);
};

module.exports = { getByCodigo, getById, listar, crear, actualizar, tocar };
