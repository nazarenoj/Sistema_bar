const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const StockCompras = require('../stock/comprasReceptor');
const Comprobantes = require('./comprobanteService');
const { invalida, r2, iso } = require('./comun');

// Devolución a proveedor y nota de crédito (Compras RF25, RN38, EX24). La devolución física la registra Stock (un egreso) y la informa por mensaje: Compras la guarda como reclamo
// pendiente de nota de crédito. Al cargar la nota se vincula a uno o más egresos del mismo proveedor; el vínculo viaja a Stock, que marca el egreso. La nota reduce la deuda
// (la cuenta corriente se deriva de los comprobantes, RN08). Compras no registra egresos físicos ni toca el costo de inventario.

// Stock publica «devolución a proveedor»; es idempotente por el documento (RN32).
M.registrarReceptor('compras', 'devolucion_proveedor', async (conn, c, ctx) => {
  const [[ya]] = await conn.query('SELECT id FROM cmp_devoluciones WHERE id_global = ?', [ctx.docIdGlobal]);
  if (ya) return { id: ya.id, ya_procesado: true };
  let proveedorId = null, nombre = c.proveedor ?? null;
  const ing = c.ingreso ? await StockCompras.detalle(c.ingreso).catch(() => null) : null;
  if (ing?.comprobante_cuit) proveedorId = (await conn.query('SELECT id FROM cmp_proveedores WHERE cuit = ?', [String(ing.comprobante_cuit).replace(/\D/g, '')]))[0][0]?.id ?? null;
  if (!proveedorId && nombre) proveedorId = (await conn.query('SELECT id FROM cmp_proveedores WHERE razon_social = ? LIMIT 1', [nombre]))[0][0]?.id ?? null;
  const [r] = await conn.query('INSERT INTO cmp_devoluciones (id_global, egreso_id_global, ingreso_id_global, proveedor_id, proveedor_nombre, item_tipo, item_id, lote_id, cantidad, costo_unitario, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [ctx.docIdGlobal, c.id_egreso_stock ?? null, c.ingreso ?? null, proveedorId, nombre, c.item.tipo, c.item.id, c.lote_id ?? null, c.cantidad, c.costo_unitario ?? null, Date.now()]);
  return { id: r.insertId };
});

const vista = (d) => ({ id: d.id, id_global: d.id_global, egreso_id_global: d.egreso_id_global, ingreso_id_global: d.ingreso_id_global, proveedor_id: d.proveedor_id, proveedor: d.proveedor ?? d.proveedor_nombre, item_tipo: d.item_tipo, item_id: d.item_id, nombre: d.nombre ?? null,
  cantidad: Number(d.cantidad), costo_unitario: d.costo_unitario === null ? null : Number(d.costo_unitario), costo_devuelto: d.costo_unitario === null ? null : r2(Number(d.cantidad) * Number(d.costo_unitario)), estado: d.estado, comprobante_id: d.comprobante_id,
  diferencia_importe: d.diferencia_importe === null ? null : Number(d.diferencia_importe), motivo_diferencia: d.motivo_diferencia, fecha: new Date(Number(d.ts_ms)).toISOString().slice(0, 10) });

const listar = async ({ proveedorId, estado } = {}) => {
  const w = [], p = [];
  if (proveedorId) { w.push('(d.proveedor_id = ? OR d.proveedor_id IS NULL)'); p.push(Number(proveedorId)); }
  if (estado) { w.push('d.estado = ?'); p.push(estado); }
  return (await pool.query(
    `SELECT d.*, pr.razon_social AS proveedor, COALESCE((SELECT nombre FROM insumos WHERE id = d.item_id AND d.item_tipo = 'insumo'), (SELECT nombre FROM productos WHERE id = d.item_id AND d.item_tipo = 'producto')) AS nombre
     FROM cmp_devoluciones d LEFT JOIN cmp_proveedores pr ON pr.id = d.proveedor_id ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY d.id DESC LIMIT 300`, p))[0].map(vista);
};

// Vincula una nota de crédito con egresos «Devolución a proveedor» pendientes (EX24).
const vincular = async (comprobanteId, d, ctx = {}) => {
  const c = await Comprobantes.obtener(comprobanteId);
  if (c.clase !== 'NOTA_CREDITO' || c.estado === 'anulado' || c.estado === 'borrador') throw invalida('Solo una nota de crédito vigente se vincula con devoluciones.', 409);
  const ids = [...new Set(d.devolucion_ids ?? [])].map(Number);
  if (!ids.length) throw invalida('Indicá las devoluciones a vincular.');
  const [devs] = await pool.query('SELECT * FROM cmp_devoluciones WHERE id IN (?)', [ids]);
  if (devs.length !== ids.length) throw invalida('Alguna devolución no existe.', 404);
  for (const x of devs) {
    if (x.estado !== 'pendiente_nc') throw invalida(`La devolución ${x.id} ya tiene su nota de crédito.`, 409, { codigo: 'DEVOLUCION_CON_NC' });
    if (x.proveedor_id && x.proveedor_id !== c.proveedor_id) throw invalida(`La devolución ${x.id} es de otro proveedor.`, 409, { codigo: 'OTRO_PROVEEDOR' });
  }
  // No se acredita más cantidad que la devuelta (por ítem).
  const devuelta = new Map();
  for (const x of devs) devuelta.set(`${x.item_tipo}:${x.item_id}`, (devuelta.get(`${x.item_tipo}:${x.item_id}`) ?? 0) + Number(x.cantidad));
  const acreditada = new Map();
  for (const l of c.lineas.filter((x) => x.tipo === 'mercaderia' && x.item_id)) acreditada.set(`${l.item_tipo}:${l.item_id}`, (acreditada.get(`${l.item_tipo}:${l.item_id}`) ?? 0) + Number(l.cantidad) * Number(l.factor_aplicado ?? 1));
  for (const [k, q] of acreditada) if (q > (devuelta.get(k) ?? 0) + 1e-9) throw invalida(`La nota acredita ${q} de ${k} y solo se devolvieron ${devuelta.get(k) ?? 0}.`, 409, { codigo: 'CANTIDAD_SUPERA_DEVUELTA' });
  const devuelto = r2(devs.reduce((s, x) => s + (x.costo_unitario === null ? 0 : Number(x.cantidad) * Number(x.costo_unitario)), 0));
  const nota = r2(Number(c.neto_gravado) + Number(c.no_gravado) + Number(c.exento));
  const diferencia = r2(nota - devuelto);
  const conf = d.confirmar_diferencia;
  if (Math.abs(diferencia) > 0.01 && !(conf && typeof conf.motivo === 'string' && conf.motivo.trim().length >= 3))
    throw invalida(`El importe de la nota (${nota}) difiere del costo devuelto (${devuelto}): confirmá la diferencia con un motivo.`, 409, { codigo: 'IMPORTE_DIFIERE', detalle: { nota, devuelto, diferencia } });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [i, x] of devs.entries()) {
      const [u] = await conn.query("UPDATE cmp_devoluciones SET estado = 'con_nc', comprobante_id = ?, proveedor_id = COALESCE(proveedor_id, ?), diferencia_importe = ?, motivo_diferencia = ? WHERE id = ? AND estado = 'pendiente_nc'",
        [c.id, c.proveedor_id, i === 0 && Math.abs(diferencia) > 0.01 ? diferencia : null, i === 0 && Math.abs(diferencia) > 0.01 ? conf.motivo.trim().slice(0, 255) : null, x.id]);
      if (!u.affectedRows) throw invalida(`La devolución ${x.id} ya tiene su nota de crédito.`, 409, { codigo: 'DEVOLUCION_CON_NC' });
      await M.publicar(conn, { origen: 'compras', destino: 'stock', tipo: 'nota_credito_devolucion', docTipo: 'comprobante', docIdGlobal: c.id_global, docVersion: x.id, userId: ctx.userId,
        contenido: { devolucion_id_global: x.id_global, comprobante_id_global: c.id_global, clave: c.clave, importe: nota } });
    }
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  M.despertar();
  return { comprobante_id: c.id, nota, devuelto, diferencia, devoluciones: await listar({ estado: 'con_nc' }).then((l) => l.filter((x) => x.comprobante_id === c.id)) };
};

module.exports = { listar, vincular, iso };
