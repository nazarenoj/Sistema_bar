const pool = require('../config/db');
const { idGlobal } = require('../utils/idGlobal');
const Modulos = require('../modulos/registro');
const Funciones = require('../funciones/servicio');
const { invalida, r2 } = require('./comun');

// Cajas y cuentas (Financiero RF01), categorías (RF11) y configuración del módulo. El saldo nunca se guarda: se deriva de los movimientos (RN02).
const TIPOS = ['caja_efectivo', 'caja_reparto', 'caja_fuerte', 'banco', 'billetera', 'procesador', 'pasarela'];
const ES_CAJA = (t) => t.startsWith('caja_');
const BANCARIAS = ['banco', 'billetera', 'procesador', 'pasarela'];

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const flag = (v) => (v === true || v === 1 || v === '1' ? 1 : 0);

const saldoDe = async (cuentaId, db = pool) => {
  const [[r]] = await db.query('SELECT c.saldo_inicial + COALESCE(SUM(m.importe), 0) AS saldo FROM fin_cuentas c LEFT JOIN fin_movimientos m ON m.cuenta_id = c.id WHERE c.id = ? GROUP BY c.id', [cuentaId]);
  return r ? r2(r.saldo) : null;
};

const vista = (c, saldo) => ({
  id: c.id, id_global: c.id_global, tipo: c.tipo, nombre: c.nombre, moneda: c.moneda, cbu_alias: c.cbu_alias,
  limite_descubierto: Number(c.limite_descubierto), fondo_cambio: Number(c.fondo_cambio), tope_efectivo: c.tope_efectivo === null ? null : Number(c.tope_efectivo),
  terminal_id: c.terminal_id, cierre_ciego: !!c.cierre_ciego, activa: !!c.activa,
  ...(saldo !== undefined && { saldo_inicial: Number(c.saldo_inicial), saldo }),
});

const listar = async ({ conSaldo = false, soloActivas = false } = {}) => {
  const [filas] = await pool.query(
    `SELECT c.*, c.saldo_inicial + COALESCE(s.total, 0) AS saldo FROM fin_cuentas c
     LEFT JOIN (SELECT cuenta_id, SUM(importe) AS total FROM fin_movimientos GROUP BY cuenta_id) s ON s.cuenta_id = c.id
     ${soloActivas ? 'WHERE c.activa = 1' : ''} ORDER BY c.tipo, c.nombre`);
  return filas.map((c) => vista(c, conSaldo ? r2(c.saldo) : undefined));
};

const obtenerFila = async (id, db = pool) => {
  const [[c]] = await db.query('SELECT * FROM fin_cuentas WHERE id = ?', [id]);
  if (!c) throw invalida('Caja o cuenta no encontrada.', 404);
  return c;
};

const obtener = async (id, { conSaldo = false } = {}) => {
  const c = await obtenerFila(id);
  return vista(c, conSaldo ? await saldoDe(id) : undefined);
};

// Valida los datos de una caja o cuenta nueva o modificada.
const validar = async (d, { actual = null } = {}) => {
  const tipo = d.tipo ?? actual?.tipo;
  if (!TIPOS.includes(tipo)) throw invalida(`El tipo debe ser uno de: ${TIPOS.join(', ')}.`);
  const nombre = String(d.nombre ?? actual?.nombre ?? '').trim();
  if (!nombre) throw invalida('Indicá el nombre.');
  if (nombre.length > 80) throw invalida('El nombre admite hasta 80 caracteres.');
  const moneda = String(d.moneda ?? actual?.moneda ?? 'ARS').toUpperCase();
  if (!/^[A-Z]{3}$/.test(moneda)) throw invalida('La moneda es un código de 3 letras (ej. ARS).');
  if (moneda !== 'ARS' && !(await Funciones.estaActiva('FIN-MONEDA-EXT'))) throw invalida('Una caja o cuenta en moneda extranjera necesita la función FIN-MONEDA-EXT.', 409, { codigo: 'FUNCION_INACTIVA' });
  if (tipo === 'pasarela' && !(await Modulos.estaInstalado('ventas_online'))) throw invalida('Una cuenta de pasarela necesita el módulo Ventas Online.', 409, { codigo: 'MODULO_NO_INSTALADO' });
  const saldoInicial = d.saldo_inicial !== undefined ? num(d.saldo_inicial) : Number(actual?.saldo_inicial ?? 0);
  if (!Number.isFinite(saldoInicial)) throw invalida('El saldo inicial debe ser un número.');
  const descubierto = d.limite_descubierto !== undefined ? num(d.limite_descubierto) ?? 0 : Number(actual?.limite_descubierto ?? 0);
  if (!(descubierto >= 0)) throw invalida('El límite de descubierto no puede ser negativo.');
  // RN08: una caja de efectivo no queda en negativo; solo una cuenta puede tener descubierto.
  if (ES_CAJA(tipo) && saldoInicial < 0) throw invalida('Una caja de efectivo no puede tener saldo inicial negativo.');
  if (ES_CAJA(tipo) && descubierto > 0) throw invalida('Una caja de efectivo no admite descubierto.');
  const cbu = d.cbu_alias !== undefined ? (String(d.cbu_alias ?? '').trim() || null) : actual?.cbu_alias ?? null;
  if (cbu && !BANCARIAS.includes(tipo)) throw invalida('El CBU o alias solo corresponde a cuentas.');
  if (cbu && !/^[A-Za-z0-9._-]{6,30}$|^\d{22}$/.test(cbu)) throw invalida('El CBU (22 dígitos) o el alias (6 a 30 caracteres) no es válido.');
  const fondo = d.fondo_cambio !== undefined ? num(d.fondo_cambio) ?? 0 : Number(actual?.fondo_cambio ?? 0);
  const tope = d.tope_efectivo !== undefined ? num(d.tope_efectivo) : actual?.tope_efectivo === null || actual?.tope_efectivo === undefined ? null : Number(actual.tope_efectivo);
  if (!(fondo >= 0) || (tope !== null && !(tope > 0))) throw invalida('El fondo de cambio no puede ser negativo y el tope de efectivo debe ser mayor a cero.');
  if ((d.fondo_cambio !== undefined || d.tope_efectivo !== undefined) && !ES_CAJA(tipo)) throw invalida('El fondo de cambio y el tope de efectivo solo corresponden a cajas.');
  let terminalId = d.terminal_id !== undefined ? num(d.terminal_id) : actual?.terminal_id ?? null;
  if (terminalId !== null) {
    if (tipo !== 'caja_efectivo') throw invalida('Solo una caja de efectivo se asocia a una terminal.');
    const [[t]] = await pool.query('SELECT id FROM terminales WHERE id = ?', [terminalId]);
    if (!t) throw invalida('La terminal indicada no existe.', 404);
    const [[otra]] = await pool.query('SELECT id, nombre FROM fin_cuentas WHERE terminal_id = ? AND activa = 1 AND id <> ?', [terminalId, actual?.id ?? 0]);
    if (otra) throw invalida(`La terminal ya tiene la caja "${otra.nombre}": una terminal usa una sola caja de efectivo.`, 409);
  }
  return { tipo, nombre, moneda, saldoInicial, descubierto, cbu, fondo, tope, terminalId, ciego: d.cierre_ciego !== undefined ? flag(d.cierre_ciego) : actual?.cierre_ciego ?? 0 };
};

const crear = async (d) => {
  const v = await validar(d);
  if (v.ciego && !(await Funciones.estaActiva('FIN-CIERRE-CIEGO'))) throw invalida('El cierre ciego necesita la función FIN-CIERRE-CIEGO.', 409, { codigo: 'FUNCION_INACTIVA' });
  try {
    const [r] = await pool.query(
      `INSERT INTO fin_cuentas (id_global, tipo, nombre, moneda, saldo_inicial, cbu_alias, limite_descubierto, fondo_cambio, tope_efectivo, terminal_id, cierre_ciego)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [await idGlobal(), v.tipo, v.nombre, v.moneda, v.saldoInicial, v.cbu, v.descubierto, ES_CAJA(v.tipo) ? v.fondo : 0, ES_CAJA(v.tipo) ? v.tope : null, v.terminalId, v.ciego]);
    return obtener(r.insertId, { conSaldo: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida(`Ya existe una caja o cuenta con el nombre "${v.nombre}".`, 409);
    throw err;
  }
};

const tieneMovimientos = async (id, db = pool) => (await db.query('SELECT 1 FROM fin_movimientos WHERE cuenta_id = ? LIMIT 1', [id]))[0].length > 0;

const actualizar = async (id, d) => {
  const actual = await obtenerFila(id);
  // Con movimientos, el tipo, la moneda y el saldo inicial quedan fijos: cambiarlos reescribiría la historia (RN02).
  if (await tieneMovimientos(id)) {
    for (const campo of ['tipo', 'moneda', 'saldo_inicial'])
      if (d[campo] !== undefined && String(d[campo]).toUpperCase() !== String(actual[campo]).toUpperCase() && !(campo === 'saldo_inicial' && Number(d[campo]) === Number(actual[campo])))
        throw invalida(`La caja o cuenta ya tiene movimientos: no se cambia ${campo.replace('_', ' ')}.`, 409);
  }
  const v = await validar(d, { actual });
  if (v.ciego && !actual.cierre_ciego && !(await Funciones.estaActiva('FIN-CIERRE-CIEGO'))) throw invalida('El cierre ciego necesita la función FIN-CIERRE-CIEGO.', 409, { codigo: 'FUNCION_INACTIVA' });
  try {
    await pool.query(
      `UPDATE fin_cuentas SET tipo = ?, nombre = ?, moneda = ?, saldo_inicial = ?, cbu_alias = ?, limite_descubierto = ?, fondo_cambio = ?, tope_efectivo = ?, terminal_id = ?, cierre_ciego = ? WHERE id = ?`,
      [v.tipo, v.nombre, v.moneda, v.saldoInicial, v.cbu, v.descubierto, ES_CAJA(v.tipo) ? v.fondo : 0, ES_CAJA(v.tipo) ? v.tope : null, v.terminalId, v.ciego, id]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida(`Ya existe una caja o cuenta con el nombre "${v.nombre}".`, 409);
    throw err;
  }
  return obtener(id, { conSaldo: true });
};

// Una caja o cuenta se desactiva (no se borra) si tiene historia; sin movimientos se puede eliminar.
const cambiarEstado = async (id, activa, { confirmar = false } = {}) => {
  await obtenerFila(id);
  if (!activa) {
    // Un control devuelve { bloquea } (no se puede) o { confirma } (se puede, pero hay que confirmar: EX25).
    const bloqueos = [], avisos = [];
    for (const hook of hooksDesactivar) { const b = await hook(id); if (b?.bloquea) bloqueos.push(b.bloquea); if (b?.confirma) avisos.push(b.confirma); }
    if (bloqueos.length) throw invalida(bloqueos.join(' '), 409);
    if (avisos.length && !confirmar) throw invalida(`${avisos.join(' ')} Confirmá para desactivarla.`, 409, { codigo: 'REQUIERE_CONFIRMACION' });
  }
  await pool.query('UPDATE fin_cuentas SET activa = ? WHERE id = ?', [activa ? 1 : 0, id]);
  return obtener(id, { conSaldo: true });
};
// Cada parte de Financiero que depende de una caja (turnos abiertos, destinos de formas de pago) suma su control acá.
const hooksDesactivar = [];
const alDesactivar = (fn) => hooksDesactivar.push(fn);

const eliminar = async (id) => {
  await obtenerFila(id);
  if (await tieneMovimientos(id)) throw invalida('La caja o cuenta tiene movimientos: se desactiva, no se elimina.', 409);
  try { await pool.query('DELETE FROM fin_cuentas WHERE id = ?', [id]); } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') throw invalida('La caja o cuenta está en uso: se desactiva, no se elimina.', 409);
    throw err;
  }
  return { eliminada: true };
};

// ---- Categorías (RF11) ----

const categorias = async ({ soloActivas = false } = {}) => {
  const [filas] = await pool.query(`SELECT id, nombre, padre_id, tipo, activa FROM fin_categorias ${soloActivas ? 'WHERE activa = 1' : ''} ORDER BY nombre`);
  const nodo = (f) => ({ id: f.id, nombre: f.nombre, padre_id: f.padre_id, tipo: f.tipo, activa: !!f.activa });
  const porPadre = new Map();
  for (const f of filas) { const k = f.padre_id ?? 0; porPadre.set(k, [...(porPadre.get(k) ?? []), f]); }
  const arbol = (k) => (porPadre.get(k) ?? []).map((f) => ({ ...nodo(f), hijos: arbol(f.id) }));
  return arbol(0);
};

const categoriaFila = async (id) => {
  const [[c]] = await pool.query('SELECT * FROM fin_categorias WHERE id = ?', [id]);
  if (!c) throw invalida('Categoría no encontrada.', 404);
  return c;
};

const TIPOS_CAT = ['ingreso', 'egreso', 'ambos'];

const crearCategoria = async ({ nombre, padre_id = null, tipo = 'egreso' }) => {
  nombre = String(nombre ?? '').trim();
  if (!nombre || nombre.length > 80) throw invalida('Indicá el nombre de la categoría (hasta 80 caracteres).');
  if (!TIPOS_CAT.includes(tipo)) throw invalida(`El tipo debe ser uno de: ${TIPOS_CAT.join(', ')}.`);
  if (padre_id !== null && padre_id !== undefined) await categoriaFila(Number(padre_id));
  try {
    const [r] = await pool.query('INSERT INTO fin_categorias (nombre, padre_id, tipo) VALUES (?, ?, ?)', [nombre, padre_id ?? null, tipo]);
    return { id: r.insertId, nombre, padre_id: padre_id ?? null, tipo, activa: true };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida(`Ya existe la categoría "${nombre}".`, 409);
    throw err;
  }
};

// Mover una categoría bajo una descendiente suya formaría un ciclo.
const actualizarCategoria = async (id, d) => {
  const c = await categoriaFila(id);
  const nombre = d.nombre !== undefined ? String(d.nombre).trim() : c.nombre;
  if (!nombre || nombre.length > 80) throw invalida('Indicá el nombre de la categoría (hasta 80 caracteres).');
  const tipo = d.tipo ?? c.tipo;
  if (!TIPOS_CAT.includes(tipo)) throw invalida(`El tipo debe ser uno de: ${TIPOS_CAT.join(', ')}.`);
  const padre = d.padre_id !== undefined ? (d.padre_id === null ? null : Number(d.padre_id)) : c.padre_id;
  if (padre !== null) {
    let cursor = padre;
    for (let i = 0; cursor !== null && i < 100; i++) {
      if (cursor === id) throw invalida('La categoría no puede quedar dentro de sí misma ni de sus descendientes.', 409);
      cursor = (await categoriaFila(cursor)).padre_id;
    }
  }
  try {
    await pool.query('UPDATE fin_categorias SET nombre = ?, tipo = ?, padre_id = ?, activa = ? WHERE id = ?', [nombre, tipo, padre, d.activa !== undefined ? flag(d.activa) : c.activa, id]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida(`Ya existe la categoría "${nombre}".`, 409);
    throw err;
  }
  return { id, nombre, padre_id: padre, tipo, activa: d.activa !== undefined ? !!flag(d.activa) : !!c.activa };
};

// ---- Configuración (RN04, RN05, RN43) ----

const config = async (db = pool) => {
  const [[c]] = await db.query('SELECT * FROM fin_config WHERE id = 1');
  return {
    antiguedad_max_reapertura_dias: c.antiguedad_max_reapertura_dias, tolerancia_diferencia: Number(c.tolerancia_diferencia),
    exigir_turno_efectivo: !!c.exigir_turno_efectivo, retencion_solicitudes_dias: c.retencion_solicitudes_dias,
    plazo_presentacion_cheque_dias: c.plazo_presentacion_cheque_dias, conciliacion_dias: c.conciliacion_dias,
    cotizacion_vencida: c.cotizacion_vencida, divisas_tolerancia_pct: Number(c.divisas_tolerancia_pct),
  };
};

const actualizarConfig = async (d) => {
  const actual = await config();
  const dias = d.antiguedad_max_reapertura_dias !== undefined ? Number(d.antiguedad_max_reapertura_dias) : actual.antiguedad_max_reapertura_dias;
  const tol = d.tolerancia_diferencia !== undefined ? Number(d.tolerancia_diferencia) : actual.tolerancia_diferencia;
  const ret = d.retencion_solicitudes_dias !== undefined ? Number(d.retencion_solicitudes_dias) : actual.retencion_solicitudes_dias;
  if (!Number.isInteger(dias) || dias < 0 || dias > 365) throw invalida('La antigüedad máxima de reapertura es un número entero de días entre 0 y 365 (0 no admite reaperturas).');
  if (!(tol >= 0)) throw invalida('La tolerancia de diferencia no puede ser negativa.');
  if (!Number.isInteger(ret) || ret < 90) throw invalida('Las solicitudes procesadas se conservan al menos 90 días.');
  const exigir = d.exigir_turno_efectivo !== undefined ? flag(d.exigir_turno_efectivo) : actual.exigir_turno_efectivo ? 1 : 0;
  const plazo = d.plazo_presentacion_cheque_dias !== undefined ? Number(d.plazo_presentacion_cheque_dias) : actual.plazo_presentacion_cheque_dias;
  const ventana = d.conciliacion_dias !== undefined ? Number(d.conciliacion_dias) : actual.conciliacion_dias;
  if (!Number.isInteger(plazo) || plazo < 1 || plazo > 365) throw invalida('El plazo de presentación de cheques es un entero de días entre 1 y 365.');
  if (!Number.isInteger(ventana) || ventana < 0 || ventana > 30) throw invalida('La ventana de la conciliación automática es un entero de días entre 0 y 30.');
  const vencida = d.cotizacion_vencida ?? actual.cotizacion_vencida;
  const tolDivisa = d.divisas_tolerancia_pct !== undefined ? Number(d.divisas_tolerancia_pct) : actual.divisas_tolerancia_pct;
  if (!['advertir', 'bloquear'].includes(vencida)) throw invalida('Con la cotización vencida se puede advertir o bloquear.');
  if (!(tolDivisa >= 0 && tolDivisa <= 100)) throw invalida('La tolerancia de la cotización pactada es un porcentaje entre 0 y 100.');
  await pool.query('UPDATE fin_config SET antiguedad_max_reapertura_dias = ?, tolerancia_diferencia = ?, exigir_turno_efectivo = ?, retencion_solicitudes_dias = ?, plazo_presentacion_cheque_dias = ?, conciliacion_dias = ?, cotizacion_vencida = ?, divisas_tolerancia_pct = ? WHERE id = 1', [dias, tol, exigir, ret, plazo, ventana, vencida, tolDivisa]);
  return config();
};

module.exports = {
  TIPOS, ES_CAJA, saldoDe, listar, obtener, obtenerFila, crear, actualizar, cambiarEstado, alDesactivar, eliminar, tieneMovimientos,
  categorias, crearCategoria, actualizarCategoria, categoriaFila, config, actualizarConfig,
};
