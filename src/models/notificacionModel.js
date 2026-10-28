const pool = require('../config/db');

// Centro de notificaciones (Usuarios RF17). `clave` identifica una alerta que debe existir una sola vez
// mientras siga abierta (por ejemplo, "mensaje fallido X"): volver a emitirla la actualiza en vez de
// duplicarla, y se resuelve sola cuando el origen se resuelve.
const SEVERIDADES = ['baja', 'media', 'alta', 'critica'];

const destinatarios = (roles) => `,${roles.join(',')},`;

// Emite una alerta. `roles`: códigos de rol destinatarios (el Administrador siempre puede verlas).
const crear = async ({ modulo, tipo, severidad, mensaje, roles, clave = null }) => {
  if (!SEVERIDADES.includes(severidad)) throw new Error(`Severidad inválida: ${severidad}`);
  if (clave) {
    const [[abierta]] = await pool.query("SELECT id FROM notificaciones WHERE clave = ? AND estado <> 'resuelta' LIMIT 1", [clave]);
    if (abierta) {
      await pool.query('UPDATE notificaciones SET ts_ms = ?, mensaje = ?, severidad = ? WHERE id = ?', [Date.now(), mensaje.slice(0, 500), severidad, abierta.id]);
      return abierta.id;
    }
  }
  const [r] = await pool.query(
    'INSERT INTO notificaciones (ts_ms, modulo, tipo, severidad, mensaje, roles_destinatarios, clave) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [Date.now(), modulo, tipo, severidad, mensaje.slice(0, 500), destinatarios(roles), clave]
  );
  return r.insertId;
};

// Resuelve la alerta abierta de esa clave (por ejemplo, el mensaje fallido se confirmó o se descartó).
const resolverPorClave = async (clave, resolucion) => {
  const [r] = await pool.query(
    "UPDATE notificaciones SET estado = 'resuelta', resuelta_ms = ?, resolucion = ? WHERE clave = ? AND estado <> 'resuelta'",
    [Date.now(), resolucion.slice(0, 200), clave]
  );
  return r.affectedRows;
};

// Las que le corresponden a una persona según sus roles (el Administrador ve las suyas y las de todos).
const listarPara = async ({ roles, esAdmin }, { estado, limite = 50 } = {}) => {
  const filtros = [];
  const params = [];
  if (!esAdmin) {
    filtros.push(`(${roles.map(() => 'roles_destinatarios LIKE ?').join(' OR ') || '0'})`);
    params.push(...roles.map((r) => `%,${r},%`));
  }
  if (estado) { filtros.push('estado = ?'); params.push(estado); }
  const [rows] = await pool.query(
    `SELECT * FROM notificaciones ${filtros.length ? 'WHERE ' + filtros.join(' AND ') : ''}
     ORDER BY FIELD(estado, 'nueva', 'leida', 'resuelta'), FIELD(severidad, 'critica', 'alta', 'media', 'baja'), ts_ms DESC LIMIT ?`,
    [...params, Math.min(Number(limite) || 50, 200)]
  );
  return rows.map((r) => ({ ...r, roles_destinatarios: r.roles_destinatarios.split(',').filter(Boolean) }));
};

const contarNuevas = async (destino) => (await listarPara(destino, { estado: 'nueva', limite: 200 })).length;

const marcar = async (id, estado) => {
  const [r] = await pool.query(
    'UPDATE notificaciones SET estado = ?, resuelta_ms = IF(? = \'resuelta\', ?, resuelta_ms) WHERE id = ? AND estado <> \'resuelta\'',
    [estado, estado, Date.now(), id]
  );
  return r.affectedRows;
};

module.exports = { SEVERIDADES, crear, resolverPorClave, listarPara, contarNuevas, marcar };
