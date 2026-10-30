const pool = require('../config/db');
const Mov = require('./movimientoService');
const { idGlobal } = require('../utils/idGlobal');

// Trazabilidad y retiro de lote (Stock RF21, RF42, RN73, RN83), con las funciones STK-LOTES y STK-TRAZA. La cadena sale de los
// movimientos: una orden de producción consume lotes de insumos e ingresa un lote elaborado (mismo documento); una venta egresa un
// lote. Un retiro bloquea el lote, congela la lista de ventas alcanzadas y lleva el aviso y el recupero de cada línea.
class TrazaInvalida extends Error {}
const invalida = (m, status = 400) => Object.assign(new TrazaInvalida(m), { status });

const PROFUNDIDAD_MAXIMA = 10;
const num = (x) => Number(x);

const loteInfo = async (conn, id) => (await conn.query(
  `SELECT l.id, l.codigo, l.fecha_elaboracion, l.fecha_vencimiento, l.bloqueado, l.insumo_id, l.producto_id, COALESCE(i.nombre, p.nombre) AS item
   FROM lotes l LEFT JOIN insumos i ON i.id = l.insumo_id LEFT JOIN productos p ON p.id = l.producto_id WHERE l.id = ?`, [id]))[0][0] ?? null;

// ---- Hacia arriba: de un lote elaborado a los lotes de insumos que consumió (y su proveedor) ----

const ascendente = async (loteId, conn = pool, nivel = 0, vistos = new Set()) => {
  const lote = await loteInfo(conn, loteId);
  if (!lote) throw invalida('Lote no encontrado.', 404);
  const nodo = { lote, origen: null, insumos: [], incompleto: [] };
  if (nivel > PROFUNDIDAD_MAXIMA || vistos.has(loteId)) return nodo;
  vistos.add(loteId);
  const [ords] = await conn.query("SELECT DISTINCT documento FROM stock_movimientos WHERE lote_id = ? AND motivo = 'produccion' AND documento_tipo = 'orden_produccion'", [loteId]);
  if (ords.length) {
    nodo.origen = { tipo: 'produccion', ordenes: ords.map((o) => o.documento) };
    const [cons] = await conn.query(
      "SELECT id, lote_id FROM stock_movimientos WHERE documento IN (?) AND documento_tipo = 'orden_produccion' AND motivo = 'consumo_produccion'", [ords.map((o) => o.documento)]);
    const idsLote = [...new Set(cons.filter((c) => c.lote_id).map((c) => c.lote_id))];
    nodo.incompleto = cons.filter((c) => !c.lote_id).map((c) => c.id); // movimientos sin lote: la cadena se corta (EX20)
    for (const id of idsLote) nodo.insumos.push(await ascendente(id, conn, nivel + 1, vistos));
  } else {
    const [[ing]] = await conn.query(
      `SELECT si.id_global, si.proveedor, si.comprobante_numero, si.created_at FROM stock_movimientos m JOIN stock_ingresos si ON si.id_global = m.documento
       WHERE m.lote_id = ? AND m.documento_tipo = 'ingreso' ORDER BY m.id LIMIT 1`, [loteId]);
    nodo.origen = ing ? { tipo: 'ingreso', ...ing } : { tipo: 'desconocido' };
  }
  return nodo;
};

// ---- Hacia abajo: de un lote a los elaborados que lo usaron y a las ventas en que salió ----

const ventasDe = async (conn, loteId) => (await conn.query(
  `SELECT m.id AS movimiento_id, m.documento_tipo, m.documento, m.created_at AS fecha, m.deposito_id, d.nombre AS deposito, -m.cantidad AS cantidad, m.origen_lote
   FROM stock_movimientos m JOIN depositos d ON d.id = m.deposito_id WHERE m.lote_id = ? AND m.tipo = 'venta' AND m.cantidad < 0 ORDER BY m.id`, [loteId]))[0]
  .map((v) => ({ ...v, cantidad: num(v.cantidad), no_confirmado: v.origen_lote === 'fefo' }));

const descendente = async (loteId, conn = pool, nivel = 0, vistos = new Set()) => {
  const lote = await loteInfo(conn, loteId);
  if (!lote) throw invalida('Lote no encontrado.', 404);
  const nodo = { lote, ventas: await ventasDe(conn, loteId), elaborados: [] };
  if (nivel > PROFUNDIDAD_MAXIMA || vistos.has(loteId)) return nodo;
  vistos.add(loteId);
  const [ords] = await conn.query("SELECT DISTINCT documento FROM stock_movimientos WHERE lote_id = ? AND documento_tipo = 'orden_produccion' AND motivo = 'consumo_produccion'", [loteId]);
  if (ords.length) {
    const [prod] = await conn.query("SELECT DISTINCT lote_id FROM stock_movimientos WHERE documento IN (?) AND motivo = 'produccion' AND lote_id IS NOT NULL", [ords.map((o) => o.documento)]);
    for (const p of prod) nodo.elaborados.push(await descendente(p.lote_id, conn, nivel + 1, vistos));
  }
  return nodo;
};

const aplanar = (nodo, acum = []) => { acum.push(nodo.lote.id); nodo.elaborados.forEach((e) => aplanar(e, acum)); return acum; };

// EX21: de lo que tuvo el lote, cuánto sigue en stock, se vendió, se consumió en producción o se mermó.
const resumenLote = async (conn, loteId) => {
  const [[r]] = await conn.query(
    `SELECT COALESCE(SUM(m.cantidad), 0) AS en_stock,
            COALESCE(-SUM(CASE WHEN m.tipo = 'venta' THEN m.cantidad END), 0) AS vendidas,
            COALESCE(-SUM(CASE WHEN m.documento_tipo = 'orden_produccion' AND m.cantidad < 0 THEN m.cantidad END), 0) AS consumidas,
            COALESCE(-SUM(CASE WHEN ms.clase_contable = 'merma' AND m.cantidad < 0 THEN m.cantidad END), 0) AS mermadas
     FROM stock_movimientos m LEFT JOIN motivos_stock ms ON ms.codigo = m.motivo WHERE m.lote_id = ?`, [loteId]);
  return { en_stock: num(r.en_stock), vendidas: num(r.vendidas), consumidas: num(r.consumidas), mermadas: num(r.mermadas) };
};

// ---- Retiro de lote ----

const retirar = async (loteId, { motivo, incluir_derivados = false } = {}, { userId } = {}) => {
  if (!String(motivo ?? '').trim()) throw invalida('El motivo del retiro es obligatorio.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const lote = await loteInfo(conn, loteId);
    if (!lote) throw invalida('Lote no encontrado.', 404);
    const lotes = incluir_derivados ? aplanar(await descendente(loteId, conn)) : [loteId];
    const [[ya]] = await conn.query("SELECT r.id FROM retiro_lotes rl JOIN retiros_lote r ON r.id = rl.retiro_id WHERE rl.lote_id IN (?) AND r.estado = 'activo' LIMIT 1", [lotes]);
    if (ya) throw invalida('Uno de los lotes ya está en un retiro activo.', 409);
    const id_global = await idGlobal();
    const [r] = await conn.query('INSERT INTO retiros_lote (id_global, lote_id, motivo, incluye_derivados, user_id) VALUES (?, ?, ?, ?, ?)', [id_global, loteId, String(motivo).trim(), incluir_derivados ? 1 : 0, userId ?? null]);
    for (const id of lotes) {
      await conn.query('INSERT INTO retiro_lotes (retiro_id, lote_id) VALUES (?, ?)', [r.insertId, id]);
      await conn.query('UPDATE lotes SET bloqueado = 1, motivo_bloqueo = ? WHERE id = ?', [`Retiro: ${String(motivo).trim()}`.slice(0, 255), id]);
      for (const v of await ventasDe(conn, id)) {
        await conn.query(
          `INSERT INTO retiro_lineas (retiro_id, lote_id, movimiento_id, documento_tipo, documento, fecha, deposito_id, cantidad, origen_lote, no_confirmado)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [r.insertId, id, v.movimiento_id, v.documento_tipo, v.documento, v.fecha, v.deposito_id, v.cantidad, v.origen_lote, v.no_confirmado ? 1 : 0]);
      }
    }
    await conn.commit();
    return obtener(r.insertId);
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const horasAlerta = async () => num((await pool.query("SELECT valor FROM parametros WHERE clave = 'horas_alerta_aviso_retiro'"))[0][0]?.valor ?? 4);

// El retiro con su alcance: lotes, resumen por lote (EX21) y líneas con el aviso vencido pasadas las horas parametrizadas (RN83).
const obtener = async (id, conn = pool) => {
  const [[ret]] = await conn.query('SELECT r.*, l.codigo AS lote_codigo FROM retiros_lote r JOIN lotes l ON l.id = r.lote_id WHERE r.id = ?', [id]);
  if (!ret) return null;
  const [lotes] = await conn.query('SELECT rl.lote_id FROM retiro_lotes rl WHERE rl.retiro_id = ?', [id]);
  const [lineas] = await conn.query(
    `SELECT li.*, d.nombre AS deposito, l.codigo AS lote FROM retiro_lineas li JOIN depositos d ON d.id = li.deposito_id JOIN lotes l ON l.id = li.lote_id WHERE li.retiro_id = ? ORDER BY li.id`, [id]);
  const limite = Date.now() - (await horasAlerta()) * 3600000;
  const resumen = [];
  for (const l of lotes) resumen.push({ ...(await loteInfo(conn, l.lote_id)), ...(await resumenLote(conn, l.lote_id)) });
  return {
    ...ret, lotes: resumen,
    lineas: lineas.map((li) => ({ ...li, cantidad: num(li.cantidad), cantidad_recuperada: num(li.cantidad_recuperada),
      aviso_vencido: ret.estado === 'activo' && li.estado_aviso === 'pendiente' && new Date(ret.created_at).getTime() < limite })),
  };
};

const listar = async (estado) => (await pool.query(
  `SELECT r.id, r.id_global, r.estado, r.motivo, r.incluye_derivados, r.created_at, l.codigo AS lote_codigo,
          (SELECT COUNT(*) FROM retiro_lineas li WHERE li.retiro_id = r.id) AS lineas
   FROM retiros_lote r JOIN lotes l ON l.id = r.lote_id ${estado ? 'WHERE r.estado = ?' : ''} ORDER BY r.id DESC`, estado ? [estado] : []))[0];

const linea = async (conn, id) => {
  const [[li]] = await conn.query('SELECT li.*, r.estado AS retiro_estado, r.id_global AS retiro_global FROM retiro_lineas li JOIN retiros_lote r ON r.id = li.retiro_id WHERE li.id = ? FOR UPDATE', [id]);
  if (!li) throw invalida('Línea no encontrada.', 404);
  if (li.retiro_estado !== 'activo') throw invalida('El retiro ya fue liberado: el producto sigue las reglas de la devolución común.', 409);
  return li;
};

const avisar = async (lineaId, { userId } = {}) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const li = await linea(conn, lineaId);
    if (li.estado_aviso === 'pendiente') await conn.query("UPDATE retiro_lineas SET estado_aviso = 'avisado', avisado_por = ?, avisado_at = NOW() WHERE id = ?", [userId ?? null, lineaId]);
    await conn.commit();
    return obtener(li.retiro_id);
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

// El producto devuelto se recibe como merma del lote bloqueado: un ingreso y un egreso por "Devolución a merma" (RN83).
const recuperar = async (lineaId, cantidad, { userId } = {}) => {
  if (!(num(cantidad) > 0)) throw invalida('La cantidad recuperada debe ser mayor que cero.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const li = await linea(conn, lineaId);
    if (num(li.cantidad_recuperada) + num(cantidad) > num(li.cantidad)) throw invalida(`No se puede recuperar más de lo alcanzado por la línea (${num(li.cantidad)}).`, 409);
    const [[o]] = await conn.query('SELECT * FROM stock_movimientos WHERE id = ?', [li.movimiento_id]);
    const item = o.insumo_id ? { tipo: 'insumo', id: o.insumo_id } : { tipo: 'producto', id: o.producto_id };
    const comun = { item, deposito_id: o.deposito_id, costo_unitario: o.costo_unitario, costo_provisorio: o.costo_provisorio, lote_id: o.lote_id, documento_tipo: 'retiro_lote', documento: li.retiro_global, user_id: userId };
    await Mov.registrar(conn, { ...comun, tipo: 'ingreso', motivo: 'devolucion', cantidad: num(cantidad), observacion: 'Recupero de retiro de lote' });
    await Mov.registrar(conn, { ...comun, tipo: 'egreso', motivo: 'devolucion_merma', cantidad: -num(cantidad), observacion: 'Recupero de retiro de lote' });
    const total = num(li.cantidad_recuperada) + num(cantidad);
    await conn.query("UPDATE retiro_lineas SET cantidad_recuperada = ?, estado_aviso = ? WHERE id = ?", [total, total >= num(li.cantidad) ? 'recuperado' : li.estado_aviso === 'pendiente' ? 'avisado' : li.estado_aviso, lineaId]);
    await conn.commit();
    return obtener(li.retiro_id);
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const liberar = async (id, motivo, { userId } = {}) => {
  if (!String(motivo ?? '').trim()) throw invalida('El motivo de la liberación es obligatorio.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[r]] = await conn.query('SELECT * FROM retiros_lote WHERE id = ? FOR UPDATE', [id]);
    if (!r) throw invalida('Retiro no encontrado.', 404);
    if (r.estado !== 'activo') throw invalida('El retiro ya fue liberado.', 409);
    await conn.query("UPDATE retiros_lote SET estado = 'liberado', liberado_motivo = ?, liberado_por = ?, liberado_at = NOW() WHERE id = ?", [String(motivo).trim(), userId ?? null, id]);
    await conn.query('UPDATE lotes SET bloqueado = 0, motivo_bloqueo = NULL WHERE id IN (SELECT lote_id FROM retiro_lotes WHERE retiro_id = ?)', [id]);
    await conn.commit();
    return obtener(id);
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

module.exports = { TrazaInvalida, ascendente, descendente, retirar, obtener, listar, avisar, recuperar, liberar };
