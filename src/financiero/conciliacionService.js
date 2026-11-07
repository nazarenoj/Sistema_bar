const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const Cuentas = require('./cuentaService');
const { invalida, r2, cts, movimiento } = require('./comun');

// Conciliación bancaria (Financiero RF09, RN12, FIN-CONCILIACION): se importa el extracto (CSV, Excel u OFX, con el formato configurable por banco) o se carga a mano; se concilia
// en forma automática (importe, fecha ± N días y referencia) o manual (una línea contra uno o varios movimientos); lo que el sistema no tenía se registra desde el extracto; y se cierra
// el período con su saldo conciliado. Un movimiento solo se concilia una vez y un período cerrado no admite cambios.
const exigirFuncion = async () => {
  if (!(await Funciones.estaActiva('FIN-CONCILIACION'))) throw invalida('La conciliación bancaria necesita la función FIN-CONCILIACION.', 409, { codigo: 'FUNCION_INACTIVA' });
};
const TIPOS_REGISTRO = ['comision', 'impuesto_debitos_creditos', 'interes', 'transferencia_sin_identificar'];
const iso = (f) => (f instanceof Date ? f.toISOString().slice(0, 10) : f);

// ---- Lectura del extracto ----

const numero = (v) => {
  let s = String(v ?? '').trim().replace(/[$\s]/g, '');
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.endsWith('-');
  s = s.replace(/[()]/g, '').replace(/-$/, '');
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -Math.abs(n) : n) : NaN;
};
const fechaDe = (v, formato = 'auto') => {
  const s = String(v ?? '').trim();
  let m;
  if ((formato === 'auto' || formato === 'yyyy-mm-dd') && (m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((formato === 'auto' || formato === 'dd/mm/yyyy') && (m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if ((formato === 'auto' || formato === 'yyyymmdd') && (m = s.match(/^(\d{4})(\d{2})(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
};
const valida = (f) => f && !Number.isNaN(new Date(`${f}T00:00:00Z`).getTime()) && new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10) === f;

const filasCSV = (texto, separador) => {
  const sep = separador ?? ((texto.split('\n')[0] ?? '').split(';').length > (texto.split('\n')[0] ?? '').split(',').length ? ';' : ',');
  const out = [];
  for (const linea of String(texto).replace(/\r/g, '').split('\n')) {
    if (!linea.trim()) continue;
    const celdas = []; let cur = '', q = false;
    for (const ch of linea) {
      if (ch === '"') q = !q; else if (ch === sep && !q) { celdas.push(cur); cur = ''; } else cur += ch;
    }
    celdas.push(cur);
    out.push(celdas.map((c) => c.trim()));
  }
  return out;
};

// Convierte las filas (con encabezado) en líneas según el formato del banco: nombres de columna para fecha, importe (con signo) o débito y crédito, referencia y descripción.
const mapear = (filas, formato = {}) => {
  if (filas.length < 2) throw invalida('El extracto está vacío o no tiene encabezado.', 400, { codigo: 'EXTRACTO_INVALIDO' });
  const cab = filas[0].map((c) => c.toLowerCase());
  const col = (nombre) => (nombre ? cab.indexOf(String(nombre).toLowerCase()) : -1);
  const iF = col(formato.fecha ?? 'fecha'), iI = col(formato.importe ?? 'importe'), iD = col(formato.debito ?? 'debito'), iC = col(formato.credito ?? 'credito'), iR = col(formato.referencia ?? 'referencia'), iX = col(formato.descripcion ?? 'descripcion');
  if (iF < 0) throw invalida(`No encuentro la columna de fecha ("${formato.fecha ?? 'fecha'}") en el encabezado.`, 400, { codigo: 'EXTRACTO_INVALIDO' });
  if (iI < 0 && iD < 0 && iC < 0) throw invalida('El formato necesita la columna de importe, o las de débito y crédito.', 400, { codigo: 'EXTRACTO_INVALIDO' });
  return filas.slice(1).map((c, i) => {
    const fila = i + 2;
    const fecha = fechaDe(c[iF], formato.fecha_formato);
    if (!valida(fecha)) throw invalida(`Fila ${fila}: la fecha "${c[iF]}" no es válida.`, 400, { codigo: 'EXTRACTO_INVALIDO', detalle: { fila } });
    let importe;
    if (iI >= 0) importe = numero(c[iI]);
    else { const d = numero(c[iD]) || 0, cr = numero(c[iC]) || 0; importe = Number.isNaN(d) || Number.isNaN(cr) ? NaN : cr - Math.abs(d); }
    if (importe === null || Number.isNaN(importe)) throw invalida(`Fila ${fila}: el importe "${c[iI >= 0 ? iI : iC]}" no es válido.`, 400, { codigo: 'EXTRACTO_INVALIDO', detalle: { fila } });
    return { fecha, importe: r2(importe), referencia: iR >= 0 && c[iR] ? c[iR].slice(0, 100) : null, descripcion: iX >= 0 && c[iX] ? c[iX].slice(0, 255) : null };
  });
};

const lineasOFX = (texto) => {
  const bloques = [...String(texto).matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|$)/gi)];
  if (!bloques.length) throw invalida('El archivo OFX no tiene movimientos (STMTTRN).', 400, { codigo: 'EXTRACTO_INVALIDO' });
  const tag = (b, t) => (b.match(new RegExp(`<${t}>([^<\\r\\n]*)`, 'i')) ?? [])[1]?.trim();
  return bloques.map((m, i) => {
    const b = m[1], fecha = fechaDe(tag(b, 'DTPOSTED'), 'yyyymmdd'), importe = numero(tag(b, 'TRNAMT'));
    if (!valida(fecha) || importe === null || Number.isNaN(importe)) throw invalida(`Movimiento ${i + 1} del OFX: fecha o importe inválidos.`, 400, { codigo: 'EXTRACTO_INVALIDO', detalle: { fila: i + 1 } });
    return { fecha, importe: r2(importe), referencia: (tag(b, 'FITID') ?? tag(b, 'CHECKNUM') ?? null)?.slice(0, 100) ?? null, descripcion: (tag(b, 'MEMO') ?? tag(b, 'NAME') ?? null)?.slice(0, 255) ?? null };
  });
};

const lineasXLSX = async (base64, formato) => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(Buffer.from(String(base64), 'base64')); } catch { throw invalida('El archivo Excel no se puede leer.', 400, { codigo: 'EXTRACTO_INVALIDO' }); }
  const ws = wb.worksheets[0];
  if (!ws) throw invalida('El Excel no tiene hojas.', 400, { codigo: 'EXTRACTO_INVALIDO' });
  const filas = [];
  ws.eachRow((row) => filas.push(row.values.slice(1).map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v?.result ?? v ?? '')).map((v) => String(v))));
  return mapear(filas, formato);
};

// ---- Importación ----

const ultimoCierre = async (cuentaId, db = pool) => (await db.query('SELECT * FROM fin_conciliaciones WHERE cuenta_id = ? ORDER BY hasta DESC LIMIT 1', [cuentaId]))[0][0] ?? null;

const cuentaBancaria = async (id) => {
  const c = await Cuentas.obtenerFila(Number(id));
  if (!['banco', 'billetera', 'procesador'].includes(c.tipo)) throw invalida('El extracto es de una cuenta bancaria, billetera o procesador.');
  return c;
};

// Inserta las líneas; las que ya estaban (misma fecha, importe y referencia) se marcan y no se vuelven a importar (EX06). Una fila inválida rechaza el archivo completo (EX05).
const insertar = async (cuenta, lineas, origen) => {
  const cierre = await ultimoCierre(cuenta.id);
  if (cierre) {
    const dentro = lineas.filter((l) => l.fecha <= iso(cierre.hasta));
    if (dentro.length) throw invalida(`Hay ${dentro.length} línea(s) de un período ya cerrado (hasta el ${iso(cierre.hasta)}): un período cerrado no admite cambios.`, 409, { codigo: 'PERIODO_CERRADO' });
  }
  const vistos = new Map();
  let importadas = 0;
  const duplicadas = [];
  for (const l of lineas) {
    const base = `${l.fecha}|${l.importe.toFixed(2)}|${l.referencia ?? ''}`;
    const n = vistos.get(base) ?? 0;
    vistos.set(base, n + 1);
    const [r] = await pool.query('INSERT IGNORE INTO fin_extracto_lineas (cuenta_id, clave, fecha, importe, referencia, descripcion, origen, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [cuenta.id, `${base}|${n}`, l.fecha, l.importe, l.referencia, l.descripcion, origen, Date.now()]);
    if (r.affectedRows) importadas++; else duplicadas.push({ fecha: l.fecha, importe: l.importe, referencia: l.referencia });
  }
  return { importadas, duplicadas: duplicadas.length, lineas_duplicadas: duplicadas };
};

const importar = async (cuentaId, { tipo = 'csv', contenido, formato = {} }) => {
  await exigirFuncion();
  const cuenta = await cuentaBancaria(cuentaId);
  let lineas;
  if (tipo === 'csv') lineas = mapear(filasCSV(String(contenido ?? ''), formato.separador), formato);
  else if (tipo === 'ofx') lineas = lineasOFX(contenido);
  else if (tipo === 'xlsx') lineas = await lineasXLSX(contenido, formato);
  else throw invalida('El tipo del extracto es csv, ofx o xlsx.');
  if (!lineas.length) throw invalida('El extracto no tiene movimientos.', 400, { codigo: 'EXTRACTO_INVALIDO' });
  return insertar(cuenta, lineas, 'importacion');
};
const cargarManual = async (cuentaId, d) => {
  await exigirFuncion();
  const cuenta = await cuentaBancaria(cuentaId);
  const linea = { fecha: d.fecha, importe: r2(Number(d.importe)), referencia: d.referencia ? String(d.referencia).slice(0, 100) : null, descripcion: d.descripcion ? String(d.descripcion).slice(0, 255) : null };
  if (!valida(linea.fecha) || !Number.isFinite(linea.importe) || linea.importe === 0) throw invalida('Indicá la fecha (AAAA-MM-DD) y un importe distinto de cero.');
  return insertar(cuenta, [linea], 'manual');
};

// ---- Conciliación ----

const vistaLinea = (l) => ({ id: l.id, cuenta_id: l.cuenta_id, fecha: iso(l.fecha), importe: Number(l.importe), referencia: l.referencia, descripcion: l.descripcion, estado: l.estado, conciliacion_id: l.conciliacion_id, origen: l.origen });
const lineaFila = async (id, db = pool) => {
  const [[l]] = await db.query('SELECT * FROM fin_extracto_lineas WHERE id = ?', [id]);
  if (!l) throw invalida('Línea del extracto no encontrada.', 404);
  return l;
};
const exigirAbierta = (l) => { if (l.conciliacion_id) throw invalida('La línea pertenece a un período cerrado: no admite cambios.', 409, { codigo: 'PERIODO_CERRADO' }); };

const listarLineas = async ({ cuentaId, estado, desde, hasta, limite = 500 } = {}) => {
  const w = [], p = [];
  if (cuentaId) { w.push('cuenta_id = ?'); p.push(Number(cuentaId)); }
  if (estado) { w.push('estado = ?'); p.push(estado); }
  if (desde) { w.push('fecha >= ?'); p.push(desde); }
  if (hasta) { w.push('fecha <= ?'); p.push(hasta); }
  return (await pool.query(`SELECT * FROM fin_extracto_lineas ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY fecha, id LIMIT ?`, [...p, Math.min(Number(limite) || 500, 2000)]))[0].map(vistaLinea);
};

// Movimientos de la cuenta que todavía no se conciliaron (para elegirlos a mano).
const movimientosSinConciliar = async (cuentaId, { desde, hasta } = {}) => {
  const w = ['m.cuenta_id = ?', 'v.id IS NULL'], p = [Number(cuentaId)];
  if (desde) { w.push('m.fecha_ms >= ?'); p.push(new Date(`${desde}T00:00:00`).getTime()); }
  if (hasta) { w.push('m.fecha_ms <= ?'); p.push(new Date(`${hasta}T23:59:59.999`).getTime()); }
  const [filas] = await pool.query(`SELECT m.id, m.tipo, m.importe, m.fecha_ms, m.referencia_externa, m.motivo FROM fin_movimientos m LEFT JOIN fin_conciliacion_vinculos v ON v.movimiento_id = m.id WHERE ${w.join(' AND ')} ORDER BY m.id LIMIT 1000`, p);
  return filas.map((m) => ({ ...m, importe: Number(m.importe), fecha_ms: Number(m.fecha_ms) }));
};

const vincularTx = async (conn, linea, movIds, modo, userId) => {
  for (const mid of movIds) {
    try { await conn.query('INSERT INTO fin_conciliacion_vinculos (linea_id, movimiento_id, modo, user_id, ts_ms) VALUES (?, ?, ?, ?, ?)', [linea.id, mid, modo, userId ?? null, Date.now()]); } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw invalida(`El movimiento ${mid} ya está conciliado: un movimiento se concilia una sola vez.`, 409, { codigo: 'YA_CONCILIADO', detalle: { movimiento_id: mid } });
      throw err;
    }
  }
  await conn.query("UPDATE fin_extracto_lineas SET estado = 'conciliada' WHERE id = ?", [linea.id]);
};

// Conciliación manual: una línea contra uno o varios movimientos que suman su importe (RF09).
const vincular = async (lineaId, movimientoIds, userId) => {
  await exigirFuncion();
  const linea = await lineaFila(lineaId);
  exigirAbierta(linea);
  if (linea.estado === 'conciliada') throw invalida('La línea ya está conciliada.', 409, { codigo: 'YA_CONCILIADO' });
  const ids = [...new Set((movimientoIds ?? []).map(Number))];
  if (!ids.length || ids.some((i) => !Number.isInteger(i))) throw invalida('Indicá los movimientos a conciliar.');
  const [ms] = await pool.query('SELECT id, cuenta_id, importe FROM fin_movimientos WHERE id IN (?)', [ids]);
  if (ms.length !== ids.length) throw invalida('Algún movimiento no existe.', 404);
  if (ms.some((m) => m.cuenta_id !== linea.cuenta_id)) throw invalida('Los movimientos son de otra cuenta.', 409);
  const suma = ms.reduce((a, m) => a + cts(m.importe), 0);
  if (suma !== cts(linea.importe)) throw invalida(`Los movimientos suman ${suma / 100} y la línea del extracto es ${Number(linea.importe)}.`, 400, { codigo: 'IMPORTE_NO_COINCIDE' });
  const conn = await pool.getConnection();
  try { await conn.beginTransaction(); await vincularTx(conn, linea, ids, 'manual', userId); await conn.commit(); } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return vistaLinea(await lineaFila(lineaId));
};

const desvincular = async (lineaId) => {
  await exigirFuncion();
  const linea = await lineaFila(lineaId);
  exigirAbierta(linea);
  await pool.query('DELETE FROM fin_conciliacion_vinculos WHERE linea_id = ?', [lineaId]);
  await pool.query("UPDATE fin_extracto_lineas SET estado = 'pendiente' WHERE id = ?", [lineaId]);
  return vistaLinea(await lineaFila(lineaId));
};

// Conciliación automática por importe, fecha (± N días) y referencia. Si hay más de un candidato no adivina; sin ninguno, queda «pendiente de identificar» (EX07).
const automatica = async (cuentaId, userId) => {
  await exigirFuncion();
  const cuenta = await cuentaBancaria(cuentaId);
  const { conciliacion_dias: dias } = await Cuentas.config();
  const pendientes = (await pool.query("SELECT * FROM fin_extracto_lineas WHERE cuenta_id = ? AND estado IN ('pendiente', 'pendiente_de_identificar') AND conciliacion_id IS NULL ORDER BY fecha, id", [cuenta.id]))[0];
  let conciliadas = 0, ambiguas = 0, sinMatch = 0;
  for (const l of pendientes) {
    const f = new Date(`${iso(l.fecha)}T12:00:00`).getTime();
    const [cand] = await pool.query(
      `SELECT m.id, m.referencia_externa, m.motivo, m.doc_id_global FROM fin_movimientos m LEFT JOIN fin_conciliacion_vinculos v ON v.movimiento_id = m.id
       WHERE m.cuenta_id = ? AND v.id IS NULL AND m.importe = ? AND m.fecha_ms BETWEEN ? AND ? ORDER BY m.id`, [cuenta.id, l.importe, f - (dias + 0.5) * 86400000, f + (dias + 0.5) * 86400000]);
    const ref = l.referencia ? String(l.referencia).toLowerCase() : null;
    const conRef = ref ? cand.filter((m) => [m.referencia_externa, m.doc_id_global, m.motivo].some((x) => x && String(x).toLowerCase().includes(ref))) : [];
    const elegidos = conRef.length ? conRef : cand;
    if (elegidos.length === 1) {
      const conn = await pool.getConnection();
      try { await conn.beginTransaction(); await vincularTx(conn, l, [elegidos[0].id], 'automatico', userId); await conn.commit(); conciliadas++; } catch (err) {
        await conn.rollback();
        if (!(err.codigo === 'YA_CONCILIADO')) throw err;
        ambiguas++;
      } finally { conn.release(); }
    } else if (elegidos.length > 1) ambiguas++;
    else { sinMatch++; if (l.estado !== 'pendiente_de_identificar') await pool.query("UPDATE fin_extracto_lineas SET estado = 'pendiente_de_identificar' WHERE id = ?", [l.id]); }
  }
  return { revisadas: pendientes.length, conciliadas, ambiguas, pendientes_de_identificar: sinMatch };
};

// Registra desde el extracto un movimiento que el sistema no tenía (comisiones, impuesto a los débitos y créditos, intereses, transferencias recibidas sin identificar) y lo concilia (RF09).
const registrarDesdeExtracto = async (lineaId, { tipo, categoria_id: categoriaId = null }, userId) => {
  await exigirFuncion();
  if (!TIPOS_REGISTRO.includes(tipo)) throw invalida(`El tipo debe ser uno de: ${TIPOS_REGISTRO.join(', ')}.`);
  const linea = await lineaFila(lineaId);
  exigirAbierta(linea);
  if (linea.estado === 'conciliada') throw invalida('La línea ya está conciliada.', 409, { codigo: 'YA_CONCILIADO' });
  const cuenta = await Cuentas.obtenerFila(linea.cuenta_id);
  if (categoriaId) await Cuentas.categoriaFila(Number(categoriaId));
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM fin_cuentas WHERE id = ? FOR UPDATE', [cuenta.id]);
    const id = await movimiento(conn, { cuentaId: cuenta.id, tipo, importe: Number(linea.importe), moneda: cuenta.moneda, categoriaId: categoriaId ?? null, referenciaExterna: linea.referencia, fechaMs: new Date(`${iso(linea.fecha)}T12:00:00`).getTime(),
      motivo: linea.descripcion ?? `Registrado desde el extracto (${tipo})`, marcas: 'desde_extracto', userId });
    await vincularTx(conn, linea, [id], 'extracto', userId);
    await conn.commit();
    return { linea: vistaLinea(await lineaFila(lineaId)), movimiento_id: id };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

// Cierra la conciliación de un período con su saldo conciliado: todas las líneas conciliadas y el saldo del extracto igual al conciliado.
const cerrar = async (d, userId) => {
  await exigirFuncion();
  const cuenta = await cuentaBancaria(d.cuenta_id);
  if (!valida(d.desde) || !valida(d.hasta) || d.desde > d.hasta) throw invalida('Indicá el período (desde y hasta, AAAA-MM-DD).');
  const saldoExtracto = Number(d.saldo_extracto);
  if (!Number.isFinite(saldoExtracto)) throw invalida('Indicá el saldo final del extracto.');
  const previo = await ultimoCierre(cuenta.id);
  if (previo && d.desde <= iso(previo.hasta)) throw invalida(`El período se superpone con el cerrado hasta el ${iso(previo.hasta)}.`, 409, { codigo: 'PERIODO_CERRADO' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [lineas] = await conn.query('SELECT * FROM fin_extracto_lineas WHERE cuenta_id = ? AND fecha BETWEEN ? AND ? AND conciliacion_id IS NULL FOR UPDATE', [cuenta.id, d.desde, d.hasta]);
    const sin = lineas.filter((l) => l.estado !== 'conciliada');
    if (sin.length) throw invalida(`Quedan ${sin.length} línea(s) sin conciliar en el período.`, 409, { codigo: 'LINEAS_SIN_CONCILIAR', detalle: { lineas: sin.map((l) => l.id) } });
    const saldoInicial = d.saldo_inicial !== undefined && d.saldo_inicial !== null ? Number(d.saldo_inicial) : previo ? Number(previo.saldo_extracto) : 0;
    const conciliado = r2(saldoInicial + lineas.reduce((a, l) => a + Number(l.importe), 0));
    const diferencia = r2(saldoExtracto - conciliado);
    if (Math.abs(diferencia) > 0.01) throw invalida(`El saldo del extracto (${saldoExtracto}) no coincide con el conciliado (${conciliado}): falta cargar o conciliar movimientos.`, 409, { codigo: 'SALDO_NO_CUADRA', detalle: { saldo_conciliado: conciliado, diferencia } });
    const [r] = await conn.query('INSERT INTO fin_conciliaciones (cuenta_id, desde, hasta, saldo_extracto, saldo_conciliado, diferencia, user_id, cerrada_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [cuenta.id, d.desde, d.hasta, saldoExtracto, conciliado, diferencia, userId ?? null, Date.now()]);
    if (lineas.length) await conn.query('UPDATE fin_extracto_lineas SET conciliacion_id = ? WHERE id IN (?)', [r.insertId, lineas.map((l) => l.id)]);
    await conn.commit();
    return { id: r.insertId, cuenta_id: cuenta.id, desde: d.desde, hasta: d.hasta, saldo_extracto: saldoExtracto, saldo_conciliado: conciliado, diferencia, lineas: lineas.length };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};
const cierres = async (cuentaId) => (await pool.query(`SELECT * FROM fin_conciliaciones ${cuentaId ? 'WHERE cuenta_id = ?' : ''} ORDER BY hasta DESC LIMIT 200`, cuentaId ? [Number(cuentaId)] : []))[0]
  .map((c) => ({ id: c.id, cuenta_id: c.cuenta_id, desde: iso(c.desde), hasta: iso(c.hasta), saldo_extracto: Number(c.saldo_extracto), saldo_conciliado: Number(c.saldo_conciliado), diferencia: Number(c.diferencia), cerrada_ms: Number(c.cerrada_ms) }));

module.exports = { numero, fechaDe, importar, cargarManual, listarLineas, movimientosSinConciliar, vincular, desvincular, automatica, registrarDesdeExtracto, cerrar, cierres };
