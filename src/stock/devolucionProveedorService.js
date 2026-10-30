const pool = require('../config/db');
const Mov = require('./movimientoService');
const M = require('../mensajeria/servicio');
const { idGlobal } = require('../utils/idGlobal');

// Devolución a proveedor (Stock RF40, RN80, EX58): egreso con el motivo reservado "Devolución a proveedor" que referencia la línea del
// ingreso (y su lote), al costo de ese ingreso y consumiendo su capa. Solo se devuelve lo que sigue en stock y no se devolvió antes.
// Con Compras publica el evento; sin Compras la nota de crédito se carga a mano. Queda "Pendiente de nota de crédito" hasta entonces.
class DevolucionInvalida extends Error {}
const invalida = (m, status = 400, extra = {}) => Object.assign(new DevolucionInvalida(m), { status, ...extra });
const COL = { insumo: 'insumo_id', producto: 'producto_id' };

const devolver = async ({ movimiento_id, cantidad, motivo }, { userId } = {}) => {
  if (!(Number(cantidad) > 0)) throw invalida('La cantidad a devolver debe ser mayor que cero.');
  if (typeof motivo !== 'string' || !motivo.trim()) throw invalida('Indicá el motivo de la devolución.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[o]] = await conn.query('SELECT * FROM stock_movimientos WHERE id = ? FOR UPDATE', [movimiento_id]);
    if (!o || o.tipo !== 'ingreso' || o.documento_tipo !== 'ingreso') throw invalida('Referenciá una línea de un ingreso (EX58).', 404);
    const item = o.insumo_id ? { tipo: 'insumo', id: o.insumo_id } : { tipo: 'producto', id: o.producto_id };
    const [[it]] = await conn.query(`SELECT ${item.tipo === 'producto' ? 'controla_serie,' : ''} nombre FROM ${item.tipo === 'insumo' ? 'insumos' : 'productos'} WHERE id = ?`, [item.id]);
    if (it.controla_serie) throw invalida('Un artículo con series se devuelve por sus series (todavía no soportado acá).', 409);
    const [[{ devuelto }]] = await conn.query('SELECT COALESCE(SUM(cantidad), 0) AS devuelto FROM devoluciones_proveedor WHERE movimiento_id = ?', [movimiento_id]);
    // Lo que sigue en stock: el saldo del lote o, sin lote, el del depósito.
    const [[{ saldo }]] = await conn.query(
      `SELECT COALESCE(SUM(cantidad), 0) AS saldo FROM stock_movimientos WHERE ${COL[item.tipo]} = ? AND deposito_id = ? ${o.lote_id ? 'AND lote_id = ?' : ''}`,
      o.lote_id ? [item.id, o.deposito_id, o.lote_id] : [item.id, o.deposito_id]);
    const devolvible = Math.max(0, Math.min(Number(o.cantidad) - Number(devuelto), Number(saldo)));
    if (Number(cantidad) > devolvible + 1e-9) throw invalida(`Solo se pueden devolver ${devolvible} de ese ingreso: lo demás ya se consumió, se vendió o se devolvió (se regula con la nota de crédito y un ajuste de valuación).`, 409, { devolvible });

    // Estado del costo antes del egreso, para rehacer promedio y último costo (RN80).
    const [[costos]] = await conn.query('SELECT costo_promedio, ultimo_costo FROM stock_costos WHERE item_tipo = ? AND item_id = ?', [item.tipo, item.id]);
    const [[{ total }]] = await conn.query(`SELECT COALESCE(SUM(cantidad), 0) AS total FROM stock_movimientos WHERE ${COL[item.tipo]} = ?`, [item.id]);
    const id_global = await idGlobal();
    const e = await Mov.registrar(conn, { item, deposito_id: o.deposito_id, tipo: 'egreso', motivo: 'devolucion_proveedor', cantidad: -Number(cantidad), costo_unitario: o.costo_unitario,
      lote_id: o.lote_id, origen_lote: o.lote_id ? 'indicado' : undefined, capa_movimiento_id: o.id, documento_tipo: 'devolucion_proveedor', documento: id_global,
      user_id: userId ?? null, observacion: motivo.trim() });
    if (costos && o.costo_unitario !== null) {
      const q = Number(cantidad);
      const costo = Number(o.costo_unitario);
      if (costos.costo_promedio !== null && Number(total) - q > 0)
        await conn.query('UPDATE stock_costos SET costo_promedio = ? WHERE item_tipo = ? AND item_id = ?', [Math.round(((Number(total) * Number(costos.costo_promedio) - q * costo) / (Number(total) - q)) * 10000) / 10000, item.tipo, item.id]);
      // Si lo devuelto era el último ingreso con costo, el último costo vuelve al del ingreso anterior.
      const [[ultimo]] = await conn.query(`SELECT id FROM stock_movimientos WHERE ${COL[item.tipo]} = ? AND tipo = 'ingreso' AND costo_unitario IS NOT NULL ORDER BY id DESC LIMIT 1`, [item.id]);
      if (ultimo?.id === o.id) {
        const [[prev]] = await conn.query(`SELECT costo_unitario FROM stock_movimientos WHERE ${COL[item.tipo]} = ? AND tipo = 'ingreso' AND costo_unitario IS NOT NULL AND id < ? ORDER BY id DESC LIMIT 1`, [item.id, o.id]);
        if (prev && Number(devuelto) + q >= Number(o.cantidad) - 1e-9) await conn.query('UPDATE stock_costos SET ultimo_costo = ? WHERE item_tipo = ? AND item_id = ?', [prev.costo_unitario, item.tipo, item.id]);
      }
    }
    const [[ing]] = await conn.query('SELECT id_global, proveedor FROM stock_ingresos WHERE id_global = ?', [o.documento]);
    const [r] = await conn.query(
      `INSERT INTO devoluciones_proveedor (id_global, movimiento_id, ingreso_id_global, egreso_id, item_tipo, item_id, deposito_id, lote_id, cantidad, costo_unitario, proveedor, motivo, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id_global, o.id, ing?.id_global ?? null, e.id, item.tipo, item.id, o.deposito_id, o.lote_id, cantidad, o.costo_unitario, ing?.proveedor ?? null, motivo.trim(), userId ?? null]);
    await M.publicar(conn, { origen: 'stock', destino: 'compras', tipo: 'devolucion_proveedor', docTipo: 'devolucion_proveedor', docIdGlobal: id_global, userId,
      contenido: { id_egreso_stock: e.id_global, ingreso: ing?.id_global ?? null, item, lote_id: o.lote_id, cantidad: Number(cantidad), costo_unitario: o.costo_unitario === null ? null : Number(o.costo_unitario), proveedor: ing?.proveedor ?? null } });
    await conn.commit();
    return obtener(r.insertId);
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const obtener = async (id) => {
  const [[d]] = await pool.query('SELECT * FROM devoluciones_proveedor WHERE id = ?', [id]);
  if (!d) throw invalida('Devolución no encontrada.', 404);
  return d;
};
const listar = async ({ estado } = {}) => (await pool.query(`SELECT * FROM devoluciones_proveedor ${estado ? 'WHERE estado = ?' : ''} ORDER BY id DESC LIMIT 200`, estado ? [estado] : []))[0];

// Sin Compras, la nota de crédito del proveedor se carga a mano (clase Nota de crédito, clave del comprobante RN09). La diferencia entre su
// importe y el costo devuelto queda a la vista; el ajuste de valuación lo hará quien lleve la contabilidad.
const cargarNotaCredito = async (id, { comprobante, importe }) => {
  const d = await obtener(id);
  if (d.estado === 'con_nc') throw invalida('La devolución ya tiene su nota de crédito.', 409);
  const clave = Mov.claveComprobante(comprobante);
  if (!clave) throw invalida('Falta el comprobante de la nota de crédito (CUIT, clase, tipo, punto de venta y número).');
  if (importe !== undefined && !(Number(importe) >= 0)) throw invalida('El importe debe ser mayor o igual a cero.');
  try {
    await pool.query("UPDATE devoluciones_proveedor SET estado = 'con_nc', nota_credito_clave = ?, nota_credito_importe = ? WHERE id = ?", [clave, importe ?? null, id]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida('Esa nota de crédito ya está cargada en otra devolución.', 409);
    throw err;
  }
  const r = await obtener(id);
  const costo = r.costo_unitario === null ? null : Math.round(Number(r.costo_unitario) * Number(r.cantidad) * 100) / 100;
  return { ...r, diferencia_valuacion: importe === undefined || costo === null ? null : Math.round((Number(importe) - costo) * 100) / 100 };
};

module.exports = { DevolucionInvalida, devolver, obtener, listar, cargarNotaCredito };
