const crypto = require('crypto');
const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const Correo = require('../servicios/correoService');
const Reservas = require('../services/reservaService');
const Catalogo = require('./catalogoService');
const { TiendaInvalida } = require('./tiendaService');

// Reservas de mesa, turnos y pedidos especiales desde la tienda (Ventas Online RF20, RN29 a RN31, EX19, con ONL-RESERVAS sobre VEN-RESERVAS). Ofrece solo los cupos que publica Ventas y registra todo
// en la función Reservas de Ventas con origen «tienda». Sin señas ni cobros anticipados (RN31). La reserva nace «pendiente» y se confirma sola (por defecto) o a mano; el cliente la consulta y la cancela
// con el enlace del correo hasta N horas antes. Si la disponibilidad está desactualizada, las reservas de mesa se pausan para no sobrevender cupos (RN04, RN29).
const invalida = (m, status = 400, extra = {}) => Object.assign(new TiendaInvalida(m), { status, ...extra });
const exigir = async () => {
  if (!(await Funciones.estaActiva('ONL-RESERVAS'))) throw invalida('Las reservas desde la tienda no están habilitadas.', 409, { codigo: 'FUNCION_INACTIVA' });
  if (!(await Funciones.estaActiva('VEN-RESERVAS'))) throw invalida('Las reservas necesitan la función Reservas de Ventas.', 409, { codigo: 'FUNCION_INACTIVA' });
};
const traducir = (err) => { if (err instanceof Reservas.ReservaInvalida) throw invalida(err.message, err.status ?? 400, { codigo: err.codigo ?? 'RESERVA_INVALIDA', ...(err.sugerencias && { sugerencias: err.sugerencias }) }); throw err; };
const cfg = async () => (await pool.query('SELECT reservas_confirmacion, reservas_cancelar_horas FROM onl_tienda WHERE id = 1'))[0][0];
const ms = (f) => (f instanceof Date ? f.getTime() : new Date(String(f).replace(' ', 'T')).getTime());
const fmt = (f) => { const d = f instanceof Date ? f : new Date(String(f).replace(' ', 'T')); const p2 = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const enlaceDe = (r) => `/reservas/${r.token}`;

const registrar = async (tipo, refId, d, fechaMs, inscriptoId = null) => {
  const token = crypto.randomBytes(16).toString('hex');
  const [r] = await pool.query('INSERT INTO onl_reservas (token, tipo, ref_id, inscripto_id, nombre, email, estado, fecha_ms, creado_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [token, tipo, refId, inscriptoId, d.nombre, d.email, 'pendiente', fechaMs, Date.now()]);
  return { id: r.insertId, token };
};
const contacto = (d) => {
  const nombre = String(d.nombre ?? '').trim(), email = String(d.email ?? '').trim().toLowerCase();
  if (!nombre) throw invalida('Falta el nombre.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalida('El correo no es válido.');
  return { nombre, email, telefono: d.telefono ? String(d.telefono).slice(0, 40) : null };
};
const avisar = (r, asunto, cuerpo) => Correo.encolar({ para: r.email, asunto, cuerpo: `${cuerpo}\nVer o cancelar: ${enlaceDe(r)}\n` }).catch(() => {});

// Los cupos que publica Ventas: turnos de taller o cata con lugar libre.
const cupos = async () => {
  await exigir();
  const sync = await Catalogo.estadoSync();
  const turnos = (await Reservas.listarTurnos({ desde: new Date().toISOString() })).filter((t) => !t.cancelado && t.disponible > 0);
  return { mesas_pausadas: sync.desactualizada, turnos: turnos.map((t) => ({ id: t.id, nombre: t.nombre, tipo: t.tipo, fecha_hora: t.fecha_hora, disponibles: t.disponible })) };
};

const reservarMesa = async (d) => {
  await exigir();
  if ((await Catalogo.estadoSync()).desactualizada) throw invalida('Las reservas de mesa están pausadas: no pudimos confirmar la disponibilidad. Probá más tarde.', 409, { codigo: 'RESERVAS_PAUSADAS' });
  const c = contacto(d);
  const cf = await cfg();
  let res;
  try { res = await Reservas.crear({ fecha_hora: d.fecha_hora, personas: d.personas, salon_id: d.salon_id ?? null, cliente_nombre: c.nombre, cliente_telefono: c.telefono, cliente_email: c.email, observaciones: d.observaciones }); } catch (err) { traducir(err); } // EX19: sin cupo, se informa el motivo
  await pool.query("UPDATE reservas_mesa SET origen = 'tienda' WHERE id = ?", [res.id]);
  const o = await registrar('mesa', res.id, c, ms(res.fecha_hora));
  if (cf.reservas_confirmacion === 'auto') { await Reservas.confirmar(res.id); await pool.query("UPDATE onl_reservas SET estado = 'confirmada' WHERE id = ?", [o.id]); }
  await avisar({ ...c, ...o }, 'Tu reserva de mesa', `Hola ${c.nombre}, ${cf.reservas_confirmacion === 'auto' ? 'confirmamos' : 'recibimos'} tu reserva para ${d.personas} persona(s) el ${fmt(res.fecha_hora)}.`);
  return vista(o.id);
};

const reservarTurno = async (turnoId, d) => {
  await exigir();
  const c = contacto(d);
  let turno;
  try { turno = await Reservas.inscribir(turnoId, { nombre: c.nombre, telefono: c.telefono, personas: d.personas ?? 1 }); } catch (err) {
    if (err instanceof Reservas.ReservaInvalida && err.codigo === 'SIN_CUPO') { // EX19: se ofrecen los turnos más cercanos con lugar
      const otros = (await Reservas.listarTurnos({ desde: new Date().toISOString() })).filter((t) => !t.cancelado && t.disponible >= (d.personas ?? 1) && t.id !== turnoId).slice(0, 3);
      throw invalida(err.message, 409, { codigo: 'SIN_CUPO', alternativas: otros.map((t) => ({ id: t.id, nombre: t.nombre, fecha_hora: t.fecha_hora, disponibles: t.disponible })) });
    }
    traducir(err);
  }
  const ins = turno.inscriptos.filter((i) => i.nombre === c.nombre).pop();
  const o = await registrar('turno', turnoId, c, ms(turno.fecha_hora), ins?.id ?? null);
  await pool.query("UPDATE onl_reservas SET estado = 'confirmada' WHERE id = ?", [o.id]);
  await avisar({ ...c, ...o }, `Tu lugar en ${turno.nombre}`, `Hola ${c.nombre}, confirmamos tu lugar en "${turno.nombre}" el ${fmt(turno.fecha_hora)}.`);
  return vista(o.id);
};

// Pedido especial (torta por encargo): cada artículo define anticipación mínima y máxima y un cupo diario de encargos (RN30).
const encargar = async (d) => {
  await exigir();
  const c = contacto(d);
  if (!Array.isArray(d.items) || !d.items.length) throw invalida('Elegí al menos un artículo.');
  const fecha = new Date(String(d.fecha_entrega ?? '').replace(' ', 'T'));
  if (Number.isNaN(fecha.getTime())) throw invalida('La fecha de entrega va como AAAA-MM-DD HH:MM.');
  const horas = (fecha.getTime() - Date.now()) / 3600000;
  for (const i of d.items) {
    const [[p]] = await pool.query('SELECT * FROM onl_publicados WHERE producto_id = ?', [i.producto_id]);
    if (!p || !p.por_encargo) throw invalida(`El artículo ${i.producto_id} no se pide por encargo.`, 409, { codigo: 'NO_ES_POR_ENCARGO' });
    if (horas < p.anticipacion_min_h) throw invalida(`Este encargo necesita al menos ${p.anticipacion_min_h} horas de anticipación.`, 409, { codigo: 'ANTICIPACION_MINIMA' });
    if (p.anticipacion_max_dias !== null && horas > p.anticipacion_max_dias * 24) throw invalida(`Se pide hasta ${p.anticipacion_max_dias} días antes.`, 409, { codigo: 'ANTICIPACION_MAXIMA' });
    if (p.cupo_diario_encargos !== null) {
      const dia = fmt(fecha).slice(0, 10);
      const [[{ n }]] = await pool.query("SELECT COALESCE(SUM(pi.cantidad), 0) AS n FROM pedido_especial_items pi JOIN pedidos_especiales pe ON pe.id = pi.especial_id WHERE pi.producto_id = ? AND DATE(pe.fecha_entrega) = ? AND pe.estado <> 'cancelado'", [i.producto_id, dia]);
      if (Number(n) + Number(i.cantidad) > p.cupo_diario_encargos) throw invalida(`Ese día el obrador ya completó su cupo de este artículo.`, 409, { codigo: 'SIN_CUPO', cupo: p.cupo_diario_encargos });
    }
  }
  let esp;
  try { esp = await Reservas.crearEspecial({ cliente_nombre: c.nombre, cliente_telefono: c.telefono, fecha_entrega: d.fecha_entrega, observaciones: d.personalizacion ? String(d.personalizacion).slice(0, 500) : null, items: d.items.map((i) => ({ producto_id: i.producto_id, cantidad: i.cantidad, observaciones: i.personalizacion ?? null })) }); } catch (err) { traducir(err); }
  await pool.query("UPDATE pedidos_especiales SET origen = 'tienda' WHERE id = ?", [esp.id]);
  const o = await registrar('encargo', esp.id, c, fecha.getTime());
  await pool.query("UPDATE onl_reservas SET estado = 'confirmada' WHERE id = ?", [o.id]);
  await avisar({ ...c, ...o }, 'Tu encargo', `Hola ${c.nombre}, registramos tu encargo para el ${String(d.fecha_entrega)}. Podés modificarlo hasta ${(await pool.query('SELECT MAX(anticipacion_min_h) AS h FROM onl_publicados WHERE por_encargo = 1'))[0][0].h ?? 0} horas antes.`);
  return vista(o.id);
};
const configurarEncargo = async (productoId, d) => {
  const [[p]] = await pool.query('SELECT producto_id FROM onl_publicados WHERE producto_id = ?', [productoId]);
  if (!p) throw invalida('El artículo no está publicado.', 404);
  for (const [k, min] of [['anticipacion_min_h', 0], ['anticipacion_max_dias', 1], ['cupo_diario_encargos', 1]]) if (d[k] !== undefined && d[k] !== null && (!Number.isInteger(d[k]) || d[k] < min)) throw invalida(`${k} es un entero de ${min} o más.`);
  await pool.query('UPDATE onl_publicados SET por_encargo = ?, anticipacion_min_h = ?, anticipacion_max_dias = ?, cupo_diario_encargos = ? WHERE producto_id = ?', [d.por_encargo ? 1 : 0, d.anticipacion_min_h ?? 0, d.anticipacion_max_dias ?? null, d.cupo_diario_encargos ?? null, productoId]);
  return { producto_id: productoId, por_encargo: !!d.por_encargo };
};

// ---- Consultar y cancelar con el enlace del correo ----

const porToken = async (token) => {
  const [[o]] = await pool.query('SELECT * FROM onl_reservas WHERE token = ?', [String(token ?? '')]);
  if (!o) throw invalida('Reserva no encontrada.', 404);
  return o;
};
const vista = async (id) => {
  const [[o]] = await pool.query('SELECT * FROM onl_reservas WHERE id = ?', [id]);
  return { id: o.id, token: o.token, tipo: o.tipo, estado: o.estado, nombre: o.nombre, fecha_ms: Number(o.fecha_ms), enlace: enlaceDe(o) };
};
const consultar = async (token) => { const o = await porToken(token); return vista(o.id); };
const cancelar = async (token) => {
  const o = await porToken(token);
  if (o.estado === 'cancelada') throw invalida('La reserva ya está cancelada.', 409);
  const c = await cfg();
  if (Number(o.fecha_ms) - Date.now() < c.reservas_cancelar_horas * 3600000) throw invalida(`Se cancela hasta ${c.reservas_cancelar_horas} horas antes: comunicate con el comercio.`, 409, { codigo: 'FUERA_DE_PLAZO' });
  try {
    if (o.tipo === 'mesa') await Reservas.cancelar(o.ref_id, 'Cancelada por el cliente desde la tienda');
    else if (o.tipo === 'turno') await Reservas.bajaInscripcion(o.ref_id, o.inscripto_id);
    else await Reservas.cancelarEspecial(o.ref_id);
  } catch (err) { traducir(err); }
  await pool.query("UPDATE onl_reservas SET estado = 'cancelada' WHERE id = ?", [o.id]);
  await avisar(o, 'Cancelamos tu reserva', `Hola ${o.nombre}, tu reserva quedó cancelada.`);
  return vista(o.id);
};
// Con confirmación a mano, el comercio confirma desde el panel.
const confirmar = async (id) => {
  const [[o]] = await pool.query('SELECT * FROM onl_reservas WHERE id = ?', [id]);
  if (!o) throw invalida('Reserva no encontrada.', 404);
  if (o.tipo !== 'mesa') throw invalida('Solo las reservas de mesa se confirman a mano.', 409);
  if (o.estado !== 'pendiente') throw invalida(`La reserva está ${o.estado}.`, 409);
  try { await Reservas.confirmar(o.ref_id); } catch (err) { traducir(err); }
  await pool.query("UPDATE onl_reservas SET estado = 'confirmada' WHERE id = ?", [id]);
  await avisar(o, 'Confirmamos tu reserva', `Hola ${o.nombre}, tu reserva está confirmada.`);
  return vista(id);
};
const listar = async ({ estado } = {}) => {
  const ids = (await pool.query(`SELECT id FROM onl_reservas ${estado ? 'WHERE estado = ?' : ''} ORDER BY fecha_ms DESC LIMIT 200`, estado ? [estado] : []))[0];
  return Promise.all(ids.map((x) => vista(x.id)));
};
const configurar = async (d) => {
  const campos = {};
  if (d.reservas_confirmacion !== undefined) { if (!['auto', 'manual'].includes(d.reservas_confirmacion)) throw invalida('La confirmación es auto o manual.'); campos.reservas_confirmacion = d.reservas_confirmacion; }
  if (d.reservas_cancelar_horas !== undefined) { if (!Number.isInteger(d.reservas_cancelar_horas) || d.reservas_cancelar_horas < 0 || d.reservas_cancelar_horas > 168) throw invalida('Las horas para cancelar son un entero entre 0 y 168.'); campos.reservas_cancelar_horas = d.reservas_cancelar_horas; }
  const k = Object.keys(campos);
  if (k.length) await pool.query(`UPDATE onl_tienda SET ${k.map((x) => `${x} = ?`).join(', ')} WHERE id = 1`, k.map((x) => campos[x]));
  return cfg();
};

module.exports = { cupos, reservarMesa, reservarTurno, encargar, configurarEncargo, consultar, cancelar, confirmar, listar, configurar };
