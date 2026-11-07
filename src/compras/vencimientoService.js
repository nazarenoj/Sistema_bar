const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const Notificacion = require('../models/notificacionModel');
const Comprobantes = require('./comprobanteService');
const Proveedores = require('./proveedorService');
const { invalida, r2, cts, hoy, iso } = require('./comun');

// Vencimientos y cuenta corriente de proveedor (Compras RF02, RF05, RN08). El saldo del proveedor es la suma de los comprobantes menos las notas de crédito y los pagos, y nunca se
// edita: se deriva siempre. Un comprobante tiene una o varias cuotas con fecha e importe; la agenda las muestra y avisa N días antes de cada una (parametrizable).
const suma = (f, n) => new Date(new Date(`${f}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const DEUDA = ['FACTURA', 'NOTA_DEBITO', 'TICKET', 'OTRO']; // suman a la deuda; la nota de crédito resta; el recibo es un comprobante del proveedor, no un pago nuestro

// Las cuotas de un comprobante: las que se indican (tienen que sumar el total) o una sola a la condición de pago del proveedor. Una nota de crédito no vence.
const cuotasDe = async (conn, comp, cuotas, tolerancia) => {
  if (comp.clase === 'NOTA_CREDITO') return [];
  const total = Number(comp.total);
  if (Array.isArray(cuotas) && cuotas.length) {
    const lista = cuotas.map((c, i) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.fecha ?? ''))) throw invalida(`La fecha de la cuota ${i + 1} va como AAAA-MM-DD.`);
      if (!(Number(c.importe) > 0)) throw invalida(`El importe de la cuota ${i + 1} debe ser mayor a cero.`);
      return { cuota: i + 1, fecha: String(c.fecha), importe: r2(c.importe) };
    });
    if (Math.abs(lista.reduce((s, c) => s + c.importe, 0) - total) > tolerancia) throw invalida(`Las cuotas suman ${r2(lista.reduce((s, c) => s + c.importe, 0))} y el comprobante es ${total}.`, 400, { codigo: 'CUOTAS_NO_SUMAN' });
    return lista;
  }
  const [[p]] = await conn.query('SELECT condicion_pago_dias FROM cmp_proveedores WHERE id = ?', [comp.proveedor_id]);
  return [{ cuota: 1, fecha: suma(iso(comp.fecha), p?.condicion_pago_dias ?? 0), importe: total }];
};

const crear = async (conn, comp, cuotas) => {
  const cfg = await Proveedores.config(conn);
  for (const c of await cuotasDe(conn, comp, cuotas, cfg.tolerancia_redondeo))
    await conn.query("INSERT INTO cmp_vencimientos (comprobante_id, cuota, fecha, importe, saldo) VALUES (?, ?, ?, ?, ?)", [comp.id, c.cuota, c.fecha, c.importe, c.importe]);
};

// Reemplaza las cuotas mientras ninguna tenga pagos aplicados.
const reemplazar = async (comprobanteId, cuotas) => {
  const c = await Comprobantes.fila(comprobanteId);
  if (c.estado === 'anulado' || c.estado === 'borrador') throw invalida('El comprobante no admite cambiar sus cuotas.', 409);
  const [pagadas] = await pool.query("SELECT 1 FROM cmp_vencimientos WHERE comprobante_id = ? AND saldo < importe LIMIT 1", [comprobanteId]);
  if (pagadas.length) throw invalida('Una cuota ya tiene pagos aplicados: no se cambian las cuotas.', 409, { codigo: 'CON_PAGOS' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM cmp_vencimientos WHERE comprobante_id = ?', [comprobanteId]);
    await crear(conn, c, cuotas);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  publicar().catch(() => {});
  return agenda({ comprobanteId });
};

// ---- Agenda y avisos (RF05) ----

const agenda = async ({ desde, hasta, proveedorId, estado = 'pendiente', comprobanteId, limite = 500 } = {}) => {
  const w = [], p = [];
  if (estado !== 'todos') { w.push('v.estado = ?'); p.push(estado); }
  if (desde) { w.push('v.fecha >= ?'); p.push(desde); }
  if (hasta) { w.push('v.fecha <= ?'); p.push(hasta); }
  if (proveedorId) { w.push('c.proveedor_id = ?'); p.push(Number(proveedorId)); }
  if (comprobanteId) { w.push('v.comprobante_id = ?'); p.push(Number(comprobanteId)); }
  const [filas] = await pool.query(
    `SELECT v.*, c.clase, c.tipo, c.punto_venta, c.numero, c.moneda, p.razon_social AS proveedor, p.id AS proveedor_id FROM cmp_vencimientos v JOIN cmp_comprobantes c ON c.id = v.comprobante_id
     JOIN cmp_proveedores p ON p.id = c.proveedor_id ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY v.fecha, v.id LIMIT ?`, [...p, Math.min(Number(limite) || 500, 2000)]);
  const h = hoy();
  return filas.map((v) => ({ id: v.id, comprobante_id: v.comprobante_id, proveedor_id: v.proveedor_id, proveedor: v.proveedor, comprobante: `${v.clase} ${v.tipo} ${v.punto_venta}-${v.numero}`, cuota: v.cuota, fecha: iso(v.fecha),
    moneda: v.moneda, importe: Number(v.importe), saldo: Number(v.saldo), estado: v.estado, vencido: v.estado === 'pendiente' && iso(v.fecha) < h, dias: Math.round((new Date(`${iso(v.fecha)}T00:00:00Z`) - new Date(`${h}T00:00:00Z`)) / 86400000) }));
};

// Avisa N días antes de cada vencimiento (y mientras esté vencido y sin pagar): una alerta por cuota, que se resuelve sola al pagarse.
const avisos = async () => {
  const { aviso_vencimiento_dias: dias } = await Proveedores.config();
  const limite = suma(hoy(), dias);
  const lista = await agenda({ hasta: limite });
  for (const v of lista) await Notificacion.crear({ modulo: 'compras', tipo: 'vencimiento_proveedor', severidad: v.vencido ? 'alta' : 'media', roles: ['administrativo', 'gerente'], clave: `cmp-venc:${v.id}`,
    mensaje: `${v.vencido ? 'Vencido' : 'Vence'} el ${v.fecha}: ${v.proveedor}, ${v.comprobante}, cuota ${v.cuota} por ${v.saldo}.` });
  return { emitidos: lista.length };
};
const resolverAviso = (vencimientoId) => Notificacion.resolverPorClave(`cmp-venc:${vencimientoId}`, 'Se pagó el vencimiento');

// ---- Cuenta corriente del proveedor (RF02) ----

const signo = (clase) => (clase === 'NOTA_CREDITO' ? -1 : DEUDA.includes(clase) ? 1 : 0);

const cuenta = async (proveedorId, { moneda } = {}) => {
  const prov = await Proveedores.obtener(proveedorId);
  const mon = String(moneda ?? prov.moneda).toUpperCase();
  const [comps] = await pool.query("SELECT id, clase, tipo, punto_venta, numero, fecha, total FROM cmp_comprobantes WHERE proveedor_id = ? AND moneda = ? AND estado NOT IN ('anulado', 'borrador') ORDER BY fecha, id", [proveedorId, mon]);
  const movimientos = [];
  for (const c of comps) if (signo(c.clase)) movimientos.push({ fecha: iso(c.fecha), orden: c.id, concepto: `${c.clase} ${c.tipo} ${c.punto_venta}-${c.numero}`, comprobante_id: c.id, importe: signo(c.clase) * Number(c.total) });
  for (const x of movimientosExternos) movimientos.push(...(await x(proveedorId, mon)));
  movimientos.sort((a, b) => (a.fecha === b.fecha ? a.orden - b.orden : a.fecha < b.fecha ? -1 : 1));
  let saldo = 0;
  const detalle = movimientos.map((m) => { saldo = r2(saldo + m.importe); return { ...m, saldo }; });
  const abiertas = await agenda({ proveedorId });
  const { tramos_antiguedad: tramosTxt } = await tramosConfig();
  const tramos = tramosTxt.split(',').map(Number);
  const edades = Array(tramos.length + 2).fill(0);
  for (const v of abiertas.filter((x) => x.moneda === mon)) {
    const atraso = Math.max(-v.dias, 0); // días de vencida
    const i = tramos.findIndex((t) => atraso <= t);
    edades[atraso === 0 ? 0 : i === -1 ? tramos.length + 1 : i + 1] += v.saldo;
  }
  return { proveedor: { id: prov.id, razon_social: prov.razon_social, cuit: prov.cuit }, moneda: mon, saldo, movimientos: detalle, composicion: abiertas.filter((x) => x.moneda === mon),
    antiguedad: { tramos: ['al día', ...tramos.map((t, i) => (i === 0 ? `hasta ${t} días` : `${tramos[i - 1] + 1} a ${t} días`)), `más de ${tramos[tramos.length - 1]} días`], importes: edades.map(r2) } };
};
// Los pagos y anticipos (H5) se suman a la cuenta registrando acá su movimiento.
const movimientosExternos = [];
const alArmarCuenta = (fn) => movimientosExternos.push(fn);

const tramosConfig = async () => (await pool.query('SELECT tramos_antiguedad FROM cmp_config WHERE id = 1'))[0][0];

// La deuda de cada proveedor por moneda (RF02): lo que pide el informe y el tablero.
const deudaPorProveedor = async () => {
  const [provs] = await pool.query('SELECT id FROM cmp_proveedores ORDER BY razon_social');
  const out = [];
  for (const p of provs) {
    const monedas = (await pool.query("SELECT DISTINCT moneda FROM cmp_comprobantes WHERE proveedor_id = ? AND estado NOT IN ('anulado', 'borrador')", [p.id]))[0];
    for (const { moneda } of monedas) { const c = await cuenta(p.id, { moneda }); if (c.saldo !== 0) out.push({ proveedor_id: p.id, proveedor: c.proveedor.razon_social, moneda, saldo: c.saldo }); }
  }
  return out;
};

// ---- Flujo de fondos: Compras publica sus vencimientos a pagar y Financiero se suscribe (Financiero RF13) ----

const publicar = async () => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [filas] = await conn.query(
      `SELECT v.fecha, SUM(v.saldo) AS importe FROM cmp_vencimientos v JOIN cmp_comprobantes c ON c.id = v.comprobante_id WHERE v.estado = 'pendiente' AND v.saldo > 0 AND c.moneda = 'ARS' GROUP BY v.fecha ORDER BY v.fecha`);
    const [[{ v }]] = await conn.query("SELECT COALESCE(MAX(doc_version), 0) + 1 AS v FROM mensajes_integracion WHERE doc_id_global = 'COMPRAS-VENCIMIENTOS' AND tipo = 'vencimientos_por_pagar'");
    const r = await M.publicar(conn, { origen: 'compras', destino: 'financiero', tipo: 'vencimientos_por_pagar', docTipo: 'vencimientos', docIdGlobal: 'COMPRAS-VENCIMIENTOS', docVersion: v,
      contenido: { generado_ms: Date.now(), vencimientos: filas.map((f) => ({ fecha: iso(f.fecha), importe: Number(f.importe) })) } });
    await conn.commit();
    if (r) M.despertar();
    return r;
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

// Las cuotas nacen con el comprobante (en su misma transacción) y mueren con su anulación (RN08).
Comprobantes.alRegistrar(async (conn, comp, datos) => crear(conn, comp, datos.vencimientos));
Comprobantes.alAnulado(async (comp) => { await pool.query("UPDATE cmp_vencimientos SET estado = 'anulado' WHERE comprobante_id = ?", [comp.id]); });

module.exports = { crear, reemplazar, agenda, avisos, resolverAviso, cuenta, deudaPorProveedor, alArmarCuenta, publicar, suma, cts };
