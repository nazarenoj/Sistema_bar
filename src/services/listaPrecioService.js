const pool = require('../config/db');

// Listas de precios múltiples (Ventas RF34, RF35, RN32, EX23), con VEN-LISTAS. La lista aplicable a un pedido sale de la terminal (o de
// la elección manual con permiso) y, sin ninguna, es la Minorista (precio base del catálogo). El precio de cada ítem se fija al agregarlo
// (RN17) y la lista usada queda en la línea; sin precio en la lista, vencida o inactiva se usa el base y se advierte, sin bloquear la venta.
class ListaInvalida extends Error {}
const invalida = (m, status = 400) => Object.assign(new ListaInvalida(m), { status });
const TIPOS = ['minorista', 'mayorista', 'online', 'personal', 'otra'];
const hoy = () => new Date().toISOString().slice(0, 10);
const dia = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

const enLista = (l) => ({ ...l, es_base: !!l.es_base, activa: !!l.activa, vigente_desde: dia(l.vigente_desde), vigente_hasta: dia(l.vigente_hasta) });
const base = async (conn = pool) => (await conn.query('SELECT * FROM listas_precio WHERE es_base = 1 LIMIT 1'))[0][0];
const obtener = async (id, conn = pool) => {
  const [[l]] = await conn.query('SELECT * FROM listas_precio WHERE id = ?', [id]);
  return l ? enLista(l) : null;
};
const listar = async () => (await pool.query('SELECT * FROM listas_precio ORDER BY es_base DESC, nombre'))[0].map(enLista);

// Una lista sirve si está activa y dentro de su vigencia.
const vigente = (l) => l.activa && (!l.vigente_desde || l.vigente_desde <= hoy()) && (!l.vigente_hasta || l.vigente_hasta >= hoy());

const validar = ({ nombre, tipo, vigente_desde, vigente_hasta }) => {
  if (typeof nombre !== 'string' || !nombre.trim() || nombre.length > 80) throw invalida('El nombre es obligatorio (hasta 80 caracteres).');
  if (tipo !== undefined && !TIPOS.includes(tipo)) throw invalida(`El tipo debe ser uno de: ${TIPOS.join(', ')}.`);
  for (const f of [vigente_desde, vigente_hasta]) if (f && !/^\d{4}-\d{2}-\d{2}$/.test(f)) throw invalida('Las fechas de vigencia van como AAAA-MM-DD.');
  if (vigente_desde && vigente_hasta && vigente_desde > vigente_hasta) throw invalida('La vigencia empieza después de terminar.');
};

const guardar = async (id, datos) => {
  validar(datos);
  try {
    if (id) {
      const l = await obtener(id);
      if (!l) throw invalida('Lista no encontrada.', 404);
      if (l.es_base && (datos.vigente_desde || datos.vigente_hasta)) throw invalida('La lista Minorista no vence.');
      await pool.query('UPDATE listas_precio SET nombre = ?, tipo = ?, vigente_desde = ?, vigente_hasta = ? WHERE id = ?',
        [datos.nombre.trim(), l.es_base ? 'minorista' : datos.tipo ?? l.tipo, datos.vigente_desde ?? null, datos.vigente_hasta ?? null, id]);
      return obtener(id);
    }
    const [r] = await pool.query('INSERT INTO listas_precio (nombre, tipo, vigente_desde, vigente_hasta) VALUES (?, ?, ?, ?)', [datos.nombre.trim(), datos.tipo ?? 'otra', datos.vigente_desde ?? null, datos.vigente_hasta ?? null]);
    return obtener(r.insertId);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida('Ya hay una lista con ese nombre.', 409);
    throw err;
  }
};

const activar = async (id, activa) => {
  const l = await obtener(id);
  if (!l) throw invalida('Lista no encontrada.', 404);
  if (l.es_base && !activa) throw invalida('La lista Minorista es la base y no se desactiva.', 409);
  await pool.query('UPDATE listas_precio SET activa = ? WHERE id = ?', [activa ? 1 : 0, id]);
  return obtener(id);
};

// Precios de una lista (por artículo). `null` en el precio quita el del artículo: vuelve el base.
const fijarPrecios = async (id, precios) => {
  const l = await obtener(id);
  if (!l) throw invalida('Lista no encontrada.', 404);
  if (l.es_base) throw invalida('La lista Minorista usa el precio del catálogo: cambialo desde el catálogo.', 409);
  if (!Array.isArray(precios) || !precios.length) throw invalida('Indicá al menos un precio.');
  for (const p of precios) {
    if (!Number.isInteger(p.producto_id)) throw invalida('Cada precio necesita "producto_id".');
    if (p.precio !== null && !(Number(p.precio) >= 0)) throw invalida('El precio debe ser mayor o igual a cero (o null para quitarlo).');
    if (!(await pool.query('SELECT 1 FROM productos WHERE id = ?', [p.producto_id]))[0].length) throw invalida(`El artículo ${p.producto_id} no existe.`, 404);
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const p of precios) {
      if (p.precio === null) await conn.query('DELETE FROM lista_precio_items WHERE lista_id = ? AND producto_id = ?', [id, p.producto_id]);
      else await conn.query('INSERT INTO lista_precio_items (lista_id, producto_id, precio) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE precio = VALUES(precio)', [id, p.producto_id, p.precio]);
    }
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return precios_de(id);
};
const precios_de = async (id) => (await pool.query(
  'SELECT i.producto_id, p.nombre, i.precio AS precio, p.precio AS precio_base FROM lista_precio_items i JOIN productos p ON p.id = i.producto_id WHERE i.lista_id = ? ORDER BY p.nombre', [id]))[0]
  .map((r) => ({ ...r, precio: Number(r.precio), precio_base: Number(r.precio_base) }));

// Lista de la terminal (RN32 punto 3): null si la terminal no tiene.
const asignarATerminal = async (terminalId, listaId) => {
  if (listaId !== null) { const l = await obtener(listaId); if (!l) throw invalida('Lista no encontrada.', 404); }
  const [r] = await pool.query('UPDATE terminales SET lista_precio_id = ? WHERE id = ?', [listaId, terminalId]);
  if (!r.affectedRows) throw invalida('Terminal no encontrada.', 404);
  return { terminal_id: terminalId, lista_precio_id: listaId };
};

// Al abrir un pedido: la lista de la terminal si sirve y, si no, la Minorista. Devuelve el id.
const alAbrirPedido = async (pedidoId, terminalId, conn = pool) => {
  let lista = null;
  if (terminalId) {
    const [[t]] = await conn.query('SELECT lista_precio_id FROM terminales WHERE id = ?', [terminalId]);
    if (t?.lista_precio_id) { const l = await obtener(t.lista_precio_id, conn); if (l && vigente(l)) lista = l; }
  }
  lista ??= enLista(await base(conn));
  await conn.query('UPDATE pedidos SET lista_precio_id = ? WHERE id = ?', [lista.id, pedidoId]);
  return lista.id;
};

// Elección manual: cambiar la lista de un pedido no toca el precio de los ítems ya agregados (RN17). Con ítems, el llamador exige permiso.
const asignarAPedido = async (pedidoId, listaId) => {
  const l = await obtener(listaId);
  if (!l) throw invalida('Lista no encontrada.', 404);
  if (!vigente(l)) throw invalida(`La lista "${l.nombre}" está inactiva o fuera de vigencia.`, 409);
  const [[p]] = await pool.query("SELECT estado FROM pedidos WHERE id = ?", [pedidoId]);
  if (!p) throw invalida('Pedido no encontrado.', 404);
  if (p.estado !== 'activo') throw invalida('El pedido ya no está abierto.', 409);
  await pool.query('UPDATE pedidos SET lista_precio_id = ? WHERE id = ?', [listaId, pedidoId]);
  return { pedido_id: pedidoId, lista_precio_id: listaId, lista: l.nombre };
};
const itemsDe = async (pedidoId) => Number((await pool.query('SELECT COUNT(*) AS n FROM pedido_productos WHERE pedido_id = ?', [pedidoId]))[0][0].n);

// Precio de un artículo para un pedido: { precio, lista_precio_id, advertencia? }. Sin precio en la lista, o con la lista vencida o inactiva
// (EX23), el precio es el del catálogo, la línea queda en la Minorista y se advierte.
const precioDe = async (conn, pedidoId, productoId, nombre, precioCatalogo) => {
  const b = await base(conn);
  const [[ped]] = await conn.query('SELECT lista_precio_id FROM pedidos WHERE id = ?', [pedidoId]);
  const l = ped?.lista_precio_id ? await obtener(ped.lista_precio_id, conn) : null;
  if (!l || l.es_base) return { precio: precioCatalogo, lista_precio_id: b.id };
  if (!vigente(l)) return { precio: precioCatalogo, lista_precio_id: b.id, advertencia: `La lista "${l.nombre}" está inactiva o vencida: "${nombre}" se cargó al precio base.` };
  const [[i]] = await conn.query('SELECT precio FROM lista_precio_items WHERE lista_id = ? AND producto_id = ?', [l.id, productoId]);
  if (!i) return { precio: precioCatalogo, lista_precio_id: b.id, advertencia: `"${nombre}" no tiene precio en la lista "${l.nombre}": se cargó al precio base.` };
  return { precio: Number(i.precio), lista_precio_id: l.id };
};

module.exports = { ListaInvalida, listar, obtener, guardar, activar, fijarPrecios, preciosDe: precios_de, asignarATerminal, alAbrirPedido, asignarAPedido, itemsDe, precioDe };
