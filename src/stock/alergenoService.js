const pool = require('../config/db');

// Alérgenos (Stock RF22, RF39, RN33, RN34, RN77). Se declaran por insumo o artículo ("contiene" / "trazas"); los de un elaborado
// o combo se derivan de su receta y sub-recetas al consultar (así siempre están al día, RN34). "Contiene" prevalece sobre "trazas".
// Un ítem sin alérgenos declarados y sin revisar deja la receta o la línea "incompleta" (EX22); eso no bloquea la venta.
class AlergenoInvalido extends Error {}
const invalido = (m, status = 400) => Object.assign(new AlergenoInvalido(m), { status });

const TIPOS = ['contiene', 'trazas'];
const TABLA = { insumo: 'insumos', producto: 'productos' };
const PROFUNDIDAD_MAXIMA = 8;

// ---- Catálogo ----

const catalogo = async () => (await pool.query('SELECT id, codigo, nombre, activo FROM alergenos ORDER BY nombre'))[0];

const crear = async ({ codigo, nombre }) => {
  const c = String(codigo ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_]{2,40}$/.test(c) || !String(nombre ?? '').trim()) throw invalido('Indicá un código (letras, números y guion bajo) y un nombre.');
  try {
    const [r] = await pool.query('INSERT INTO alergenos (codigo, nombre) VALUES (?, ?)', [c, String(nombre).trim()]);
    return { id: r.insertId, codigo: c, nombre: String(nombre).trim(), activo: 1 };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalido('Ya existe un alérgeno con ese código.', 409);
    throw err;
  }
};

const activar = async (id, activo) => (await pool.query('UPDATE alergenos SET activo = ? WHERE id = ?', [activo ? 1 : 0, id]))[0].affectedRows > 0;

// ---- Declaración por ítem ----

// Reemplaza lo declarado del ítem y lo marca revisado; una lista vacía declara "sin alérgenos".
const declarar = async (item, declaraciones) => {
  if (!TABLA[item?.tipo] || !Number.isInteger(item.id)) throw invalido('Ítem inválido.');
  if (!Array.isArray(declaraciones)) throw invalido('Indicá la lista de alérgenos.');
  for (const d of declaraciones) if (!TIPOS.includes(d.tipo)) throw invalido('El tipo debe ser "contiene" o "trazas".');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[fila]] = await conn.query(`SELECT id FROM ${TABLA[item.tipo]} WHERE id = ? FOR UPDATE`, [item.id]);
    if (!fila) throw invalido('El ítem no existe.', 404);
    for (const d of declaraciones) {
      const [[a]] = await conn.query('SELECT id FROM alergenos WHERE id = ? AND activo = 1', [d.alergeno_id]);
      if (!a) throw invalido(`El alérgeno ${d.alergeno_id} no existe o está inactivo.`);
    }
    await conn.query('DELETE FROM item_alergenos WHERE item_tipo = ? AND item_id = ?', [item.tipo, item.id]);
    for (const d of declaraciones) await conn.query('INSERT INTO item_alergenos (item_tipo, item_id, alergeno_id, tipo) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE tipo = VALUES(tipo)', [item.tipo, item.id, d.alergeno_id, d.tipo]);
    await conn.query(`UPDATE ${TABLA[item.tipo]} SET alergenos_revisado = 1 WHERE id = ?`, [item.id]);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return declarados(item);
};

const declarados = async (item, conn = pool) => (await conn.query(
  `SELECT a.id AS alergeno_id, a.codigo, a.nombre, ia.tipo FROM item_alergenos ia JOIN alergenos a ON a.id = ia.alergeno_id
   WHERE ia.item_tipo = ? AND ia.item_id = ? AND a.activo = 1 ORDER BY a.nombre`, [item.tipo, item.id]))[0];

const revisado = async (conn, item) => !!(await conn.query(`SELECT alergenos_revisado AS r FROM ${TABLA[item.tipo]} WHERE id = ?`, [item.id]))[0][0]?.r;

// ---- Derivación (RN33) ----

// Suma `lista` al acumulado: contiene prevalece sobre trazas y se guardan todos los orígenes.
const sumar = (acum, lista, origen) => {
  for (const a of lista) {
    const e = acum.get(a.alergeno_id) ?? { alergeno_id: a.alergeno_id, codigo: a.codigo, nombre: a.nombre, tipo: 'trazas', origenes: new Set() };
    if (a.tipo === 'contiene') e.tipo = 'contiene';
    e.origenes.add(origen);
    acum.set(a.alergeno_id, e);
  }
};

// Un ítem hoja (insumo, o artículo sin composición): lo declarado; sin nada y sin revisar queda como faltante.
const hoja = async (conn, item, nombre, acum, faltantes, origen) => {
  const d = await declarados(item, conn);
  sumar(acum, d, origen);
  if (!d.length && !(await revisado(conn, item))) faltantes.add(nombre);
};

const nombreDe = async (conn, item) => (await conn.query(`SELECT nombre FROM ${TABLA[item.tipo]} WHERE id = ?`, [item.id]))[0][0]?.nombre ?? `${item.tipo} ${item.id}`;

const derivar = async (conn, productoId, nivel = 0) => {
  if (nivel > PROFUNDIDAD_MAXIMA) throw invalido('La receta es demasiado profunda o tiene un ciclo.');
  const [[p]] = await conn.query('SELECT id, nombre, tipo FROM productos WHERE id = ?', [productoId]);
  if (!p) throw invalido('El artículo no existe.', 404);
  const acum = new Map();
  const faltantes = new Set();
  const propio = { tipo: 'producto', id: p.id };
  const hijos = async (filas) => {
    for (const f of filas) {
      if (f.insumo_id) await hoja(conn, { tipo: 'insumo', id: f.insumo_id }, await nombreDe(conn, { tipo: 'insumo', id: f.insumo_id }), acum, faltantes, 'derivado');
      else {
        const r = await derivar(conn, f.componente_producto_id ?? f.componente_id, nivel + 1);
        sumar(acum, r.alergenos, 'derivado');
        r.faltantes.forEach((x) => faltantes.add(x));
      }
    }
  };
  let compuesto = false;
  if (p.tipo === 'combo') {
    const [comps] = await conn.query('SELECT componente_id FROM producto_componentes WHERE combo_id = ?', [p.id]);
    compuesto = comps.length > 0;
    await hijos(comps);
  } else if (p.tipo === 'elaborado') {
    const [ls] = await conn.query('SELECT insumo_id, componente_producto_id FROM producto_insumos WHERE producto_id = ?', [p.id]);
    compuesto = ls.length > 0;
    await hijos(ls);
  }
  // Lo declarado a mano en el artículo se suma (RN33: se pueden agregar). Sin composición, el artículo es una hoja.
  if (compuesto) sumar(acum, await declarados(propio, conn), 'declarado');
  else await hoja(conn, propio, p.nombre, acum, faltantes, 'declarado');
  // Un derivado solo se quita con permiso y motivo auditado (RN33): lo quitado no figura.
  const [quitados] = await conn.query('SELECT alergeno_id FROM alergenos_quitados WHERE producto_id = ?', [p.id]);
  for (const q of quitados) acum.delete(q.alergeno_id);
  return { alergenos: [...acum.values()], faltantes };
};

const salida = (r, extra = {}) => ({
  alergenos: r.alergenos.map((a) => ({ ...a, origenes: [...a.origenes] })).sort((x, y) => x.nombre.localeCompare(y.nombre)),
  incompletos: r.faltantes.size > 0, faltantes: [...r.faltantes], ...extra,
});

// Alérgenos de un artículo (declarados + derivados).
const articulo = async (productoId, conn = pool) => salida(await derivar(conn, productoId));

// Alérgenos de una línea de venta (RF39): el artículo más las opciones elegidas ({ insumo_id } sustituto o agregado, RN77).
// Una sustitución no quita los del artículo base. Las porciones heredan del origen en C15.
const linea = async (productoId, opciones = [], conn = pool) => {
  const r = await derivar(conn, productoId);
  const acum = new Map(r.alergenos.map((x) => [x.alergeno_id, x]));
  for (const o of opciones) {
    if (!Number.isInteger(o.insumo_id)) continue;
    const item = { tipo: 'insumo', id: o.insumo_id };
    await hoja(conn, item, await nombreDe(conn, item), acum, r.faltantes, 'opcion');
  }
  r.alergenos = [...acum.values()];
  return salida(r);
};

// ---- Quitar un derivado (RN33) ----

const quitar = async (productoId, alergenoId, motivo, userId) => {
  if (!String(motivo ?? '').trim()) throw invalido('El motivo para quitar un alérgeno es obligatorio.');
  const [[p]] = await pool.query('SELECT id FROM productos WHERE id = ?', [productoId]);
  if (!p) throw invalido('El artículo no existe.', 404);
  const [[a]] = await pool.query('SELECT id FROM alergenos WHERE id = ?', [alergenoId]);
  if (!a) throw invalido('El alérgeno no existe.', 404);
  await pool.query('INSERT INTO alergenos_quitados (producto_id, alergeno_id, motivo, user_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE motivo = VALUES(motivo), user_id = VALUES(user_id)', [productoId, alergenoId, String(motivo).trim(), userId ?? null]);
  return articulo(productoId);
};

const restituir = async (productoId, alergenoId) => (await pool.query('DELETE FROM alergenos_quitados WHERE producto_id = ? AND alergeno_id = ?', [productoId, alergenoId]))[0].affectedRows > 0;

module.exports = { AlergenoInvalido, catalogo, crear, activar, declarar, declarados, articulo, linea, quitar, restituir };
