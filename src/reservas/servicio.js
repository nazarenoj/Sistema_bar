const pool = require('../config/db');
const Parametro = require('../models/parametroModel');
const { idGlobal } = require('../utils/idGlobal');

// Reservas con vencimiento (Usuarios RN82, RN83): reservar → confirmar (consumir) → vencer. Lo usan los
// módulos que toman un recurso compartido antes de confirmar su documento. No hay transacciones entre
// módulos: la reserva vence sola y el recurso queda libre sin intervención de nadie.

const TIPOS = ['compromiso_stock', 'reserva_online', 'credito', 'retencion_saldo', 'clave_comprobante'];

// Falla de negocio de una reserva: el llamador la muestra o la convierte en un rechazo (RechazoNegocio).
class ReservaError extends Error {
  constructor(codigo, mensaje, extra = {}) { super(mensaje); this.codigo = codigo; Object.assign(this, extra); }
}

const vigenciaDe = async (tipo) => ((await Parametro.todos())[`reserva_vigencia_${tipo}`] ?? 300) * 1000;

// Cantidad ya tomada de un recurso por reservas vigentes que todavía no vencieron.
const tomado = async (conn, recurso, excluir = null) => {
  const [[{ t }]] = await conn.query(
    "SELECT COALESCE(SUM(cantidad), 0) AS t FROM reservas WHERE recurso = ? AND estado = 'vigente' AND vence_ms > ? AND id_reserva <> ?",
    [recurso, Date.now(), excluir ?? '']
  );
  return Number(t);
};

const fila = (r) => ({ ...r, cantidad: Number(r.cantidad) });

// Pide una reserva.
//   tipo, modulo, idSolicitud (nueva en cada intento), recurso, cantidad, contenido
//   capacidad: async (conn) => cantidad total que el módulo tiene del recurso (lo calcula el dueño del recurso)
//   reemplazaA: ID de la reserva anterior del mismo origen. Se libera y se toma la nueva en una sola operación
//               atómica: nadie puede quedarse con lo reservado entre las dos (RN82.4).
// Con la misma idSolicitud devuelve la misma reserva (reintento idempotente). Si no hay disponible lanza
// ReservaError 'SIN_DISPONIBLE' con la cantidad que queda (EX56).
const reservar = async ({ tipo, modulo, idSolicitud, recurso, cantidad, contenido = null, capacidad, reemplazaA = null, userId = null }) => {
  if (!TIPOS.includes(tipo)) throw new Error(`Tipo de reserva inválido: ${tipo}`);
  if (!(cantidad > 0)) throw new ReservaError('CANTIDAD_INVALIDA', 'La cantidad a reservar debe ser mayor que cero.');
  const conn = await pool.getConnection();
  const candado = `reserva:${recurso}`.slice(0, 64);
  let tengoCandado = false;
  try {
    // El candado por recurso serializa a quienes compiten por lo mismo.
    const [[{ ok }]] = await conn.query('SELECT GET_LOCK(?, 5) AS ok', [candado]);
    if (!ok) throw new ReservaError('OCUPADO', 'El recurso está siendo reservado por otra operación. Reintentá.');
    tengoCandado = true;
    await conn.beginTransaction();

    const [[previa]] = await conn.query('SELECT * FROM reservas WHERE id_solicitud = ?', [idSolicitud]);
    if (previa) { await conn.commit(); return fila(previa); } // mismo intento: mismo resultado

    if (reemplazaA) {
      const [[ant]] = await conn.query('SELECT * FROM reservas WHERE id_reserva = ? FOR UPDATE', [reemplazaA]);
      if (!ant || ant.modulo_receptor !== modulo) throw new ReservaError('REEMPLAZO_INVALIDO', 'La reserva a reemplazar no existe.');
      if (ant.estado === 'consumida') throw new ReservaError('REEMPLAZO_INVALIDO', 'La reserva a reemplazar ya se consumió.');
      if (ant.estado === 'vigente') await conn.query("UPDATE reservas SET estado = 'liberada', cerrada_ms = ? WHERE id_reserva = ?", [Date.now(), reemplazaA]);
    }

    const total = Number(await capacidad(conn));
    const libre = total - (await tomado(conn, recurso));
    if (cantidad > libre) throw new ReservaError('SIN_DISPONIBLE', `No hay disponible: quedan ${Math.max(libre, 0)}.`, { disponible: Math.max(libre, 0) });

    const p = await Parametro.todos();
    const id = await idGlobal();
    const ahora = Date.now();
    await conn.query(
      `INSERT INTO reservas (id_reserva, tipo, modulo_receptor, id_solicitud, reemplaza_a, recurso, cantidad, contenido,
                             vence_ms, renovaciones_max, user_id, creada_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, tipo, modulo, idSolicitud, reemplazaA, recurso, cantidad, contenido == null ? null : JSON.stringify(contenido),
        ahora + (await vigenciaDe(tipo)), p.reserva_renovaciones_max ?? 3, userId, ahora]
    );
    await conn.commit();
    const [[nueva]] = await pool.query('SELECT * FROM reservas WHERE id_reserva = ?', [id]);
    return fila(nueva);
  } catch (err) {
    await conn.rollback(); // si había un reemplazo, la anterior queda como estaba
    throw err;
  } finally {
    if (tengoCandado) await conn.query('SELECT RELEASE_LOCK(?)', [candado]).catch(() => {});
    conn.release();
  }
};

// Mientras la operación de origen sigue en curso, la reserva se renueva (mismo identificador, nuevo
// vencimiento) hasta `renovaciones_max` veces. Una vencida no se renueva: se pide una nueva (RN82.5).
const renovar = async (idReserva) => {
  const [[r]] = await pool.query('SELECT * FROM reservas WHERE id_reserva = ?', [idReserva]);
  if (!r) throw new ReservaError('NO_EXISTE', 'La reserva no existe.');
  if (r.estado !== 'vigente' || Number(r.vence_ms) <= Date.now()) throw new ReservaError('RESERVA_VENCIDA', 'La reserva venció: pedí una nueva.');
  if (r.renovaciones >= r.renovaciones_max) throw new ReservaError('SIN_RENOVACIONES', `La reserva ya se renovó ${r.renovaciones_max} veces.`);
  await pool.query('UPDATE reservas SET vence_ms = ?, renovaciones = renovaciones + 1 WHERE id_reserva = ?', [Date.now() + (await vigenciaDe(r.tipo)), idReserva]);
  return fila((await pool.query('SELECT * FROM reservas WHERE id_reserva = ?', [idReserva]))[0][0]);
};

// Confirmar: al confirmarse el documento, el receptor consume la reserva que el mensaje cita. Una
// confirmación con la reserva vencida se rechaza con el motivo "reserva vencida" y no consume nada,
// salvo que el receptor pueda volver a tomar el recurso (`retomar`) y lo informe (RN83, EX56).
// `conn` es la conexión de la transacción que aplica el efecto. Es idempotente: consumir dos veces la
// misma reserva no descuenta dos veces.
const consumir = async (conn, idReserva, { retomar = null } = {}) => {
  const [[r]] = await conn.query('SELECT * FROM reservas WHERE id_reserva = ? FOR UPDATE', [idReserva]);
  if (!r) throw new ReservaError('NO_EXISTE', 'La reserva no existe.');
  if (r.estado === 'consumida') return { consumida: true, yaConsumida: true, reserva: fila(r) };
  const vigente = r.estado === 'vigente' && Number(r.vence_ms) > Date.now();
  if (vigente) {
    await conn.query("UPDATE reservas SET estado = 'consumida', cerrada_ms = ? WHERE id_reserva = ?", [Date.now(), idReserva]);
    return { consumida: true, reserva: fila(r) };
  }
  if (r.estado === 'liberada') throw new ReservaError('RESERVA_LIBERADA', 'reserva liberada');
  if (retomar && (await retomar(conn, fila(r)))) {
    await conn.query("UPDATE reservas SET estado = 'consumida', cerrada_ms = ? WHERE id_reserva = ?", [Date.now(), idReserva]);
    return { consumida: true, retomada: true, reserva: fila(r) };
  }
  throw new ReservaError('RESERVA_VENCIDA', 'reserva vencida');
};

const liberar = async (idReserva) => {
  const [r] = await pool.query("UPDATE reservas SET estado = 'liberada', cerrada_ms = ? WHERE id_reserva = ? AND estado = 'vigente'", [Date.now(), idReserva]);
  return r.affectedRows === 1;
};

// Marca como vencidas las que pasaron su vigencia (la corre el trabajador). El recurso ya estaba libre
// desde el vencimiento: `tomado` no cuenta las vencidas aunque falte este barrido.
const vencer = async () => {
  const [r] = await pool.query("UPDATE reservas SET estado = 'vencida', cerrada_ms = ? WHERE estado = 'vigente' AND vence_ms <= ?", [Date.now(), Date.now()]);
  return r.affectedRows;
};

const obtener = async (idReserva) => {
  const [[r]] = await pool.query('SELECT * FROM reservas WHERE id_reserva = ?', [idReserva]);
  return r ? fila(r) : null;
};

module.exports = { TIPOS, ReservaError, reservar, renovar, consumir, liberar, vencer, obtener };
