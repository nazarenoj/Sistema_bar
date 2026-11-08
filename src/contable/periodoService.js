const pool = require('../config/db');
const Config = require('./configService');
const { invalida, iso, esFecha } = require('./comun');

// Ejercicios y períodos (Contable RF02, RN05, RN06, EX03). Un período cerrado no admite asientos; lo que llega con fecha de un período cerrado se contabiliza en el primer período abierto
// con una leyenda que indica su fecha original. Reabrir pide permiso y motivo, y queda registrado.
const ejercicioVista = (e) => ({ id: e.id, desde: iso(e.desde), hasta: iso(e.hasta), estado: e.estado });
const periodoVista = (p) => ({ id: p.id, ejercicio_id: p.ejercicio_id, anio: p.anio, mes: p.mes, estado: p.estado, cerrado_ms: p.cerrado_ms ? Number(p.cerrado_ms) : null });

const ejercicios = async () => (await pool.query('SELECT * FROM con_ejercicios ORDER BY desde'))[0].map(ejercicioVista);
const periodos = async ({ ejercicio_id: ej } = {}) => (await pool.query(`SELECT * FROM con_periodos ${ej ? 'WHERE ejercicio_id = ?' : ''} ORDER BY anio, mes`, ej ? [ej] : []))[0].map(periodoVista);

// Agrega un ejercicio contiguo al último; dura hasta 12 meses y termina el último día de un mes (RF02).
const crearEjercicio = async ({ hasta } = {}, db = pool) => {
  const [[ult]] = await db.query('SELECT * FROM con_ejercicios ORDER BY hasta DESC LIMIT 1');
  if (!ult) throw invalida('Todavía no se inició la contabilidad.', 409, { codigo: 'SIN_INICIO' });
  const desde = new Date(`${iso(ult.hasta)}T12:00:00`); desde.setDate(desde.getDate() + 1);
  const d = iso(desde);
  const fin = hasta ?? `${d.slice(0, 4)}-12-31`;
  if (!esFecha(fin) || fin < d) throw invalida('La fecha de fin del ejercicio es posterior a su inicio.');
  const ultimoDia = new Date(Number(fin.slice(0, 4)), Number(fin.slice(5, 7)), 0).getDate();
  if (Number(fin.slice(8, 10)) !== ultimoDia) throw invalida('El ejercicio termina el último día de un mes.');
  if (Config.MESES(d, fin).length > 12) throw invalida('Un ejercicio dura hasta 12 meses.');
  const conn = db === pool ? await pool.getConnection() : null;
  const c = conn ?? db;
  try {
    if (conn) await conn.beginTransaction();
    const id = await Config.crearEjercicio(c, d, fin);
    if (conn) await conn.commit();
    return ejercicioVista((await c.query('SELECT * FROM con_ejercicios WHERE id = ?', [id]))[0][0]);
  } catch (err) { if (conn) await conn.rollback(); throw err; } finally { conn?.release(); }
};

const cambiarPeriodo = async (id, estado, { usuarioId, motivo } = {}) => {
  const [[p]] = await pool.query('SELECT p.*, e.estado AS ej_estado FROM con_periodos p JOIN con_ejercicios e ON e.id = p.ejercicio_id WHERE p.id = ?', [id]);
  if (!p) throw invalida('Período no encontrado.', 404);
  if (p.ej_estado === 'cerrado') throw invalida('El ejercicio está cerrado: solo se consulta.', 409, { codigo: 'EJERCICIO_CERRADO' });
  if (p.estado === estado) throw invalida(`El período ya está ${estado}.`, 409, { codigo: 'SIN_CAMBIO' });
  await pool.query('UPDATE con_periodos SET estado = ?, cerrado_ms = ?, cerrado_por = ? WHERE id = ?', [estado, estado === 'cerrado' ? Date.now() : null, estado === 'cerrado' ? usuarioId ?? null : null, id]);
  await pool.query('INSERT INTO con_periodo_log (periodo_id, accion, motivo, usuario_id, ms) VALUES (?, ?, ?, ?, ?)', [id, estado === 'cerrado' ? 'cierre' : 'reapertura', motivo ?? null, usuarioId ?? null, Date.now()]);
  return periodoVista((await pool.query('SELECT * FROM con_periodos WHERE id = ?', [id]))[0][0]);
};
const cerrar = (id, usuarioId) => cambiarPeriodo(id, 'cerrado', { usuarioId });
const reabrir = (id, motivo, usuarioId) => {
  if (String(motivo ?? '').trim().length < 5) throw invalida('Reabrir un período requiere un motivo (al menos 5 caracteres).');
  return cambiarPeriodo(id, 'abierto', { usuarioId, motivo: String(motivo).trim().slice(0, 255) });
};
const historial = async (id) => (await pool.query('SELECT accion, motivo, usuario_id, ms FROM con_periodo_log WHERE periodo_id = ? ORDER BY id', [id]))[0];

// El período que recibe un asiento de esa fecha (RN05, EX03): el de su mes si está abierto y, si está cerrado, el primer período abierto con la leyenda de la fecha original. Si la fecha cae
// después del último ejercicio se agregan ejercicios calendario hasta cubrirla. `exacto` (asientos manuales) rechaza un período cerrado en vez de desplazarlo.
// shortcut: se crean ejercicios de año calendario sin avisar, cuando haya cierres de ejercicio reales (J8) conviene exigir que el anterior esté cerrado.
const periodoPara = async (db, fecha, { exacto = false } = {}) => {
  const f = iso(fecha);
  const [anio, mes] = [Number(f.slice(0, 4)), Number(f.slice(5, 7))];
  let [[p]] = await db.query('SELECT * FROM con_periodos WHERE anio = ? AND mes = ?', [anio, mes]);
  if (!p) {
    const [[ini]] = await db.query('SELECT MIN(desde) AS d FROM con_ejercicios');
    if (!ini?.d || f < iso(ini.d)) throw invalida('La fecha es anterior al inicio de la contabilidad.', 409, { codigo: 'ANTERIOR_AL_INICIO' });
    for (let guarda = 0; guarda < 10 && !p; guarda++) {
      await crearEjercicio({}, db);
      [[p]] = await db.query('SELECT * FROM con_periodos WHERE anio = ? AND mes = ?', [anio, mes]);
    }
    if (!p) throw invalida('No hay un ejercicio que cubra esa fecha.', 409, { codigo: 'SIN_EJERCICIO' });
  }
  if (p.estado === 'abierto') return { periodo: p, desplazado: false, fechaOriginal: f };
  if (exacto) throw invalida('El período de esa fecha está cerrado.', 409, { codigo: 'PERIODO_CERRADO' });
  const [[abierto]] = await db.query("SELECT p.* FROM con_periodos p JOIN con_ejercicios e ON e.id = p.ejercicio_id WHERE p.estado = 'abierto' AND e.estado = 'abierto' ORDER BY p.anio, p.mes LIMIT 1");
  if (!abierto) throw invalida('No hay períodos abiertos.', 409, { codigo: 'SIN_PERIODO_ABIERTO' });
  return { periodo: abierto, desplazado: true, fechaOriginal: f };
};

module.exports = { ejercicios, periodos, crearEjercicio, cerrar, reabrir, historial, periodoPara };
