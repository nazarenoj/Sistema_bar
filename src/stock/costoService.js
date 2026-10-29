const pool = require('../config/db');
const Parametro = require('../models/parametroModel');
const Receta = require('./recetaService');

// Valuación y costos (Stock RF17, RN62, RN63). Todos los costos son netos de IVA computable. El costo se congela en cada
// movimiento al registrarlo: un cambio posterior del método o un nuevo ingreso no lo modifica.
const METODOS = { 1: 'promedio', 2: 'peps', 3: 'ultimo' };
const metodo = async () => METODOS[(await Parametro.todos()).metodo_valuacion ?? 1] ?? 'promedio';
const redondear = (n) => Math.round(n * 10000) / 10000;

// Costo manual del insumo (`insumos.costo_unitario`): sirve de respaldo, marcado provisorio, mientras no hay ingresos con costo.
const respaldo = async (conn, item) => {
  if (item.tipo !== 'insumo') return null;
  const [[i]] = await conn.query('SELECT costo_unitario FROM insumos WHERE id = ?', [item.id]);
  return i?.costo_unitario === null || i?.costo_unitario === undefined ? null : Number(i.costo_unitario);
};

const fila = async (conn, item) => (await conn.query('SELECT * FROM stock_costos WHERE item_tipo = ? AND item_id = ?', [item.tipo, item.id]))[0][0] ?? null;

// Un ingreso con costo: actualiza promedio y último costo y abre una capa PEPS. `saldoPrevio` es el total antes del ingreso.
const alIngresar = async (conn, item, cantidad, costo, movimientoId, saldoPrevio) => {
  const f = await fila(conn, item);
  const previo = Number(saldoPrevio);
  const promedio = f?.costo_promedio !== null && f?.costo_promedio !== undefined && previo > 0
    ? (previo * Number(f.costo_promedio) + cantidad * costo) / (previo + cantidad)
    : costo;
  await conn.query(
    `INSERT INTO stock_costos (item_tipo, item_id, costo_promedio, ultimo_costo) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE costo_promedio = VALUES(costo_promedio), ultimo_costo = VALUES(ultimo_costo)`, [item.tipo, item.id, redondear(promedio), costo]);
  await conn.query('INSERT INTO stock_capas (item_tipo, item_id, movimiento_id, cantidad_restante, costo) VALUES (?, ?, ?, ?, ?)', [item.tipo, item.id, movimientoId, cantidad, costo]);
};

// Un egreso: devuelve el costo unitario según el método y consume las capas más viejas (si no es una transferencia, que no
// cambia lo que hay). Lo que excede las capas (stock negativo) se valora al último costo conocido y queda provisorio.
const alEgresar = async (conn, item, cantidad, { consumir = true } = {}) => {
  const f = await fila(conn, item);
  const m = await metodo();
  const manual = await respaldo(conn, item);
  const ultimo = f?.ultimo_costo !== null && f?.ultimo_costo !== undefined ? Number(f.ultimo_costo) : manual;
  const [capas] = await conn.query('SELECT id, cantidad_restante, costo FROM stock_capas WHERE item_tipo = ? AND item_id = ? AND cantidad_restante > 0 ORDER BY id FOR UPDATE', [item.tipo, item.id]);
  let faltante = cantidad;
  let valorPeps = 0;
  for (const c of capas) {
    if (faltante <= 0) break;
    const toma = Math.min(faltante, Number(c.cantidad_restante));
    valorPeps += toma * Number(c.costo);
    faltante -= toma;
    if (consumir) await conn.query('UPDATE stock_capas SET cantidad_restante = cantidad_restante - ? WHERE id = ?', [toma, c.id]);
  }
  let provisorio = false;
  if (faltante > 1e-9) { // sin capas suficientes: se completa con el último costo conocido
    if (ultimo === null) return { costo_unitario: capas.length ? redondear(valorPeps / (cantidad - faltante)) : null, provisorio: true };
    valorPeps += faltante * ultimo;
    provisorio = true;
  }
  let unitario;
  if (m === 'peps') unitario = valorPeps / cantidad;
  else if (m === 'ultimo') unitario = ultimo;
  else unitario = f?.costo_promedio !== null && f?.costo_promedio !== undefined ? Number(f.costo_promedio) : manual;
  if (unitario === null || unitario === undefined) return { costo_unitario: null, provisorio: false };
  // Sin ingresos con costo, el único costo es el manual del insumo: es provisorio.
  if (!f && manual !== null) provisorio = true;
  return { costo_unitario: redondear(unitario), provisorio };
};

// Costo vigente de un ítem (lo próximo que se descontaría), con su origen, para el puerto de costos de Ventas.
const costoActual = async (item, conn = pool) => {
  const f = await fila(conn, item);
  const m = await metodo();
  const manual = await respaldo(conn, item);
  let costo = null;
  if (m === 'peps') {
    const [[c]] = await conn.query('SELECT costo FROM stock_capas WHERE item_tipo = ? AND item_id = ? AND cantidad_restante > 0 ORDER BY id LIMIT 1', [item.tipo, item.id]);
    costo = c ? Number(c.costo) : (f?.ultimo_costo !== null && f?.ultimo_costo !== undefined ? Number(f.ultimo_costo) : null);
  } else if (m === 'ultimo') costo = f?.ultimo_costo !== null && f?.ultimo_costo !== undefined ? Number(f.ultimo_costo) : null;
  else costo = f?.costo_promedio !== null && f?.costo_promedio !== undefined ? Number(f.costo_promedio) : null;
  if (costo === null && manual !== null) return { costo: manual, provisorio: true, origen: 'manual' };
  return costo === null ? { costo: null, provisorio: false, origen: 'sin_costo' } : { costo, provisorio: false, origen: 'movimiento_stock' };
};

// CI de un artículo Propio, o CP (suma de sus componentes a CI) si se descuenta por componentes (RN62). `parcial` si a algún
// componente le falta el costo; `sin_costo` si no hay ninguno.
const costoArticulo = async (productoId, conn = pool) => {
  const hojas = await Receta.hojas(conn, productoId, 1);
  let total = 0;
  let conCosto = 0;
  let provisorio = false;
  for (const [k, q] of hojas) {
    const [tipo, id] = k.split(':');
    const c = await costoActual({ tipo, id: Number(id) }, conn);
    if (c.costo === null) continue;
    total += q * c.costo;
    conCosto++;
    provisorio = provisorio || c.provisorio;
  }
  const propio = hojas.size === 1 && [...hojas.keys()][0] === `producto:${productoId}`;
  return {
    costo: conCosto ? redondear(total) : null, tipo: propio ? 'CI' : 'CP', parcial: conCosto > 0 && conCosto < hojas.size, sin_costo: conCosto === 0,
    provisorio, fecha: new Date().toISOString(),
  };
};

// Inventario valorizado a una fecha (RF18): suma cantidad x costo congelado de cada movimiento hasta esa fecha. Los movimientos
// sin costo (saldo inicial, ajustes) no valorizan: se informan aparte como "sin costo".
const valorizado = async ({ fecha, deposito_id } = {}) => {
  const donde = [];
  const params = [];
  if (fecha) { donde.push('m.created_at <= ?'); params.push(`${fecha} 23:59:59`); }
  if (deposito_id) { donde.push('m.deposito_id = ?'); params.push(deposito_id); }
  const where = donde.length ? `WHERE ${donde.join(' AND ')}` : '';
  const filas = [];
  for (const [tipo, tabla, col, unidad] of [['insumo', 'insumos', 'insumo_id', 'x.unidad'], ['producto', 'productos', 'producto_id', "'unidad'"]]) {
    const [rows] = await pool.query(
      `SELECT '${tipo}' AS tipo, x.id AS item_id, x.nombre, ${unidad} AS unidad, SUM(m.cantidad) AS cantidad,
              SUM(CASE WHEN m.costo_unitario IS NOT NULL THEN m.cantidad * m.costo_unitario ELSE 0 END) AS valor,
              SUM(CASE WHEN m.costo_unitario IS NULL THEN m.cantidad ELSE 0 END) AS cantidad_sin_costo
       FROM stock_movimientos m JOIN ${tabla} x ON x.id = m.${col} ${where ? `${where} AND` : 'WHERE'} m.${col} IS NOT NULL
       GROUP BY x.id, x.nombre${tipo === 'insumo' ? ', x.unidad' : ''} HAVING SUM(m.cantidad) <> 0 ORDER BY x.nombre`, params);
    filas.push(...rows.map((r) => ({ ...r, cantidad: Number(r.cantidad), valor: redondear(Number(r.valor)), cantidad_sin_costo: Number(r.cantidad_sin_costo) })));
  }
  return { fecha: fecha ?? null, metodo: await metodo(), total: redondear(filas.reduce((a, f) => a + f.valor, 0)), items: filas };
};

module.exports = { METODOS, metodo, alIngresar, alEgresar, costoActual, costoArticulo, valorizado, redondear };
