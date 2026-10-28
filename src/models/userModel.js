const pool = require('../config/db');

// "habilitado" junta el estado manual (activo) con la baja programada: un usuario con fecha_baja
// deja de poder ingresar desde ese día. "bloqueo_min" son los minutos que faltan para que termine
// el bloqueo por intentos fallidos (0 = no está bloqueado). Todo con la hora de la base.
const SELECT = `
  SELECT u.*,
         (u.activo = 1 AND (u.fecha_baja IS NULL OR u.fecha_baja > CURDATE())) AS habilitado,
         IF(u.bloqueado_hasta > NOW(), TIMESTAMPDIFF(MINUTE, NOW(), u.bloqueado_hasta) + 1, 0) AS bloqueo_min
  FROM users u`;

const getByUsername = async (username) => {
  const [rows] = await pool.query(`${SELECT} WHERE u.username = ?`, [username]);
  return rows[0] || null;
};

const getById = async (id) => {
  const [rows] = await pool.query(`${SELECT} WHERE u.id = ?`, [id]);
  return rows[0] || null;
};

const getByPin = async (hash) => {
  const [rows] = await pool.query(`${SELECT} WHERE u.pin_hash = ?`, [hash]);
  return rows[0] || null;
};

const getByTarjeta = async (hash) => {
  const [rows] = await pool.query(`${SELECT} WHERE u.tarjeta_hash = ?`, [hash]);
  return rows[0] || null;
};

// Sin hashes: lo que sale de acá puede viajar al navegador.
const listar = async () => {
  const [rows] = await pool.query(`
    SELECT u.id, u.username, u.nombre, u.email, u.rol, u.activo, u.fecha_baja, u.ultimo_login, u.created_at,
           u.debe_cambiar_password, u.pin_hash IS NOT NULL AS tiene_pin, u.tarjeta_hash IS NOT NULL AS tiene_tarjeta,
           (u.activo = 1 AND (u.fecha_baja IS NULL OR u.fecha_baja > CURDATE())) AS habilitado,
           IF(u.bloqueado_hasta > NOW(), TIMESTAMPDIFF(MINUTE, NOW(), u.bloqueado_hasta) + 1, 0) AS bloqueo_min
    FROM users u ORDER BY u.username`);
  const [roles] = await pool.query('SELECT ur.user_id, r.id, r.nombre FROM usuario_roles ur JOIN roles r ON r.id = ur.rol_id');
  for (const u of rows) u.roles = roles.filter((r) => r.user_id === u.id).map((r) => ({ id: r.id, nombre: r.nombre }));
  return rows;
};

const crear = async (d) => {
  const [r] = await pool.query(
    `INSERT INTO users (username, password_hash, rol, nombre, email, pin_hash, tarjeta_hash, fecha_baja, debe_cambiar_password)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [d.username, d.password_hash, d.rol, d.nombre ?? null, d.email ?? null, d.pin_hash ?? null, d.tarjeta_hash ?? null, d.fecha_baja ?? null]
  );
  return r.insertId;
};

// Solo las columnas que vienen en `cambios` (lista blanca: los nombres van directo al SQL).
const COLUMNAS_EDITABLES = ['nombre', 'email', 'rol', 'pin_hash', 'tarjeta_hash', 'fecha_baja', 'activo'];
const actualizar = async (id, cambios) => {
  const claves = Object.keys(cambios).filter((k) => COLUMNAS_EDITABLES.includes(k));
  if (!claves.length) return 0;
  const [r] = await pool.query(
    `UPDATE users SET ${claves.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    [...claves.map((k) => cambios[k]), id]
  );
  return r.affectedRows;
};

const setPassword = async (id, hash, debeCambiar) => {
  await pool.query(
    'UPDATE users SET password_hash = ?, debe_cambiar_password = ? WHERE id = ?',
    [hash, debeCambiar ? 1 : 0, id]
  );
};

// A los `max` fallos seguidos bloquea `minutos` y vuelve el contador a cero. En un UPDATE de MySQL
// las asignaciones se evalúan de izquierda a derecha: bloqueado_hasta va primero para ver todavía
// el contador anterior.
const registrarFallo = async (id, max, minutos) => {
  await pool.query(
    `UPDATE users SET
       bloqueado_hasta   = IF(intentos_fallidos + 1 >= ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), bloqueado_hasta),
       intentos_fallidos = IF(intentos_fallidos + 1 >= ?, 0, intentos_fallidos + 1)
     WHERE id = ?`,
    [max, minutos, max, id]
  );
};

const registrarLoginOk = async (id) => {
  await pool.query('UPDATE users SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_login = NOW() WHERE id = ?', [id]);
};

const desbloquear = async (id) => {
  await pool.query('UPDATE users SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?', [id]);
};

// Administradores activos y sin baja programada, sin contar a `excluirId` (Usuarios RN06).
const contarAdminsPermanentes = async (excluirId) => {
  const [[{ n }]] = await pool.query(
    "SELECT COUNT(*) AS n FROM users WHERE rol = 'admin' AND activo = 1 AND fecha_baja IS NULL AND id <> ?",
    [excluirId]
  );
  return n;
};

module.exports = {
  getByUsername, getById, getByPin, getByTarjeta, listar, crear, actualizar, setPassword,
  registrarFallo, registrarLoginOk, desbloquear, contarAdminsPermanentes,
};
