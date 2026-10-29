const pool = require('../config/db');
const Deposito = require('../models/depositoModel');
const Presentacion = require('../models/presentacionModel');
const { idGlobal } = require('../utils/idGlobal');

// Movimientos y kardex (Stock RF04, RF12, RF13, RF18, RN02). Todo cambio de existencias es un movimiento de solo
// agregar; el saldo sale de sumarlos y un error se corrige con un movimiento inverso que referencia al original.
// `insumos.stock` y `productos.stock` son un total derivado: un trigger impide tocarlos si no es desde `registrar`.
class MovimientoInvalido extends Error {}
const invalido = (m, status = 400) => Object.assign(new MovimientoInvalido(m), { status });

const TABLA = { insumo: 'insumos', producto: 'productos' };
const COL = { insumo: 'insumo_id', producto: 'producto_id' };

const itemValido = async (conn, item) => {
  if (!item || !TABLA[item.tipo] || !Number.isInteger(item.id)) throw invalido('Ítem inválido: indicá { tipo: "insumo" | "producto", id }.');
  const [[fila]] = await conn.query(`SELECT * FROM ${TABLA[item.tipo]} WHERE id = ?`, [item.id]);
  if (!fila) throw invalido(`El ${item.tipo} ${item.id} no existe.`, 404);
  return fila;
};

// Registra un movimiento y actualiza el total del ítem, en la transacción de `conn`. `cantidad` va con signo y en
// la unidad base. Es la única vía para cambiar existencias.
const registrar = async (conn, m) => {
  const cantidad = Number(m.cantidad);
  if (!Number.isFinite(cantidad) || cantidad === 0) throw invalido('La cantidad del movimiento no puede ser cero.');
  await itemValido(conn, m.item);
  const deposito = m.deposito_id ?? (await Deposito.getPredeterminado(conn)).id;
  const id_global = await idGlobal();
  const [r] = await conn.query(
    `INSERT INTO stock_movimientos (id_global, ${COL[m.item.tipo]}, deposito_id, tipo, motivo, cantidad, costo_unitario, presentacion_id, factor_aplicado,
       cantidad_presentacion, documento_tipo, documento, movimiento_original_id, user_id, observacion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id_global, m.item.id, deposito, m.tipo, m.motivo, cantidad, m.costo_unitario ?? null, m.presentacion_id ?? null, m.factor_aplicado ?? null,
      m.cantidad_presentacion ?? null, m.documento_tipo ?? null, m.documento ?? null, m.movimiento_original_id ?? null, m.user_id ?? null, m.observacion ?? null]);
  await conn.query('SET @chepola_mov = 1');
  try {
    await conn.query(`UPDATE ${TABLA[m.item.tipo]} SET stock = stock + ? WHERE id = ?`, [cantidad, m.item.id]);
  } finally {
    await conn.query('SET @chepola_mov = 0');
  }
  return { id: r.insertId, id_global };
};

const conTransaccion = async (fn) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const r = await fn(conn);
    await conn.commit();
    return r;
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

// Saldo inicial al crear un ítem con existencias (el campo stock ya no se carga a mano).
const saldoInicial = async (item, cantidad, conn, userId = null) => {
  if (!(Number(cantidad) > 0)) return null;
  const c = conn ?? pool;
  return conn
    ? registrar(c, { item, tipo: 'ajuste', motivo: 'saldo_inicial', cantidad, documento_tipo: 'inicial', user_id: userId })
    : conTransaccion((cx) => registrar(cx, { item, tipo: 'ajuste', motivo: 'saldo_inicial', cantidad, documento_tipo: 'inicial', user_id: userId }));
};

// ---- Venta y devolución (el cierre de cuenta descuenta; la devolución reingresa) ----

// Una línea [{ producto_id, cantidad }] a movimientos: el producto en sí y los insumos de su receta, en el depósito
// del sector de comanda del producto (RF03). Cada línea de receta puede venir en otra presentación (factor_aplicado).
const movimientosDeVenta = async (conn, items) => {
  const salida = [];
  for (const { producto_id, cantidad } of items) {
    const [[p]] = await conn.query('SELECT sector_id FROM productos WHERE id = ?', [producto_id]);
    const deposito = await Deposito.depositoDeSector(p?.sector_id ?? null, conn);
    salida.push({ item: { tipo: 'producto', id: producto_id }, deposito_id: deposito.id, cantidad });
    const [receta] = await conn.query('SELECT insumo_id, cantidad_consumida * COALESCE(factor_aplicado, 1) AS consumo FROM producto_insumos WHERE producto_id = ?', [producto_id]);
    for (const l of receta) salida.push({ item: { tipo: 'insumo', id: l.insumo_id }, deposito_id: deposito.id, cantidad: cantidad * Number(l.consumo) });
  }
  return salida;
};

const aplicarVenta = async (items, conn, ctx = {}, signo) => {
  for (const l of await movimientosDeVenta(conn, items))
    await registrar(conn, {
      item: l.item, deposito_id: l.deposito_id, tipo: signo < 0 ? 'venta' : 'devolucion', motivo: signo < 0 ? 'venta' : 'devolucion_venta',
      cantidad: signo * l.cantidad, documento_tipo: ctx.documento_tipo ?? null, documento: ctx.documento ?? null, user_id: ctx.user_id ?? null,
    });
};
const descontarPorVenta = (items, conn, ctx) => aplicarVenta(items, conn, ctx, -1);
const reingresarPorDevolucion = (items, conn, ctx) => aplicarVenta(items, conn, ctx, 1);

// ---- Ingreso manual (RF04) ----

const motivoDe = async (conn, codigo, tipo) => {
  const [[m]] = await conn.query('SELECT * FROM motivos_stock WHERE codigo = ? AND tipo = ? AND activo = 1', [codigo, tipo]);
  if (!m) throw invalido(`El motivo "${codigo}" no existe o no es un motivo de ${tipo}.`);
  return m;
};

// Cantidad de la línea en unidad base; con presentación, ID y factor quedan guardados (RF02).
const lineaABase = async (conn, l, uso) => {
  if (!(Number(l.cantidad) > 0)) throw invalido('La cantidad de cada línea debe ser mayor que cero.');
  if (!l.presentacion_id) return { cantidad: Number(l.cantidad) };
  if (l.item.tipo !== 'insumo') throw invalido('Solo los insumos tienen presentaciones.');
  const p = await Presentacion.getById(l.presentacion_id, conn);
  const vigente = p && (!p.vigente_hasta || new Date(p.vigente_hasta) > new Date());
  if (!p || p.insumo_id !== l.item.id || !vigente || !String(p.usos).split(',').includes(uso)) throw invalido(`La presentación debe ser una presentación vigente de uso "${uso}" de ese ítem.`);
  return { cantidad: Presentacion.aBase(p, l.cantidad), presentacion_id: p.id, factor_aplicado: p.factor, cantidad_presentacion: Number(l.cantidad) };
};

const claveComprobante = (c) => (c?.numero ? [c.cuit, c.clase, c.tipo, c.punto_venta, c.numero].map((x) => String(x ?? '').trim().toUpperCase()).join('-') : null);

const ingresar = async ({ deposito_id, motivo, proveedor, comprobante, lineas, observacion }, { userId } = {}) => {
  if (!Array.isArray(lineas) || !lineas.length) throw invalido('Indicá al menos una línea.');
  return conTransaccion(async (conn) => {
    const m = await motivoDe(conn, motivo, 'ingreso');
    if (m.requiere_observacion && !String(observacion ?? '').trim()) throw invalido(`El motivo "${m.nombre}" exige una observación.`);
    const dep = deposito_id ? await Deposito.getById(deposito_id, conn) : await Deposito.getPredeterminado(conn);
    if (!dep || !dep.activo) throw invalido('El depósito no existe o está inactivo.');
    const clave = claveComprobante(comprobante);
    const id_global = await idGlobal();
    try {
      await conn.query(
        `INSERT INTO stock_ingresos (id_global, deposito_id, motivo, proveedor, comprobante_cuit, comprobante_clase, comprobante_tipo, comprobante_pto, comprobante_numero, comprobante_cae, clave_comprobante, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id_global, dep.id, m.codigo, proveedor ?? null, comprobante?.cuit ?? null, comprobante?.clase ?? null, comprobante?.tipo ?? null, comprobante?.punto_venta ?? null, comprobante?.numero ?? null, comprobante?.cae ?? null, clave, userId ?? null]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw invalido('Ese comprobante de origen ya fue registrado: un ingreso físico se registra una sola vez.', 409);
      throw err;
    }
    const movs = [];
    for (const l of lineas) {
      await itemValido(conn, l.item);
      if (l.costo_unitario !== undefined && l.costo_unitario !== null && !(Number(l.costo_unitario) >= 0)) throw invalido('El costo unitario debe ser mayor o igual a cero.');
      const base = await lineaABase(conn, l, 'compra');
      movs.push(await registrar(conn, { item: l.item, deposito_id: dep.id, tipo: 'ingreso', motivo: m.codigo, cantidad: base.cantidad, costo_unitario: l.costo_unitario, presentacion_id: base.presentacion_id,
        factor_aplicado: base.factor_aplicado, cantidad_presentacion: base.cantidad_presentacion, documento_tipo: 'ingreso', documento: id_global, user_id: userId, observacion }));
    }
    return { id_global, deposito_id: dep.id, motivo: m.codigo, movimientos: movs };
  });
};

// ---- Egreso por motivo (RF12) ----

// El motivo pide o no autorización (la valida la ruta) y observación. Los reservados los usan otras funciones del sistema.
const motivoDeEgreso = async (codigo) => {
  const [[m]] = await pool.query("SELECT * FROM motivos_stock WHERE codigo = ? AND tipo = 'egreso' AND activo = 1", [codigo]);
  if (!m) throw invalido(`El motivo "${codigo}" no existe o no es un motivo de egreso.`);
  return m;
};

const egresar = async ({ deposito_id, motivo, observacion, lineas }, { userId, manual = true } = {}) => {
  if (!Array.isArray(lineas) || !lineas.length) throw invalido('Indicá al menos una línea.');
  return conTransaccion(async (conn) => {
    const m = await motivoDe(conn, motivo, 'egreso');
    if (manual && m.reservado) throw invalido(`El motivo "${m.nombre}" es del sistema y no se usa en un egreso manual.`);
    if (m.requiere_observacion && !String(observacion ?? '').trim()) throw invalido(`El motivo "${m.nombre}" exige una observación.`);
    const dep = deposito_id ? await Deposito.getById(deposito_id, conn) : await Deposito.getPredeterminado(conn);
    if (!dep || !dep.activo) throw invalido('El depósito no existe o está inactivo.');
    const documento = await idGlobal();
    const movs = [];
    for (const l of lineas) {
      await itemValido(conn, l.item);
      const base = await lineaABase(conn, l, 'receta');
      movs.push(await registrar(conn, { item: l.item, deposito_id: dep.id, tipo: 'egreso', motivo: m.codigo, cantidad: -base.cantidad, presentacion_id: base.presentacion_id,
        factor_aplicado: base.factor_aplicado, cantidad_presentacion: base.cantidad_presentacion, documento_tipo: 'egreso', documento, user_id: userId, observacion }));
    }
    return { documento, deposito_id: dep.id, motivo: m.codigo, clase_contable: m.clase_contable, movimientos: movs };
  });
};

// ---- Transferencia entre depósitos (RF13): un solo documento, egreso del origen e ingreso en el destino ----

const transferir = async ({ origen_id, destino_id, lineas, observacion }, { userId } = {}) => {
  if (!Array.isArray(lineas) || !lineas.length) throw invalido('Indicá al menos una línea.');
  if (!Number.isInteger(origen_id) || !Number.isInteger(destino_id) || origen_id === destino_id) throw invalido('El origen y el destino deben ser dos depósitos distintos.');
  return conTransaccion(async (conn) => {
    for (const id of [origen_id, destino_id]) {
      const d = await Deposito.getById(id, conn);
      if (!d || !d.activo) throw invalido(`El depósito ${id} no existe o está inactivo.`);
    }
    const documento = await idGlobal();
    const movs = [];
    for (const l of lineas) {
      await itemValido(conn, l.item);
      const base = await lineaABase(conn, l, 'fraccionamiento').catch(() => lineaABase(conn, l, 'receta'));
      const comun = { item: l.item, tipo: 'transferencia', motivo: 'transferencia', documento_tipo: 'transferencia', documento, user_id: userId, observacion, costo_unitario: l.costo_unitario };
      movs.push(await registrar(conn, { ...comun, deposito_id: origen_id, cantidad: -base.cantidad }));
      movs.push(await registrar(conn, { ...comun, deposito_id: destino_id, cantidad: base.cantidad }));
    }
    return { documento, origen_id, destino_id, movimientos: movs };
  });
};

// ---- Corrección: un movimiento inverso que referencia al original (RN02) ----

const corregir = async (movimientoId, observacion, { userId } = {}) => {
  if (!String(observacion ?? '').trim()) throw invalido('El motivo de la corrección es obligatorio.');
  return conTransaccion(async (conn) => {
    const [[o]] = await conn.query('SELECT * FROM stock_movimientos WHERE id = ? FOR UPDATE', [movimientoId]);
    if (!o) throw invalido('Movimiento no encontrado.', 404);
    if (o.movimiento_original_id) throw invalido('Una corrección no se vuelve a corregir: registrá un movimiento nuevo.');
    const [[ya]] = await conn.query('SELECT id FROM stock_movimientos WHERE movimiento_original_id = ?', [o.id]);
    if (ya) throw invalido('Ese movimiento ya fue corregido.', 409);
    const item = o.insumo_id ? { tipo: 'insumo', id: o.insumo_id } : { tipo: 'producto', id: o.producto_id };
    return registrar(conn, { item, deposito_id: o.deposito_id, tipo: 'correccion', motivo: 'correccion', cantidad: -Number(o.cantidad), costo_unitario: o.costo_unitario,
      presentacion_id: o.presentacion_id, factor_aplicado: o.factor_aplicado, cantidad_presentacion: o.cantidad_presentacion ? -Number(o.cantidad_presentacion) : null,
      documento_tipo: o.documento_tipo, documento: o.documento, movimiento_original_id: o.id, user_id: userId, observacion });
  });
};

// ---- Consultas (RF18) ----

const colItem = (tipo) => COL[tipo] ?? null;

// Saldo de un ítem, sumando movimientos (en un depósito, o en todos).
const saldo = async (item, deposito_id, conn = pool) => {
  const [[r]] = await conn.query(`SELECT COALESCE(SUM(cantidad), 0) AS saldo FROM stock_movimientos WHERE ${COL[item.tipo]} = ? ${deposito_id ? 'AND deposito_id = ?' : ''}`, deposito_id ? [item.id, deposito_id] : [item.id]);
  return Number(r.saldo);
};

// Existencias por ítem y depósito (físico). Reservado y comprometido llegan con C5.
const existencias = async ({ deposito_id, tipo } = {}) => {
  const donde = [];
  const params = [];
  if (deposito_id) { donde.push('m.deposito_id = ?'); params.push(deposito_id); }
  const filtro = donde.length ? `WHERE ${donde.join(' AND ')}` : '';
  const filas = [];
  for (const t of tipo ? [tipo] : ['insumo', 'producto']) {
    const [rows] = await pool.query(
      `SELECT '${t}' AS tipo, x.id AS item_id, x.nombre, ${t === 'insumo' ? 'x.unidad' : "'unidad'"} AS unidad, d.id AS deposito_id, d.nombre AS deposito, SUM(m.cantidad) AS fisico
       FROM stock_movimientos m JOIN ${TABLA[t]} x ON x.id = m.${COL[t]} JOIN depositos d ON d.id = m.deposito_id ${filtro ? `${filtro} AND` : 'WHERE'} m.${COL[t]} IS NOT NULL
       GROUP BY x.id, x.nombre, d.id, d.nombre ${t === 'insumo' ? ', x.unidad' : ''} ORDER BY x.nombre, d.nombre`, params);
    filas.push(...rows.map((r) => ({ ...r, fisico: Number(r.fisico) })));
  }
  return filas;
};

// Kardex de un ítem: sus movimientos con el saldo corrido (RF18).
const kardex = async ({ item, deposito_id, desde, hasta }) => {
  await itemValido(pool, item);
  const donde = [`m.${COL[item.tipo]} = ?`];
  const params = [item.id];
  if (deposito_id) { donde.push('m.deposito_id = ?'); params.push(deposito_id); }
  const [filas] = await pool.query(
    `SELECT m.id, m.id_global, m.created_at, m.tipo, m.motivo, m.cantidad, m.costo_unitario, m.deposito_id, d.nombre AS deposito, m.documento_tipo, m.documento,
            m.movimiento_original_id, m.user_id, m.observacion, SUM(m.cantidad) OVER (ORDER BY m.id) AS saldo
     FROM stock_movimientos m JOIN depositos d ON d.id = m.deposito_id WHERE ${donde.join(' AND ')} ORDER BY m.id`, params);
  const dentro = filas.filter((f) => (!desde || new Date(f.created_at) >= new Date(`${desde} 00:00:00`)) && (!hasta || new Date(f.created_at) <= new Date(`${hasta} 23:59:59`)));
  return dentro.map((f) => ({ ...f, cantidad: Number(f.cantidad), saldo: Number(f.saldo) }));
};

// Egresos por motivo de clase "merma" (incluye la merma de fin de día), RF18.
const mermas = async ({ desde, hasta } = {}) => {
  const donde = ["m.tipo = 'egreso'", "ms.clase_contable = 'merma'"];
  const params = [];
  if (desde) { donde.push('m.created_at >= ?'); params.push(`${desde} 00:00:00`); }
  if (hasta) { donde.push('m.created_at <= ?'); params.push(`${hasta} 23:59:59`); }
  const [rows] = await pool.query(
    `SELECT m.motivo, ms.nombre AS motivo_nombre, COUNT(*) AS movimientos, -SUM(m.cantidad) AS cantidad FROM stock_movimientos m JOIN motivos_stock ms ON ms.codigo = m.motivo
     WHERE ${donde.join(' AND ')} GROUP BY m.motivo, ms.nombre ORDER BY cantidad DESC`, params);
  return rows.map((r) => ({ ...r, cantidad: Number(r.cantidad) }));
};

// Una presentación con movimientos no se edita (RN61): se crea una versión nueva.
Presentacion.registrarDetectorUso(async (id) => (await pool.query('SELECT 1 FROM stock_movimientos WHERE presentacion_id = ? LIMIT 1', [id]))[0].length > 0);

module.exports = { MovimientoInvalido, registrar, saldoInicial, descontarPorVenta, reingresarPorDevolucion, ingresar, egresar, transferir, corregir, saldo, existencias, kardex, mermas, motivoDeEgreso, colItem };
