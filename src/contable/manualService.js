const pool = require('../config/db');
const Asientos = require('./asientoService');
const { invalida, esFecha, iso, fechaLocal } = require('./comun');

// Asientos manuales, modelos reutilizables y asientos recurrentes (Contable RF05, RN04, RN13, RN33, EX01, EX03). Un asiento manual con fecha de un período cerrado se rechaza (EX03); los
// automáticos no se editan a mano (RN04). La clave X-ID-Solicitud la controla el middleware de idempotencia (mismo contenido devuelve el asiento original, otro contenido es conflicto).
const limpiarLineas = (lineas) => (Array.isArray(lineas) ? lineas : []).map((l) => ({ cuenta_id: Number(l.cuenta_id), debe: Number(l.debe ?? 0), haber: Number(l.haber ?? 0), detalle: l.detalle ? String(l.detalle).slice(0, 160) : null, importe_divisa: l.importe_divisa ?? null, cotizacion: l.cotizacion ?? null }));

const crear = async ({ fecha, leyenda, lineas }, usuarioId, idSolicitud = null, { tipo = 'manual' } = {}) => {
  if (!esFecha(fecha)) throw invalida('La fecha va como AAAA-MM-DD.');
  const texto = String(leyenda ?? '').trim();
  if (!texto) throw invalida('Falta la leyenda del asiento.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[cfg]] = await conn.query('SELECT fecha_inicio FROM con_config WHERE id = 1');
    if (!cfg.fecha_inicio) throw invalida('Todavía no se inició la contabilidad.', 409, { codigo: 'SIN_INICIO' });
    if (fecha < iso(cfg.fecha_inicio)) throw invalida('La fecha es anterior al inicio de la contabilidad.', 409, { codigo: 'ANTERIOR_AL_INICIO' });
    const a = await Asientos.crear(conn, { fecha, tipo, leyenda: texto.slice(0, 200), lineas: limpiarLineas(lineas), usuarioId, idSolicitud, exacto: true });
    await conn.commit();
    return Asientos.vista(a.id);
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

// ---- Modelos ----

const modeloVista = (m) => ({ id: m.id, nombre: m.nombre, leyenda: m.leyenda, lineas: JSON.parse(m.lineas), recurrente: !!m.recurrente, dia_mes: m.dia_mes, desde: iso(m.desde), hasta: iso(m.hasta), activo: !!m.activo });
const modelos = async () => (await pool.query('SELECT * FROM con_modelos ORDER BY nombre'))[0].map(modeloVista);
const obtenerModelo = async (id) => {
  const [[m]] = await pool.query('SELECT * FROM con_modelos WHERE id = ?', [id]);
  if (!m) throw invalida('Modelo no encontrado.', 404);
  return m;
};
const validarModelo = async (d) => {
  const nombre = String(d.nombre ?? '').trim();
  if (!nombre || nombre.length > 80) throw invalida('Falta el nombre del modelo (hasta 80 caracteres).');
  const leyenda = String(d.leyenda ?? '').trim();
  if (!leyenda) throw invalida('Falta la leyenda del modelo.');
  const lineas = limpiarLineas(d.lineas);
  await Asientos.validarLineas(pool, lineas); // un modelo también tiene que balancear
  const recurrente = !!d.recurrente;
  if (recurrente) {
    if (!Number.isInteger(d.dia_mes) || d.dia_mes < 1 || d.dia_mes > 28) throw invalida('El día del mes de un asiento recurrente va de 1 a 28.');
    if (!esFecha(d.desde)) throw invalida('Un asiento recurrente necesita la fecha desde la que se genera.');
    if (d.hasta && (!esFecha(d.hasta) || d.hasta < d.desde)) throw invalida('La fecha hasta es posterior a la de inicio.');
  }
  return { nombre, leyenda: leyenda.slice(0, 200), lineas: JSON.stringify(lineas), recurrente: recurrente ? 1 : 0, dia: recurrente ? d.dia_mes : null, desde: recurrente ? d.desde : null, hasta: recurrente ? d.hasta ?? null : null };
};
const crearModelo = async (d) => {
  const v = await validarModelo(d);
  try {
    const [r] = await pool.query('INSERT INTO con_modelos (nombre, leyenda, lineas, recurrente, dia_mes, desde, hasta) VALUES (?, ?, ?, ?, ?, ?, ?)', [v.nombre, v.leyenda, v.lineas, v.recurrente, v.dia, v.desde, v.hasta]);
    return modeloVista(await obtenerModelo(r.insertId));
  } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw invalida('Ya hay un modelo con ese nombre.', 409, { codigo: 'NOMBRE_DUPLICADO' }); throw err; }
};
const editarModelo = async (id, d) => {
  await obtenerModelo(id);
  const v = await validarModelo(d);
  await pool.query('UPDATE con_modelos SET nombre = ?, leyenda = ?, lineas = ?, recurrente = ?, dia_mes = ?, desde = ?, hasta = ?, activo = ? WHERE id = ?', [v.nombre, v.leyenda, v.lineas, v.recurrente, v.dia, v.desde, v.hasta, d.activo === false ? 0 : 1, id]);
  return modeloVista(await obtenerModelo(id));
};
const eliminarModelo = async (id) => { await obtenerModelo(id); await pool.query('DELETE FROM con_modelos WHERE id = ?', [id]); return { eliminado: true }; };

const generar = async (id, fecha, usuarioId, idSolicitud) => {
  const m = modeloVista(await obtenerModelo(id));
  return crear({ fecha, leyenda: m.leyenda, lineas: m.lineas }, usuarioId, idSolicitud, { tipo: 'modelo' });
};

// Genera las ocurrencias vencidas de los modelos recurrentes hasta `hasta` (hoy por defecto). La clave es el modelo y la fecha de la ocurrencia: no se genera dos veces (RN33).
const generarRecurrentes = async ({ hasta = fechaLocal() } = {}, usuarioId = null) => {
  const generados = [], omitidos = [];
  for (const m of (await modelos()).filter((x) => x.recurrente && x.activo)) {
    const [anio0, mes0] = [Number(m.desde.slice(0, 4)), Number(m.desde.slice(5, 7))];
    for (let a = anio0, mes = mes0; ; mes++) {
      if (mes > 12) { mes = 1; a++; }
      const f = `${a}-${String(mes).padStart(2, '0')}-${String(m.dia_mes).padStart(2, '0')}`;
      if (f > hasta || (m.hasta && f > m.hasta)) break;
      if (f < m.desde) continue;
      const clave = `mod${m.id}-${f}`;
      const [[ya]] = await pool.query('SELECT id FROM con_asientos WHERE id_solicitud = ?', [clave]);
      if (ya) continue;
      try { generados.push({ modelo: m.nombre, fecha: f, asiento: (await crear({ fecha: f, leyenda: `${m.leyenda} ${String(mes).padStart(2, '0')}/${a}`, lineas: m.lineas }, usuarioId, clave, { tipo: 'recurrente' })).numero }); } catch (err) {
        if (!err.status) throw err;
        omitidos.push({ modelo: m.nombre, fecha: f, motivo: err.message });
      }
    }
  }
  return { generados, omitidos };
};

module.exports = { crear, modelos, crearModelo, editarModelo, eliminarModelo, generar, generarRecurrentes };
