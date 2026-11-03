const pool = require('../config/db');

// Disponibilidad del menú por franja horaria (Ventas RF29, RN45), con VEN-FRANJA. Un ítem con franjas propias se ofrece solo dentro de
// alguna de ellas; si no tiene, valen las de su categoría; sin ninguna, siempre. Un ítem agregado antes de que termine la franja conserva
// su precio y puede enviarse a comanda: la franja solo decide si se ofrece uno nuevo. No cambia el precio.
class FranjaInvalida extends Error {}
const invalida = (m, status = 400) => Object.assign(new FranjaInvalida(m), { status });

const hhmm = (ahora) => `${String(ahora.getHours()).padStart(2, '0')}:${String(ahora.getMinutes()).padStart(2, '0')}`;
// Una franja que cruza la medianoche (22:00 a 02:00) vale de noche y de madrugada.
const dentro = (f, ahora) => {
  if (f.dias_semana && !f.dias_semana.split(',').includes(String(ahora.getDay()))) return false;
  const t = hhmm(ahora);
  const d = String(f.hora_desde).slice(0, 5);
  const h = String(f.hora_hasta).slice(0, 5);
  return d <= h ? t >= d && t < h : t >= d || t < h;
};

const validar = (d) => {
  if (typeof d.nombre !== 'string' || !d.nombre.trim() || d.nombre.length > 60) throw invalida('El nombre es obligatorio (hasta 60 caracteres).');
  if (!!d.producto_id === !!d.categoria_id) throw invalida('La franja es de un artículo o de una categoría, no de ambos.');
  if (d.dias_semana && !/^[0-6](,[0-6])*$/.test(d.dias_semana)) throw invalida('Los días van como números de 0 (domingo) a 6 separados por coma.');
  for (const h of [d.hora_desde, d.hora_hasta]) if (!/^\d{2}:\d{2}(:\d{2})?$/.test(h ?? '')) throw invalida('Las horas van como HH:MM.');
  if (d.hora_desde === d.hora_hasta) throw invalida('La franja no puede empezar y terminar a la misma hora.');
};

const listar = async () => (await pool.query(
  `SELECT f.*, p.nombre AS producto, c.nombre AS categoria FROM franjas_menu f LEFT JOIN productos p ON p.id = f.producto_id LEFT JOIN categorias_producto c ON c.id = f.categoria_id ORDER BY f.nombre, f.id`))[0]
  .map((f) => ({ ...f, hora_desde: String(f.hora_desde).slice(0, 5), hora_hasta: String(f.hora_hasta).slice(0, 5) }));

const crear = async (d) => {
  validar(d);
  const [f] = d.producto_id ? await pool.query('SELECT 1 FROM productos WHERE id = ?', [d.producto_id]) : await pool.query('SELECT 1 FROM categorias_producto WHERE id = ?', [d.categoria_id]);
  if (!f.length) throw invalida(`${d.producto_id ? 'El artículo' : 'La categoría'} no existe.`, 404);
  const [r] = await pool.query('INSERT INTO franjas_menu (nombre, producto_id, categoria_id, dias_semana, hora_desde, hora_hasta) VALUES (?, ?, ?, ?, ?, ?)',
    [d.nombre.trim(), d.producto_id ?? null, d.categoria_id ?? null, d.dias_semana ?? null, d.hora_desde, d.hora_hasta]);
  return (await listar()).find((x) => x.id === r.insertId);
};

const quitar = async (id) => (await pool.query('DELETE FROM franjas_menu WHERE id = ?', [id]))[0].affectedRows > 0;

// ¿Se ofrece el artículo en este momento? { disponible, franjas } (las que lo rigen, para decirle al usuario cuándo vuelve).
const disponible = async (conn, productoId, ahora = new Date()) => {
  const [[p]] = await conn.query('SELECT categoria_id FROM productos WHERE id = ?', [productoId]);
  let [franjas] = await conn.query('SELECT * FROM franjas_menu WHERE producto_id = ?', [productoId]);
  if (!franjas.length && p?.categoria_id) [franjas] = await conn.query('SELECT * FROM franjas_menu WHERE categoria_id = ?', [p.categoria_id]);
  if (!franjas.length) return { disponible: true, franjas: [] };
  return { disponible: franjas.some((f) => dentro(f, ahora)), franjas: franjas.map((f) => `${f.nombre} ${String(f.hora_desde).slice(0, 5)}–${String(f.hora_hasta).slice(0, 5)}`) };
};

// Menú que el POS ofrece ahora.
const menu = async (ahora = new Date()) => {
  const [productos] = await pool.query('SELECT id, nombre, precio, categoria_id FROM productos ORDER BY nombre');
  const salida = [];
  for (const p of productos) if ((await disponible(pool, p.id, ahora)).disponible) salida.push({ ...p, precio: Number(p.precio) });
  return salida;
};

module.exports = { FranjaInvalida, listar, crear, quitar, disponible, menu };
