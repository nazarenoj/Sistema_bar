const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const Cuentas = require('./cuentaService');
const { idGlobal } = require('../utils/idGlobal');
const { invalida, r2, movimiento } = require('./comun');

// Turnos de caja (Financiero RF03, RN03, RN39). Una caja tiene un solo turno abierto a la vez; el efectivo teórico del turno es el saldo de la caja
// (los movimientos nunca se editan, así que el saldo derivado ya incluye el fondo contado al abrir).
const CON_TURNO = ['caja_efectivo', 'caja_reparto'];
const FUNCIONES_DEL_TURNO = ['FIN-CIERRE-CIEGO', 'FIN-CHEQUES', 'FIN-MONEDA-EXT']; // RN39

const llevaTurno = (cuenta) => CON_TURNO.includes(cuenta.tipo);

// ---- Turnos de servicio (mañana, tarde u otros) ----

const HORA = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const servicios = async () => (await pool.query('SELECT id, nombre, TIME_FORMAT(desde, "%H:%i") AS desde, TIME_FORMAT(hasta, "%H:%i") AS hasta, activo FROM fin_turnos_servicio ORDER BY desde'))[0]
  .map((s) => ({ ...s, activo: !!s.activo }));

const validarServicio = (d, actual = {}) => {
  const nombre = String(d.nombre ?? actual.nombre ?? '').trim();
  const desde = d.desde ?? actual.desde, hasta = d.hasta ?? actual.hasta;
  if (!nombre || nombre.length > 40) throw invalida('Indicá el nombre del turno de servicio (hasta 40 caracteres).');
  if (!HORA.test(String(desde)) || !HORA.test(String(hasta))) throw invalida('Las horas se indican como HH:MM.');
  if (String(desde) === String(hasta)) throw invalida('El turno no puede empezar y terminar a la misma hora.');
  return { nombre, desde, hasta };
};
const crearServicio = async (d) => {
  const v = validarServicio(d);
  try { const [r] = await pool.query('INSERT INTO fin_turnos_servicio (nombre, desde, hasta) VALUES (?, ?, ?)', [v.nombre, v.desde, v.hasta]); return (await servicios()).find((s) => s.id === r.insertId); } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida(`Ya existe el turno de servicio "${v.nombre}".`, 409);
    throw err;
  }
};
const actualizarServicio = async (id, d) => {
  const actual = (await servicios()).find((s) => s.id === id);
  if (!actual) throw invalida('Turno de servicio no encontrado.', 404);
  const v = validarServicio(d, actual);
  try { await pool.query('UPDATE fin_turnos_servicio SET nombre = ?, desde = ?, hasta = ?, activo = ? WHERE id = ?', [v.nombre, v.desde, v.hasta, d.activo === undefined ? actual.activo : d.activo ? 1 : 0, id]); } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida(`Ya existe el turno de servicio "${v.nombre}".`, 409);
    throw err;
  }
  return (await servicios()).find((s) => s.id === id);
};

// El turno de servicio de una hora: el que la contiene, con la vuelta de medianoche (de 22:00 a 06:00, por ejemplo).
const servicioDe = async (fecha = new Date(), db = pool) => {
  const hm = `${String(fecha.getHours()).padStart(2, '0')}:${String(fecha.getMinutes()).padStart(2, '0')}`;
  const [filas] = await db.query('SELECT id, TIME_FORMAT(desde, "%H:%i") AS desde, TIME_FORMAT(hasta, "%H:%i") AS hasta FROM fin_turnos_servicio WHERE activo = 1');
  return filas.find((s) => (s.desde < s.hasta ? hm >= s.desde && hm < s.hasta : hm >= s.desde || hm < s.hasta))?.id ?? null;
};

// ---- Turnos de caja ----

const vista = async (t, { verTeorico = false, ciego = false } = {}) => {
  const [[c]] = await pool.query('SELECT nombre, tipo, moneda, fondo_cambio, tope_efectivo, cierre_ciego FROM fin_cuentas WHERE id = ?', [t.cuenta_id]);
  const [[u]] = await pool.query('SELECT username FROM users WHERE id = ?', [t.user_id]);
  const [[s]] = t.turno_servicio_id ? await pool.query('SELECT nombre FROM fin_turnos_servicio WHERE id = ?', [t.turno_servicio_id]) : [[null]];
  const v = {
    id: t.id, id_global: t.id_global, cuenta_id: t.cuenta_id, caja: c.nombre, moneda: c.moneda, estado: t.estado, usuario: u?.username ?? null, terminal_id: t.terminal_id,
    turno_servicio: s?.nombre ?? null, fondo_apertura: Number(t.fondo_apertura), fondo_propuesto: Number(t.fondo_propuesto), abierto_ms: Number(t.abierto_ms),
    cerrado_ms: t.cerrado_ms === null ? null : Number(t.cerrado_ms), reaperturas: t.reaperturas, version_config: t.version_config,
    funciones: t.funciones ? t.funciones.split(',') : [],
  };
  // El saldo teórico solo lo ve quien tiene el permiso; en un cierre ciego tampoco se ve mientras se cuenta (RN06).
  if (verTeorico && !(ciego && t.estado === 'abierto')) {
    const teorico = await Cuentas.saldoDe(t.cuenta_id);
    v.saldo_teorico = teorico;
    // Aviso en pantalla cuando el efectivo supera el tope de la caja: nunca bloquea la venta (RF03).
    if (c.tope_efectivo !== null && teorico > Number(c.tope_efectivo)) v.aviso_tope = { tope: Number(c.tope_efectivo), exceso: r2(teorico - Number(c.tope_efectivo)), mensaje: 'Hacé un retiro a caja fuerte.' };
  }
  return v;
};

const fila = async (id, db = pool) => {
  const [[t]] = await db.query('SELECT * FROM fin_turnos WHERE id = ?', [id]);
  if (!t) throw invalida('Turno no encontrado.', 404);
  return t;
};

const abiertoDe = async (cuentaId, db = pool) => (await db.query("SELECT * FROM fin_turnos WHERE cuenta_id = ? AND estado = 'abierto'", [cuentaId]))[0][0] ?? null;

const obtener = async (id, opciones) => vista(await fila(id), opciones);

const listar = async ({ estado, cuentaId, terminalId, desde, hasta, limite = 100 } = {}, opciones = {}) => {
  const w = [], p = [];
  if (estado) { w.push('estado = ?'); p.push(estado); }
  if (cuentaId) { w.push('cuenta_id = ?'); p.push(Number(cuentaId)); }
  if (terminalId) { w.push('terminal_id = ?'); p.push(Number(terminalId)); }
  if (desde) { w.push('abierto_ms >= ?'); p.push(new Date(`${desde}T00:00:00`).getTime()); }
  if (hasta) { w.push('abierto_ms <= ?'); p.push(new Date(`${hasta}T23:59:59.999`).getTime()); }
  const [filas] = await pool.query(`SELECT * FROM fin_turnos ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, [...p, Math.min(Number(limite) || 100, 500)]);
  return Promise.all(filas.map((t) => vista(t, opciones)));
};

// El fondo que se propone al abrir: el que quedó al último cierre de la caja o, si no hubo, el parametrizado en la caja (RF03).
const fondoPropuesto = async (db, cuenta) => Number(cuenta.fondo_cambio);

// Abre un turno con el fondo de cambio contado (RF03). El fondo propuesto es el que quedó al último cierre o el de la caja.
const abrir = async ({ cuentaId, fondo, userId, terminalId = null }) => {
  const cuenta = await Cuentas.obtenerFila(Number(cuentaId));
  if (!llevaTurno(cuenta)) throw invalida('Solo las cajas de efectivo y de reparto llevan turno.');
  if (!cuenta.activa) throw invalida('La caja está desactivada.', 409);
  const contado = Number(fondo);
  if (fondo === undefined || fondo === null || fondo === '' || !Number.isFinite(contado) || contado < 0) throw invalida('Indicá el fondo de cambio contado (no puede ser negativo).');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const propuesto = await fondoPropuesto(conn, cuenta);
    const cfg = await Funciones.estado(conn);
    const activas = cfg.funciones.filter((f) => f.activa && FUNCIONES_DEL_TURNO.includes(f.id)).map((f) => f.id);
    let id;
    try {
      const [r] = await conn.query(
        `INSERT INTO fin_turnos (id_global, cuenta_id, user_id, terminal_id, turno_servicio_id, estado, cuenta_abierta, fondo_apertura, fondo_propuesto, abierto_ms, version_config, funciones)
         VALUES (?, ?, ?, ?, ?, 'abierto', ?, ?, ?, ?, ?, ?)`,
        [await idGlobal(), cuenta.id, userId, terminalId ?? cuenta.terminal_id, await servicioDe(new Date(), conn), cuenta.id, contado, propuesto, Date.now(), cfg.version, activas.join(',') || null]);
      id = r.insertId;
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') { // RN03, EX14: ya hay uno abierto; se informa de quién es
        await conn.rollback();
        const ab = await abiertoDe(cuenta.id);
        const [[u]] = await pool.query('SELECT username FROM users WHERE id = ?', [ab.user_id]);
        throw invalida(`La caja "${cuenta.nombre}" ya tiene un turno abierto (${u?.username ?? ab.user_id}, desde ${new Date(Number(ab.abierto_ms)).toISOString()}).`, 409, { codigo: 'TURNO_ABIERTO', detalle: { turno_id: ab.id, usuario: u?.username ?? null, terminal_id: ab.terminal_id, abierto_ms: Number(ab.abierto_ms) } });
      }
      throw err;
    }
    // Si lo contado no coincide con lo que la caja debería tener, la diferencia queda como un ajuste del turno (nada se edita, RN02).
    const saldo = await Cuentas.saldoDe(cuenta.id, conn);
    if (r2(contado - saldo) !== 0)
      await movimiento(conn, { cuentaId: cuenta.id, turnoId: id, tipo: 'ajuste', importe: contado - saldo, moneda: cuenta.moneda, motivo: `Diferencia del fondo de cambio al abrir (contado ${contado}, esperado ${saldo})`, userId });
    // Lo que quedó en espera por no haber turno abierto se incorpora a este turno (RN41, EX30).
    await conn.query('UPDATE fin_movimientos SET turno_id = ?, en_espera = 0 WHERE cuenta_id = ? AND en_espera = 1', [id, cuenta.id]);
    await conn.commit();
    return obtener(id, { verTeorico: true });
  } catch (err) {
    try { await conn.rollback(); } catch { /* ya se revirtió */ }
    throw err;
  } finally {
    conn.release();
  }
};

// Ingreso o retiro manual con motivo dentro de un turno (RF03). Una caja no queda en negativo (RN08, EX04).
const movimientoManual = async (turnoId, { tipo, importe, motivo, categoria_id: categoriaId }, userId) => {
  const t = await fila(turnoId);
  if (t.estado !== 'abierto') throw invalida('El turno está cerrado.', 409);
  if (!['ingreso', 'retiro'].includes(tipo)) throw invalida('El tipo debe ser "ingreso" o "retiro".');
  const monto = Number(importe);
  if (!(monto > 0)) throw invalida('El importe debe ser mayor a cero.');
  if (typeof motivo !== 'string' || motivo.trim().length < 3) throw invalida('El motivo es obligatorio.');
  if (categoriaId) await Cuentas.categoriaFila(Number(categoriaId));
  const cuenta = await Cuentas.obtenerFila(t.cuenta_id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM fin_cuentas WHERE id = ? FOR UPDATE', [cuenta.id]); // serializa los egresos de la caja
    const saldo = await Cuentas.saldoDe(cuenta.id, conn);
    if (tipo === 'retiro' && saldo - monto < 0) throw invalida(`El retiro dejaría la caja en negativo: el saldo disponible es ${saldo}.`, 409, { codigo: 'SALDO_INSUFICIENTE', detalle: { saldo } });
    const id = await movimiento(conn, { cuentaId: cuenta.id, turnoId, tipo, importe: tipo === 'retiro' ? -monto : monto, moneda: cuenta.moneda, categoriaId: categoriaId ?? null, motivo: motivo.trim(), userId });
    await conn.commit();
    return { id, saldo: await Cuentas.saldoDe(cuenta.id) };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

// ---- Lo que usan el receptor de cobros y Ventas ----

// A qué turno va un cobro (RN41, EX30). Un cobro de un turno que ya se cerró nunca lo modifica: va como ajuste al turno actual de la caja, o queda en espera
// de que se abra uno. Una caja sin turno abierto (la venta se cobró sin él, RN04) deja el cobro en espera hasta el próximo turno.
const paraCobro = async (conn, cuenta, { fechaMs = null } = {}) => {
  if (!llevaTurno(cuenta)) return { turnoId: null, enEspera: false, ajuste: false };
  const abierto = await abiertoDe(cuenta.id, conn);
  let ajuste = false;
  if (fechaMs !== null) {
    const [[cerrado]] = await conn.query("SELECT id FROM fin_turnos WHERE cuenta_id = ? AND estado = 'cerrado' AND abierto_ms <= ? AND cerrado_ms >= ? LIMIT 1", [cuenta.id, fechaMs, fechaMs]);
    ajuste = !!cerrado;
  }
  return { turnoId: abierto?.id ?? null, enEspera: !abierto, ajuste };
};
const paraContramovimiento = async (conn, cuenta) => {
  if (!llevaTurno(cuenta)) return { turnoId: null, enEspera: false };
  const abierto = await abiertoDe(cuenta.id, conn);
  return { turnoId: abierto?.id ?? null, enEspera: !abierto };
};

// La caja de efectivo de una terminal y su turno abierto (llamada n.º 5 de Ventas, RN04).
const turnoDeTerminal = async (terminalId) => {
  if (!terminalId) return { exigido: false, sinCaja: true };
  const cfg = await Cuentas.config();
  const [[caja]] = await pool.query("SELECT * FROM fin_cuentas WHERE terminal_id = ? AND tipo = 'caja_efectivo' AND activa = 1", [terminalId]);
  if (!caja) return { exigido: false, sinCaja: true }; // la terminal no tiene caja: no hay turno que exigir
  const ab = await abiertoDe(caja.id);
  return { exigido: cfg.exigir_turno_efectivo, abierto: !!ab, turno_id: ab?.id ?? null, caja_id: caja.id, caja: caja.nombre };
};

// Una caja con un turno abierto no se desactiva (primero se cierra).
Cuentas.alDesactivar(async (cuentaId) => (await abiertoDe(cuentaId)) ? { bloquea: 'La caja tiene un turno abierto: cerralo antes de desactivarla.' } : null);

module.exports = {
  CON_TURNO, servicios, crearServicio, actualizarServicio, servicioDe, vista, fila, abiertoDe, obtener, listar, abrir, movimientoManual, paraCobro, paraContramovimiento, turnoDeTerminal, llevaTurno,
};
