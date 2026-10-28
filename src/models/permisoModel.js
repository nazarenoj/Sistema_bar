const pool = require('../config/db');
const { PERMISOS } = require('../permisos/catalogo');

// Orden de "cuánto deja hacer" cada nivel: con varios roles gana el más permisivo; la excepción
// individual del usuario pisa a todos.
const PESO = { denegado: 0, requiere_autorizacion: 1, permitido: 2 };

const ROL_LEGACY = { admin: 'administrador', empleado: 'encargado' };

// Roles del usuario. Un usuario sin filas en usuario_roles (creado a mano en la base) toma el rol
// que corresponde a su campo `rol` de siempre.
const rolesDe = async (userId, rolLegacy) => {
  const [rows] = await pool.query(
    'SELECT r.id, r.codigo FROM usuario_roles ur JOIN roles r ON r.id = ur.rol_id WHERE ur.user_id = ?', [userId]);
  if (rows.length) return rows;
  const [fallback] = await pool.query('SELECT id, codigo FROM roles WHERE codigo = ?', [ROL_LEGACY[rolLegacy] || 'mozo']);
  return fallback;
};

// Permisos efectivos de un usuario: { esAdmin, niveles: { permiso: nivel } }. Se calcula en cada
// acción (RN09): un cambio de rol rige desde la siguiente.
const efectivos = async (userId, rolLegacy) => {
  const roles = await rolesDe(userId, rolLegacy);
  const esAdmin = roles.some((r) => r.codigo === 'administrador');
  const niveles = {};
  if (esAdmin) {
    for (const p of PERMISOS) niveles[p.id] = 'permitido';
    return { esAdmin, niveles, roles: roles.map((r) => r.codigo) };
  }
  if (roles.length) {
    const [rp] = await pool.query('SELECT permiso, nivel FROM rol_permisos WHERE rol_id IN (?)', [roles.map((r) => r.id)]);
    for (const { permiso, nivel } of rp) if (!(permiso in niveles) || PESO[nivel] > PESO[niveles[permiso]]) niveles[permiso] = nivel;
  }
  const [ex] = await pool.query('SELECT permiso, nivel FROM usuario_permisos WHERE user_id = ?', [userId]);
  for (const { permiso, nivel } of ex) niveles[permiso] = nivel;
  for (const p of PERMISOS) if (!(p.id in niveles)) niveles[p.id] = 'denegado';
  return { esAdmin, niveles, roles: roles.map((r) => r.codigo) };
};

const alcancesDe = async (userId) => {
  const [rows] = await pool.query('SELECT tipo, valor FROM usuario_alcances WHERE user_id = ?', [userId]);
  return rows;
};

const listarRoles = async () => {
  const [roles] = await pool.query('SELECT * FROM roles ORDER BY predefinido DESC, id');
  const [rp] = await pool.query('SELECT rol_id, permiso, nivel FROM rol_permisos');
  const [uso] = await pool.query('SELECT rol_id, COUNT(*) AS usuarios FROM usuario_roles GROUP BY rol_id');
  return roles.map((r) => ({
    ...r,
    usuarios: uso.find((u) => u.rol_id === r.id)?.usuarios ?? 0,
    permisos: Object.fromEntries(rp.filter((x) => x.rol_id === r.id).map((x) => [x.permiso, x.nivel])),
  }));
};

const getRol = async (id) => (await listarRoles()).find((r) => r.id === id) || null;

const guardarPermisosRol = async (conn, rolId, permisos) => {
  await conn.query('DELETE FROM rol_permisos WHERE rol_id = ?', [rolId]);
  const filas = Object.entries(permisos).map(([p, n]) => [rolId, p, n]);
  if (filas.length) await conn.query('INSERT INTO rol_permisos (rol_id, permiso, nivel) VALUES ?', [filas]);
};

const crearRol = async ({ codigo, nombre, descripcion, permisos }) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query('INSERT INTO roles (codigo, nombre, descripcion) VALUES (?, ?, ?)', [codigo, nombre, descripcion ?? null]);
    await guardarPermisosRol(conn, r.insertId, permisos || {});
    await conn.commit();
    return r.insertId;
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const actualizarRol = async (id, { nombre, descripcion, permisos }) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (nombre !== undefined) await conn.query('UPDATE roles SET nombre = ? WHERE id = ?', [nombre, id]);
    if (descripcion !== undefined) await conn.query('UPDATE roles SET descripcion = ? WHERE id = ?', [descripcion, id]);
    if (permisos) await guardarPermisosRol(conn, id, permisos);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const borrarRol = (id) => pool.query('DELETE FROM roles WHERE id = ? AND predefinido = 0', [id]);

// Reemplaza roles, excepciones y alcances de un usuario, y deja el campo `rol` de siempre
// ('admin' / 'empleado') acorde, porque otras partes (vencimiento por inactividad, RN06) lo leen.
const guardarAccesos = async (userId, { rolIds, excepciones, alcances }) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (rolIds) {
      await conn.query('DELETE FROM usuario_roles WHERE user_id = ?', [userId]);
      if (rolIds.length) await conn.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES ?', [rolIds.map((r) => [userId, r])]);
      await conn.query(
        `UPDATE users SET rol = IF(EXISTS (SELECT 1 FROM usuario_roles ur JOIN roles r ON r.id = ur.rol_id
           WHERE ur.user_id = ? AND r.codigo = 'administrador'), 'admin', 'empleado') WHERE id = ?`, [userId, userId]);
    }
    if (excepciones) {
      await conn.query('DELETE FROM usuario_permisos WHERE user_id = ?', [userId]);
      const filas = Object.entries(excepciones).map(([p, n]) => [userId, p, n]);
      if (filas.length) await conn.query('INSERT INTO usuario_permisos (user_id, permiso, nivel) VALUES ?', [filas]);
    }
    if (alcances) {
      await conn.query('DELETE FROM usuario_alcances WHERE user_id = ?', [userId]);
      if (alcances.length) await conn.query('INSERT INTO usuario_alcances (user_id, tipo, valor) VALUES ?', [alcances.map((a) => [userId, a.tipo, a.valor || ''])]);
    }
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const accesosDe = async (userId) => {
  const [roles] = await pool.query('SELECT rol_id FROM usuario_roles WHERE user_id = ?', [userId]);
  const [ex] = await pool.query('SELECT permiso, nivel FROM usuario_permisos WHERE user_id = ?', [userId]);
  return { rolIds: roles.map((r) => r.rol_id), excepciones: Object.fromEntries(ex.map((e) => [e.permiso, e.nivel])), alcances: await alcancesDe(userId) };
};

module.exports = { efectivos, alcancesDe, listarRoles, getRol, crearRol, actualizarRol, borrarRol, guardarAccesos, accesosDe };
