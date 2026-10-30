const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const Funciones = require('../funciones/servicio');
const { hojasDeLinea } = require('./lineaVentaService');
const { idGlobal } = require('../utils/idGlobal');

// Ítems agotados automáticos (Stock RF32), con VEN-KDS: cuando un artículo se queda sin lo necesario para venderse (existencias de algún
// insumo de su receta menores o iguales al umbral, o a lo que pide una unidad), Stock avisa a Ventas por mensaje (dentro de la misma
// transacción del movimiento, así sale en la próxima vuelta del trabajador, 2 s) y quita la marca al reponerse. Informa a la cocina:
// no bloquea ninguna venta (RN01). shortcut: mira las existencias físicas totales del ítem, no el disponible por depósito; si hace falta
// por depósito, pasar el depósito del sector del artículo.

// Qué le falta a un artículo para una unidad: true si algún ítem que controla stock y no admite negativo no alcanza.
const sinStock = async (conn, productoId, umbral) => {
  for (const [k, q] of await hojasDeLinea(conn, { producto_id: productoId, cantidad: 1 })) {
    const [tipo, id] = k.split(':');
    const [[f]] = await conn.query(`SELECT stock, controla_stock, permite_negativo${tipo === 'producto' ? ', tipo' : ''} FROM ${tipo === 'insumo' ? 'insumos' : 'productos'} WHERE id = ?`, [id]);
    if (!f || !f.controla_stock || f.permite_negativo || f.tipo === 'servicio') continue;
    if (Number(f.stock) <= umbral || Number(f.stock) < q) return true;
  }
  return false;
};

// Reevalúa los artículos que pueden depender de `item` (o todos, sin `item`) y avisa de los que cambiaron.
const evaluar = async (conn, item = null) => {
  const [[u]] = await conn.query("SELECT valor FROM parametros WHERE clave = 'agotado_umbral'");
  const umbral = Number(u?.valor ?? 0);
  const [candidatos] = await conn.query(
    "SELECT id, EXISTS(SELECT 1 FROM item_agotado a WHERE a.producto_id = productos.id) AS previo FROM productos WHERE tipo IN ('elaborado', 'combo') OR id IN (SELECT producto_id FROM porciones) OR id = ? OR controla_stock = 1", [item?.tipo === 'producto' ? item.id : 0]);
  let cambios = 0;
  for (const p of candidatos) {
    if (item) { // solo los que usan el ítem que se movió
      const hojas = await hojasDeLinea(conn, { producto_id: p.id, cantidad: 1 });
      if (!hojas.has(`${item.tipo}:${item.id}`)) continue;
    }
    const agotado = await sinStock(conn, p.id, umbral);
    if (agotado === !!p.previo) continue;
    if (agotado) await conn.query('INSERT IGNORE INTO item_agotado (producto_id) VALUES (?)', [p.id]); else await conn.query('DELETE FROM item_agotado WHERE producto_id = ?', [p.id]);
    await M.publicar(conn, { origen: 'stock', destino: 'ventas', tipo: 'disponibilidad_item', docTipo: 'disponibilidad', docIdGlobal: await idGlobal(), contenido: { producto_id: p.id, agotado } });
    cambios++;
  }
  return cambios;
};

// Lo llama el registro de movimientos: si la función no está activa no hace nada.
const alCambiar = async (conn, item) => {
  if (!(await Funciones.estaActiva('VEN-KDS', conn))) return 0;
  return evaluar(conn, item);
};

// Para el trabajo periódico y la activación de la función: recalcula todo.
const evaluarTodos = async () => {
  if (!(await Funciones.estaActiva('VEN-KDS'))) return 0;
  const conn = await pool.getConnection();
  try { await conn.beginTransaction(); const n = await evaluar(conn); await conn.commit(); return n; } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

module.exports = { evaluar, alCambiar, evaluarTodos };
