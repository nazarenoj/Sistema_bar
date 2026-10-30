const pool = require('../config/db');
const puertos = require('../modulos/puertos');

// Reposición automática sugerida (Stock RF29, EX40), con la función STK-REPO-AUTO. Por ítem: consumo promedio por día de la semana
// en una ventana configurable (8 semanas), proyectado sobre los días de cobertura más el plazo de entrega, más el stock de seguridad,
// menos lo disponible. El consumo es el real: ventas y consumos de producción. Nunca compra: arma la lista.
class ReposicionInvalida extends Error {}
const invalida = (m, status = 400) => Object.assign(new ReposicionInvalida(m), { status });

const CONSUMO = ['venta', 'consumo_produccion'];   // motivos que cuentan como consumo
const DIA_MS = 86400000;
const redondear = (x) => Math.round(x * 1000) / 1000;

const parametro = async (clave, defecto) => Number((await pool.query('SELECT valor FROM parametros WHERE clave = ?', [clave]))[0][0]?.valor ?? defecto);

const configurar = async (item, { stock_seguridad, plazo_entrega_dias, dias_cobertura }) => {
  if (!['insumo', 'producto'].includes(item?.tipo) || !Number.isInteger(item.id)) throw invalida('Ítem inválido.');
  if (stock_seguridad !== undefined && !(Number(stock_seguridad) >= 0)) throw invalida('El stock de seguridad debe ser mayor o igual a cero.');
  for (const [k, v] of Object.entries({ plazo_entrega_dias, dias_cobertura })) if (v !== undefined && v !== null && !(Number.isInteger(v) && v >= 0)) throw invalida(`${k} debe ser un entero mayor o igual a cero.`);
  const [[existe]] = await pool.query(`SELECT id FROM ${item.tipo === 'insumo' ? 'insumos' : 'productos'} WHERE id = ?`, [item.id]);
  if (!existe) throw invalida('El ítem no existe.', 404);
  await pool.query(
    `INSERT INTO item_reposicion (item_tipo, item_id, stock_seguridad, plazo_entrega_dias, dias_cobertura) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE stock_seguridad = COALESCE(?, stock_seguridad), plazo_entrega_dias = COALESCE(?, plazo_entrega_dias), dias_cobertura = COALESCE(?, dias_cobertura)`,
    [item.tipo, item.id, stock_seguridad ?? 0, plazo_entrega_dias ?? null, dias_cobertura ?? null, stock_seguridad ?? null, plazo_entrega_dias ?? null, dias_cobertura ?? null]);
  return (await pool.query('SELECT * FROM item_reposicion WHERE item_tipo = ? AND item_id = ?', [item.tipo, item.id]))[0][0];
};

// Lista sugerida. `hoy` permite fijar la fecha de cálculo (pruebas). Por ítem trae el consumo por día de la semana y de dónde salió el plazo.
const sugerir = async ({ deposito_id, hoy = new Date() } = {}) => {
  const semanas = await parametro('repo_ventana_semanas', 8);
  const coberturaGeneral = await parametro('repo_dias_cobertura', 7);
  const desde = new Date(hoy.getTime() - semanas * 7 * DIA_MS);
  const [filas] = await pool.query(
    `SELECT COALESCE(m.insumo_id, m.producto_id) AS item_id, IF(m.insumo_id IS NULL, 'producto', 'insumo') AS item_tipo, DAYOFWEEK(m.created_at) AS dia, -SUM(m.cantidad) AS consumo
     FROM stock_movimientos m WHERE m.motivo IN (?) AND m.cantidad < 0 AND m.created_at >= ? AND m.created_at < ? ${deposito_id ? 'AND m.deposito_id = ?' : ''}
     GROUP BY item_tipo, item_id, dia`, deposito_id ? [CONSUMO, desde, hoy, deposito_id] : [CONSUMO, desde, hoy]);
  const porItem = new Map();
  for (const f of filas) {
    const k = `${f.item_tipo}:${f.item_id}`;
    if (!porItem.has(k)) porItem.set(k, { item_tipo: f.item_tipo, item_id: f.item_id, dias: Array(8).fill(0) });
    porItem.get(k).dias[f.dia] = Number(f.consumo);
  }
  // Cuántas veces ocurre cada día de la semana dentro de la ventana, para promediar por día.
  const ocurrencias = Array(8).fill(0);
  for (let t = desde.getTime(); t < hoy.getTime(); t += DIA_MS) ocurrencias[new Date(t).getDay() + 1]++;
  const plazos = await puertos.obtener('plazosEntrega');
  const salida = [];
  for (const it of porItem.values()) {
    const [[cfg]] = await pool.query('SELECT * FROM item_reposicion WHERE item_tipo = ? AND item_id = ?', [it.item_tipo, it.item_id]);
    const tabla = it.item_tipo === 'insumo' ? 'insumos' : 'productos';
    const [[x]] = await pool.query(`SELECT nombre FROM ${tabla} WHERE id = ?`, [it.item_id]);
    const colMov = it.item_tipo === 'insumo' ? 'insumo_id' : 'producto_id';
    const [[{ fisico }]] = await pool.query(`SELECT COALESCE(SUM(cantidad), 0) AS fisico FROM stock_movimientos WHERE ${colMov} = ? ${deposito_id ? 'AND deposito_id = ?' : ''}`, deposito_id ? [it.item_id, deposito_id] : [it.item_id]);
    const viaCompras = await plazos.plazo(it);
    const plazo = viaCompras ?? cfg?.plazo_entrega_dias ?? null;
    if (plazo === null) { salida.push({ ...it, nombre: x?.nombre, sin_plazo: true, sugerida: null, motivo: 'Falta el plazo de entrega del ítem (EX40)' }); continue; }
    const cobertura = cfg?.dias_cobertura ?? coberturaGeneral;
    const promedio = it.dias.map((c, d) => (ocurrencias[d] ? c / ocurrencias[d] : 0));
    let necesario = 0;
    for (let i = 0; i < cobertura + plazo; i++) necesario += promedio[new Date(hoy.getTime() + i * DIA_MS).getDay() + 1];
    const seguridad = Number(cfg?.stock_seguridad ?? 0);
    necesario += seguridad;
    const disponible = Number(fisico);
    salida.push({ item_tipo: it.item_tipo, item_id: it.item_id, nombre: x?.nombre, consumo_diario: redondear(it.dias.reduce((a, c) => a + c, 0) / (semanas * 7)), consumo_por_dia: promedio.slice(1).map(redondear),
      plazo_entrega_dias: plazo, plazo_origen: viaCompras !== null ? 'compras' : 'item', dias_cobertura: cobertura, stock_seguridad: seguridad, disponible, sugerida: Math.max(0, redondear(necesario - disponible)) });
  }
  return salida.filter((s) => s.sin_plazo || s.sugerida > 0).sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
};

module.exports = { ReposicionInvalida, configurar, sugerir };
