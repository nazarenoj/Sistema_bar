const pool = require('../config/db');
const Parametro = require('./parametroModel');
const { idGlobal } = require('../utils/idGlobal');

// Presentaciones (Stock RF02, RN61, EX46): nombre, factor a la unidad base del ítem, usos y versión. Una
// presentación que ya se usó no se edita: se crea una versión nueva con su vigencia y la anterior vence.
const USOS = ['compra', 'receta', 'venta', 'fraccionamiento'];

class PresentacionInvalida extends Error {}

// Detectores de "esta presentación ya se usó". Cada documento que la guarda (recetas, movimientos, ingresos)
// registra el suyo; con uno que responda sí, la presentación deja de poder editarse.
const detectores = [
  async (id) => (await pool.query('SELECT 1 FROM producto_insumos WHERE presentacion_id = ? LIMIT 1', [id]))[0].length > 0,
];
const registrarDetectorUso = (fn) => detectores.push(fn);
const enUso = async (id) => {
  for (const d of detectores) if (await d(id)) return true;
  return false;
};

const getById = async (id, conn = pool) => (await conn.query('SELECT * FROM presentaciones WHERE id = ?', [id]))[0][0] ?? null;

const listar = async ({ insumo_id, vigentes } = {}) => {
  const donde = [];
  const params = [];
  if (insumo_id) { donde.push('insumo_id = ?'); params.push(insumo_id); }
  if (vigentes) donde.push('(vigente_hasta IS NULL OR vigente_hasta > NOW())');
  return (await pool.query(`SELECT * FROM presentaciones ${donde.length ? `WHERE ${donde.join(' AND ')}` : ''} ORDER BY insumo_id, nombre, version`, params))[0];
};

// Valida factor (mayor que cero, con la precisión configurada) y usos.
const validar = async ({ nombre, factor, usos }) => {
  if (typeof nombre !== 'string' || !nombre.trim()) throw new PresentacionInvalida('El nombre es obligatorio.');
  if (!(Number(factor) > 0) || !Number.isFinite(Number(factor))) throw new PresentacionInvalida('El factor debe ser un número mayor que cero.');
  const precision = (await Parametro.todos()).stock_precision_factor ?? 6;
  const decimales = (String(factor).split('.')[1] ?? '').replace(/0+$/, '').length;
  if (decimales > precision) throw new PresentacionInvalida(`El factor admite hasta ${precision} decimales.`);
  if (!Array.isArray(usos) || !usos.length || usos.some((u) => !USOS.includes(u))) throw new PresentacionInvalida(`Los usos deben ser algunos de: ${USOS.join(', ')}.`);
};

const create = async ({ insumo_id, nombre, factor, usos }) => {
  await validar({ nombre, factor, usos });
  const [[insumo]] = await pool.query('SELECT id FROM insumos WHERE id = ?', [insumo_id]);
  if (!insumo) throw Object.assign(new PresentacionInvalida('El ítem no existe.'), { status: 404 });
  const [[vigente]] = await pool.query('SELECT id FROM presentaciones WHERE insumo_id = ? AND nombre = ? AND vigente_hasta IS NULL', [insumo_id, nombre.trim()]);
  if (vigente) throw Object.assign(new PresentacionInvalida('Ya hay una presentación vigente con ese nombre para el ítem.'), { status: 409 });
  const [[{ v }]] = await pool.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM presentaciones WHERE insumo_id = ? AND nombre = ?', [insumo_id, nombre.trim()]);
  const [r] = await pool.query('INSERT INTO presentaciones (id_global, insumo_id, nombre, factor, usos, version) VALUES (?, ?, ?, ?, ?, ?)', [await idGlobal(), insumo_id, nombre.trim(), factor, usos.join(','), v]);
  return getById(r.insertId);
};

// Edita una presentación. Si ya se usó, no se toca: se crea la versión siguiente y la anterior queda vencida.
const editar = async (id, cambios) => {
  const p = await getById(id);
  if (!p) return null;
  if (p.vigente_hasta && new Date(p.vigente_hasta) <= new Date()) throw Object.assign(new PresentacionInvalida('Esta versión ya está vencida: editá la vigente.'), { status: 409 });
  const nuevo = { nombre: cambios.nombre ?? p.nombre, factor: cambios.factor ?? p.factor, usos: cambios.usos ?? String(p.usos).split(',') };
  await validar(nuevo);
  if (!(await enUso(id))) {
    await pool.query('UPDATE presentaciones SET nombre = ?, factor = ?, usos = ? WHERE id = ?', [nuevo.nombre.trim(), nuevo.factor, nuevo.usos.join(','), id]);
    return { ...(await getById(id)), nueva_version: false };
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE presentaciones SET vigente_hasta = NOW() WHERE id = ?', [id]);
    const [[{ v }]] = await conn.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM presentaciones WHERE insumo_id = ? AND nombre = ?', [p.insumo_id, nuevo.nombre.trim()]);
    const [r] = await conn.query('INSERT INTO presentaciones (id_global, insumo_id, nombre, factor, usos, version, version_anterior_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [await idGlobal(), p.insumo_id, nuevo.nombre.trim(), nuevo.factor, nuevo.usos.join(','), v, id]);
    await conn.commit();
    return { ...(await getById(r.insertId)), nueva_version: true };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const darDeBaja = async (id) => {
  const [r] = await pool.query('UPDATE presentaciones SET vigente_hasta = NOW() WHERE id = ? AND vigente_hasta IS NULL', [id]);
  return r.affectedRows > 0;
};

// Cantidad en unidades base de una cantidad en una presentación, con el factor de esa versión.
const aBase = (presentacion, cantidad) => Number(cantidad) * Number(presentacion.factor);

module.exports = { USOS, PresentacionInvalida, getById, listar, create, editar, darDeBaja, enUso, registrarDetectorUso, aBase };
