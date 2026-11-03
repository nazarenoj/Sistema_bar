const pool = require('../config/db');
const Notificacion = require('../models/notificacionModel');
const M = require('../mensajeria/servicio');
const { idGlobal } = require('../utils/idGlobal');

// Comisiones de vendedores (Ventas RF40, RF41, RN38, EX28), con VEN-COMISIONES. Se calculan sobre el importe neto de IVA de la venta, que
// se atribuye al mozo o vendedor del pedido. Reglas: porcentaje sobre la venta, porcentaje sobre el margen realizado (con el costo de la venta
// que informó Stock) y metas escalonadas (cada tramo del acumulado del período paga su porcentaje). Una liquidación cerrada no se modifica:
// las devoluciones se descuentan en la liquidación del período en que ocurren, como ajuste.
class ComisionInvalida extends Error {}
const invalida = (m, status = 400) => Object.assign(new ComisionInvalida(m), { status });
const cts = (x) => Math.round(Number(x) * 100);
const TIPOS = ['porcentaje', 'margen', 'metas'];
const PERIODOS = { semanal: 7, quincenal: 16, mensual: 31 };

// ---------- Reglas ----------

const tramosDe = async (id, conn = pool) => (await conn.query('SELECT desde, porcentaje FROM comision_tramos WHERE regla_id = ? ORDER BY desde', [id]))[0].map((t) => ({ desde: Number(t.desde), porcentaje: Number(t.porcentaje) }));
const reglaDe = async (id, conn = pool) => {
  const [[r]] = await conn.query('SELECT * FROM comision_reglas WHERE id = ?', [id]);
  return r ? { ...r, activa: !!r.activa, porcentaje: r.porcentaje === null ? null : Number(r.porcentaje), tramos: await tramosDe(id, conn) } : null;
};
const reglas = async () => Promise.all((await pool.query('SELECT id FROM comision_reglas ORDER BY id'))[0].map((r) => reglaDe(r.id)));

const pct = (x) => Number.isFinite(Number(x)) && Number(x) > 0 && Number(x) <= 100;
const guardarRegla = async (id, d, { userId } = {}) => {
  if (typeof d.nombre !== 'string' || !d.nombre.trim() || d.nombre.length > 100) throw invalida('El nombre es obligatorio (hasta 100 caracteres).');
  if (!TIPOS.includes(d.tipo)) throw invalida(`El tipo debe ser uno de: ${TIPOS.join(', ')}.`);
  if (d.user_id && d.rol) throw invalida('La regla es de un vendedor o de un rol, no de ambos.');
  if (d.user_id && !(await pool.query('SELECT 1 FROM users WHERE id = ?', [d.user_id]))[0].length) throw invalida('El vendedor no existe.', 404);
  if (d.rol && !(await pool.query('SELECT 1 FROM roles WHERE codigo = ?', [d.rol]))[0].length) throw invalida('El rol no existe.', 404);
  if (d.tipo === 'metas') {
    const t = d.tramos;
    if (!Array.isArray(t) || t.length < 2) throw invalida('Las metas necesitan al menos dos tramos.');
    if (Number(t[0].desde) !== 0) throw invalida('El primer tramo empieza en 0.');
    for (let i = 0; i < t.length; i++) {
      if (!pct(t[i].porcentaje)) throw invalida('El porcentaje de cada tramo está entre 0 (sin incluir) y 100.');
      if (!(Number(t[i].desde) >= 0) || (i > 0 && !(Number(t[i].desde) > Number(t[i - 1].desde)))) throw invalida('Los tramos van en orden creciente de "desde".');
    }
  } else if (!pct(d.porcentaje)) throw invalida('El porcentaje debe estar entre 0 (sin incluir) y 100.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const campos = [d.nombre.trim(), d.tipo, d.user_id ?? null, d.rol ?? null, d.tipo === 'metas' ? null : d.porcentaje];
    if (id) {
      const [r] = await conn.query('UPDATE comision_reglas SET nombre = ?, tipo = ?, user_id = ?, rol = ?, porcentaje = ? WHERE id = ?', [...campos, id]);
      if (!r.affectedRows) throw invalida('Regla no encontrada.', 404);
    } else {
      const [r] = await conn.query('INSERT INTO comision_reglas (nombre, tipo, user_id, rol, porcentaje, creada_por) VALUES (?, ?, ?, ?, ?, ?)', [...campos, userId ?? null]);
      id = r.insertId;
    }
    await conn.query('DELETE FROM comision_tramos WHERE regla_id = ?', [id]);
    if (d.tipo === 'metas') for (const t of d.tramos) await conn.query('INSERT INTO comision_tramos (regla_id, desde, porcentaje) VALUES (?, ?, ?)', [id, t.desde, t.porcentaje]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') throw invalida('Ya hay una regla con ese nombre.', 409);
    throw err;
  } finally { conn.release(); }
  return reglaDe(id);
};
const activarRegla = async (id, activa) => {
  const [r] = await pool.query('UPDATE comision_reglas SET activa = ? WHERE id = ?', [activa ? 1 : 0, id]);
  if (!r.affectedRows) throw invalida('Regla no encontrada.', 404);
  return reglaDe(id);
};

// ---------- Cálculo ----------

const param = async (clave, defecto) => (await pool.query('SELECT valor FROM parametros WHERE clave = ?', [clave]))[0][0]?.valor ?? defecto;
const fechas = (desde, hasta) => {
  for (const f of [desde, hasta]) if (!/^\d{4}-\d{2}-\d{2}$/.test(f ?? '')) throw invalida('Las fechas van como AAAA-MM-DD.');
  if (desde > hasta) throw invalida('El período empieza después de terminar.');
  return [`${desde} 00:00:00`, `${hasta} 23:59:59`];
};

// La regla que rige a un vendedor: la suya, la de su rol o la general.
const reglaPara = (activas, userId, roles) => activas.find((r) => r.user_id === userId) ?? activas.find((r) => r.rol && roles.includes(r.rol)) ?? activas.find((r) => !r.user_id && !r.rol) ?? null;

// Comisión de un tramo escalonado sobre el acumulado: cada porción del importe paga el porcentaje del tramo donde cae.
const porMetas = (tramos, previo, importe) => {
  let total = 0;
  tramos.forEach((t, i) => {
    const hasta = i + 1 < tramos.length ? tramos[i + 1].desde : Infinity;
    const solape = Math.min(previo + importe, hasta) - Math.max(previo, t.desde);
    if (solape > 0) total += solape * t.porcentaje / 100;
  });
  return total;
};

// Calcula lo que corresponde liquidar en el período sin guardar nada: ventas todavía no liquidadas y ajustes por devoluciones.
const calcular = async (conn, desde, hasta) => {
  const [d, h] = fechas(desde, hasta);
  const activas = [];
  for (const { id } of (await conn.query('SELECT id FROM comision_reglas WHERE activa = 1 ORDER BY id'))[0]) activas.push(await reglaDe(id, conn));
  const respaldo = await param('comision_respaldo', 'sin_comision');
  const respaldoPct = Number(await param('comision_respaldo_pct', 0));
  const [ventas] = await conn.query(
    `SELECT v.id, v.id_global, v.total, v.detalle, v.mozo_id, v.created_at FROM ventas v WHERE v.created_at >= ? AND v.created_at <= ?
     AND NOT EXISTS (SELECT 1 FROM comision_ventas cv WHERE cv.venta_id = v.id) ORDER BY v.id`, [d, h]);
  const rolesDe = new Map();
  const roles = async (u) => {
    if (!rolesDe.has(u)) rolesDe.set(u, (await conn.query('SELECT r.codigo FROM usuario_roles ur JOIN roles r ON r.id = ur.rol_id WHERE ur.user_id = ?', [u]))[0].map((x) => x.codigo));
    return rolesDe.get(u);
  };
  const alicuotas = new Map((await conn.query('SELECT id, alicuota_iva FROM productos'))[0].map((p) => [p.id, Number(p.alicuota_iva)]));
  const acumulado = new Map(); // vendedor -> neto acumulado del período (metas)
  const items = [];
  const omitidas = { sin_vendedor: 0, sin_regla: 0, pendientes_de_costo: 0, sin_costo: 0 };
  for (const v of ventas) {
    if (!v.mozo_id) { omitidas.sin_vendedor++; continue; }
    const regla = reglaPara(activas, v.mozo_id, await roles(v.mozo_id));
    if (!regla) { omitidas.sin_regla++; continue; }
    const detalle = JSON.parse(v.detalle);
    const costos = new Map((await conn.query('SELECT linea, costo_unitario FROM lineas_costo WHERE doc_id_global = ?', [v.id_global]))[0].map((c) => [c.linea, c.costo_unitario === null ? null : Number(c.costo_unitario)]));
    const lineas = detalle.map((l, i) => {
      const bruto = l.cantidad * l.precio_unitario - (l.importe_descuento ?? 0);
      const neto = bruto / (1 + (alicuotas.get(l.producto_id) ?? 21) / 100);
      return { neto, costo: costos.has(i) && costos.get(i) !== null ? costos.get(i) * l.cantidad : null, tieneRegistro: costos.has(i) };
    });
    const neto = lineas.reduce((a, l) => a + l.neto, 0);
    let comision = 0;
    let costoTotal = null;
    let nota = null;
    if (regla.tipo === 'porcentaje') comision = neto * regla.porcentaje / 100;
    else if (regla.tipo === 'metas') {
      const previo = acumulado.get(v.mozo_id) ?? 0;
      comision = porMetas(regla.tramos, previo, neto);
      acumulado.set(v.mozo_id, previo + neto);
    } else {
      // Margen: el costo es el de la venta que informó Stock. Si todavía no llegó, la venta entra en la liquidación siguiente.
      const [[{ conDescuento }]] = await conn.query("SELECT COUNT(*) AS conDescuento FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'descuento_stock'", [v.id_global]);
      if (conDescuento > 0 && lineas.some((l) => !l.tieneRegistro)) { omitidas.pendientes_de_costo++; continue; }
      let margenCom = 0;
      let sinCosto = false;
      for (const l of lineas) {
        if (l.costo !== null) { margenCom += (l.neto - l.costo) * regla.porcentaje / 100; costoTotal = (costoTotal ?? 0) + l.costo; }
        else { sinCosto = true; if (respaldo === 'porcentaje') margenCom += l.neto * respaldoPct / 100; }
      }
      comision = margenCom;
      if (sinCosto) { omitidas.sin_costo++; nota = respaldo === 'porcentaje' ? `sin costo: ${respaldoPct}% sobre la venta` : 'sin costo: sin comisión por margen'; }
    }
    items.push({ tipo: 'venta', user_id: v.mozo_id, venta_id: v.id, regla_id: regla.id, base: cts(neto) / 100, costo: costoTotal === null ? null : cts(costoTotal) / 100, comision: cts(comision) / 100, nota });
  }

  // Ajustes: lo devuelto descuenta la comisión de su venta, sea cual sea el período de esa venta.
  const [devs] = await conn.query(
    `SELECT dv.id, dv.venta_id, dv.total, v.total AS venta_total, v.mozo_id FROM devoluciones dv JOIN ventas v ON v.id = dv.venta_id
     WHERE dv.created_at <= ? AND NOT EXISTS (SELECT 1 FROM comision_devoluciones cd WHERE cd.devolucion_id = dv.id) ORDER BY dv.id`, [h]);
  for (const dv of devs) {
    const [[previa]] = await conn.query("SELECT COALESCE(SUM(comision), 0) AS c, COALESCE(SUM(base), 0) AS b, MAX(user_id) AS u FROM comision_items WHERE venta_id = ? AND tipo = 'venta'", [dv.venta_id]);
    const enCurso = items.find((i) => i.venta_id === dv.venta_id);
    const original = enCurso ? enCurso.comision : Number(previa.c);
    if (!original) continue; // la venta no generó comisión (todavía): no hay qué descontar
    const f = Number(dv.total) / Number(dv.venta_total);
    items.push({ tipo: 'ajuste', user_id: enCurso?.user_id ?? previa.u ?? dv.mozo_id, venta_id: dv.venta_id, devolucion_id: dv.id, regla_id: enCurso?.regla_id ?? null, base: -cts((enCurso ? enCurso.base : Number(previa.b)) * f) / 100, costo: null, comision: -cts(original * f) / 100, nota: 'devolución' });
  }
  return { items, omitidas };
};

const porVendedor = async (items, conn = pool) => {
  const ids = [...new Set(items.map((i) => i.user_id))];
  const nombres = ids.length ? new Map((await conn.query('SELECT id, username FROM users WHERE id IN (?)', [ids]))[0].map((u) => [u.id, u.username])) : new Map();
  return ids.map((u) => {
    const mios = items.filter((i) => i.user_id === u);
    return { user_id: u, vendedor: nombres.get(u), ventas: mios.filter((i) => i.tipo === 'venta').length, base: cts(mios.reduce((a, i) => a + i.base, 0)) / 100,
      comisiones: cts(mios.filter((i) => i.tipo === 'venta').reduce((a, i) => a + i.comision, 0)) / 100, ajustes: cts(mios.filter((i) => i.tipo === 'ajuste').reduce((a, i) => a + i.comision, 0)) / 100,
      total: cts(mios.reduce((a, i) => a + i.comision, 0)) / 100 };
  });
};

const previa = async (desde, hasta) => {
  const { items, omitidas } = await calcular(pool, desde, hasta);
  return { desde, hasta, vendedores: await porVendedor(items), total: cts(items.reduce((a, i) => a + i.comision, 0)) / 100, omitidas };
};

// ---------- Liquidaciones ----------

const liquidar = async ({ tipo, desde, hasta }, { userId } = {}) => {
  if (!PERIODOS[tipo]) throw invalida(`El tipo debe ser uno de: ${Object.keys(PERIODOS).join(', ')}.`);
  fechas(desde, hasta);
  const dias = Math.round((new Date(`${hasta}T00:00:00Z`) - new Date(`${desde}T00:00:00Z`)) / 86400000) + 1;
  if (dias > PERIODOS[tipo]) throw invalida(`Una liquidación ${tipo} cubre hasta ${PERIODOS[tipo]} días.`);
  const conn = await pool.getConnection();
  let id;
  try {
    await conn.beginTransaction();
    await conn.query('SELECT valor FROM parametros WHERE clave = \'comision_respaldo\' FOR UPDATE'); // serializa dos liquidaciones a la vez
    const { items, omitidas } = await calcular(conn, desde, hasta);
    if (!items.length) throw invalida('No hay nada para liquidar en ese período.', 409);
    const total = cts(items.reduce((a, i) => a + i.comision, 0)) / 100;
    const [r] = await conn.query('INSERT INTO comision_liquidaciones (id_global, tipo, desde, hasta, total, creada_por) VALUES (?, ?, ?, ?, ?, ?)', [await idGlobal(), tipo, desde, hasta, total, userId ?? null]);
    id = r.insertId;
    for (const i of items) {
      await conn.query('INSERT INTO comision_items (liquidacion_id, user_id, tipo, venta_id, devolucion_id, regla_id, base, costo, comision, nota) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, i.user_id, i.tipo, i.venta_id, i.devolucion_id ?? null, i.regla_id, i.base, i.costo, i.comision, i.nota]);
      if (i.tipo === 'venta') await conn.query('INSERT INTO comision_ventas (venta_id, liquidacion_id) VALUES (?, ?)', [i.venta_id, id]);
      else await conn.query('INSERT INTO comision_devoluciones (devolucion_id, liquidacion_id) VALUES (?, ?)', [i.devolucion_id, id]);
    }
    await conn.commit();
    if (omitidas.sin_costo && (await param('comision_respaldo', 'sin_comision')) === 'sin_comision')
      await Notificacion.crear({ modulo: 'ventas', tipo: 'comision_sin_costo', severidad: 'media', roles: ['gerente', 'encargado'], clave: `comision-sin-costo:${id}`,
        mensaje: `${omitidas.sin_costo} venta(s) de la liquidación ${id} no tienen costo: no generaron comisión por margen.` });
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return obtener(id);
};

const obtener = async (id) => {
  const [[l]] = await pool.query('SELECT * FROM comision_liquidaciones WHERE id = ?', [id]);
  if (!l) return null;
  const [items] = await pool.query('SELECT user_id, tipo, venta_id, devolucion_id, regla_id, base, costo, comision, nota FROM comision_items WHERE liquidacion_id = ? ORDER BY user_id, id', [id]);
  const conv = items.map((i) => ({ ...i, base: Number(i.base), costo: i.costo === null ? null : Number(i.costo), comision: Number(i.comision) }));
  const f = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
  return { ...l, desde: f(l.desde), hasta: f(l.hasta), total: Number(l.total), vendedores: await porVendedor(conv), items: conv };
};
const listar = async () => (await pool.query('SELECT id, id_global, tipo, desde, hasta, estado, total, pagada_at FROM comision_liquidaciones ORDER BY id DESC LIMIT 200'))[0].map((l) => ({ ...l, total: Number(l.total) }));

// Marca la liquidación como pagada. Con Financiero el pago sale como egreso de la caja o cuenta elegida; sin él se marca a mano (RN38).
const pagar = async (id, { medio_pago } = {}, { userId } = {}) => {
  const l = await obtener(id);
  if (!l) throw invalida('Liquidación no encontrada.', 404);
  if (l.estado !== 'cerrada') throw invalida('La liquidación ya está pagada.', 409);
  const conn = await pool.getConnection();
  let estado = 'pagada';
  try {
    await conn.beginTransaction();
    const msg = await M.publicar(conn, { origen: 'ventas', destino: 'financiero', tipo: 'pago_comision', docTipo: 'liquidacion_comision', docIdGlobal: l.id_global, userId,
      contenido: { total: l.total, medio_pago: medio_pago ?? null, desde: l.desde, hasta: l.hasta } });
    if (msg) estado = 'pagada_pendiente_registro'; // Financiero lo registra por la bandeja de salida; se confirma cuando lo aplique
    await conn.query('UPDATE comision_liquidaciones SET estado = ?, medio_pago = ?, pagada_at = NOW() WHERE id = ?', [estado, medio_pago ?? null, id]);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return obtener(id);
};

// Lo que lleva acumulado un vendedor en un período, sin liquidar (para que cada mozo vea lo suyo).
const deUsuario = async (userId, desde, hasta) => {
  const { items } = await calcular(pool, desde, hasta);
  const mios = items.filter((i) => i.user_id === userId);
  return { desde, hasta, ventas: mios.filter((i) => i.tipo === 'venta').length, comision: cts(mios.reduce((a, i) => a + i.comision, 0)) / 100 };
};

module.exports = { ComisionInvalida, reglas, reglaDe, guardarRegla, activarRegla, previa, liquidar, obtener, listar, pagar, deUsuario };
