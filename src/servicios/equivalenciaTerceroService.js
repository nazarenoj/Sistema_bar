const pool = require('../config/db');

// Diccionario de equivalencias de terceros (Usuarios RF16, RN20): por CUIT del emisor, un código o descripción (normalizado) lleva a un único
// destino: ítem de stock, artículo o categoría de gasto. Cuando el destino es un ítem de stock apunta a una presentación de Stock y NO guarda
// unidad ni factor: el que registra el comprobante toma el factor vigente de la presentación al usar la equivalencia. Cada módulo registra
// los destinos que ofrece (puerto "Destinos de equivalencia"); un destino cuyo módulo no está instalado se rechaza.
class EquivalenciaInvalida extends Error {}
const invalida = (m, status = 400) => Object.assign(new EquivalenciaInvalida(m), { status });

const destinos = new Map(); // tipo -> { existe(id), presentacion?(presentacionId, idDestino) -> { vigente_id } | null }
const registrarDestino = (tipo, def) => destinos.set(tipo, def);
const TIPOS = ['item_stock', 'articulo', 'categoria_gasto'];

const clave = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 200);
const soloCuit = (c) => {
  const d = String(c ?? '').replace(/[\s\-]/g, '');
  if (!/^\d{11}$/.test(d)) throw invalida('El CUIT del emisor tiene 11 dígitos.');
  return d;
};

const validarDestino = async ({ tipo_destino: tipo, id_destino: id, presentacion_id: presentacionId }) => {
  if (!TIPOS.includes(tipo)) throw invalida(`El tipo de destino es uno de: ${TIPOS.join(', ')}.`);
  const d = destinos.get(tipo);
  if (!d) throw invalida(tipo === 'categoria_gasto' ? 'Las categorías de gasto necesitan el módulo Financiero, que no está instalado.' : 'El módulo de ese destino no está instalado.', 409);
  if (!Number.isInteger(Number(id)) || !(await d.existe(Number(id)))) throw invalida('El destino no existe.', 404);
  if (tipo === 'item_stock') {
    if (!presentacionId) throw invalida('Un ítem de stock se asocia a una presentación de Stock.');
    const p = await d.presentacion(Number(presentacionId), Number(id));
    if (!p) throw invalida('La presentación no pertenece al ítem.');
    if (!p.vigente) throw invalida('La presentación no está vigente: elegí la vigente.', 409);
  } else if (presentacionId) throw invalida('Solo un ítem de stock lleva presentación.');
};

const guardar = async ({ cuit, descripcion, tipo_destino, id_destino, presentacion_id }, { userId = null } = {}) => {
  const c = soloCuit(cuit);
  const k = clave(descripcion);
  if (!k) throw invalida('Falta el código o la descripción del tercero.');
  await validarDestino({ tipo_destino, id_destino, presentacion_id });
  await pool.query(
    `INSERT INTO equivalencias_terceros (cuit_emisor, texto_clave, descripcion, tipo_destino, id_destino, presentacion_id, estado, user_id) VALUES (?, ?, ?, ?, ?, ?, 'vigente', ?)
     ON DUPLICATE KEY UPDATE descripcion = VALUES(descripcion), tipo_destino = VALUES(tipo_destino), id_destino = VALUES(id_destino), presentacion_id = VALUES(presentacion_id), estado = 'vigente', user_id = VALUES(user_id)`,
    [c, k, String(descripcion).trim().slice(0, 200), tipo_destino, id_destino, tipo_destino === 'item_stock' ? presentacion_id : null, userId]);
  return (await pool.query('SELECT * FROM equivalencias_terceros WHERE cuit_emisor = ? AND texto_clave = ?', [c, k]))[0][0];
};

// Qué destino tiene este texto de este emisor. Con la presentación al día: si Stock creó una versión nueva, rige la vigente; si quedó sin
// vigencia la equivalencia pasa a "revisar" y el módulo pide elegir otra presentación antes de confirmar (RN20).
const resolver = async ({ cuit, descripcion }) => {
  const [[e]] = await pool.query('SELECT * FROM equivalencias_terceros WHERE cuit_emisor = ? AND texto_clave = ?', [soloCuit(cuit), clave(descripcion)]);
  if (!e) return null;
  if (e.tipo_destino !== 'item_stock') return { ...e, estado: e.estado };
  const d = destinos.get('item_stock');
  const p = d ? await d.presentacion(e.presentacion_id, e.id_destino) : null;
  if (!p || !p.vigente) {
    if (e.estado !== 'revisar') await pool.query("UPDATE equivalencias_terceros SET estado = 'revisar' WHERE id = ?", [e.id]);
    return { ...e, estado: 'revisar', motivo: 'La presentación ya no está vigente: elegí otra antes de confirmar.' };
  }
  if (p.vigente_id !== e.presentacion_id) await pool.query('UPDATE equivalencias_terceros SET presentacion_id = ? WHERE id = ?', [p.vigente_id, e.id]);
  return { ...e, presentacion_id: p.vigente_id, estado: 'vigente' };
};

// Recorre todas las equivalencias de ítems de stock y marca las que quedaron sin presentación vigente.
const revisar = async () => {
  const filas = (await pool.query("SELECT cuit_emisor, descripcion FROM equivalencias_terceros WHERE tipo_destino = 'item_stock'"))[0];
  let marcadas = 0;
  for (const f of filas) if ((await resolver({ cuit: f.cuit_emisor, descripcion: f.descripcion })).estado === 'revisar') marcadas++;
  return { revisadas: filas.length, en_revision: marcadas };
};

const listar = async ({ cuit, estado } = {}) => {
  const donde = [], p = [];
  if (cuit) { donde.push('cuit_emisor = ?'); p.push(soloCuit(cuit)); }
  if (estado) { donde.push('estado = ?'); p.push(estado); }
  return (await pool.query(`SELECT * FROM equivalencias_terceros ${donde.length ? `WHERE ${donde.join(' AND ')}` : ''} ORDER BY cuit_emisor, descripcion LIMIT 500`, p))[0];
};
const borrar = async (id) => {
  const [r] = await pool.query('DELETE FROM equivalencias_terceros WHERE id = ?', [id]);
  if (!r.affectedRows) throw invalida('Equivalencia no encontrada.', 404);
};

module.exports = { EquivalenciaInvalida, registrarDestino, clave, guardar, resolver, revisar, listar, borrar };
