const pool = require('../config/db');
const Asientos = require('./asientoService');
const Periodos = require('./periodoService');
const Cuentas = require('./cuentaService');
const Libros = require('./libroService');
const Controles = require('./controlService');
const { invalida, r2, iso, cts } = require('./comun');

// Cierre y apertura de ejercicio (Contable RF10, RN12, EX09). Para cerrar, todos los períodos tienen que estar cerrados, sin pendientes de imputar y con el balance cuadrado. El cierre genera
// el asiento de refundición de resultados, el de cierre patrimonial y el de apertura del ejercicio siguiente; después el ejercicio solo se consulta.
const faltantes = async (ej) => {
  const [abiertos] = await pool.query("SELECT anio, mes FROM con_periodos WHERE ejercicio_id = ? AND estado = 'abierto' ORDER BY anio, mes", [ej.id]);
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM con_pendientes WHERE estado = 'abierto'");
  const balance = await Libros.balance({ desde: iso(ej.desde), hasta: iso(ej.hasta) });
  const [[cfg]] = await pool.query('SELECT bloquear_cierre_controles AS b FROM con_config WHERE id = 1');
  const ultimo = cfg.b ? await Controles.ultimo() : null;
  const out = {};
  if (abiertos.length) out.periodos_abiertos = abiertos.map((p) => `${p.anio}-${String(p.mes).padStart(2, '0')}`);
  if (Number(n)) out.pendientes_de_imputar = Number(n);
  if (!balance.cuadra) out.balance_descuadrado = true;
  if (cfg.b && (!ultimo || ultimo.con_diferencias > 0)) out.controles_con_diferencias = true;
  return out;
};

const ejercicio = async (id) => {
  const [[e]] = await pool.query('SELECT * FROM con_ejercicios WHERE id = ?', [id]);
  if (!e) throw invalida('Ejercicio no encontrado.', 404);
  return e;
};

// Vista previa: lo que falta resolver (EX09) y los asientos que se generarían.
const validar = async (id) => {
  const e = await ejercicio(id);
  if (e.estado === 'cerrado') throw invalida('El ejercicio ya está cerrado.', 409, { codigo: 'EJERCICIO_CERRADO' });
  return { ejercicio: e, faltan: await faltantes(e) };
};

const saldosAl = async (db, hasta, desde = null) => {
  const [filas] = await db.query(`SELECT c.id, c.codigo, c.nombre, c.tipo, c.clave, COALESCE(SUM(l.debe), 0) AS d, COALESCE(SUM(l.haber), 0) AS h
    FROM con_asiento_lineas l JOIN con_asientos a ON a.id = l.asiento_id JOIN con_cuentas c ON c.id = l.cuenta_id WHERE a.fecha <= ? ${desde ? 'AND a.fecha >= ?' : ''} GROUP BY c.id, c.codigo, c.nombre, c.tipo, c.clave`, desde ? [hasta, desde] : [hasta]);
  return filas.map((f) => ({ ...f, neto: r2(Number(f.d) - Number(f.h)) })).filter((f) => f.neto !== 0);
};

const cerrar = async (id, usuarioId, idSolicitud = null) => {
  const { ejercicio: e, faltan } = await validar(id);
  if (Object.keys(faltan).length) throw invalida('El ejercicio no se puede cerrar: hay cosas por resolver.', 409, { codigo: 'CIERRE_BLOQUEADO', faltan });
  const resultadoCta = await Cuentas.porClave('resultado_ejercicio'), acumCta = await Cuentas.porClave('resultados_acumulados');
  if (!resultadoCta || !acumCta) throw invalida('El plan necesita las cuentas «Resultado del ejercicio» y «Resultados acumulados».', 409, { codigo: 'SIN_CUENTAS_DE_CIERRE' });
  const hasta = iso(e.hasta), desde = iso(e.desde);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[bloqueo]] = await conn.query('SELECT estado FROM con_ejercicios WHERE id = ? FOR UPDATE', [id]);
    if (bloqueo.estado === 'cerrado') throw invalida('El ejercicio ya está cerrado.', 409, { codigo: 'EJERCICIO_CERRADO' });
    const opciones = { fecha: hasta, usuarioId, ignorarCierre: true };
    // 1. Refundición: las cuentas de resultado del ejercicio se llevan a «Resultado del ejercicio».
    const resultados = (await saldosAl(conn, hasta, desde)).filter((s) => s.tipo === 'resultado_positivo' || s.tipo === 'resultado_negativo');
    let refundicion = null, neto = 0;
    if (resultados.length) {
      const lineas = resultados.map((s) => ({ cuenta_id: s.id, debe: s.neto < 0 ? -s.neto : 0, haber: s.neto > 0 ? s.neto : 0 }));
      neto = r2(resultados.reduce((t, s) => t + s.neto, 0)); // deudor positivo = pérdida
      lineas.push({ cuenta_id: resultadoCta.id, debe: neto > 0 ? neto : 0, haber: neto < 0 ? -neto : 0 }); // la pérdida debita el patrimonio; la ganancia lo acredita
      refundicion = await Asientos.crear(conn, { ...opciones, tipo: 'refundicion', leyenda: `Refundición de resultados del ejercicio ${desde} a ${hasta}`, lineas: lineas.filter((l) => cts(l.debe) || cts(l.haber)) });
    }
    // 2. Cierre patrimonial: se cancelan los saldos de activo, pasivo y patrimonio.
    const saldos = (await saldosAl(conn, hasta)).filter((s) => ['activo', 'pasivo', 'patrimonio'].includes(s.tipo));
    const cierre = saldos.length ? await Asientos.crear(conn, { ...opciones, tipo: 'cierre', leyenda: `Cierre patrimonial del ejercicio ${desde} a ${hasta}`,
      lineas: saldos.map((s) => ({ cuenta_id: s.id, debe: s.neto < 0 ? -s.neto : 0, haber: s.neto > 0 ? s.neto : 0 })) }) : null;
    // 3. Apertura del ejercicio siguiente: los mismos saldos, con el resultado pasado a «Resultados acumulados».
    const [[existente]] = await conn.query('SELECT * FROM con_ejercicios WHERE desde > ? ORDER BY desde LIMIT 1', [hasta]);
    const siguiente = existente ? { id: existente.id, desde: iso(existente.desde), hasta: iso(existente.hasta) } : await Periodos.crearEjercicio({}, conn);
    let apertura = null;
    if (saldos.length) {
      const lineas = saldos.map((s) => ({ cuenta_id: s.id === resultadoCta.id ? acumCta.id : s.id, debe: s.neto > 0 ? s.neto : 0, haber: s.neto < 0 ? -s.neto : 0 }));
      apertura = await Asientos.crear(conn, { fecha: siguiente.desde, tipo: 'apertura_ejercicio', leyenda: `Apertura del ejercicio ${siguiente.desde} a ${siguiente.hasta}`, usuarioId, lineas: Asientos.consolidar(lineas) });
    }
    await conn.query("UPDATE con_ejercicios SET estado = 'cerrado', cerrado_ms = ? WHERE id = ?", [Date.now(), id]);
    await conn.query('INSERT INTO con_cierres (ejercicio_id, ms, usuario_id, asiento_refundicion_id, asiento_cierre_id, asiento_apertura_id, siguiente_ejercicio_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, Date.now(), usuarioId, refundicion?.id ?? null, cierre?.id ?? null, apertura?.id ?? null, siguiente.id]);
    await conn.commit();
    return { ejercicio_id: id, resultado: r2(-neto), refundicion: refundicion && { id: refundicion.id, numero: refundicion.numero }, cierre: cierre && { id: cierre.id, numero: cierre.numero }, apertura: apertura && { id: apertura.id, numero: apertura.numero }, siguiente_ejercicio: siguiente, idSolicitud };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

module.exports = { validar, cerrar };
