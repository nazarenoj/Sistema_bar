const pool = require('../config/db');
const puertos = require('../modulos/puertos');
const llamar = require('../modulos/llamar');
const Funciones = require('../funciones/servicio');

// Alérgenos en Ventas (RF31, RN42), con VEN-ALERGENOS. Los de una línea son la unión de los declarados del artículo, de las opciones
// elegidas y de los componentes de un combo; con Stock y STK-ALERGENOS se suman los derivados por receta (y los del insumo sustituto de una
// opción). Si Stock no responde, la línea muestra los declarados más lo último que Stock calculó, con la marca de pendiente y sin bloquear la venta.
class AlergenoVentaInvalido extends Error {}
const invalido = (m, status = 400) => Object.assign(new AlergenoVentaInvalido(m), { status });
const PROFUNDIDAD = 3;
const LEYENDA_PENDIENTE = 'alérgenos derivados pendientes de calcular';

const catalogo = async (conn = pool) => (await conn.query('SELECT id, codigo, nombre, activo FROM ven_alergenos ORDER BY nombre'))[0].map((a) => ({ ...a, activo: !!a.activo }));

const crear = async ({ codigo, nombre }) => {
  if (!/^[a-z0-9_]{2,40}$/.test(codigo ?? '')) throw invalido('El código admite minúsculas, números y guion bajo (2 a 40).');
  if (typeof nombre !== 'string' || !nombre.trim()) throw invalido('El nombre es obligatorio.');
  try { await pool.query('INSERT INTO ven_alergenos (codigo, nombre) VALUES (?, ?)', [codigo, nombre.trim()]); } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalido('Ya existe un alérgeno con ese código.', 409);
    throw err;
  }
  return (await catalogo()).find((a) => a.codigo === codigo);
};

const activar = async (id, activo) => {
  const [r] = await pool.query('UPDATE ven_alergenos SET activo = ? WHERE id = ?', [activo ? 1 : 0, id]);
  if (!r.affectedRows) throw invalido('Alérgeno no encontrado.', 404);
  return (await catalogo()).find((a) => a.id === id);
};

// Reemplaza lo declarado en un artículo o en una opción de modificador.
const declarar = async (tabla, columna, id, alergenoIds) => {
  if (!Array.isArray(alergenoIds) || alergenoIds.some((x) => !Number.isInteger(x))) throw invalido('"alergenos" debe ser una lista de ids.');
  const [ok] = alergenoIds.length ? await pool.query('SELECT id FROM ven_alergenos WHERE id IN (?) AND activo = 1', [alergenoIds]) : [[]];
  if (ok.length !== new Set(alergenoIds).size) throw invalido('Hay alérgenos que no existen o están desactivados.', 404);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM ${tabla} WHERE ${columna} = ?`, [id]);
    for (const a of new Set(alergenoIds)) await conn.query(`INSERT INTO ${tabla} (${columna}, alergeno_id) VALUES (?, ?)`, [id, a]);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return declaradosDe(tabla, columna, id);
};
const declaradosDe = async (tabla, columna, id, conn = pool) => (await conn.query(
  `SELECT a.codigo, a.nombre FROM ${tabla} t JOIN ven_alergenos a ON a.id = t.alergeno_id WHERE t.${columna} = ? AND a.activo = 1 ORDER BY a.nombre`, [id]))[0];

const declararArticulo = async (productoId, ids) => {
  if (!(await pool.query('SELECT 1 FROM productos WHERE id = ?', [productoId]))[0].length) throw invalido('El artículo no existe.', 404);
  return declarar('ven_articulo_alergenos', 'producto_id', productoId, ids);
};
const declararOpcion = async (opcionId, ids) => {
  if (!(await pool.query('SELECT 1 FROM opciones_modificador WHERE id = ?', [opcionId]))[0].length) throw invalido('La opción no existe.', 404);
  return declarar('ven_opcion_alergenos', 'opcion_id', opcionId, ids);
};

// Lo declarado del artículo y, en un combo, de sus componentes (recursivo).
const declaradosArticulo = async (conn, productoId, nivel = 0) => {
  const acum = new Map((await declaradosDe('ven_articulo_alergenos', 'producto_id', productoId, conn)).map((a) => [a.codigo, a]));
  if (nivel < PROFUNDIDAD) {
    const [comps] = await conn.query('SELECT c.componente_id FROM producto_componentes c JOIN productos p ON p.id = c.combo_id WHERE c.combo_id = ? AND p.tipo = \'combo\'', [productoId]);
    for (const c of comps) for (const a of await declaradosArticulo(conn, c.componente_id, nivel + 1)) acum.set(a.codigo, a);
  }
  return [...acum.values()];
};

// Alérgenos de una línea: { alergenos: [{ codigo, nombre }], pendientes, leyenda }.
const calcularLinea = async (conn, productoId, opcionIds = []) => {
  const acum = new Map();
  const sumar = (lista) => lista.forEach((a) => acum.set(a.codigo, { codigo: a.codigo, nombre: a.nombre }));
  sumar(await declaradosArticulo(conn, productoId));
  for (const o of opcionIds) sumar(await declaradosDe('ven_opcion_alergenos', 'opcion_id', o, conn));
  let pendientes = false;
  if ((await Funciones.estaActiva('STK-ALERGENOS', conn))) {
    // Llamada n.º 4 del registro (puerto de Stock): si no responde, se degrada a lo declarado más lo último calculado.
    const r = await llamar(4, 'ventas', async () => (await puertos.obtener('stock')).alergenosLinea(productoId, [], opcionIds));
    if (r.fallo && !/no instalado/.test(r.motivo ?? '')) pendientes = true;
    else if (!r.fallo && r.valor?.disponible !== false) {
      sumar(r.valor.alergenos);
      await conn.query('INSERT INTO ven_alergenos_derivados (producto_id, alergenos) VALUES (?, ?) ON DUPLICATE KEY UPDATE alergenos = VALUES(alergenos), calculado_at = NOW()',
        [productoId, JSON.stringify(r.valor.alergenos.map((a) => ({ codigo: a.codigo, nombre: a.nombre })))]);
    }
    if (pendientes) {
      const [[c]] = await conn.query('SELECT alergenos FROM ven_alergenos_derivados WHERE producto_id = ?', [productoId]);
      if (c) sumar(JSON.parse(c.alergenos));
    }
  }
  return { alergenos: [...acum.values()].sort((a, b) => a.nombre.localeCompare(b.nombre)), pendientes, ...(pendientes && { leyenda: LEYENDA_PENDIENTE }) };
};

// Menú del POS filtrado por alérgeno: los artículos que no contienen ninguno de los códigos excluidos (RF31).
const menu = async ({ excluir = [] } = {}) => {
  const [productos] = await pool.query('SELECT id, nombre, precio FROM productos WHERE agotado = 0 ORDER BY nombre');
  const salida = [];
  for (const p of productos) {
    const l = await calcularLinea(pool, p.id, []);
    if (l.alergenos.some((a) => excluir.includes(a.codigo))) continue;
    salida.push({ ...p, precio: Number(p.precio), alergenos: l.alergenos, pendientes: l.pendientes });
  }
  return salida;
};

module.exports = { AlergenoVentaInvalido, LEYENDA_PENDIENTE, catalogo, crear, activar, declararArticulo, declararOpcion, declaradosArticulo, calcularLinea, menu };
