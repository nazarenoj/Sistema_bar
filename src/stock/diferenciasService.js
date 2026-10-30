const pool = require('../config/db');
const Parametro = require('../models/parametroModel');
const Notificacion = require('../models/notificacionModel');
const Modulos = require('../modulos/registro');
const Deposito = require('../models/depositoModel');
const Receta = require('./recetaService');

// Diferencias de integración, vendido contra descontado (Stock RF35). Por venta, ítem y depósito compara lo que la venta
// debería haber descontado (la línea expandida, RF09) con lo que quedó en los movimientos. No corrige: se corrige reprocesando
// el mensaje desde la bandeja de pendientes o con un contramovimiento autorizado.
const ALERTAN = (causa) => causa !== 'en_tramite';
const redondear = (n) => Math.round(n * 1000) / 1000;

const esperado = async (conn, lineas) => {
  const m = new Map(); // 'tipo:id:deposito' -> cantidad
  for (const l of lineas) {
    const [[p]] = await conn.query('SELECT sector_id FROM productos WHERE id = ?', [l.producto_id]);
    const dep = await Deposito.depositoDeSector(p?.sector_id ?? null, conn);
    for (const [k, q] of await Receta.hojas(conn, l.producto_id, l.cantidad)) m.set(`${k}:${dep.id}`, (m.get(`${k}:${dep.id}`) ?? 0) + q);
  }
  return m;
};

const calcular = async ({ desde, hasta } = {}) => {
  const p = await Parametro.todos();
  const tramiteMs = (p.diferencias_tramite_min ?? 10) * 60000;
  const stockInstalado = await Modulos.estaInstalado('stock');
  const dif = [];
  const d = (venta, tipo, id, dep, vendido, descontado, causa, estadoMensaje = null, detalle = null) =>
    dif.push({ doc_id_global: venta, item_tipo: tipo, item_id: id, deposito_id: dep, vendido: redondear(vendido), descontado: redondear(descontado), causa, estado_mensaje: estadoMensaje, detalle });

  const donde = [];
  const params = [];
  if (desde) { donde.push('created_at >= ?'); params.push(`${desde} 00:00:00`); }
  if (hasta) { donde.push('created_at <= ?'); params.push(`${hasta} 23:59:59`); }
  const [ventas] = await pool.query(`SELECT id_global, detalle FROM ventas ${donde.length ? `WHERE ${donde.join(' AND ')}` : ''} ORDER BY id LIMIT 5000`, params);
  const ids = new Set(ventas.map((v) => v.id_global));

  for (const v of ventas) {
    const lineas = JSON.parse(v.detalle).map((l, linea) => ({ linea, producto_id: l.producto_id, cantidad: l.cantidad }));
    const esp = await esperado(pool, lineas);
    const [msgs] = await pool.query("SELECT estado, motivo_rechazo, ts_origen_ms, retenido_por_orden FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'descuento_stock' ORDER BY id", [v.id_global]);
    const [movs] = await pool.query(
      `SELECT insumo_id, producto_id, deposito_id, -SUM(cantidad) AS descontado, COUNT(DISTINCT SUBSTRING_INDEX(operacion_clave, '|', 1)) AS operaciones
       FROM stock_movimientos WHERE documento = ? AND tipo = 'venta' GROUP BY insumo_id, producto_id, deposito_id`, [v.id_global]);
    const desc = new Map(movs.map((m) => [`${m.insumo_id ? `insumo:${m.insumo_id}` : `producto:${m.producto_id}`}:${m.deposito_id}`, m]));
    const claveDe = (k) => { const [tipo, id, dep] = k.split(':'); return [tipo, Number(id), Number(dep)]; };

    if (!msgs.length) {
      if (stockInstalado && esp.size) for (const [k, q] of esp) { const [t, i, dp] = claveDe(k); d(v.id_global, t, i, dp, q, desc.get(k)?.descontado ?? 0, 'venta_sin_mensaje'); }
      continue;
    }
    const msg = msgs[0];
    for (const [k, q] of esp) {
      const [t, i, dp] = claveDe(k);
      const hecho = Number(desc.get(k)?.descontado ?? 0);
      if (msg.estado === 'confirmado') {
        if (Math.abs(q - hecho) > 0.0005) d(v.id_global, t, i, dp, q, hecho, 'diferencia_cantidad', 'confirmado');
      } else if (msg.estado === 'rechazado') d(v.id_global, t, i, dp, q, hecho, 'rechazado', 'rechazado', msg.motivo_rechazo);
      else if (msg.estado === 'fallido') d(v.id_global, t, i, dp, q, hecho, 'fallido', 'fallido');
      else d(v.id_global, t, i, dp, q, hecho, Date.now() - Number(msg.ts_origen_ms) < tramiteMs ? 'en_tramite' : 'descuento_pendiente', msg.estado);
    }
    for (const [k, m] of desc) if (Number(m.operaciones) > 1) { const [t, i, dp] = claveDe(k); d(v.id_global, t, i, dp, esp.get(k) ?? 0, Number(m.descontado), 'descuento_duplicado', 'confirmado', 'dos movimientos del mismo documento con distinta ID_Operacion'); }
  }

  // Anulaciones o devoluciones que esperan a su venta original (RN51).
  const [retenidas] = await pool.query("SELECT doc_id_global FROM mensajes_integracion WHERE modulo_destino = 'stock' AND tipo = 'reingreso_stock' AND retenido_por_orden = 1 AND descartado = 0");
  for (const r of retenidas) d(r.doc_id_global, null, null, null, 0, 0, 'anulacion_retenida', 'pendiente');

  // Movimientos de venta cuyo documento de origen no existe.
  const [huerfanos] = await pool.query("SELECT DISTINCT documento FROM stock_movimientos WHERE tipo = 'venta' AND documento_tipo = 'venta'");
  for (const h of huerfanos) if (!ids.has(h.documento) && !(desde || hasta)) {
    const [[existe]] = await pool.query('SELECT 1 AS si FROM ventas WHERE id_global = ?', [h.documento]);
    if (!existe) d(h.documento, null, null, null, 0, 0, 'movimiento_sin_venta');
  }
  return dif;
};

// Ejecuta el informe: abre las diferencias nuevas con su alerta crítica (salvo "en trámite") y resuelve las que ya no están.
const ejecutar = async (rango = {}) => {
  const dif = await calcular(rango);
  const vigentes = new Set();
  for (const x of dif) {
    const clave = [x.doc_id_global, x.item_tipo, x.item_id, x.deposito_id, x.causa].join('|');
    vigentes.add(clave);
    await pool.query(
      `INSERT INTO diferencias_integracion (clave, doc_id_global, item_tipo, item_id, deposito_id, vendido, descontado, causa, estado_mensaje, detalle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE vendido = VALUES(vendido), descontado = VALUES(descontado), estado_mensaje = VALUES(estado_mensaje), detalle = VALUES(detalle),
         estado = 'abierta', resuelta_at = NULL`, [clave, x.doc_id_global, x.item_tipo, x.item_id, x.deposito_id, x.vendido, x.descontado, x.causa, x.estado_mensaje, x.detalle]);
    if (ALERTAN(x.causa))
      await Notificacion.crear({ modulo: 'stock', tipo: 'diferencia_integracion', severidad: 'critica', roles: ['administrador'], clave: `dif-integracion:${clave}`.slice(0, 120),
        mensaje: `Diferencia de integración (${x.causa}) en la venta ${x.doc_id_global}${x.item_tipo ? `, ${x.item_tipo} ${x.item_id}` : ''}: vendido ${x.vendido}, descontado ${x.descontado}.` });
  }
  // Se resuelven solo las que caen dentro de lo consultado (con rango, las demás no se evaluaron).
  const [abiertas] = await pool.query("SELECT id, clave, doc_id_global FROM diferencias_integracion WHERE estado = 'abierta'");
  let resueltas = 0;
  for (const a of abiertas) {
    if (vigentes.has(a.clave)) continue;
    if ((rango.desde || rango.hasta) && !(await enRango(a.doc_id_global, rango))) continue;
    await pool.query("UPDATE diferencias_integracion SET estado = 'resuelta', resuelta_at = NOW() WHERE id = ?", [a.id]);
    await Notificacion.resolverPorClave(`dif-integracion:${a.clave}`.slice(0, 120), 'La diferencia se resolvió');
    resueltas++;
  }
  return { detectadas: dif.length, alertadas: dif.filter((x) => ALERTAN(x.causa)).length, resueltas };
};

const enRango = async (doc, { desde, hasta }) => {
  const [[v]] = await pool.query('SELECT created_at FROM ventas WHERE id_global = ?', [doc]);
  if (!v) return false;
  const f = new Date(v.created_at);
  return (!desde || f >= new Date(`${desde} 00:00:00`)) && (!hasta || f <= new Date(`${hasta} 23:59:59`));
};

const listar = async ({ estado, causa, deposito_id } = {}) => {
  const donde = [];
  const params = [];
  if (estado) { donde.push('estado = ?'); params.push(estado); }
  if (causa) { donde.push('causa = ?'); params.push(causa); }
  if (deposito_id) { donde.push('deposito_id = ?'); params.push(deposito_id); }
  return (await pool.query(`SELECT * FROM diferencias_integracion ${donde.length ? `WHERE ${donde.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 500`, params))[0]
    .map((r) => ({ ...r, vendido: Number(r.vendido), descontado: Number(r.descontado), diferencia: Number(r.vendido) - Number(r.descontado) }));
};

module.exports = { calcular, ejecutar, listar };
