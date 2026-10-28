const pool = require('../config/db');
const Parametro = require('./parametroModel');

const crear = async ({ user_id, terminal_id, ip }) => {
  const [r] = await pool.query(
    'INSERT INTO sesiones (user_id, terminal_id, inicio, ultimo_acceso, ip) VALUES (?, ?, NOW(), NOW(), ?)',
    [user_id, terminal_id ?? null, ip ?? null]
  );
  return r.insertId;
};

// Sesión con lo que el middleware necesita en una sola consulta: el estado actual del usuario
// (puede haberse desactivado después del ingreso), la terminal y los segundos sin actividad.
const getConUsuario = async (id) => {
  const [rows] = await pool.query(
    `SELECT s.*, u.username, u.rol, u.debe_cambiar_password,
            (u.activo = 1 AND (u.fecha_baja IS NULL OR u.fecha_baja > CURDATE())) AS habilitado,
            t.inactividad_min AS inactividad_terminal,
            TIMESTAMPDIFF(SECOND, s.ultimo_acceso, NOW()) AS inactivo_seg
     FROM sesiones s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN terminales t ON t.id = s.terminal_id
     WHERE s.id = ?`,
    [id]
  );
  return rows[0] || null;
};

// Minutos de inactividad permitidos: el de la terminal si lo tiene, si no el del rol.
const minutosInactividad = (sesion, params) =>
  sesion.inactividad_terminal ?? params[`inactividad_min_${sesion.rol}`] ?? params.inactividad_min_empleado ?? 10;

const tocar = async (id) => {
  await pool.query('UPDATE sesiones SET ultimo_acceso = NOW() WHERE id = ? AND fin IS NULL', [id]);
};

const cerrar = async (id, motivo) => {
  const [r] = await pool.query('UPDATE sesiones SET fin = NOW(), motivo_fin = ? WHERE id = ? AND fin IS NULL', [motivo, id]);
  return r.affectedRows;
};

// Cierra todas las sesiones abiertas de un usuario, salvo `exceptoId` (la que está en uso).
const cerrarDeUsuario = async (user_id, motivo, exceptoId = 0) => {
  await pool.query(
    'UPDATE sesiones SET fin = NOW(), motivo_fin = ? WHERE user_id = ? AND fin IS NULL AND id <> ?',
    [motivo, user_id, exceptoId]
  );
};

// Sesiones abiertas para la pantalla del Administrador. Las que ya vencieron por inactividad se
// cierran acá mismo, así la lista nunca muestra una sesión que en realidad ya no sirve.
const listarActivas = async () => {
  const [rows] = await pool.query(
    `SELECT s.id, s.user_id, u.username, u.nombre, u.rol, s.terminal_id, t.nombre AS terminal, s.inicio,
            s.ultimo_acceso, s.ip, t.inactividad_min AS inactividad_terminal,
            TIMESTAMPDIFF(SECOND, s.ultimo_acceso, NOW()) AS inactivo_seg
     FROM sesiones s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN terminales t ON t.id = s.terminal_id
     WHERE s.fin IS NULL ORDER BY s.inicio DESC`
  );
  const params = await Parametro.todos();
  const vigentes = [];
  for (const s of rows) {
    if (s.inactivo_seg > minutosInactividad(s, params) * 60) await cerrar(s.id, 'inactividad');
    else vigentes.push(s);
  }
  return vigentes;
};

module.exports = { crear, getConUsuario, minutosInactividad, tocar, cerrar, cerrarDeUsuario, listarActivas };
