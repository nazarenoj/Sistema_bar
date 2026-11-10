const pool = require('../config/db');
const { invalida } = require('./comun');

// Adjuntos de los asientos (Contable RF05): el comprobante o la planilla que respalda un asiento manual. JPG, PNG o PDF de hasta 4 MB; un asiento no se borra, así que tampoco sus adjuntos.
const TIPOS = ['image/jpeg', 'image/png', 'application/pdf'];
const TOPE = 4 * 1024 * 1024;

const agregar = async (asientoId, { nombre, tipo, contenido }, usuarioId) => {
  const [[a]] = await pool.query('SELECT id, tipo FROM con_asientos WHERE id = ?', [asientoId]);
  if (!a) throw invalida('Asiento no encontrado.', 404);
  if (!TIPOS.includes(tipo)) throw invalida('El adjunto debe ser JPG, PNG o PDF.');
  const buf = contenido;
  if (!Buffer.isBuffer(buf) || !buf.length || buf.length > TOPE) throw invalida('El adjunto está vacío o supera los 4 MB.');
  const [r] = await pool.query('INSERT INTO con_adjuntos (asiento_id, nombre, tipo, contenido, usuario_id, ms) VALUES (?, ?, ?, ?, ?, ?)', [asientoId, String(nombre ?? 'adjunto').slice(0, 120), tipo, buf, usuarioId ?? null, Date.now()]);
  return { id: r.insertId, nombre: String(nombre ?? 'adjunto').slice(0, 120), tipo, bytes: buf.length };
};
const listar = async (asientoId) => (await pool.query('SELECT id, nombre, tipo, LENGTH(contenido) AS bytes, ms FROM con_adjuntos WHERE asiento_id = ? ORDER BY id', [asientoId]))[0].map((x) => ({ ...x, bytes: Number(x.bytes), ms: Number(x.ms) }));
const obtener = async (asientoId, id) => {
  const [[x]] = await pool.query('SELECT nombre, tipo, contenido FROM con_adjuntos WHERE asiento_id = ? AND id = ?', [asientoId, id]);
  if (!x) throw invalida('Adjunto no encontrado.', 404);
  return x;
};

module.exports = { agregar, listar, obtener };
