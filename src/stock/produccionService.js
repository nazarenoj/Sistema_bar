const pool = require('../config/db');
const Deposito = require('../models/depositoModel');
const Receta = require('./recetaService');
const Costos = require('./costoService');
const Lotes = require('./loteService');
const Mov = require('./movimientoService');
const { exigirLibre } = require('./tomaAlcance');
const { idGlobal } = require('../utils/idGlobal');

// Producción por tanda (Stock RF10, RF11, RF23, RF24, RN15, RN37, RN72). Una orden planifica una cantidad de un elaborado (o el
// armado de un kit), el usuario ajusta lo realmente consumido y, al confirmar, se descuentan los insumos y se ingresa el terminado
// con costo = costo de lo consumido / cantidad producida. El consumo que excede la tolerancia es "Merma de producción", valorizada
// aparte; el desvío dentro de la tolerancia y la merma de cocción quedan en el costo.
class ProduccionInvalida extends Error {}
const invalida = (m, status = 400) => Object.assign(new ProduccionInvalida(m), { status });

const TURNOS = ['manana', 'tarde'];
const redondear = Costos.redondear;
const num = (x) => Number(x);

const tolerancia = async () => num((await pool.query("SELECT valor FROM parametros WHERE clave = 'produccion_tolerancia_pct'"))[0][0]?.valor ?? 5);

const crear = async ({ tipo = 'produccion', producto_id, cantidad, deposito_insumos_id, deposito_destino_id, turno, tolerancia_pct }, { userId } = {}) => {
  if (!['produccion', 'armado'].includes(tipo)) throw invalida('El tipo debe ser "produccion" o "armado".');
  if (!(num(cantidad) > 0)) throw invalida('La cantidad planificada debe ser mayor que cero.');
  if (turno && !TURNOS.includes(turno)) throw invalida('El turno debe ser "manana" o "tarde".');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.query('SELECT id, tipo FROM productos WHERE id = ?', [producto_id]);
    if (!p) throw invalida('El producto no existe.', 404);
    if (tipo === 'produccion' && p.tipo !== 'elaborado') throw invalida('Solo se produce un artículo elaborado.');
    if (tipo === 'armado' && p.tipo !== 'combo') throw invalida('Solo se arma un combo (kit).');
    const hojas = await Receta.hojas(conn, p.id, num(cantidad), new Map(), 0, true);
    if (hojas.size === 1 && hojas.has(`producto:${p.id}`)) throw invalida('El artículo no tiene receta ni componentes cargados.');
    const dep = async (id) => { const d = id ? await Deposito.getById(id, conn) : await Deposito.getPredeterminado(conn); if (!d?.activo) throw invalida('El depósito no existe o está inactivo.'); return d.id; };
    const ins = await dep(deposito_insumos_id);
    const dest = await dep(deposito_destino_id);
    const id_global = await idGlobal();
    const [r] = await conn.query(
      `INSERT INTO ordenes_produccion (id_global, tipo, producto_id, cantidad_planificada, deposito_insumos_id, deposito_destino_id, turno, tolerancia_pct, creada_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id_global, tipo, p.id, num(cantidad), ins, dest, turno ?? null, tolerancia_pct ?? await tolerancia(), userId ?? null]);
    for (const [k, q] of hojas) {
      const [t, id] = k.split(':');
      await conn.query('INSERT INTO orden_consumos (orden_id, item_tipo, item_id, cantidad_teorica, cantidad_real) VALUES (?, ?, ?, ?, ?)', [r.insertId, t, Number(id), q, q]);
    }
    await conn.commit();
    return obtener(r.insertId);
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const obtener = async (id, conn = pool) => {
  const [[o]] = await conn.query(
    `SELECT o.*, p.nombre AS producto FROM ordenes_produccion o JOIN productos p ON p.id = o.producto_id WHERE o.id = ?`, [id]);
  if (!o) return null;
  const [consumos] = await conn.query(
    `SELECT c.item_tipo, c.item_id, c.cantidad_teorica, c.cantidad_real, COALESCE(i.nombre, p.nombre) AS nombre
     FROM orden_consumos c LEFT JOIN insumos i ON c.item_tipo = 'insumo' AND i.id = c.item_id LEFT JOIN productos p ON c.item_tipo = 'producto' AND p.id = c.item_id
     WHERE c.orden_id = ? ORDER BY c.id`, [id]);
  return { ...o, consumos: consumos.map((c) => ({ ...c, cantidad_teorica: num(c.cantidad_teorica), cantidad_real: num(c.cantidad_real) })) };
};

const listar = async ({ estado } = {}) => (await pool.query(
  `SELECT o.id, o.id_global, o.tipo, o.estado, o.producto_id, p.nombre AS producto, o.cantidad_planificada, o.cantidad_real, o.rendimiento_pct, o.turno, o.created_at
   FROM ordenes_produccion o JOIN productos p ON p.id = o.producto_id ${estado ? 'WHERE o.estado = ?' : ''} ORDER BY o.id DESC`, estado ? [estado] : []))[0];

// Lo realmente consumido por ítem, antes de confirmar: [{ item_tipo, item_id, cantidad_real }].
const ajustar = async (id, consumos) => {
  if (!Array.isArray(consumos) || !consumos.length) throw invalida('Indicá los consumos a ajustar.');
  const o = await obtener(id);
  if (!o) throw invalida('Orden no encontrada.', 404);
  if (o.estado !== 'borrador') throw invalida('Solo se ajusta una orden en borrador.', 409);
  for (const c of consumos) {
    if (!(num(c.cantidad_real) >= 0)) throw invalida('El consumo real no puede ser negativo.');
    const [r] = await pool.query('UPDATE orden_consumos SET cantidad_real = ? WHERE orden_id = ? AND item_tipo = ? AND item_id = ?', [num(c.cantidad_real), id, c.item_tipo, c.item_id]);
    if (!r.affectedRows) throw invalida(`El ítem ${c.item_tipo} ${c.item_id} no forma parte de la orden.`);
  }
  return obtener(id);
};

// Confirma la tanda en una sola transacción: descuenta, valoriza e ingresa el terminado.
const confirmar = async (id, { cantidad_real, peso_crudo, peso_final, lote_codigo } = {}, { userId } = {}) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[o]] = await conn.query('SELECT * FROM ordenes_produccion WHERE id = ? FOR UPDATE', [id]);
    if (!o) throw invalida('Orden no encontrada.', 404);
    if (o.estado !== 'borrador') throw invalida('La orden ya fue confirmada o cancelada.', 409);
    const producida = num(cantidad_real ?? o.cantidad_planificada);
    if (!(producida > 0)) throw invalida('La cantidad real producida debe ser mayor que cero.');
    const [consumos] = await conn.query('SELECT * FROM orden_consumos WHERE orden_id = ? ORDER BY id', [id]);
    const factor = producida / num(o.cantidad_planificada); // lo esperado se mide contra lo realmente producido
    let total = 0;
    let merma = 0;
    let parcial = 0;
    const base = { deposito_id: o.deposito_insumos_id, tipo: 'egreso', documento_tipo: 'orden_produccion', documento: o.id_global, user_id: userId };
    for (const c of consumos) {
      const item = { tipo: c.item_tipo, id: c.item_id };
      await exigirLibre(conn, item.tipo, item.id, o.deposito_insumos_id);
      const real = num(c.cantidad_real);
      const esperado = num(c.cantidad_teorica) * factor;
      const exceso = real - esperado;
      const fuera = exceso > esperado * num(o.tolerancia_pct) / 100 ? exceso : 0; // fuera de tolerancia: merma valorizada (RN72)
      for (const [cant, motivo] of [[real - fuera, 'consumo_produccion'], [fuera, 'merma_produccion']]) {
        if (!(cant > 0)) continue;
        for (const a of await Lotes.paraEgreso(conn, item, o.deposito_insumos_id, cant)) {
          const m = await Mov.registrar(conn, { ...base, item, motivo, cantidad: -a.cantidad, lote_id: a.lote?.id, origen_lote: a.origen });
          if (m.costo_unitario === null) { parcial = 1; continue; }
          const valor = a.cantidad * m.costo_unitario;
          if (motivo === 'merma_produccion') merma += valor; else total += valor;
        }
      }
    }
    const [[p]] = await conn.query('SELECT costo_adicional FROM productos WHERE id = ?', [o.producto_id]);
    total += num(p.costo_adicional) * producida; // costos adicionales por unidad (RN37)
    const unitario = redondear(total / producida);
    const item = { tipo: 'producto', id: o.producto_id };
    await exigirLibre(conn, 'producto', o.producto_id, o.deposito_destino_id);
    const codigo = lote_codigo ?? `P${o.id}`;
    const lote = await Lotes.paraIngreso(conn, item, { codigo, fecha_elaboracion: new Date().toISOString().slice(0, 10) });
    await Mov.registrar(conn, { item, deposito_id: o.deposito_destino_id, tipo: 'ingreso', motivo: 'produccion', cantidad: producida, costo_unitario: parcial ? null : unitario,
      lote_id: lote?.id, documento_tipo: 'orden_produccion', documento: o.id_global, user_id: userId });
    const merma_coccion = num(peso_crudo) > 0 && peso_final != null ? redondear((peso_crudo - peso_final) / peso_crudo * 100) : null;
    await conn.query(
      `UPDATE ordenes_produccion SET estado = 'confirmada', cantidad_real = ?, peso_crudo = ?, peso_final = ?, costo_total = ?, costo_unitario = ?, costo_parcial = ?, merma_valorizada = ?,
         rendimiento_pct = ?, merma_coccion_pct = ?, lote_codigo = ?, confirmada_por = ?, confirmada_at = NOW() WHERE id = ?`,
      [producida, peso_crudo ?? null, peso_final ?? null, redondear(total), unitario, parcial, redondear(merma), redondear(producida / num(o.cantidad_planificada) * 100), merma_coccion,
        lote?.codigo ?? null, userId ?? null, id]);
    await conn.commit();
    return obtener(id);
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const cancelar = async (id) => {
  const [r] = await pool.query("UPDATE ordenes_produccion SET estado = 'cancelada' WHERE id = ? AND estado = 'borrador'", [id]);
  return r.affectedRows > 0;
};

// Rendimiento teórico vs real por producto en un período (RF23).
const informe = async ({ desde, hasta } = {}) => {
  const donde = ["o.estado = 'confirmada'"];
  const params = [];
  if (desde) { donde.push('o.confirmada_at >= ?'); params.push(`${desde} 00:00:00`); }
  if (hasta) { donde.push('o.confirmada_at <= ?'); params.push(`${hasta} 23:59:59`); }
  const [rows] = await pool.query(
    `SELECT o.producto_id, p.nombre AS producto, COUNT(*) AS tandas, SUM(o.cantidad_planificada) AS planificado, SUM(o.cantidad_real) AS producido,
            AVG(o.rendimiento_pct) AS rendimiento_pct, AVG(o.merma_coccion_pct) AS merma_coccion_pct, SUM(o.merma_valorizada) AS merma_valorizada
     FROM ordenes_produccion o JOIN productos p ON p.id = o.producto_id WHERE ${donde.join(' AND ')} GROUP BY o.producto_id, p.nombre ORDER BY p.nombre`, params);
  return rows.map((r) => ({ ...r, planificado: num(r.planificado), producido: num(r.producido), rendimiento_pct: redondear(num(r.rendimiento_pct)),
    merma_coccion_pct: r.merma_coccion_pct === null ? null : redondear(num(r.merma_coccion_pct)), merma_valorizada: num(r.merma_valorizada) }));
};

// Ficha técnica (RF24): componentes, procedimiento, rendimiento, porción, conservación, costo de receta y margen teórico.
const fichaTecnica = async (productoId) => {
  const [[p]] = await pool.query('SELECT id, nombre, tipo, precio, modo_produccion, costo_adicional, procedimiento, peso_porcion, conservacion, vida_util_dias FROM productos WHERE id = ?', [productoId]);
  if (!p) return null;
  const receta = await Receta.obtener(productoId);
  let costo = 0;
  let parcial = false;
  for (const [k, q] of await Receta.hojas(pool, productoId, 1, new Map(), 0, true)) {
    const [tipo, id] = k.split(':');
    const c = await Costos.costoActual({ tipo, id: Number(id) });
    if (c.costo === null) parcial = true; else costo += q * c.costo;
  }
  costo += num(p.costo_adicional);
  const [[r]] = await pool.query("SELECT AVG(rendimiento_pct) AS rend FROM ordenes_produccion WHERE producto_id = ? AND estado = 'confirmada'", [productoId]);
  const precio = num(p.precio);
  return { producto: p, componentes: receta.lineas, rendimiento_real_pct: r.rend === null ? null : redondear(num(r.rend)),
    costo_receta: redondear(costo), costo_parcial: parcial, precio, margen_teorico: redondear(precio - costo), margen_teorico_pct: precio > 0 ? redondear((precio - costo) / precio * 100) : null };
};

// Datos propios de la ficha y modo de producción del elaborado.
const configurar = async (productoId, c) => {
  if (c.modo_produccion !== undefined && !['venta', 'previa'].includes(c.modo_produccion)) throw invalida('El modo de producción debe ser "venta" o "previa".');
  if (c.costo_adicional !== undefined && !(num(c.costo_adicional) >= 0)) throw invalida('El costo adicional debe ser mayor o igual a cero.');
  const campos = ['modo_produccion', 'costo_adicional', 'procedimiento', 'peso_porcion', 'conservacion'].filter((k) => c[k] !== undefined);
  if (!campos.length) throw invalida('No hay nada para cambiar.');
  const [r] = await pool.query(`UPDATE productos SET ${campos.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...campos.map((k) => c[k]), productoId]);
  if (!r.affectedRows) throw invalida('El producto no existe.', 404);
  return fichaTecnica(productoId);
};

module.exports = { ProduccionInvalida, crear, obtener, listar, ajustar, confirmar, cancelar, informe, fichaTecnica, configurar };
