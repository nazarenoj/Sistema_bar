const pool = require('../config/db');
const Deposito = require('../models/depositoModel');
const Lotes = require('./loteService');
const Mov = require('./movimientoService');
const { exigirLibre } = require('./tomaAlcance');
const { idGlobal } = require('../utils/idGlobal');

// Venta por porción de una pieza entera (Stock RF30, RN44, RN78) y la configuración de envases y modificadores (RF38, RF31).
class PorcionInvalida extends Error {}
const invalida = (m, status = 400) => Object.assign(new PorcionInvalida(m), { status });
const redondear = (x) => Math.round(x * 10000) / 10000;
const existe = async (tabla, id) => (await pool.query(`SELECT 1 FROM ${tabla} WHERE id = ?`, [id]))[0].length > 0;

const configurar = async (producto_id, { origen_producto_id, porciones_por_pieza, modalidad }) => {
  if (!['proporcional', 'fraccionamiento'].includes(modalidad)) throw invalida('La modalidad debe ser proporcional o fraccionamiento.');
  if (!Number.isInteger(porciones_por_pieza) || porciones_por_pieza < 2) throw invalida('Las porciones por pieza deben ser un entero de 2 o más (RN04).');
  if (modalidad === 'fraccionamiento' && (!Number.isInteger(origen_producto_id) || origen_producto_id === producto_id)) throw invalida('El fraccionamiento necesita la pieza de origen, un artículo distinto de la porción.');
  for (const id of [producto_id, origen_producto_id].filter(Boolean)) if (!(await existe('productos', id))) throw invalida(`El artículo ${id} no existe.`, 404);
  await pool.query(
    `INSERT INTO porciones (producto_id, origen_producto_id, porciones_por_pieza, modalidad) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE origen_producto_id = VALUES(origen_producto_id), porciones_por_pieza = VALUES(porciones_por_pieza), modalidad = VALUES(modalidad)`,
    [producto_id, modalidad === 'fraccionamiento' ? origen_producto_id : null, porciones_por_pieza, modalidad]);
  return (await pool.query('SELECT * FROM porciones WHERE producto_id = ?', [producto_id]))[0][0];
};

const quitar = async (producto_id) => (await pool.query('DELETE FROM porciones WHERE producto_id = ?', [producto_id]))[0].affectedRows > 0;

const esPorcion = async (conn, producto_id) => (await conn.query('SELECT 1 FROM porciones WHERE producto_id = ?', [producto_id]))[0].length > 0;

// Ingreso de piezas enteras de un artículo proporcional: entra como N porciones, con el costo de la pieza dividido por N (RF30, RN04).
const ingresarPiezas = async (producto_id, { piezas, costo_pieza, deposito_id, lote, proveedor, comprobante }, { userId } = {}) => {
  const [[cfg]] = await pool.query("SELECT porciones_por_pieza FROM porciones WHERE producto_id = ? AND modalidad = 'proporcional'", [producto_id]);
  if (!cfg) throw invalida('El artículo no se vende por porción proporcional.', 409);
  if (!(Number(piezas) > 0)) throw invalida('Las piezas deben ser mayor que cero.');
  return Mov.ingresar({ deposito_id, motivo: 'compra', proveedor, comprobante, lineas: [{ item: { tipo: 'producto', id: producto_id }, cantidad: Number(piezas) * cfg.porciones_por_pieza,
    costo_unitario: costo_pieza === undefined ? undefined : redondear(Number(costo_pieza) / cfg.porciones_por_pieza), lote }] }, { userId });
};

// Orden de fraccionamiento: egresa las piezas (por lote, FEFO) e ingresa N porciones por pieza con el lote y el vencimiento de la pieza,
// vinculado a ella, y con el costo de la pieza dividido por las porciones (RN78).
const fraccionar = async ({ producto_id, piezas, deposito_id }, { userId } = {}) => {
  if (!(Number(piezas) > 0)) throw invalida('Las piezas a fraccionar deben ser mayor que cero.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[cfg]] = await conn.query("SELECT * FROM porciones WHERE producto_id = ? AND modalidad = 'fraccionamiento'", [producto_id]);
    if (!cfg) throw invalida('El artículo no se vende por porción con fraccionamiento.', 409);
    const dep = deposito_id ? await Deposito.getById(deposito_id, conn) : await Deposito.getPredeterminado(conn);
    if (!dep?.activo) throw invalida('El depósito no existe o está inactivo.');
    const pieza = { tipo: 'producto', id: cfg.origen_producto_id };
    const porcion = { tipo: 'producto', id: producto_id };
    await exigirLibre(conn, 'producto', pieza.id, dep.id);
    await exigirLibre(conn, 'producto', porcion.id, dep.id);
    if ((await Mov.saldo(pieza, dep.id, conn)) < Number(piezas)) throw invalida('No hay piezas suficientes en el depósito.', 409);
    const documento = await idGlobal();
    const base = { deposito_id: dep.id, documento_tipo: 'fraccionamiento', documento, user_id: userId ?? null };
    let costoTotal = 0;
    let conCosto = true;
    for (const a of await Lotes.paraEgreso(conn, pieza, dep.id, Number(piezas))) {
      const e = await Mov.registrar(conn, { ...base, item: pieza, tipo: 'egreso', motivo: 'fraccionamiento', cantidad: -a.cantidad, lote_id: a.lote?.id, origen_lote: a.origen });
      const loteP = a.lote ? await Lotes.paraIngreso(conn, porcion, { codigo: a.lote.codigo, fecha_elaboracion: a.lote.fecha_elaboracion, fecha_vencimiento: a.lote.fecha_vencimiento }) : null;
      if (loteP) await conn.query('UPDATE lotes SET lote_origen_id = ? WHERE id = ?', [a.lote.id, loteP.id]);
      await Mov.registrar(conn, { ...base, item: porcion, tipo: 'ingreso', motivo: 'fraccionamiento_ingreso', cantidad: a.cantidad * cfg.porciones_por_pieza,
        costo_unitario: e.costo_unitario === null ? null : redondear(e.costo_unitario / cfg.porciones_por_pieza), costo_provisorio: e.costo_provisorio, lote_id: loteP?.id });
      if (e.costo_unitario === null) conCosto = false; else costoTotal += a.cantidad * e.costo_unitario;
    }
    const porciones = Number(piezas) * cfg.porciones_por_pieza;
    const [r] = await conn.query('INSERT INTO fraccionamientos (id_global, producto_id, origen_producto_id, piezas, porciones, deposito_id, costo_porcion, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [documento, producto_id, pieza.id, piezas, porciones, dep.id, conCosto ? redondear(costoTotal / porciones) : null, userId ?? null]);
    await conn.commit();
    return (await pool.query('SELECT * FROM fraccionamientos WHERE id = ?', [r.insertId]))[0][0];
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

// ---- Envases por modalidad (RF38) ----
const MODALIDADES = ['salon', 'mostrador', 'para_llevar', 'delivery', 'retiro'];
const fijarEnvase = async ({ producto_id, categoria_id, modalidad, insumo_id, cantidad }) => {
  if (!!producto_id === !!categoria_id) throw invalida('Indicá el artículo o la categoría, no ambos.');
  if (!MODALIDADES.includes(modalidad)) throw invalida(`La modalidad debe ser una de: ${MODALIDADES.join(', ')}.`);
  if (!(Number(cantidad) > 0)) throw invalida('La cantidad de envase debe ser mayor que cero.');
  if (!(await existe('insumos', insumo_id))) throw invalida('El insumo de envase no existe.', 404);
  const alcance = producto_id ? `p:${producto_id}` : `c:${categoria_id}`;
  await pool.query('INSERT INTO envases_modalidad (alcance, modalidad, insumo_id, cantidad) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE insumo_id = VALUES(insumo_id), cantidad = VALUES(cantidad)', [alcance, modalidad, insumo_id, cantidad]);
  return (await pool.query('SELECT * FROM envases_modalidad WHERE alcance = ? AND modalidad = ?', [alcance, modalidad]))[0][0];
};
const envases = async () => (await pool.query('SELECT * FROM envases_modalidad ORDER BY alcance, modalidad'))[0];
const quitarEnvase = async (id) => (await pool.query('DELETE FROM envases_modalidad WHERE id = ?', [id]))[0].affectedRows > 0;

// ---- Insumos por opción de modificador (RF31) ----
const fijarModificador = async (opcion_id, lineas) => {
  if (typeof opcion_id !== 'string' || !opcion_id.trim()) throw invalida('La opción es obligatoria.');
  if (!Array.isArray(lineas)) throw invalida('"lineas" debe ser una lista.');
  for (const l of lineas) {
    if (!['sustituir', 'agregar', 'quitar'].includes(l.accion)) throw invalida('La acción debe ser sustituir, agregar o quitar.');
    const nuevo = l.accion !== 'quitar';
    const viejo = l.accion !== 'agregar';
    if (nuevo && !(Number.isInteger(l.insumo_id) && Number(l.cantidad) > 0)) throw invalida('Falta el insumo y una cantidad mayor que cero.');
    if (viejo && !(Number.isInteger(l.insumo_original_id) && Number(l.cantidad_original) > 0)) throw invalida('Falta el insumo original y su cantidad.');
    for (const id of [nuevo ? l.insumo_id : null, viejo ? l.insumo_original_id : null].filter(Boolean))
      if (!(await existe('insumos', id))) throw invalida(`El insumo ${id} no existe.`, 404);
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM modificador_insumos WHERE opcion_id = ?', [opcion_id]);
    for (const l of lineas)
      await conn.query('INSERT INTO modificador_insumos (opcion_id, accion, insumo_id, cantidad, insumo_original_id, cantidad_original) VALUES (?, ?, ?, ?, ?, ?)',
        [opcion_id, l.accion, l.accion === 'quitar' ? null : l.insumo_id, l.accion === 'quitar' ? null : l.cantidad, l.accion === 'agregar' ? null : l.insumo_original_id, l.accion === 'agregar' ? null : l.cantidad_original]);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return modificador(opcion_id);
};
const modificador = async (opcion_id) => (await pool.query('SELECT * FROM modificador_insumos WHERE opcion_id = ? ORDER BY id', [opcion_id]))[0];

module.exports = { PorcionInvalida, configurar, quitar, esPorcion, ingresarPiezas, fraccionar, fijarEnvase, envases, quitarEnvase, fijarModificador, modificador };
