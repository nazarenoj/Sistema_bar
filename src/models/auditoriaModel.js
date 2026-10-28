const crypto = require('crypto');
const pool = require('../config/db');
const { idGlobal } = require('../utils/idGlobal');

// Auditoría de solo agregar y encadenada (A6). Nada de este módulo modifica ni borra filas.
const CERO = '0'.repeat(64);
const SECRETO = () => process.env.CODIGO_PEPPER || process.env.JWT_SECRET;

// Claves que nunca se guardan, ni en el valor anterior ni en el nuevo (RN12).
const SENSIBLE = /pass|pin|tarjeta|hash|token|secret|clave/i;
const limpiar = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object') return String(v);
  return JSON.stringify(Object.fromEntries(Object.entries(v).filter(([k]) => !SENSIBLE.test(k))));
};

const CAMPOS = ['id_global', 'ts_ms', 'user_id', 'username', 'rol', 'terminal_id', 'ip', 'modulo', 'accion',
  'resultado', 'entidad', 'entidad_id', 'valor_anterior', 'valor_nuevo', 'detalle'];

const calcularHash = (previo, fila) =>
  crypto.createHmac('sha256', SECRETO())
    .update(previo + JSON.stringify(CAMPOS.map((c) => fila[c] ?? null)))
    .digest('hex');

// Agrega un evento al final de la cadena. `e`: { modulo, accion, resultado, entidad, entidad_id,
// valor_anterior, valor_nuevo, detalle, actor: { id, username, rol, terminal_id, ip } }.
const registrar = async (e) => {
  const a = e.actor || {};
  const fila = {
    id_global: await idGlobal(),
    ts_ms: Date.now(),
    user_id: a.id ?? null, username: a.username ?? null, rol: a.rol ?? null,
    terminal_id: a.terminal_id ?? null, ip: a.ip ?? null,
    modulo: e.modulo, accion: e.accion, resultado: e.resultado || 'ok',
    entidad: e.entidad ?? null, entidad_id: e.entidad_id != null ? String(e.entidad_id) : null,
    valor_anterior: limpiar(e.valor_anterior), valor_nuevo: limpiar(e.valor_nuevo),
    detalle: e.detalle ? String(e.detalle).slice(0, 500) : null,
  };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[{ ultimo_hash: previo }]] = await conn.query('SELECT ultimo_hash FROM auditoria_cadena WHERE id = 1 FOR UPDATE');
    fila.hash_previo = previo;
    fila.hash = calcularHash(previo, fila);
    await conn.query('INSERT INTO auditoria SET ?', [fila]);
    await conn.query('UPDATE auditoria_cadena SET ultimo_hash = ? WHERE id = 1', [fila.hash]);
    await conn.commit();
    return fila;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

// Consulta con filtros y paginación por cursor (`antes_de` = id): no usa OFFSET, así la primera
// página y las siguientes cuestan lo mismo con millones de eventos.
const listar = async (f = {}) => {
  const where = [];
  const params = [];
  const igual = (col, v) => { if (v !== undefined && v !== '') { where.push(`${col} = ?`); params.push(v); } };
  igual('user_id', f.user_id); igual('modulo', f.modulo); igual('accion', f.accion);
  igual('resultado', f.resultado); igual('entidad', f.entidad); igual('entidad_id', f.entidad_id);
  if (f.desde) { where.push('ts_ms >= ?'); params.push(Number(f.desde)); }
  if (f.hasta) { where.push('ts_ms <= ?'); params.push(Number(f.hasta)); }
  if (f.antes_de) { where.push('id < ?'); params.push(Number(f.antes_de)); }
  const limite = Math.min(Math.max(parseInt(f.limite, 10) || 50, 1), f.maximo || 200);
  const [rows] = await pool.query(
    `SELECT id, id_global, ts_ms, user_id, username, rol, terminal_id, ip, modulo, accion, resultado,
            entidad, entidad_id, valor_anterior, valor_nuevo, detalle
     FROM auditoria ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY id DESC LIMIT ?`,
    [...params, limite]
  );
  return rows;
};

// Control de integridad: recorre la cadena en orden y recalcula cada hash. Devuelve el primer
// evento que no cierra (alterado, o con eventos borrados antes).
const verificar = async () => {
  let previo = CERO;
  let ultimoId = 0;
  let total = 0;
  for (;;) {
    const [rows] = await pool.query('SELECT * FROM auditoria WHERE id > ? ORDER BY id LIMIT 5000', [ultimoId]);
    if (!rows.length) break;
    for (const r of rows) {
      if (r.hash_previo !== previo || r.hash !== calcularHash(previo, r))
        return { ok: false, total, primer_roto: r.id };
      previo = r.hash;
      ultimoId = r.id;
      total += 1;
    }
  }
  const [[{ ultimo_hash }]] = await pool.query('SELECT ultimo_hash FROM auditoria_cadena WHERE id = 1');
  if (ultimo_hash !== previo) return { ok: false, total, primer_roto: ultimoId + 1 }; // faltan eventos al final
  return { ok: true, total, primer_roto: null };
};

module.exports = { registrar, listar, verificar };
