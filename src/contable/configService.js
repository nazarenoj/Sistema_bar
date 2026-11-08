const pool = require('../config/db');
const Modulos = require('../modulos/registro');
const Funciones = require('../funciones/servicio');
const { cuentasDe, PERFILES } = require('./plantillas');
const Reglas = require('./reglaService');
const { invalida, fechaLocal, esFecha, iso } = require('./comun');

// Inicio de la contabilidad (Contable RF13, RN01, RN18, EX12). Contable se instala como cualquier módulo, pero recién cuenta movimientos desde la fecha de inicio que elige el
// Administrador: la de hoy o una posterior, nunca una anterior. Lo anterior no se reconstruye (queda en «Movimientos anteriores al inicio») y sus saldos entran por el asiento de apertura.
const MESES = (desde, hasta) => {
  const salida = [];
  let [a, m] = [Number(desde.slice(0, 4)), Number(desde.slice(5, 7))];
  const [af, mf] = [Number(hasta.slice(0, 4)), Number(hasta.slice(5, 7))];
  while (a < af || (a === af && m <= mf)) { salida.push([a, m]); m++; if (m > 12) { m = 1; a++; } }
  return salida;
};

const config = async (db = pool) => (await db.query('SELECT * FROM con_config WHERE id = 1'))[0][0];
const vista = (c) => ({ fecha_inicio: iso(c.fecha_inicio), iniciada: !!c.fecha_inicio, perfil_rubro: c.perfil_rubro, momento_costo_no_fiscal: c.momento_costo_no_fiscal, asiento_apertura_id: c.asiento_apertura_id, es_casa_central: !!c.es_casa_central,
  retencion_anios: c.retencion_anios, bloquear_cierre_controles: !!c.bloquear_cierre_controles });

// Primer ejercicio: desde el inicio hasta fin de año (puede durar menos de 12 meses, RF02).
const crearEjercicio = async (conn, desde, hasta) => {
  const [e] = await conn.query('INSERT INTO con_ejercicios (desde, hasta) VALUES (?, ?)', [desde, hasta]);
  for (const [a, m] of MESES(desde, hasta)) await conn.query('INSERT IGNORE INTO con_periodos (ejercicio_id, anio, mes) VALUES (?, ?, ?)', [e.insertId, a, m]);
  await conn.query('INSERT IGNORE INTO con_numeracion (ejercicio_id, ultimo) VALUES (?, 0)', [e.insertId]);
  return e.insertId;
};

const cargarPlan = async (conn, perfil) => {
  const requisitos = new Map();
  for (const m of ['stock', 'compras', 'financiero', 'clientes', 'ventas_online']) requisitos.set(`m:${m}`, await Modulos.estaInstalado(m));
  const cumple = (req) => (req.modulo ? requisitos.get(`m:${req.modulo}`) : req.funcion ? funcionesActivas.has(req.funcion) : true);
  const funcionesActivas = new Set((await Funciones.estado(conn)).funciones.filter((f) => f.activa).map((f) => f.id));
  const ids = new Map();
  for (const c of cuentasDe(perfil, cumple)) {
    const [r] = await conn.query('INSERT IGNORE INTO con_cuentas (codigo, nombre, tipo, padre_id, imputable, clave) VALUES (?, ?, ?, ?, ?, ?)', [c.codigo, c.nombre, c.tipo, c.padre ? ids.get(c.padre) ?? null : null, c.imputable ? 1 : 0, c.clave]);
    if (r.insertId) ids.set(c.codigo, r.insertId);
    else ids.set(c.codigo, (await conn.query('SELECT id FROM con_cuentas WHERE codigo = ?', [c.codigo]))[0][0].id);
  }
  return ids.size;
};

const estado = async () => {
  const c = await config();
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM con_cuentas');
  return { ...vista(c), propuesta_inicio: fechaLocal(), cuentas: Number(n), perfiles: PERFILES };
};

// Fija (o corrige, mientras no haya asiento de apertura) la fecha de inicio y arma el primer ejercicio con sus períodos y el plan de cuentas del perfil.
const iniciar = async ({ fecha_inicio: fecha, perfil }, { hoy = fechaLocal() } = {}) => {
  if (!esFecha(fecha)) throw invalida('La fecha de inicio va como AAAA-MM-DD.');
  if (fecha < hoy) throw invalida('La contabilidad no puede empezar antes de hoy: no hay generación retroactiva.', 409, { codigo: 'INICIO_ANTERIOR' });
  if (!PERFILES.includes(perfil)) throw invalida(`El perfil de rubro es uno de: ${PERFILES.join(', ')}.`);
  const c = await config();
  if (c.asiento_apertura_id) throw invalida('Ya hay un asiento de apertura: la fecha de inicio no se modifica. Corregí con un asiento manual de ajuste.', 409, { codigo: 'INICIO_FIJO' }); // EX12
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM con_asientos');
    if (Number(n)) throw invalida('Ya hay asientos: la fecha de inicio no se modifica.', 409, { codigo: 'INICIO_FIJO' });
    await conn.query('DELETE FROM con_numeracion'); await conn.query('DELETE FROM con_periodos'); await conn.query('DELETE FROM con_ejercicios');
    await crearEjercicio(conn, fecha, `${fecha.slice(0, 4)}-12-31`);
    if (!c.perfil_rubro) { await cargarPlan(conn, perfil); await Reglas.sembrar(conn, fecha); }
    await conn.query('UPDATE con_config SET fecha_inicio = ?, perfil_rubro = COALESCE(perfil_rubro, ?), iniciada_ms = COALESCE(iniciada_ms, ?) WHERE id = 1', [fecha, perfil, Date.now()]);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return estado();
};

const actualizar = async (d) => {
  const campos = {};
  if (d.momento_costo_no_fiscal !== undefined) { if (!['movimiento', 'regularizar'].includes(d.momento_costo_no_fiscal)) throw invalida('El momento es movimiento o regularizar.'); campos.momento_costo_no_fiscal = d.momento_costo_no_fiscal; }
  if (d.retencion_anios !== undefined) { if (!Number.isInteger(d.retencion_anios) || d.retencion_anios < 1 || d.retencion_anios > 50) throw invalida('La retención son entre 1 y 50 años.'); campos.retencion_anios = d.retencion_anios; }
  if (d.bloquear_cierre_controles !== undefined) campos.bloquear_cierre_controles = d.bloquear_cierre_controles ? 1 : 0;
  const k = Object.keys(campos);
  if (k.length) await pool.query(`UPDATE con_config SET ${k.map((x) => `${x} = ?`).join(', ')} WHERE id = 1`, k.map((x) => campos[x]));
  return estado();
};

module.exports = { config, estado, iniciar, actualizar, crearEjercicio, MESES, cargarPlan };
