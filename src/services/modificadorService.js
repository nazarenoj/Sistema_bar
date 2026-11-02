const pool = require('../config/db');

// Modificadores y opciones del producto (Ventas RF30, RN41, EX31), con VEN-MODIF. Un grupo se aplica a artículos o categorías, es
// obligatorio u opcional con mínimo y máximo de selecciones, y cada opción ajusta el precio. El ajuste se congela al agregar el ítem.
class ModificadorInvalido extends Error {}
const invalido = (m, status = 400) => Object.assign(new ModificadorInvalido(m), { status });
const entero = (x) => Number.isInteger(x) && x >= 0;

const validar = async ({ nombre, obligatorio = false, minimo, maximo = null, opciones, aplica_a }) => {
  if (typeof nombre !== 'string' || !nombre.trim() || nombre.length > 80) throw invalido('El nombre del grupo es obligatorio (hasta 80 caracteres).');
  const min = minimo ?? (obligatorio ? 1 : 0);
  if (!entero(min)) throw invalido('El mínimo debe ser un entero mayor o igual a cero.');
  if (obligatorio && min < 1) throw invalido('Un grupo obligatorio exige al menos una opción.');
  if (maximo !== null && (!entero(maximo) || maximo < 1 || maximo < min)) throw invalido('El máximo debe ser un entero mayor que cero y no menor que el mínimo.');
  if (!Array.isArray(opciones) || !opciones.length) throw invalido('El grupo necesita al menos una opción.');
  for (const o of opciones) {
    if (typeof o.nombre !== 'string' || !o.nombre.trim() || o.nombre.length > 80) throw invalido('Cada opción necesita un nombre (hasta 80 caracteres).');
    if (o.ajuste_precio !== undefined && !Number.isFinite(Number(o.ajuste_precio))) throw invalido(`El ajuste de "${o.nombre}" debe ser un número (puede ser negativo o cero).`);
  }
  if (min > opciones.filter((o) => o.activo !== false).length) throw invalido('El mínimo supera la cantidad de opciones activas.');
  if (!Array.isArray(aplica_a) || !aplica_a.length) throw invalido('Indicá a qué artículos o categorías se aplica el grupo.');
  for (const a of aplica_a) {
    if (!!a.producto_id === !!a.categoria_id) throw invalido('Cada alcance es un artículo o una categoría, no ambos.');
    const [filas] = a.producto_id ? await pool.query('SELECT 1 FROM productos WHERE id = ?', [a.producto_id]) : await pool.query('SELECT 1 FROM categorias_producto WHERE id = ?', [a.categoria_id]);
    if (!filas.length) throw invalido(`El ${a.producto_id ? 'artículo' : 'la categoría'} ${a.producto_id ?? a.categoria_id} no existe.`, 404);
  }
  return { min };
};

const guardarHijos = async (conn, id, { opciones, aplica_a }) => {
  await conn.query('DELETE FROM grupo_modificador_alcance WHERE grupo_id = ?', [id]);
  for (const a of aplica_a) await conn.query('INSERT INTO grupo_modificador_alcance (grupo_id, producto_id, categoria_id) VALUES (?, ?, ?)', [id, a.producto_id ?? null, a.categoria_id ?? null]);
  // Las opciones ya usadas en pedidos no se borran: las que no vienen se desactivan, las que traen id se actualizan.
  const mantener = [];
  let orden = 0;
  for (const o of opciones) {
    orden++;
    if (o.id) {
      const [r] = await conn.query('UPDATE opciones_modificador SET nombre = ?, ajuste_precio = ?, activo = ?, orden = ? WHERE id = ? AND grupo_id = ?', [o.nombre.trim(), o.ajuste_precio ?? 0, o.activo === false ? 0 : 1, orden, o.id, id]);
      if (!r.affectedRows) throw invalido(`La opción ${o.id} no es de este grupo.`, 404);
      mantener.push(o.id);
    } else {
      const [r] = await conn.query('INSERT INTO opciones_modificador (grupo_id, nombre, ajuste_precio, activo, orden) VALUES (?, ?, ?, ?, ?)', [id, o.nombre.trim(), o.ajuste_precio ?? 0, o.activo === false ? 0 : 1, orden]);
      mantener.push(r.insertId);
    }
  }
  await conn.query(`UPDATE opciones_modificador SET activo = 0 WHERE grupo_id = ? ${mantener.length ? `AND id NOT IN (${mantener.map(() => '?').join(',')})` : ''}`, [id, ...mantener]);
};

const guardar = async (id, datos) => {
  const { min } = await validar(datos);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (id) {
      const [r] = await conn.query('UPDATE grupos_modificador SET nombre = ?, obligatorio = ?, minimo = ?, maximo = ? WHERE id = ?', [datos.nombre.trim(), datos.obligatorio ? 1 : 0, min, datos.maximo ?? null, id]);
      if (!r.affectedRows) throw invalido('Grupo no encontrado.', 404);
    } else {
      const [r] = await conn.query('INSERT INTO grupos_modificador (nombre, obligatorio, minimo, maximo) VALUES (?, ?, ?, ?)', [datos.nombre.trim(), datos.obligatorio ? 1 : 0, min, datos.maximo ?? null]);
      id = r.insertId;
    }
    await guardarHijos(conn, id, datos);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') throw invalido('Ya hay un grupo con ese nombre.', 409);
    throw err;
  } finally { conn.release(); }
  return obtener(id);
};

const obtener = async (id, conn = pool) => {
  const [[g]] = await conn.query('SELECT * FROM grupos_modificador WHERE id = ?', [id]);
  if (!g) return null;
  const [opciones] = await conn.query('SELECT id, nombre, ajuste_precio, activo, orden FROM opciones_modificador WHERE grupo_id = ? ORDER BY orden, id', [id]);
  const [aplica_a] = await conn.query('SELECT producto_id, categoria_id FROM grupo_modificador_alcance WHERE grupo_id = ?', [id]);
  return { ...g, obligatorio: !!g.obligatorio, activo: !!g.activo, opciones: opciones.map((o) => ({ ...o, ajuste_precio: Number(o.ajuste_precio), activo: !!o.activo })), aplica_a };
};

const listar = async () => Promise.all((await pool.query('SELECT id FROM grupos_modificador ORDER BY nombre'))[0].map((r) => obtener(r.id)));

const activar = async (id, activo) => {
  const [r] = await pool.query('UPDATE grupos_modificador SET activo = ? WHERE id = ?', [activo ? 1 : 0, id]);
  if (!r.affectedRows) throw invalido('Grupo no encontrado.', 404);
  return obtener(id);
};

// Grupos activos que se aplican a un artículo (los suyos o los de su categoría), con sus opciones activas.
const paraProducto = async (productoId, conn = pool) => {
  const [ids] = await conn.query(
    `SELECT DISTINCT g.id FROM grupos_modificador g JOIN grupo_modificador_alcance a ON a.grupo_id = g.id
     WHERE g.activo = 1 AND (a.producto_id = ? OR a.categoria_id = (SELECT categoria_id FROM productos WHERE id = ?)) ORDER BY g.id`, [productoId, productoId]);
  const grupos = [];
  for (const { id } of ids) { const g = await obtener(id, conn); grupos.push({ ...g, opciones: g.opciones.filter((o) => o.activo) }); }
  return grupos;
};

// Valida lo elegido para un artículo y devuelve las opciones con su ajuste. El máximo se respeta siempre; el mínimo de un grupo
// obligatorio no impide agregar el ítem: impide enviarlo a comanda (EX31), y se completa después.
const resolver = async (conn, productoId, opcionIds) => {
  const ids = [...new Set(opcionIds)];
  if (ids.length !== opcionIds.length) throw invalido('Una opción no puede repetirse.');
  const grupos = await paraProducto(productoId, conn);
  const porId = new Map(grupos.flatMap((g) => g.opciones.map((o) => [o.id, { ...o, grupo_id: g.id }])));
  const elegidas = ids.map((id) => {
    const o = porId.get(id);
    if (!o) throw invalido(`La opción ${id} no existe, está inactiva o no se aplica a este artículo.`);
    return o;
  });
  for (const g of grupos) {
    const n = elegidas.filter((o) => o.grupo_id === g.id).length;
    if (g.maximo !== null && n > g.maximo) throw invalido(`El grupo "${g.nombre}" admite hasta ${g.maximo} opción(es).`);
  }
  return elegidas.map((o) => ({ opcion_id: o.id, grupo_id: o.grupo_id, nombre: o.nombre, ajuste_precio_aplicado: o.ajuste_precio }));
};

// Grupos obligatorios que le faltan a un ítem del pedido para poder enviarse a comanda: [{ grupo, minimo, elegidas }].
const faltantes = async (conn, itemId, productoId) => {
  const grupos = (await paraProducto(productoId, conn)).filter((g) => g.obligatorio || g.minimo > 0);
  if (!grupos.length) return [];
  const [elegidas] = await conn.query('SELECT grupo_id, COUNT(*) AS n FROM pedido_item_modificadores WHERE item_id = ? GROUP BY grupo_id', [itemId]);
  const n = new Map(elegidas.map((e) => [e.grupo_id, Number(e.n)]));
  return grupos.filter((g) => (n.get(g.id) ?? 0) < g.minimo).map((g) => ({ grupo_id: g.id, grupo: g.nombre, minimo: g.minimo, elegidas: n.get(g.id) ?? 0 }));
};

// Reemplaza las opciones de un ítem del pedido que todavía no se envió a comanda (completar un grupo obligatorio, cambiar una elección):
// el precio del ítem se recalcula sobre el que tenía sin los ajustes anteriores.
const asignarAItem = async (itemId, opcionIds) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[it]] = await conn.query(
      "SELECT pp.id, pp.producto_id, pp.precio_unitario, pp.enviado_at, p.estado FROM pedido_productos pp JOIN pedidos p ON p.id = pp.pedido_id WHERE pp.id = ? FOR UPDATE", [itemId]);
    if (!it) throw invalido('Ítem no encontrado.', 404);
    if (it.estado !== 'activo') throw invalido('El pedido ya no está abierto.', 409);
    if (it.enviado_at) throw invalido('El ítem ya se envió a comanda: quitalo y cargalo de nuevo.', 409);
    const nuevas = await resolver(conn, it.producto_id, opcionIds);
    const [[{ viejo }]] = await conn.query('SELECT COALESCE(SUM(ajuste_precio_aplicado), 0) AS viejo FROM pedido_item_modificadores WHERE item_id = ?', [itemId]);
    await conn.query('DELETE FROM pedido_item_modificadores WHERE item_id = ?', [itemId]);
    for (const m of nuevas) await conn.query('INSERT INTO pedido_item_modificadores (item_id, opcion_id, grupo_id, nombre, ajuste_precio_aplicado) VALUES (?, ?, ?, ?, ?)', [itemId, m.opcion_id, m.grupo_id, m.nombre, m.ajuste_precio_aplicado]);
    const precio = Math.round((Number(it.precio_unitario) - Number(viejo) + nuevas.reduce((a, m) => a + Number(m.ajuste_precio_aplicado), 0)) * 100) / 100;
    await conn.query('UPDATE pedido_productos SET precio_unitario = ? WHERE id = ?', [precio, itemId]);
    const f = await faltantes(conn, itemId, it.producto_id);
    await conn.commit();
    return { item_id: itemId, precio_unitario: precio, modificadores: nuevas, faltan: f };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

module.exports = { ModificadorInvalido, asignarAItem, guardar, obtener, listar, activar, paraProducto, resolver, faltantes };
