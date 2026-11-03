const pool = require('../config/db');
const Mesa = require('../models/mesaModel');
const Pedido = require('../models/pedidoModel');
const Comandas = require('./comandaService');
const Funciones = require('../funciones/servicio');
const { idGlobal } = require('../utils/idGlobal');

// Reservas de mesa, lista de espera, turnos con cupo y pedidos especiales (Ventas RF43, RF44, RN40, EX30), con VEN-RESERVAS. Una mesa no
// tiene dos reservas que se superpongan en su duración estimada; la que no se presenta pasa a "No presentó" y libera la mesa; ante un
// choque el sistema ofrece otra mesa o la lista de espera y nunca mueve pedidos abiertos. Sin señas ni cobros anticipados.
class ReservaInvalida extends Error {}
const invalida = (m, status = 400, extra = {}) => Object.assign(new ReservaInvalida(m), { status, ...extra });

const param = async (clave, defecto) => Number((await pool.query('SELECT valor FROM parametros WHERE clave = ?', [clave]))[0][0]?.valor ?? defecto);
const fechaHora = (x, campo = 'fecha_hora') => {
  const s = String(x ?? '').trim().replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) throw invalida(`"${campo}" va como AAAA-MM-DD HH:MM.`);
  return s.length === 16 ? `${s}:00` : s;
};
const texto = (x, campo, max, obligatorio = false) => {
  if (x === undefined || x === null || x === '') { if (obligatorio) throw invalida(`"${campo}" es obligatorio.`); return null; }
  if (typeof x !== 'string' || x.length > max) throw invalida(`"${campo}" es un texto de hasta ${max} caracteres.`);
  return x.trim();
};

const enReserva = (r) => ({ ...r, en_espera: !!r.en_espera });
const obtener = async (id, conn = pool) => { const [[r]] = await conn.query('SELECT * FROM reservas_mesa WHERE id = ?', [id]); return r ? enReserva(r) : null; };

// ---------- Reservas ----------

// Mesas libres (sin reserva que se superponga) en esa franja, para ofrecer otra (EX30).
const mesasLibres = async (conn, desde, hasta, { salon_id = null, excluir = null } = {}) => (await conn.query(
  `SELECT m.id, m.numero_mesa, m.salon_id FROM mesas m WHERE m.activa = 1 AND m.es_virtual = 0 ${salon_id ? 'AND m.salon_id = ?' : ''}
   AND NOT EXISTS (SELECT 1 FROM reservas_mesa r WHERE r.mesa_id = m.id AND r.estado IN ('pendiente', 'confirmada') AND r.en_espera = 0 ${excluir ? 'AND r.id <> ?' : ''}
                   AND r.fecha_hora < ? AND r.fecha_fin > ?) ORDER BY m.numero_mesa`,
  [...(salon_id ? [salon_id] : []), ...(excluir ? [excluir] : []), hasta, desde]))[0];

const superpuesta = async (conn, mesaId, desde, hasta, excluir = null) => (await conn.query(
  `SELECT id, fecha_hora, fecha_fin, cliente_nombre FROM reservas_mesa WHERE mesa_id = ? AND estado IN ('pendiente', 'confirmada') AND en_espera = 0 ${excluir ? 'AND id <> ?' : ''} AND fecha_hora < ? AND fecha_fin > ? LIMIT 1`,
  [mesaId, ...(excluir ? [excluir] : []), hasta, desde]))[0][0] ?? null;

// Valida que la mesa exista, esté activa y no se superponga (RN40). Devuelve avisos (mesa ocupada a la hora de la reserva).
const validarMesa = async (conn, { mesa_id, desde, hasta, duracion, excluir = null }) => {
  if (!(await Funciones.estaActiva('VEN-SALON', conn))) throw invalida('Reservar una mesa necesita el Modo Salón (VEN-SALON).', 409);
  const mesa = await Mesa.getById(mesa_id, conn);
  if (!mesa || !mesa.activa || mesa.es_virtual) throw invalida('La mesa no existe.', 404);
  const choque = await superpuesta(conn, mesa_id, desde, hasta, excluir);
  if (choque) {
    const alternativas = await mesasLibres(conn, desde, hasta, { salon_id: mesa.salon_id, excluir });
    throw invalida(`La mesa ${mesa.numero_mesa} ya está reservada a nombre de ${choque.cliente_nombre} en ese horario.`, 409, { codigo: 'SUPERPUESTA', alternativas, lista_espera: true });
  }
  const avisos = [];
  // Mesa ocupada a la hora de la reserva: se advierte y no se mueve ningún pedido abierto (EX30).
  const [[{ cerca }]] = await conn.query('SELECT ? <= DATE_ADD(NOW(), INTERVAL ? MINUTE) AND ? >= DATE_SUB(NOW(), INTERVAL 3 HOUR) AS cerca', [desde, duracion, desde]);
  if (mesa.estado === 'ocupado' && cerca) avisos.push(`La mesa ${mesa.numero_mesa} está ocupada ahora: la reserva no mueve pedidos abiertos.`);
  return { mesa, avisos };
};

const crear = async (d, { userId } = {}) => {
  const nombre = texto(d.cliente_nombre, 'cliente_nombre', 120, true);
  const telefono = texto(d.cliente_telefono, 'cliente_telefono', 40);
  const email = texto(d.cliente_email, 'cliente_email', 150);
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw invalida('El correo no es válido.');
  if (!Number.isInteger(d.personas) || d.personas < 1) throw invalida('Las personas son un entero de 1 o más.');
  const duracion = d.duracion_min ?? await param('reserva_duracion_min', 90);
  if (!Number.isInteger(duracion) || duracion < 15) throw invalida('La duración es un entero de minutos, 15 o más.');
  const espera = !!d.en_espera;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let desde = d.fecha_hora ? fechaHora(d.fecha_hora) : null;
    if (!desde) { if (!espera) throw invalida('"fecha_hora" es obligatoria.'); desde = (await conn.query("SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS t"))[0][0].t; }
    const [[{ pasada }]] = await conn.query('SELECT ? < DATE_SUB(NOW(), INTERVAL 5 MINUTE) AS pasada', [desde]);
    if (pasada && !espera) throw invalida('La fecha de la reserva ya pasó.');
    const [[{ hasta }]] = await conn.query("SELECT DATE_FORMAT(DATE_ADD(?, INTERVAL ? MINUTE), '%Y-%m-%d %H:%i:%s') AS hasta", [desde, duracion]);
    let avisos = [];
    let mesaId = null;
    let salonId = d.salon_id ?? null;
    if (d.mesa_id && !espera) {
      if (!Number.isInteger(d.mesa_id)) throw invalida('"mesa_id" debe ser un entero.');
      const v = await validarMesa(conn, { mesa_id: d.mesa_id, desde, hasta, duracion });
      mesaId = v.mesa.id; salonId = v.mesa.salon_id; avisos = v.avisos;
    } else if (!espera && !d.mesa_id && !salonId) { /* una reserva sin mesa asignada queda pendiente de asignar */ }
    const [r] = await conn.query(
      `INSERT INTO reservas_mesa (id_global, fecha_hora, duracion_min, fecha_fin, personas, salon_id, mesa_id, cliente_nombre, cliente_telefono, cliente_email, en_espera, observaciones, creada_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [await idGlobal(), desde, duracion, hasta, d.personas, salonId, mesaId, nombre, telefono, email, espera ? 1 : 0, texto(d.observaciones, 'observaciones', 255), userId ?? null]);
    await conn.commit();
    return { ...(await obtener(r.insertId)), ...(avisos.length && { avisos }) };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

// Cambia fecha, duración, mesa o personas de una reserva abierta; vuelve a validar la superposición.
const actualizar = async (id, c) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[r]] = await conn.query('SELECT * FROM reservas_mesa WHERE id = ? FOR UPDATE', [id]);
    if (!r) throw invalida('Reserva no encontrada.', 404);
    if (!['pendiente', 'confirmada'].includes(r.estado)) throw invalida(`Una reserva ${r.estado.replace('_', ' ')} no se modifica.`, 409);
    const desde = c.fecha_hora ? fechaHora(c.fecha_hora) : (await conn.query("SELECT DATE_FORMAT(?, '%Y-%m-%d %H:%i:%s') AS t", [r.fecha_hora]))[0][0].t;
    const duracion = c.duracion_min ?? r.duracion_min;
    if (!Number.isInteger(duracion) || duracion < 15) throw invalida('La duración es un entero de minutos, 15 o más.');
    const personas = c.personas ?? r.personas;
    if (!Number.isInteger(personas) || personas < 1) throw invalida('Las personas son un entero de 1 o más.');
    const [[{ hasta }]] = await conn.query("SELECT DATE_FORMAT(DATE_ADD(?, INTERVAL ? MINUTE), '%Y-%m-%d %H:%i:%s') AS hasta", [desde, duracion]);
    const mesaId = c.mesa_id === undefined ? r.mesa_id : c.mesa_id;
    if (mesaId && !r.en_espera) await validarMesa(conn, { mesa_id: mesaId, desde, hasta, duracion, excluir: id });
    await conn.query('UPDATE reservas_mesa SET fecha_hora = ?, duracion_min = ?, fecha_fin = ?, personas = ?, mesa_id = ?, observaciones = ?, recordatorio_enviado_at = IF(? <> fecha_hora, NULL, recordatorio_enviado_at) WHERE id = ?',
      [desde, duracion, hasta, personas, mesaId, c.observaciones === undefined ? r.observaciones : texto(c.observaciones, 'observaciones', 255), desde, id]);
    await conn.commit();
    return obtener(id);
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const cambiarEstado = async (id, desde, hasta, extra = {}) => {
  const [r] = await pool.query(`UPDATE reservas_mesa SET estado = ?, motivo_cancelacion = COALESCE(?, motivo_cancelacion) WHERE id = ? AND estado IN (?) AND en_espera = 0`, [hasta, extra.motivo ?? null, id, desde]);
  if (!r.affectedRows) {
    const actual = await obtener(id);
    if (!actual) throw invalida('Reserva no encontrada.', 404);
    throw invalida(actual.en_espera ? 'La reserva está en lista de espera: asignale una mesa primero.' : `La reserva está ${actual.estado.replace('_', ' ')}: no se puede pasar a ${hasta.replace('_', ' ')}.`, 409);
  }
  return obtener(id);
};
const confirmar = (id) => cambiarEstado(id, ['pendiente'], 'confirmada');
const cumplir = (id) => cambiarEstado(id, ['pendiente', 'confirmada'], 'cumplida');
const noPresento = (id) => cambiarEstado(id, ['pendiente', 'confirmada'], 'no_presento');
const cancelar = (id, motivo) => {
  if (typeof motivo !== 'string' || !motivo.trim()) throw invalida('El motivo de la cancelación es obligatorio.');
  return cambiarEstado(id, ['pendiente', 'confirmada'], 'cancelada', { motivo: motivo.trim().slice(0, 255) });
};

// Lista de espera: alguien llega sin reserva o el choque lo manda ahí; al liberarse una mesa se le asigna (EX30).
const asignarMesa = async (id, { mesa_id, fecha_hora }) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[r]] = await conn.query('SELECT * FROM reservas_mesa WHERE id = ? FOR UPDATE', [id]);
    if (!r) throw invalida('Reserva no encontrada.', 404);
    if (!r.en_espera) throw invalida('La reserva no está en lista de espera.', 409);
    const desde = fecha_hora ? fechaHora(fecha_hora) : (await conn.query("SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS t"))[0][0].t;
    const [[{ hasta }]] = await conn.query("SELECT DATE_FORMAT(DATE_ADD(?, INTERVAL ? MINUTE), '%Y-%m-%d %H:%i:%s') AS hasta", [desde, r.duracion_min]);
    const v = await validarMesa(conn, { mesa_id, desde, hasta, duracion: r.duracion_min });
    await conn.query("UPDATE reservas_mesa SET en_espera = 0, mesa_id = ?, salon_id = ?, fecha_hora = ?, fecha_fin = ?, estado = 'pendiente' WHERE id = ?", [v.mesa.id, v.mesa.salon_id, desde, hasta, id]);
    await conn.commit();
    return { ...(await obtener(id)), ...(v.avisos.length && { avisos: v.avisos }) };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const listar = async ({ desde, hasta, estado, espera } = {}) => {
  const donde = [];
  const params = [];
  if (desde) { donde.push('r.fecha_hora >= ?'); params.push(`${String(desde).slice(0, 10)} 00:00:00`); }
  if (hasta) { donde.push('r.fecha_hora <= ?'); params.push(`${String(hasta).slice(0, 10)} 23:59:59`); }
  if (estado) { donde.push('r.estado = ?'); params.push(estado); }
  if (espera === '1') donde.push('r.en_espera = 1'); else if (espera === '0') donde.push('r.en_espera = 0');
  return (await pool.query(`SELECT r.*, m.numero_mesa FROM reservas_mesa r LEFT JOIN mesas m ON m.id = r.mesa_id ${donde.length ? `WHERE ${donde.join(' AND ')}` : ''} ORDER BY r.fecha_hora, r.id LIMIT 500`, params))[0].map(enReserva);
};

// La mesa reservada en el plano del salón: las mesas con una reserva abierta en la franja (por defecto, desde ahora hasta dentro de 3 horas).
const plano = async ({ salon_id, desde, hasta } = {}) => {
  const d = desde ? fechaHora(desde, 'desde') : (await pool.query("SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS t"))[0][0].t;
  const h = hasta ? fechaHora(hasta, 'hasta') : (await pool.query("SELECT DATE_FORMAT(DATE_ADD(NOW(), INTERVAL 3 HOUR), '%Y-%m-%d %H:%i:%s') AS t"))[0][0].t;
  return (await pool.query(
    `SELECT m.id AS mesa_id, m.numero_mesa, m.salon_id, r.id AS reserva_id, r.cliente_nombre, r.personas, r.fecha_hora, r.estado
     FROM mesas m JOIN reservas_mesa r ON r.mesa_id = m.id AND r.estado IN ('pendiente', 'confirmada') AND r.en_espera = 0 AND r.fecha_hora < ? AND r.fecha_fin > ?
     WHERE m.activa = 1 ${salon_id ? 'AND m.salon_id = ?' : ''} ORDER BY m.numero_mesa, r.fecha_hora`, [h, d, ...(salon_id ? [salon_id] : [])]))[0];
};

// Trabajo periódico: la reserva que supera la tolerancia pasa a "No presentó" y libera la mesa (RN40).
const vencer = async () => {
  const tolerancia = await param('reserva_tolerancia_min', 15);
  const [r] = await pool.query("UPDATE reservas_mesa SET estado = 'no_presento' WHERE estado IN ('pendiente', 'confirmada') AND en_espera = 0 AND DATE_ADD(fecha_hora, INTERVAL ? MINUTE) < NOW()", [tolerancia]);
  return r.affectedRows;
};

// Recordatorios por correo: requieren internet y el servicio de correo (USU-CORREO); sin él quedan listados para avisar a mano.
const Correo = require('../servicios/correoService');
let correo = (r) => Correo.enviarDirecto({ para: r.cliente_email, asunto: 'Recordatorio de tu reserva', cuerpo: `Hola ${r.cliente_nombre}, te recordamos tu reserva para el ${new Date(r.fecha_hora).toLocaleString('es-AR')}. Si no podés venir, avisanos para liberar la mesa.` });
const usarCorreo = (fn) => { correo = fn; };
const recordatoriosDebidos = async () => {
  const horas = await param('reserva_recordatorio_horas', 24);
  return (await pool.query(
    `SELECT id, cliente_nombre, cliente_email, fecha_hora FROM reservas_mesa WHERE estado IN ('pendiente', 'confirmada') AND en_espera = 0 AND cliente_email IS NOT NULL
     AND recordatorio_enviado_at IS NULL AND fecha_hora > NOW() AND DATE_SUB(fecha_hora, INTERVAL ? HOUR) <= NOW() ORDER BY fecha_hora`, [horas]))[0];
};
const enviarRecordatorios = async () => {
  if (!correo) return { enviados: 0, pendientes: (await recordatoriosDebidos()).length };
  let enviados = 0;
  for (const r of await recordatoriosDebidos()) {
    try { await correo(r); await pool.query('UPDATE reservas_mesa SET recordatorio_enviado_at = NOW() WHERE id = ?', [r.id]); enviados++; } catch { /* sin internet: queda para la próxima vuelta */ }
  }
  return { enviados, pendientes: (await recordatoriosDebidos()).length };
};

// ---------- Turnos con cupo (talleres y catas) ----------

const crearTurno = async (d) => {
  const nombre = texto(d.nombre, 'nombre', 120, true);
  if (!['taller', 'cata'].includes(d.tipo)) throw invalida('El tipo debe ser taller o cata.');
  if (!Number.isInteger(d.cupo) || d.cupo < 1) throw invalida('El cupo es un entero de 1 o más.');
  const [r] = await pool.query('INSERT INTO turnos_servicio (nombre, tipo, fecha_hora, cupo, responsable_id, detalle) VALUES (?, ?, ?, ?, ?, ?)',
    [nombre, d.tipo, fechaHora(d.fecha_hora), d.cupo, d.responsable_id ?? null, texto(d.detalle, 'detalle', 500)]);
  return obtenerTurno(r.insertId);
};
const obtenerTurno = async (id, conn = pool) => {
  const [[t]] = await conn.query('SELECT * FROM turnos_servicio WHERE id = ?', [id]);
  if (!t) return null;
  const [[{ ocupados }]] = await conn.query('SELECT COALESCE(SUM(personas), 0) AS ocupados FROM turno_inscriptos WHERE turno_id = ? AND activo = 1', [id]);
  const [inscriptos] = await conn.query('SELECT id, nombre, telefono, personas FROM turno_inscriptos WHERE turno_id = ? AND activo = 1 ORDER BY id', [id]);
  return { ...t, cancelado: !!t.cancelado, ocupados: Number(ocupados), disponible: t.cupo - Number(ocupados), inscriptos };
};
const listarTurnos = async ({ desde } = {}) => Promise.all((await pool.query('SELECT id FROM turnos_servicio WHERE fecha_hora >= ? ORDER BY fecha_hora', [desde ? `${String(desde).slice(0, 10)} 00:00:00` : '1970-01-01']))[0].map((r) => obtenerTurno(r.id)));
const inscribir = async (turnoId, d) => {
  const nombre = texto(d.nombre, 'nombre', 120, true);
  const personas = d.personas ?? 1;
  if (!Number.isInteger(personas) || personas < 1) throw invalida('Las personas son un entero de 1 o más.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[t]] = await conn.query('SELECT * FROM turnos_servicio WHERE id = ? FOR UPDATE', [turnoId]); // dos inscripciones a la vez no pasan del cupo
    if (!t) throw invalida('Turno no encontrado.', 404);
    if (t.cancelado) throw invalida('El turno está cancelado.', 409);
    const [[{ ocupados }]] = await conn.query('SELECT COALESCE(SUM(personas), 0) AS ocupados FROM turno_inscriptos WHERE turno_id = ? AND activo = 1', [turnoId]);
    if (Number(ocupados) + personas > t.cupo) throw invalida(`No hay cupo: quedan ${t.cupo - Number(ocupados)} lugar(es).`, 409, { codigo: 'SIN_CUPO', disponible: t.cupo - Number(ocupados) });
    await conn.query('INSERT INTO turno_inscriptos (turno_id, nombre, telefono, personas) VALUES (?, ?, ?, ?)', [turnoId, nombre, texto(d.telefono, 'telefono', 40), personas]);
    await conn.commit();
    return obtenerTurno(turnoId);
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};
const bajaInscripcion = async (turnoId, inscriptoId) => {
  const [r] = await pool.query('UPDATE turno_inscriptos SET activo = 0 WHERE id = ? AND turno_id = ? AND activo = 1', [inscriptoId, turnoId]);
  if (!r.affectedRows) throw invalida('Inscripción no encontrada.', 404);
  return obtenerTurno(turnoId);
};
const cancelarTurno = async (id) => {
  const [r] = await pool.query('UPDATE turnos_servicio SET cancelado = 1 WHERE id = ?', [id]);
  if (!r.affectedRows) throw invalida('Turno no encontrado.', 404);
  return obtenerTurno(id);
};

// ---------- Pedidos especiales ----------

const obtenerEspecial = async (id, conn = pool) => {
  const [[e]] = await conn.query('SELECT * FROM pedidos_especiales WHERE id = ?', [id]);
  if (!e) return null;
  const [items] = await conn.query('SELECT i.producto_id, p.nombre, i.cantidad, i.observaciones FROM pedido_especial_items i JOIN productos p ON p.id = i.producto_id WHERE i.especial_id = ? ORDER BY i.id', [id]);
  return { ...e, items };
};
const crearEspecial = async (d) => {
  const nombre = texto(d.cliente_nombre, 'cliente_nombre', 120, true);
  if (!Array.isArray(d.items) || !d.items.length) throw invalida('Indicá al menos un ítem.');
  for (const i of d.items) {
    if (!Number.isInteger(i.producto_id) || !Number.isInteger(i.cantidad) || i.cantidad < 1) throw invalida('Cada ítem necesita "producto_id" y una "cantidad" entera de 1 o más.');
    if (!(await pool.query('SELECT 1 FROM productos WHERE id = ?', [i.producto_id]))[0].length) throw invalida(`El artículo ${i.producto_id} no existe.`, 404);
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query('INSERT INTO pedidos_especiales (cliente_nombre, cliente_telefono, fecha_entrega, responsable_id, observaciones) VALUES (?, ?, ?, ?, ?)',
      [nombre, texto(d.cliente_telefono, 'cliente_telefono', 40), fechaHora(d.fecha_entrega, 'fecha_entrega'), d.responsable_id ?? null, texto(d.observaciones, 'observaciones', 500)]);
    for (const i of d.items) await conn.query('INSERT INTO pedido_especial_items (especial_id, producto_id, cantidad, observaciones) VALUES (?, ?, ?, ?)', [r.insertId, i.producto_id, i.cantidad, texto(i.observaciones, 'observaciones', 255)]);
    await conn.commit();
    return obtenerEspecial(r.insertId);
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};
const listarEspeciales = async ({ estado } = {}) => Promise.all((await pool.query(`SELECT id FROM pedidos_especiales ${estado ? 'WHERE estado = ?' : ''} ORDER BY fecha_entrega LIMIT 300`, estado ? [estado] : []))[0].map((r) => obtenerEspecial(r.id)));

// A su fecha de entrega genera la comanda al obrador (RF07): un pedido de retiro con los ítems, que se cobra al entregar. Es idempotente.
const generarComanda = async (id, { userId } = {}) => {
  const conn = await pool.getConnection();
  let mesaId;
  try {
    await conn.beginTransaction();
    const [[e]] = await conn.query('SELECT * FROM pedidos_especiales WHERE id = ? FOR UPDATE', [id]);
    if (!e) throw invalida('Pedido especial no encontrado.', 404);
    if (e.estado !== 'pendiente') {
      await conn.rollback();
      if (e.estado === 'cancelado') throw invalida('El pedido especial está cancelado.', 409);
      return obtenerEspecial(id);
    }
    const mesa = await Mesa.createVirtual();
    const pedido = await Pedido.create(mesa.id, { modalidad: 'retiro', origen: 'local', mozo_id: e.responsable_id ?? userId ?? null, referencia: `Encargo ${e.cliente_nombre}${e.cliente_telefono ? ` ${e.cliente_telefono}` : ''}`.slice(0, 255) });
    const [items] = await conn.query('SELECT i.producto_id, i.cantidad, i.observaciones, p.nombre, p.descripcion, p.precio FROM pedido_especial_items i JOIN productos p ON p.id = i.producto_id WHERE i.especial_id = ?', [id]);
    await Pedido.addProductos(pedido.id, items.map((i) => ({ producto_id: i.producto_id, cantidad: i.cantidad, nombre: i.nombre, descripcion: i.descripcion, precio_unitario: Number(i.precio), observaciones: i.observaciones })), conn);
    await conn.query("UPDATE pedidos_especiales SET estado = 'comanda_generada', pedido_id = ?, mesa_id = ? WHERE id = ?", [pedido.id, mesa.id, id]);
    await conn.commit();
    mesaId = mesa.id;
  } catch (err) { await conn.rollback().catch(() => {}); throw err; } finally { conn.release(); }
  await Comandas.enviar(mesaId, { userId }).catch(() => {}); // si un grupo obligatorio falta, la comanda queda para enviar a mano
  return obtenerEspecial(id);
};
const entregarEspecial = async (id) => {
  const [r] = await pool.query("UPDATE pedidos_especiales SET estado = 'entregado' WHERE id = ? AND estado = 'comanda_generada'", [id]);
  if (!r.affectedRows) throw invalida('El pedido especial todavía no generó su comanda, o ya se entregó o canceló.', 409);
  return obtenerEspecial(id);
};
const cancelarEspecial = async (id) => {
  const [r] = await pool.query("UPDATE pedidos_especiales SET estado = 'cancelado' WHERE id = ? AND estado = 'pendiente'", [id]);
  if (!r.affectedRows) throw invalida('Solo se cancela un pedido especial que todavía no generó su comanda.', 409);
  return obtenerEspecial(id);
};
// Trabajo periódico: genera la comanda de los especiales cuya entrega está dentro de la anticipación configurada.
const generarVencidos = async () => {
  const anticipo = await param('especial_comanda_anticipo_min', 120);
  const [ids] = await pool.query("SELECT id FROM pedidos_especiales WHERE estado = 'pendiente' AND DATE_SUB(fecha_entrega, INTERVAL ? MINUTE) <= NOW()", [anticipo]);
  let n = 0;
  for (const { id } of ids) { await generarComanda(id).then(() => n++).catch(() => {}); }
  return n;
};

module.exports = {
  ReservaInvalida, crear, actualizar, confirmar, cumplir, noPresento, cancelar, asignarMesa, obtener, listar, plano, vencer, usarCorreo, recordatoriosDebidos, enviarRecordatorios,
  crearTurno, obtenerTurno, listarTurnos, inscribir, bajaInscripcion, cancelarTurno,
  crearEspecial, obtenerEspecial, listarEspeciales, generarComanda, entregarEspecial, cancelarEspecial, generarVencidos,
};
