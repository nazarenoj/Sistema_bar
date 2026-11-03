const pool = require('../config/db');

// Monedas y cotizaciones (Usuarios RF14, RN17, EX12): servicio de plataforma que usan Ventas (cobro en divisa) y los módulos de arriba.
// La moneda local es una; las extranjeras se agregan. Las cotizaciones (comprador y vendedor, con fecha y hora) son de solo agregar y la
// vigente a una fecha es la última cargada hasta ella. Si es más vieja que la antigüedad permitida, el servicio lo dice y cada módulo decide
// si advierte o bloquea. La actualización automática (USU-COTIZ-AUTO) queda para después: hoy la carga es manual y con permiso.
class MonedaInvalida extends Error {}
const invalida = (m, status = 400) => Object.assign(new MonedaInvalida(m), { status });
const LOCAL = 'ARS';

const listar = async () => (await pool.query('SELECT * FROM monedas ORDER BY es_local DESC, codigo'))[0].map((m) => ({ ...m, es_local: !!m.es_local, activa: !!m.activa }));
const obtener = async (codigo) => (await listar()).find((m) => m.codigo === String(codigo).toUpperCase()) ?? null;

const crear = async ({ codigo, nombre, simbolo }) => {
  if (!/^[A-Z]{3}$/.test(codigo ?? '')) throw invalida('El código es el de 3 letras mayúsculas (ISO 4217), por ejemplo USD.');
  if (typeof nombre !== 'string' || !nombre.trim() || nombre.length > 60) throw invalida('El nombre es obligatorio (hasta 60 caracteres).');
  if (typeof simbolo !== 'string' || !simbolo.trim() || simbolo.length > 5) throw invalida('El símbolo es obligatorio (hasta 5 caracteres).');
  try { await pool.query('INSERT INTO monedas (codigo, nombre, simbolo) VALUES (?, ?, ?)', [codigo, nombre.trim(), simbolo.trim()]); } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida('Esa moneda ya existe.', 409);
    throw err;
  }
  return obtener(codigo);
};
const activar = async (codigo, activa) => {
  const m = await obtener(codigo);
  if (!m) throw invalida('Moneda no encontrada.', 404);
  if (m.es_local && !activa) throw invalida('La moneda local no se desactiva.', 409);
  await pool.query('UPDATE monedas SET activa = ? WHERE codigo = ?', [activa ? 1 : 0, m.codigo]);
  return obtener(codigo);
};

const antiguedadMaxima = async () => Number((await pool.query("SELECT valor FROM parametros WHERE clave = 'cotizacion_antiguedad_horas'"))[0][0]?.valor ?? 24);
const aFecha = (f) => { const s = String(f).trim().replace('T', ' '); if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(s)) throw invalida('La fecha va como AAAA-MM-DD HH:MM.'); return s.length === 10 ? `${s} 23:59:59` : s.length === 16 ? `${s}:00` : s; };

// Carga manual (la ruta exige el permiso). La fecha y hora por defecto son las del servidor; no puede ser futura.
const cargar = async ({ moneda, comprador, vendedor, fecha_hora }, { userId } = {}) => {
  const m = await obtener(moneda);
  if (!m || !m.activa) throw invalida('La moneda no existe o está desactivada.', 404);
  if (m.es_local) throw invalida('La moneda local no se cotiza.', 409);
  for (const [k, v] of [['comprador', comprador], ['vendedor', vendedor]]) if (!(Number(v) > 0) || !Number.isFinite(Number(v))) throw invalida(`La cotización ${k} debe ser un número mayor que cero.`);
  if (Number(vendedor) < Number(comprador)) throw invalida('El vendedor no puede ser menor que el comprador.');
  const fecha = fecha_hora ? aFecha(fecha_hora) : null;
  const [r] = await pool.query(`INSERT INTO cotizaciones (moneda, comprador, vendedor, fecha_hora, user_id) VALUES (?, ?, ?, ${fecha ? '?' : 'NOW()'}, ?)`,
    fecha ? [m.codigo, comprador, vendedor, fecha, userId ?? null] : [m.codigo, comprador, vendedor, userId ?? null]);
  return porId(r.insertId);
};

const dar = (c, max) => c && ({ id: c.id, moneda: c.moneda, comprador: Number(c.comprador), vendedor: Number(c.vendedor), fecha_hora: c.fecha_hora, origen: c.origen,
  antiguedad_horas: Math.round(Number(c.horas) * 10) / 10, vencida: Number(c.horas) > max });
const porId = async (id) => dar((await pool.query('SELECT *, TIMESTAMPDIFF(MINUTE, fecha_hora, NOW()) / 60 AS horas FROM cotizaciones WHERE id = ?', [id]))[0][0], await antiguedadMaxima());

// La cotización vigente a una fecha (por defecto, ahora): la última cargada hasta ella. null si no hay ninguna.
const vigente = async (moneda, fecha = null) => {
  const m = await obtener(moneda);
  if (!m) throw invalida('Moneda no encontrada.', 404);
  if (m.es_local) return { id: null, moneda: m.codigo, comprador: 1, vendedor: 1, fecha_hora: null, origen: null, antiguedad_horas: 0, vencida: false };
  const hasta = fecha ? aFecha(fecha) : null;
  const [[c]] = await pool.query(`SELECT *, TIMESTAMPDIFF(MINUTE, fecha_hora, ${hasta ? '?' : 'NOW()'}) / 60 AS horas FROM cotizaciones WHERE moneda = ? AND fecha_hora <= ${hasta ? '?' : 'NOW()'} ORDER BY fecha_hora DESC, id DESC LIMIT 1`,
    hasta ? [hasta, m.codigo, hasta] : [m.codigo]);
  return dar(c, await antiguedadMaxima()) ?? null;
};

const historial = async (moneda, limite = 100) => {
  const max = await antiguedadMaxima();
  return (await pool.query('SELECT *, TIMESTAMPDIFF(MINUTE, fecha_hora, NOW()) / 60 AS horas FROM cotizaciones WHERE moneda = ? ORDER BY fecha_hora DESC, id DESC LIMIT ?', [String(moneda).toUpperCase(), Math.min(Number(limite) || 100, 500)]))[0].map((c) => dar(c, max));
};

module.exports = { MonedaInvalida, LOCAL, listar, obtener, crear, activar, cargar, vigente, historial, porId };
