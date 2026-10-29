const pool = require('../config/db');
const { idGlobal } = require('../utils/idGlobal');
const { auditar } = require('../utils/auditar');

// Comandas (Ventas RF07, RN11, RN69, EX08): cada envío de ítems a producción genera una comanda por sector de
// destino, según el sector del artículo. Un combo se descompone en sus componentes, cada uno a su sector.
class ComandaInvalida extends Error {}

const PROFUNDIDAD = 3; // los combos no se anidan más de 3 niveles (B1)

// Un ítem del pedido a [{ producto_id, nombre, cantidad, sector_id }]: el producto, o sus componentes si es un combo.
const expandir = async (conn, productoId, nombre, cantidad, nivel = 0) => {
  const [[p]] = await conn.query('SELECT id, nombre, tipo, sector_id FROM productos WHERE id = ?', [productoId]);
  if (!p || p.tipo !== 'combo' || nivel >= PROFUNDIDAD) return [{ producto_id: productoId, nombre, cantidad, sector_id: p?.sector_id ?? null }];
  const [componentes] = await conn.query('SELECT componente_id, cantidad FROM producto_componentes WHERE combo_id = ?', [productoId]);
  if (!componentes.length) return [{ producto_id: productoId, nombre, cantidad, sector_id: p.sector_id }];
  const lineas = [];
  for (const c of componentes) {
    const [[hijo]] = await conn.query('SELECT nombre FROM productos WHERE id = ?', [c.componente_id]);
    lineas.push(...await expandir(conn, c.componente_id, hijo.nombre, cantidad * Number(c.cantidad), nivel + 1));
  }
  return lineas;
};

// Envía a producción los ítems todavía no enviados de una mesa: una comanda por sector, todas con el mismo `envio`.
const enviar = async (mesaId, { userId } = {}) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[mesa]] = await conn.query('SELECT id FROM mesas WHERE id = ? FOR UPDATE', [mesaId]);
    if (!mesa) throw Object.assign(new ComandaInvalida('Mesa no encontrada.'), { status: 404 });
    const [items] = await conn.query(
      `SELECT pp.id, pp.pedido_id, pp.producto_id, pp.nombre, pp.cantidad, pp.observaciones, p.sesion_apertura, p.modalidad, p.referencia, p.mozo_id
       FROM pedido_productos pp JOIN pedidos p ON p.id = pp.pedido_id
       WHERE p.mesa_id = ? AND p.estado = 'activo' AND pp.enviado_at IS NULL ORDER BY pp.id`, [mesaId]);
    if (!items.length) throw new ComandaInvalida('No hay ítems nuevos para enviar a producción.');

    const porSector = new Map(); // sector_id (o null) -> líneas
    for (const it of items)
      for (const l of await expandir(conn, it.producto_id, it.nombre, it.cantidad)) {
        const k = l.sector_id ?? 'sin';
        if (!porSector.has(k)) porSector.set(k, []);
        porSector.get(k).push({ ...l, pedido_producto_id: it.id, pedido_id: it.pedido_id, observaciones: it.observaciones });
      }

    const envio = await idGlobal();
    const cab = items[0];
    const comandas = [];
    for (const [k, lineas] of porSector) {
      const id_global = await idGlobal();
      const [r] = await conn.query(
        'INSERT INTO comandas (id_global, envio, mesa_id, sesion_apertura, sector_id, modalidad, referencia, mozo_id, creado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id_global, envio, mesaId, cab.sesion_apertura, k === 'sin' ? null : k, cab.modalidad, cab.referencia, cab.mozo_id, userId ?? null]);
      for (const l of lineas)
        await conn.query('INSERT INTO comanda_items (comanda_id, pedido_producto_id, pedido_id, producto_id, nombre, cantidad, observaciones) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [r.insertId, l.pedido_producto_id, l.pedido_id, l.producto_id, l.nombre, l.cantidad, l.observaciones]);
      comandas.push(r.insertId);
    }
    await conn.query(`UPDATE pedido_productos SET enviado_at = NOW() WHERE id IN (${items.map(() => '?').join(',')})`, items.map((i) => i.id));
    await conn.commit();
    return { envio, comandas: await Promise.all(comandas.map(obtener)) };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const obtener = async (id) => {
  const [[c]] = await pool.query(
    `SELECT c.*, s.nombre AS sector, m.numero_mesa FROM comandas c LEFT JOIN sectores_comanda s ON s.id = c.sector_id JOIN mesas m ON m.id = c.mesa_id WHERE c.id = ?`, [id]);
  if (!c) return null;
  const [items] = await pool.query('SELECT nombre, cantidad, observaciones, pedido_id FROM comanda_items WHERE comanda_id = ? ORDER BY id', [id]);
  return { ...c, items };
};

// Cola de una terminal: las que aún no se imprimieron (EX08), por sector. `todas` incluye las ya impresas.
const listar = async ({ sector_id, estado, pendientes, mesa_id } = {}) => {
  const donde = [];
  const params = [];
  if (sector_id !== undefined) { donde.push(sector_id === 'sin' ? 'c.sector_id IS NULL' : 'c.sector_id = ?'); if (sector_id !== 'sin') params.push(sector_id); }
  if (estado) { donde.push('c.estado = ?'); params.push(estado); }
  if (pendientes === '1') donde.push("c.impresa_at IS NULL AND c.estado = 'emitida'");
  if (mesa_id) { donde.push('c.mesa_id = ?'); params.push(mesa_id); }
  const [ids] = await pool.query(`SELECT c.id FROM comandas c ${donde.length ? `WHERE ${donde.join(' AND ')}` : ''} ORDER BY c.id DESC LIMIT 200`, params);
  return Promise.all(ids.map((r) => obtener(r.id)));
};

const marcarImpresa = async (id) => (await pool.query('UPDATE comandas SET impresa_at = COALESCE(impresa_at, NOW()) WHERE id = ?', [id]))[0].affectedRows > 0;

const exigirMotivo = (motivo) => {
  if (typeof motivo !== 'string' || !motivo.trim()) throw new ComandaInvalida('El motivo es obligatorio.');
  return motivo.trim().slice(0, 255);
};

// Reimprimir (queda auditado) y redirigir a otro sector (la impresora del sector falló, EX08).
const reimprimir = async (id, motivo, actor) => {
  const m = exigirMotivo(motivo);
  const c = await obtener(id);
  if (!c) return null;
  if (c.estado === 'anulada') throw new ComandaInvalida('La comanda está anulada.');
  await pool.query('UPDATE comandas SET reimpresiones = reimpresiones + 1 WHERE id = ?', [id]);
  await auditar(null, { modulo: 'ventas', accion: 'comanda_reimpresa', entidad: 'comanda', entidad_id: c.id_global, detalle: m }, actor);
  return obtener(id);
};

const redirigir = async (id, sectorId, motivo, actor) => {
  const m = exigirMotivo(motivo);
  const c = await obtener(id);
  if (!c) return null;
  if (c.estado === 'anulada') throw new ComandaInvalida('La comanda está anulada.');
  const [[s]] = await pool.query('SELECT id, nombre FROM sectores_comanda WHERE id = ? AND activo = 1', [sectorId]);
  if (!s) throw new ComandaInvalida('El sector indicado no existe o está inactivo.');
  await pool.query('UPDATE comandas SET sector_id = ?, impresa_at = NULL WHERE id = ?', [s.id, id]); // vuelve a la cola, ahora del otro sector
  await auditar(null, { modulo: 'ventas', accion: 'comanda_redirigida', entidad: 'comanda', entidad_id: c.id_global, detalle: `${c.sector ?? 'sin sector'} -> ${s.nombre}: ${m}` }, actor);
  return obtener(id);
};

const anular = async (id, motivo, actor) => {
  const m = exigirMotivo(motivo);
  const c = await obtener(id);
  if (!c) return null;
  if (c.estado === 'anulada') throw new ComandaInvalida('La comanda ya está anulada.');
  await pool.query("UPDATE comandas SET estado = 'anulada', motivo_anulacion = ?, anulada_por = ?, anulada_at = NOW() WHERE id = ?", [m, actor?.id ?? null, id]);
  await auditar(null, { modulo: 'ventas', accion: 'comanda_anulada', entidad: 'comanda', entidad_id: c.id_global, detalle: m }, actor);
  return obtener(id);
};

module.exports = { enviar, obtener, listar, marcarImpresa, reimprimir, redirigir, anular, ComandaInvalida };
