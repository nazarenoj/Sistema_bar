const crypto = require('crypto');
const pool = require('../config/db');
const Periodos = require('./periodoService');
const { invalida, r2, cts, iso } = require('./comun');

// Núcleo del libro diario (Contable RN02, RN03, RN05, RN07): un asiento balancea (debe = haber), solo usa cuentas imputables, cae en un período abierto y se numera en forma correlativa por
// ejercicio. Los asientos no se editan ni se borran: se anulan con un contraasiento.
const fmt = (f) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;

// Agrupa líneas por cuenta y lado, sumando en centavos.
const consolidar = (lineas) => {
  const m = new Map();
  for (const l of lineas) {
    const k = `${l.cuenta_id}:${cts(l.debe) > 0 ? 'D' : 'H'}`;
    const e = m.get(k) ?? { cuenta_id: l.cuenta_id, debe: 0, haber: 0, detalle: l.detalle ?? null };
    e.debe += cts(l.debe); e.haber += cts(l.haber);
    m.set(k, e);
  }
  return [...m.values()].map((l) => ({ cuenta_id: l.cuenta_id, debe: l.debe / 100, haber: l.haber / 100, detalle: l.detalle }));
};

// EX01: un asiento desbalanceado no se guarda y se informa la diferencia.
const validarLineas = async (db, lineas, { soloActivas = false } = {}) => {
  if (!Array.isArray(lineas) || lineas.length < 2) throw invalida('Un asiento tiene al menos dos líneas.', 400, { codigo: 'SIN_LINEAS' });
  let debe = 0, haber = 0;
  const ids = [...new Set(lineas.map((l) => l.cuenta_id))];
  const [cuentas] = await db.query('SELECT id, codigo, imputable, estado FROM con_cuentas WHERE id IN (?)', [ids]);
  const porId = new Map(cuentas.map((c) => [c.id, c]));
  for (const l of lineas) {
    const c = porId.get(l.cuenta_id);
    if (!c) throw invalida('Una línea usa una cuenta que no existe.', 404, { codigo: 'CUENTA_INEXISTENTE' });
    if (!c.imputable) throw invalida(`La cuenta ${c.codigo} no es imputable.`, 409, { codigo: 'CUENTA_NO_IMPUTABLE' });
    if (soloActivas && c.estado !== 'activa') throw invalida(`La cuenta ${c.codigo} está inactiva.`, 409, { codigo: 'CUENTA_INACTIVA' });
    const d = cts(l.debe), h = cts(l.haber);
    if (d < 0 || h < 0 || (d > 0 && h > 0) || (d === 0 && h === 0)) throw invalida('Cada línea va al debe o al haber, con un importe positivo.', 400, { codigo: 'LINEA_INVALIDA' });
    debe += d; haber += h;
  }
  if (debe !== haber) throw invalida(`El asiento no balancea: debe ${debe / 100} y haber ${haber / 100} (diferencia ${r2((debe - haber) / 100)}).`, 400, { codigo: 'ASIENTO_DESBALANCEADO', diferencia: r2((debe - haber) / 100) });
  return { debe: debe / 100, haber: haber / 100 };
};

const siguienteNumero = async (conn, ejercicioId) => {
  await conn.query('UPDATE con_numeracion SET ultimo = LAST_INSERT_ID(ultimo + 1) WHERE ejercicio_id = ?', [ejercicioId]);
  return Number((await conn.query('SELECT LAST_INSERT_ID() AS n'))[0][0].n);
};

const hashDe = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

// Registra un asiento. `exacto` (asientos manuales) rechaza un período cerrado; los automáticos se desplazan al primer período abierto con la fecha original en la leyenda (RN05).
const crear = async (conn, { fecha, tipo, leyenda, lineas, usuarioId = null, anulaId = null, resumenClave = null, idSolicitud = null, instantanea = null, configVersion = null, exacto = false, ignorarCierre = false, origen = null }) => {
  const f = iso(fecha);
  await validarLineas(conn, lineas, { soloActivas: exacto });
  const { periodo, desplazado, fechaOriginal } = await Periodos.periodoPara(conn, f, { exacto, ignorarCierre });
  const fechaAsiento = desplazado ? `${periodo.anio}-${String(periodo.mes).padStart(2, '0')}-01` : f;
  const [r] = await conn.query('INSERT INTO con_asientos (numero, ejercicio_id, periodo_id, fecha, tipo, leyenda, usuario_id, anula_id, resumen_clave, id_solicitud, contenido_hash, config_version, instantanea, creado_ms) VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [periodo.ejercicio_id, periodo.id, fechaAsiento, tipo, `${leyenda}${desplazado ? ` (fecha original ${fmt(fechaOriginal)})` : ''}`.slice(0, 255), usuarioId, anulaId, resumenClave, idSolicitud, hashDe(lineas), configVersion, instantanea ? JSON.stringify(instantanea) : null, Date.now()]);
  const numero = await siguienteNumero(conn, periodo.ejercicio_id);
  await conn.query('UPDATE con_asientos SET numero = ? WHERE id = ?', [numero, r.insertId]);
  for (const l of lineas) await conn.query('INSERT INTO con_asiento_lineas (asiento_id, cuenta_id, debe, haber, importe_divisa, cotizacion, detalle) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [r.insertId, l.cuenta_id, r2(l.debe), r2(l.haber), l.importe_divisa ?? null, l.cotizacion ?? null, l.detalle ?? null]);
  if (origen) await agregarOrigen(conn, r.insertId, origen);
  return { id: r.insertId, numero, periodo_id: periodo.id, desplazado, fecha: fechaAsiento };
};

const agregarOrigen = (conn, asientoId, o) => conn.query('INSERT INTO con_asiento_origen (asiento_id, modulo, tipo_documento, id_documento, id_operacion, relacionado, importe, contenido, tipo_evento, fecha_documento, instantanea, contenido_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  [asientoId, o.modulo, o.tipo_documento, o.id_documento, o.id_operacion, o.relacionado ?? null, o.importe ?? null, o.contenido ? JSON.stringify(o.contenido) : null, o.tipo_evento ?? null, o.fecha_documento ?? null, o.instantanea ? JSON.stringify(o.instantanea) : null, o.contenido ? hashDe(o.contenido) : null]);

// Suma líneas a un asiento resumido existente (el balance se conserva porque cada documento llega balanceado).
const sumarLineas = async (conn, asientoId, lineas) => {
  for (const l of consolidar(lineas)) {
    const lado = cts(l.debe) > 0 ? 'debe' : 'haber';
    const [u] = await conn.query(`UPDATE con_asiento_lineas SET ${lado} = ${lado} + ? WHERE asiento_id = ? AND cuenta_id = ? AND ${lado} > 0`, [l[lado], asientoId, l.cuenta_id]);
    if (!u.affectedRows) await conn.query('INSERT INTO con_asiento_lineas (asiento_id, cuenta_id, debe, haber, detalle) VALUES (?, ?, ?, ?, ?)', [asientoId, l.cuenta_id, l.debe, l.haber, l.detalle]);
  }
};

const vista = async (id, db = pool) => {
  const [[a]] = await db.query('SELECT a.*, p.anio, p.mes FROM con_asientos a JOIN con_periodos p ON p.id = a.periodo_id WHERE a.id = ?', [id]);
  if (!a) throw invalida('Asiento no encontrado.', 404);
  const [lineas] = await db.query('SELECT l.id, l.cuenta_id, c.codigo, c.nombre, l.debe, l.haber, l.detalle FROM con_asiento_lineas l JOIN con_cuentas c ON c.id = l.cuenta_id WHERE l.asiento_id = ? ORDER BY l.id', [id]);
  const [origenes] = await db.query('SELECT modulo, tipo_documento, id_documento, id_operacion, importe FROM con_asiento_origen WHERE asiento_id = ? ORDER BY id', [id]);
  return { id: a.id, numero: a.numero, ejercicio_id: a.ejercicio_id, periodo: `${a.anio}-${String(a.mes).padStart(2, '0')}`, fecha: iso(a.fecha), tipo: a.tipo, leyenda: a.leyenda, estado: a.estado, anula_id: a.anula_id, resumido: !!a.resumen_clave,
    lineas: lineas.map((l) => ({ ...l, debe: Number(l.debe), haber: Number(l.haber) })), origenes: origenes.map((o) => ({ ...o, importe: o.importe === null ? null : Number(o.importe) })) };
};

const listar = async ({ desde, hasta, tipo, cuenta_id: cuenta, limite = 200, pagina = 1 } = {}) => {
  const w = [], p = [];
  if (desde) { w.push('a.fecha >= ?'); p.push(desde); }
  if (hasta) { w.push('a.fecha <= ?'); p.push(hasta); }
  if (tipo) { w.push('a.tipo = ?'); p.push(tipo); }
  if (cuenta) { w.push('EXISTS (SELECT 1 FROM con_asiento_lineas l WHERE l.asiento_id = a.id AND l.cuenta_id = ?)'); p.push(Number(cuenta)); }
  const lim = Math.min(Math.max(Number(limite) || 200, 1), 500), off = (Math.max(Number(pagina) || 1, 1) - 1) * lim;
  const [filas] = await pool.query(`SELECT a.id, a.numero, a.ejercicio_id, a.fecha, a.tipo, a.leyenda, a.estado, a.anula_id,
      (SELECT COALESCE(SUM(debe), 0) FROM con_asiento_lineas WHERE asiento_id = a.id) AS total FROM con_asientos a ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY a.fecha DESC, a.id DESC LIMIT ? OFFSET ?`, [...p, lim, off]);
  return filas.map((a) => ({ ...a, fecha: iso(a.fecha), total: Number(a.total) }));
};

// Un asiento se anula con un contraasiento que invierte sus líneas y conserva el número del original (RN07).
const anular = async (id, { usuarioId, motivo, idSolicitud, confirmarResumen = false }) => {
  if (String(motivo ?? '').trim().length < 5) throw invalida('Anular un asiento requiere un motivo.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[a]] = await conn.query('SELECT * FROM con_asientos WHERE id = ? FOR UPDATE', [id]);
    if (!a) throw invalida('Asiento no encontrado.', 404);
    if (a.estado === 'anulado') throw invalida('El asiento ya está anulado.', 409, { codigo: 'YA_ANULADO' });
    if (a.tipo === 'anulacion') throw invalida('Un contraasiento no se anula.', 409, { codigo: 'NO_ANULABLE' });
    if (a.resumen_clave) { // un asiento resumido junta muchos documentos: anularlo anula todos juntos
      const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM con_asiento_origen WHERE asiento_id = ?', [id]);
      if (Number(n) > 1 && !confirmarResumen) throw invalida(`Es un asiento resumido de ${n} documentos: anularlo anula todos. Confirmá para seguir o corregí con un asiento manual.`, 409, { codigo: 'RESUMEN_CONFIRMAR', documentos: Number(n) });
    }
    const [lineas] = await conn.query('SELECT cuenta_id, debe, haber, detalle FROM con_asiento_lineas WHERE asiento_id = ?', [id]);
    const c = await crear(conn, { fecha: new Date(), tipo: 'anulacion', leyenda: `Anulación del asiento ${a.numero}: ${String(motivo).trim()}`, usuarioId, anulaId: id, idSolicitud, exacto: false,
      lineas: lineas.map((l) => ({ cuenta_id: l.cuenta_id, debe: Number(l.haber), haber: Number(l.debe), detalle: l.detalle })) });
    await conn.query("UPDATE con_asientos SET estado = 'anulado' WHERE id = ?", [id]);
    await conn.commit();
    return { anulado: id, contraasiento: c.id, numero: c.numero };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

module.exports = { crear, consolidar, validarLineas, sumarLineas, agregarOrigen, vista, listar, anular, hashDe, fmt };
