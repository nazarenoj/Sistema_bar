const pool = require('../config/db');
const puertos = require('../modulos/puertos');
const Funciones = require('../funciones/servicio');

// Promociones automáticas (Ventas RF36, RF37, RN33, RN34, EX24), con VEN-PROMOS. Se evalúan al cobrar, no al armar el pedido: por
// prioridad (número menor primero), solo dentro de su vigencia y sin acumularse con otra salvo que ambas sean acumulables. El descuento
// de cada una se prorratea entre las líneas alcanzadas en proporción a su importe (el redondeo se ajusta en la última) y queda por línea.
class PromocionInvalida extends Error {}
const invalida = (m, status = 400, extra = {}) => Object.assign(new PromocionInvalida(m), { status, ...extra });
const TIPOS = ['2x1', 'combo_precio', 'cantidad', 'forma_pago', 'horario', 'categoria'];
const cts = (x) => Math.round(Number(x) * 100);

// ---------- ABM ----------

const validar = (d) => {
  if (typeof d.nombre !== 'string' || !d.nombre.trim() || d.nombre.length > 100) throw invalida('El nombre es obligatorio (hasta 100 caracteres).');
  if (!TIPOS.includes(d.tipo)) throw invalida(`El tipo debe ser uno de: ${TIPOS.join(', ')}.`);
  if (d.prioridad !== undefined && !Number.isInteger(d.prioridad)) throw invalida('La prioridad es un entero (el menor va primero).');
  if (d.tope !== undefined && d.tope !== null && !(Number(d.tope) > 0)) throw invalida('El tope debe ser mayor que cero.');
  const pct = () => { if (!(Number(d.porcentaje) > 0 && Number(d.porcentaje) <= 100)) throw invalida('El porcentaje debe estar entre 0 (sin incluir) y 100.'); };
  const items = d.items ?? [];
  for (const i of items) if (!!i.producto_id === !!i.categoria_id) throw invalida('Cada alcance es un artículo o una categoría, no ambos.');
  if (d.tipo === '2x1' && !items.length) throw invalida('El 2x1 necesita los artículos o categorías que alcanza.');
  if (d.tipo === 'combo_precio') {
    if (items.length < 2 || items.some((i) => !i.producto_id)) throw invalida('El combo a precio cerrado necesita al menos dos artículos.');
    if (!(Number(d.precio_cerrado) > 0)) throw invalida('El precio cerrado debe ser mayor que cero.');
  }
  if (d.tipo === 'cantidad') { pct(); if (!items.length) throw invalida('El descuento por cantidad necesita los artículos o categorías.'); if (!Number.isInteger(d.cantidad_minima) || d.cantidad_minima < 2) throw invalida('La cantidad mínima es un entero de 2 o más.'); }
  if (d.tipo === 'forma_pago') { pct(); if (!d.forma_pago) throw invalida('Indicá la forma de pago.'); }
  if (d.tipo === 'horario') { pct(); if (!d.dias_semana && !d.hora_desde && !d.hora_hasta) throw invalida('El descuento por franja necesita días u horario.'); }
  if (d.tipo === 'categoria') { pct(); if (!items.length || items.some((i) => !i.categoria_id)) throw invalida('El descuento por categoría necesita categorías.'); }
  for (const f of [d.vigente_desde, d.vigente_hasta]) if (f && !/^\d{4}-\d{2}-\d{2}$/.test(f)) throw invalida('Las fechas de vigencia van como AAAA-MM-DD.');
  if (d.vigente_desde && d.vigente_hasta && d.vigente_desde > d.vigente_hasta) throw invalida('La vigencia empieza después de terminar.');
  if (d.dias_semana && !/^[0-6](,[0-6])*$/.test(d.dias_semana)) throw invalida('Los días van como números de 0 (domingo) a 6 separados por coma.');
  for (const h of [d.hora_desde, d.hora_hasta]) if (h && !/^\d{2}:\d{2}(:\d{2})?$/.test(h)) throw invalida('Las horas van como HH:MM.');
};

// Avisa si la promoción deja algún artículo por debajo del costo (RF37, RN08); sin costo conocido no se controla.
const bajoCosto = async (d) => {
  const costo = (await puertos.obtener('costoInventario')).costo;
  const avisos = [];
  const productos = [];
  for (const i of d.items ?? []) {
    if (i.producto_id) productos.push(i.producto_id);
    else productos.push(...(await pool.query('SELECT id FROM productos WHERE categoria_id = ? LIMIT 200', [i.categoria_id]))[0].map((r) => r.id));
  }
  const info = new Map();
  for (const id of new Set(productos)) {
    const [[p]] = await pool.query('SELECT nombre, precio FROM productos WHERE id = ?', [id]);
    const c = (await costo(id))?.costo;
    if (p && c !== null && c !== undefined) info.set(id, { nombre: p.nombre, precio: Number(p.precio), costo: Number(c) });
  }
  if (d.tipo === 'combo_precio') {
    const ids = d.items.map((i) => i.producto_id);
    if (ids.every((id) => info.has(id))) {
      const costoCombo = d.items.reduce((a, i) => a + info.get(i.producto_id).costo * (i.cantidad ?? 1), 0);
      if (Number(d.precio_cerrado) < costoCombo) avisos.push({ item: d.nombre, precio: Number(d.precio_cerrado), costo: costoCombo });
    }
  } else {
    for (const { nombre, precio, costo: c } of info.values()) {
      const final = d.tipo === '2x1' ? precio / 2 : precio * (1 - Number(d.porcentaje ?? 0) / 100);
      if (final < c) avisos.push({ item: nombre, precio: Math.round(final * 100) / 100, costo: c });
    }
  }
  return avisos;
};

const obtener = async (id, conn = pool) => {
  const [[p]] = await conn.query('SELECT * FROM promociones WHERE id = ?', [id]);
  if (!p) return null;
  const [items] = await conn.query('SELECT producto_id, categoria_id, cantidad FROM promocion_items WHERE promocion_id = ?', [id]);
  const f = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
  return { ...p, acumulable: !!p.acumulable, vigente_desde: f(p.vigente_desde), vigente_hasta: f(p.vigente_hasta), items };
};
const listar = async () => Promise.all((await pool.query('SELECT id FROM promociones ORDER BY prioridad, id'))[0].map((r) => obtener(r.id)));

const guardar = async (id, d, { userId } = {}) => {
  validar(d);
  for (const i of d.items ?? []) {
    const [f] = i.producto_id ? await pool.query('SELECT 1 FROM productos WHERE id = ?', [i.producto_id]) : await pool.query('SELECT 1 FROM categorias_producto WHERE id = ?', [i.categoria_id]);
    if (!f.length) throw invalida(`${i.producto_id ? 'El artículo' : 'La categoría'} ${i.producto_id ?? i.categoria_id} no existe.`, 404);
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const campos = [d.nombre.trim(), d.tipo, d.prioridad ?? 100, d.acumulable ? 1 : 0, d.tope ?? null, d.porcentaje ?? null, d.precio_cerrado ?? null, d.cantidad_minima ?? null,
      d.forma_pago ?? null, d.vigente_desde ?? null, d.vigente_hasta ?? null, d.dias_semana ?? null, d.hora_desde ?? null, d.hora_hasta ?? null];
    if (id) {
      const [r] = await conn.query('UPDATE promociones SET nombre = ?, tipo = ?, prioridad = ?, acumulable = ?, tope = ?, porcentaje = ?, precio_cerrado = ?, cantidad_minima = ?, forma_pago = ?, vigente_desde = ?, vigente_hasta = ?, dias_semana = ?, hora_desde = ?, hora_hasta = ? WHERE id = ?', [...campos, id]);
      if (!r.affectedRows) throw invalida('Promoción no encontrada.', 404);
    } else {
      const [r] = await conn.query('INSERT INTO promociones (nombre, tipo, prioridad, acumulable, tope, porcentaje, precio_cerrado, cantidad_minima, forma_pago, vigente_desde, vigente_hasta, dias_semana, hora_desde, hora_hasta, creada_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [...campos, userId ?? null]);
      id = r.insertId;
    }
    await conn.query('DELETE FROM promocion_items WHERE promocion_id = ?', [id]);
    for (const i of d.items ?? []) await conn.query('INSERT INTO promocion_items (promocion_id, producto_id, categoria_id, cantidad) VALUES (?, ?, ?, ?)', [id, i.producto_id ?? null, i.categoria_id ?? null, i.cantidad ?? 1]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') throw invalida('Ya hay una promoción con ese nombre.', 409);
    throw err;
  } finally { conn.release(); }
  return obtener(id);
};

// Promoción solo para socios del programa de fidelización (necesita CLI-FIDEL).
const soloSocios = async (id, valor) => {
  if (valor && !(await Funciones.estaActiva('CLI-FIDEL'))) throw invalida('Las promociones para socios necesitan la función CLI-FIDEL.', 409);
  const [r] = await pool.query('UPDATE promociones SET solo_socios = ? WHERE id = ?', [valor ? 1 : 0, id]);
  if (!r.affectedRows) throw invalida('Promoción no encontrada.', 404);
  return obtener(id);
};

const pausar = async (id, pausada) => {
  const [r] = await pool.query('UPDATE promociones SET estado = ? WHERE id = ?', [pausada ? 'pausada' : 'activa', id]);
  if (!r.affectedRows) throw invalida('Promoción no encontrada.', 404);
  return obtener(id);
};

// ---------- Motor ----------

const vigenteAhora = (p, ahora) => {
  if (p.estado !== 'activa') return false;
  const dia = ahora.toISOString().slice(0, 10);
  const f = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
  if (p.vigente_desde && f(p.vigente_desde) > dia) return false;
  if (p.vigente_hasta && f(p.vigente_hasta) < dia) return false;
  if (p.dias_semana && !p.dias_semana.split(',').includes(String(ahora.getDay()))) return false;
  if (p.hora_desde || p.hora_hasta) {
    const t = `${String(ahora.getHours()).padStart(2, '0')}:${String(ahora.getMinutes()).padStart(2, '0')}`;
    const d = (p.hora_desde ?? '00:00:00').slice(0, 5);
    const h = (p.hora_hasta ?? '23:59:59').slice(0, 5);
    if (!(d <= h ? t >= d && t < h : t >= d || t < h)) return false;
  }
  return true;
};

// Reparte `total` (en centavos) entre las líneas en proporción a su peso; la diferencia de redondeo va a la última (RN33).
const prorratear = (lineas, pesos, total) => {
  const suma = pesos.reduce((a, x) => a + x, 0);
  let asignado = 0;
  return lineas.map((l, i) => {
    const c = i === lineas.length - 1 ? total - asignado : Math.round(total * pesos[i] / suma);
    asignado += c;
    return { linea: l, centavos: c };
  });
};

// Calcula las promociones sobre las líneas de los pedidos (sin guardar): { lineas: [{ id, descuento }], aplicadas: [{ promocion_id, nombre, importe, reparto }] }.
const calcular = async (conn, pedidoIds, { formaPago = null, ahora = new Date(), socio = false } = {}) => {
  const [items] = await conn.query(
    `SELECT pp.id, pp.pedido_id, pp.producto_id, pp.cantidad, pp.precio_unitario, p.categoria_id
     FROM pedido_productos pp JOIN productos p ON p.id = pp.producto_id WHERE pp.pedido_id IN (?) ORDER BY pp.id`, [pedidoIds]);
  const lineas = items.map((i) => ({ ...i, cantidad: Number(i.cantidad), bruto: cts(Number(i.cantidad) * Number(i.precio_unitario)), desc: 0, promos: [], acumulables: true }));
  const [promos] = await conn.query("SELECT * FROM promociones WHERE estado = 'activa' ORDER BY prioridad, id");
  const aplicadas = [];
  for (const p of promos) {
    if (!vigenteAhora(p, ahora)) continue;
    if (p.solo_socios && !socio) continue; // promoción para socios: la condición de socio viene de la copia local de Ventas (Clientes RN30, RN42)
    const [alcance] = await conn.query('SELECT producto_id, categoria_id, cantidad FROM promocion_items WHERE promocion_id = ?', [p.id]);
    const coincide = (l) => !alcance.length || alcance.some((a) => (a.producto_id && a.producto_id === l.producto_id) || (a.categoria_id && a.categoria_id === l.categoria_id));
    // Una línea ya descontada solo admite otra promoción si ambas son acumulables.
    const libre = (l) => !l.promos.length || (p.acumulable && l.acumulables);
    const disponible = (l) => l.bruto - l.desc;
    let reparto = []; // [{ linea, centavos }]

    if (p.tipo === '2x1') {
      const porProducto = new Map();
      for (const l of lineas.filter((x) => coincide(x) && libre(x))) porProducto.set(l.producto_id, [...(porProducto.get(l.producto_id) ?? []), l]);
      for (const ls of porProducto.values()) {
        const unidades = ls.reduce((a, l) => a + l.cantidad, 0);
        const gratis = Math.floor(unidades / 2);
        const precio = ls.reduce((a, l) => a + l.bruto, 0) / unidades;
        if (gratis) reparto.push(...prorratear(ls, ls.map((l) => disponible(l)), Math.round(gratis * precio)));
      }
    } else if (p.tipo === 'combo_precio') {
      const unidades = (a) => lineas.filter((l) => l.producto_id === a.producto_id && libre(l)).reduce((s, l) => s + l.cantidad, 0);
      const combos = Math.min(...alcance.map((a) => Math.floor(unidades(a) / a.cantidad)));
      if (combos > 0) {
        const involucradas = lineas.filter((l) => alcance.some((a) => a.producto_id === l.producto_id) && libre(l));
        const precioLista = alcance.reduce((s, a) => {
          const ls = involucradas.filter((l) => l.producto_id === a.producto_id);
          return s + a.cantidad * (ls.reduce((x, l) => x + l.bruto, 0) / ls.reduce((x, l) => x + l.cantidad, 0));
        }, 0);
        const d = Math.round(combos * (precioLista - cts(p.precio_cerrado)));
        if (d > 0) reparto = prorratear(involucradas, involucradas.map((l) => disponible(l)), d);
      }
    } else {
      let base = lineas.filter((l) => coincide(l) && libre(l));
      if (p.tipo === 'cantidad' && base.reduce((a, l) => a + l.cantidad, 0) < p.cantidad_minima) base = [];
      if (p.tipo === 'forma_pago' && formaPago !== p.forma_pago) base = [];
      reparto = base.map((l) => ({ linea: l, centavos: Math.round(disponible(l) * Number(p.porcentaje) / 100) }));
    }

    reparto = reparto.filter((r) => r.centavos > 0);
    if (!reparto.length) continue;
    // El tope limita el importe de la promoción por venta (proporcional entre sus líneas); nada queda en negativo.
    let total = reparto.reduce((a, r) => a + r.centavos, 0);
    if (p.tope !== null && total > cts(p.tope)) { reparto = prorratear(reparto.map((r) => r.linea), reparto.map((r) => r.centavos), cts(p.tope)); total = cts(p.tope); }
    reparto = reparto.map((r) => ({ ...r, centavos: Math.min(r.centavos, disponible(r.linea)) })).filter((r) => r.centavos > 0);
    total = reparto.reduce((a, r) => a + r.centavos, 0);
    if (!total) continue;
    for (const r of reparto) { r.linea.desc += r.centavos; r.linea.promos.push(p.id); r.linea.acumulables = r.linea.acumulables && !!p.acumulable; }
    aplicadas.push({ promocion_id: p.id, nombre: p.nombre, importe: total / 100, reparto: reparto.map((r) => ({ item_id: r.linea.id, pedido_id: r.linea.pedido_id, importe: r.centavos / 100 })) });
  }
  return { lineas: lineas.map((l) => ({ id: l.id, bruto: l.bruto / 100, descuento: l.desc / 100 })), aplicadas, total_descuento: lineas.reduce((a, l) => a + l.desc, 0) / 100 };
};

// Aplica las promociones al cobrar: deja el descuento en cada línea (Importe_Descuento) y registra lo aplicado. Se puede repetir (recalcula).
const aplicar = async (conn, pedidoIds, { formaPago = null, ahora = new Date(), clave, socio = false } = {}) => {
  await conn.query('UPDATE pedido_productos SET importe_descuento = 0 WHERE pedido_id IN (?)', [pedidoIds]);
  await conn.query('DELETE FROM promociones_aplicadas WHERE pedido_id IN (?)', [pedidoIds]);
  if (!(await Funciones.estaActiva('VEN-PROMOS', conn))) return { aplicadas: [], total_descuento: 0 };
  const r = await calcular(conn, pedidoIds, { formaPago, ahora, socio });
  for (const l of r.lineas) if (l.descuento > 0) await conn.query('UPDATE pedido_productos SET importe_descuento = ? WHERE id = ?', [l.descuento, l.id]);
  for (const a of r.aplicadas)
    for (const x of a.reparto) await conn.query('INSERT INTO promociones_aplicadas (clave, promocion_id, nombre, pedido_id, item_id, importe) VALUES (?, ?, ?, ?, ?, ?)', [clave, a.promocion_id, a.nombre, x.pedido_id, x.item_id, x.importe]);
  return { aplicadas: r.aplicadas.map(({ reparto, ...a }) => a), total_descuento: r.total_descuento };
};

// Vista previa para mostrar la diferencia antes de confirmar el cobro (EX24): calcula y no guarda.
const simular = async (pedidoIds, { formaPago = null, socio = false } = {}) => {
  if (!pedidoIds.length) return { bruto: 0, descuento: 0, total: 0, aplicadas: [] };
  const r = await calcular(pool, pedidoIds, { formaPago, socio });
  const bruto = r.lineas.reduce((a, l) => a + l.bruto, 0);
  return { bruto, descuento: r.total_descuento, total: Math.round((bruto - r.total_descuento) * 100) / 100, aplicadas: r.aplicadas.map(({ reparto, ...a }) => a) };
};

// Informe de uso (RF37): veces aplicada y importe descontado por promoción.
const informe = async ({ desde, hasta } = {}) => (await pool.query(
  `SELECT promocion_id, nombre, COUNT(DISTINCT clave) AS veces, SUM(importe) AS importe_descontado FROM promociones_aplicadas
   WHERE created_at >= ? AND created_at <= ? GROUP BY promocion_id, nombre ORDER BY importe_descontado DESC`,
  [desde ? `${desde} 00:00:00` : '1970-01-01', hasta ? `${hasta} 23:59:59` : '2999-12-31']))[0].map((r) => ({ ...r, veces: Number(r.veces), importe_descontado: Number(r.importe_descontado) }));

module.exports = { PromocionInvalida, soloSocios, listar, obtener, guardar, pausar, bajoCosto, calcular, aplicar, simular, informe };
