const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const llamar = require('../modulos/llamar');
const Modulos = require('../modulos/registro');
const Funciones = require('../funciones/servicio');
const StockCompras = require('../stock/comprasReceptor');
const Comprobantes = require('./comprobanteService');
const Proveedores = require('./proveedorService');
const { invalida, r2, r4, hoy, iso } = require('./comun');

// Vínculo de una factura con los ingresos de Stock (Compras RF04, RF19, RF24, RN13, RN24, RN25, RN33, RN34, RN37, RN39). Los efectos sobre Stock son mensajes independientes con su
// ID_Operacion (la factura se registra aunque Stock no responda; el vínculo queda «Pendiente de confirmar»). Sin Stock la factura se registra sin vínculo ni ingreso.
const stockPresente = () => Modulos.estaInstalado('stock');
const exigirStock = async () => { if (!(await stockPresente())) throw invalida('Sin el módulo Stock la factura no se vincula con ingresos.', 409, { codigo: 'SIN_STOCK' }); };

const cargarCompleto = async (id) => {
  const c = await Comprobantes.obtener(id);
  if (c.estado === 'anulado') throw invalida('El comprobante está anulado.', 409);
  if (c.estado === 'borrador') throw invalida('Confirmá primero el comprobante (está en borrador).', 409);
  if (!['FACTURA', 'TICKET', 'OTRO'].includes(c.clase)) throw invalida('Solo una factura de mercadería se vincula con ingresos.', 409);
  return c;
};
const mercaderia = (c) => c.lineas.filter((l) => l.tipo === 'mercaderia' && l.item_tipo && l.item_id);

// Los ingresos del proveedor «Pendientes de factura», consultados hacia abajo a Stock (RF04).
const pendientes = async (comprobanteId) => {
  const c = await cargarCompleto(comprobanteId);
  if (!(await stockPresente())) return { disponible: false, ingresos: [] };
  const p = await Proveedores.obtener(c.proveedor_id);
  const r = await llamar(15, 'compras', () => StockCompras.pendientesDeFactura({ cuit: p.cuit, proveedor: p.razon_social })).catch(() => ({ fallo: true }));
  if (r.fallo) return { disponible: false, ingresos: [], aviso: 'Stock no responde: la lista de ingresos no está disponible.' };
  return { disponible: true, ingresos: r.valor };
};

// Diferencias entre la factura y lo que entró (EX06): cantidad fuera de la tolerancia, precio distinto, ítems facturados que no entraron y viceversa. En la unidad base.
const comparar = async (c, ingresoIds, tolPct) => {
  const facturado = new Map();
  for (const l of mercaderia(c)) {
    const k = `${l.item_tipo}:${l.item_id}`, f = l.factor_aplicado ?? 1;
    const x = facturado.get(k) ?? { item_tipo: l.item_tipo, item_id: l.item_id, descripcion: l.descripcion, cantidad: 0, importe: 0 };
    x.cantidad += l.cantidad * f; x.importe += l.importe;
    facturado.set(k, x);
  }
  const recibido = new Map();
  for (const id of ingresoIds) {
    const d = await StockCompras.detalle(id);
    for (const it of d?.items ?? []) {
      const k = `${it.item_tipo}:${it.item_id}`;
      const x = recibido.get(k) ?? { cantidad: 0, costo: null };
      x.cantidad += it.cantidad; x.costo = it.costo_unitario ?? x.costo;
      recibido.set(k, x);
    }
  }
  const dif = [];
  for (const [k, f] of facturado) {
    const r = recibido.get(k);
    if (!r) { dif.push({ tipo: 'no_recibido', item: f.descripcion, facturado: r4(f.cantidad), recibido: 0 }); continue; }
    if (Math.abs(r.cantidad - f.cantidad) > f.cantidad * tolPct / 100) dif.push({ tipo: 'cantidad', item: f.descripcion, facturado: r4(f.cantidad), recibido: r4(r.cantidad) });
    const precio = f.cantidad ? f.importe / f.cantidad : 0;
    if (r.costo !== null && Math.abs(r.costo - precio) > 0.01) dif.push({ tipo: 'precio', item: f.descripcion, facturado: r4(precio), recibido: r4(r.costo) });
  }
  for (const [k, r] of recibido) if (!facturado.has(k)) dif.push({ tipo: 'no_facturado', item: k, facturado: 0, recibido: r4(r.cantidad) });
  return dif;
};

const actualizarEstado = async (c, hayVinculos, diferencias) => {
  const estado = !hayVinculos ? 'pendiente_recepcion' : diferencias.length ? 'con_diferencias' : 'registrado';
  await pool.query("UPDATE cmp_comprobantes SET estado = ? WHERE id = ? AND estado IN ('registrado', 'pendiente_recepcion', 'con_diferencias')", [estado, c.id]);
  return estado;
};

const idOp = (c, vinculoId, tipo) => `compras:${tipo}:${c.id_global}:${vinculoId}`;

// Vincula la factura con uno o varios ingresos existentes (RF04).
const vincular = async (comprobanteId, ingresoIds, ctx) => {
  await exigirStock();
  const c = await cargarCompleto(comprobanteId);
  if (!mercaderia(c).length) throw invalida('La factura no tiene líneas de mercadería con ítem de Stock.', 409);
  const ids = [...new Set(ingresoIds ?? [])];
  if (!ids.length) throw invalida('Indicá los ingresos a vincular.');
  const pend = (await pendientes(comprobanteId)).ingresos.map((i) => i.ingreso_id_global);
  for (const id of ids) if (!pend.includes(id)) throw invalida(`El ingreso ${id} no está pendiente de factura de este proveedor.`, 409, { codigo: 'INGRESO_NO_PENDIENTE' });
  const cfg = await Proveedores.config();
  const activos = (await pool.query("SELECT ingreso_id_global FROM cmp_vinculos_ingreso WHERE comprobante_id = ? AND estado = 'activo' AND ingreso_id_global IS NOT NULL", [c.id]))[0].map((v) => v.ingreso_id_global);
  const todos = [...activos, ...ids];
  const diferencias = await comparar(c, todos, cfg.tolerancia_peso_pct);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const ingreso of ids) {
      const [r] = await conn.query("INSERT INTO cmp_vinculos_ingreso (comprobante_id, origen, ingreso_id_global, id_operacion, diferencias, user_id, ts_ms) VALUES (?, 'vinculado', ?, 'x', ?, ?, ?)", [c.id, ingreso, diferencias.length ? JSON.stringify(diferencias) : null, ctx.userId ?? null, Date.now()]);
      const op = idOp(c, r.insertId, 'vincular_ingreso');
      await conn.query('UPDATE cmp_vinculos_ingreso SET id_operacion = ? WHERE id = ?', [op, r.insertId]);
      await M.publicar(conn, { origen: 'compras', destino: 'stock', tipo: 'vincular_ingreso', docTipo: 'comprobante', docIdGlobal: c.id_global, docVersion: r.insertId, secuencia: 1, userId: ctx.userId,
        contenido: { ingreso_id_global: ingreso, comprobante_id_global: c.id_global, clave: c.clave } });
    }
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  M.despertar();
  await actualizarEstado(c, true, diferencias);
  return { ...(await Comprobantes.obtener(c.id)), diferencias, vinculos: await vinculos(c.id) };
};

const desvincular = async (comprobanteId, vinculoId, { motivo }, ctx) => {
  await exigirStock();
  const c = await cargarCompleto(comprobanteId);
  const [[v]] = await pool.query("SELECT * FROM cmp_vinculos_ingreso WHERE id = ? AND comprobante_id = ? AND estado = 'activo'", [vinculoId, c.id]);
  if (!v) throw invalida('El vínculo no existe o ya está desvinculado.', 404);
  if (typeof motivo !== 'string' || motivo.trim().length < 3) throw invalida('El motivo es obligatorio.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE cmp_vinculos_ingreso SET estado = 'desvinculado', motivo = ? WHERE id = ?", [motivo.trim().slice(0, 255), v.id]);
    // La desvinculación nunca se aplica antes que su vínculo original: viaja después y Stock la retiene hasta que el original esté confirmado (RN34).
    if (v.ingreso_id_global) await M.publicar(conn, { origen: 'compras', destino: 'stock', tipo: 'desvincular_ingreso', docTipo: 'comprobante', docIdGlobal: c.id_global, docVersion: v.id, secuencia: 2, userId: ctx.userId,
      contenido: { ingreso_id_global: v.ingreso_id_global, comprobante_id_global: c.id_global, motivo: motivo.trim() } });
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  M.despertar();
  const restantes = (await pool.query("SELECT ingreso_id_global FROM cmp_vinculos_ingreso WHERE comprobante_id = ? AND estado = 'activo'", [c.id]))[0];
  await actualizarEstado(c, restantes.length > 0, []);
  return { ...(await Comprobantes.obtener(c.id)), vinculos: await vinculos(c.id) };
};

// Los vínculos con su estado de integración: sale del mensaje que viaja a Stock (RN33) y, en un ingreso generado, de su resultado.
const vinculos = async (comprobanteId) => {
  const [filas] = await pool.query('SELECT * FROM cmp_vinculos_ingreso WHERE comprobante_id = ? ORDER BY id', [comprobanteId]);
  const out = [];
  for (const v of filas) {
    const idOp1 = v.origen === 'generado' ? v.id_operacion : v.id_operacion;
    const [[m]] = await pool.query('SELECT estado, motivo_rechazo, resultado_original, retenido_por_orden FROM mensajes_integracion WHERE id_operacion = ?', [idOp1]);
    let ingreso = v.ingreso_id_global;
    if (!ingreso && m?.resultado_original) { try { ingreso = JSON.parse(m.resultado_original).ingreso_id_global ?? null; } catch { /* resultado ilegible */ } }
    out.push({ id: v.id, origen: v.origen, estado: v.estado, ingreso_id_global: ingreso, integracion: !m ? 'sin_stock' : m.estado === 'confirmado' ? 'confirmado' : m.estado === 'rechazado' ? 'rechazado' : m.estado === 'fallido' ? 'fallido' : 'pendiente_de_confirmar',
      motivo_rechazo: m?.motivo_rechazo ?? null, diferencias: v.diferencias ? JSON.parse(v.diferencias) : [] });
  }
  return out;
};

// ---- Generar el ingreso desde la factura (RF04, RF19, RF24) ----

const generar = async (comprobanteId, d, ctx) => {
  await exigirStock();
  const c = await cargarCompleto(comprobanteId);
  const lineas = mercaderia(c);
  if (!lineas.length) throw invalida('La factura no tiene líneas de mercadería con ítem de Stock.', 409);
  if ((await pool.query("SELECT 1 FROM cmp_vinculos_ingreso WHERE comprobante_id = ? AND estado = 'activo' LIMIT 1", [c.id]))[0].length) throw invalida('La factura ya tiene un ingreso vinculado.', 409, { codigo: 'YA_VINCULADA' });
  if (!d.deposito_id) throw invalida('Indicá el depósito de destino.');
  const prov = await Proveedores.obtener(c.proveedor_id);
  const conLotes = (await Funciones.estaActiva('STK-LOTES')) && (await Funciones.estaActiva('CMP-RECEPCION-LOTES'));
  const lotesAuto = (await Funciones.estaActiva('STK-LOTES')) && !(await Funciones.estaActiva('CMP-RECEPCION-LOTES'));
  const porLinea = new Map((d.lineas ?? []).map((x) => [Number(x.linea), x]));
  const salida = [];
  const faltantes = [];
  for (const l of lineas) {
    const item = { tipo: l.item_tipo, id: l.item_id }, dato = porLinea.get(l.linea) ?? {};
    const ctl = await StockCompras.controles(item);
    const base = { item, presentacion_id: l.presentacion_id ?? undefined, costo_unitario: l.costo_unidad_base ?? r4(l.precio_unitario * (1 - l.bonificacion_pct / 100)) };
    if (ctl.serie && (await Funciones.estaActiva('STK-SERIE'))) { // RF24, RN37, EX23: una serie por unidad, sin repetidos
      const series = (dato.series ?? []).map((s) => String(s).trim());
      const esperado = l.cantidad * (l.factor_aplicado ?? 1);
      if (series.length !== esperado || series.some((s) => !s) || new Set(series).size !== series.length) faltantes.push({ linea: l.linea, motivo: `Hacen falta ${esperado} números de serie distintos (hay ${series.length}).`, codigo: 'SERIES_INVALIDAS' });
      else salida.push({ ...base, cantidad: esperado, presentacion_id: undefined, costo_unitario: l.costo_unidad_base ?? r4(l.precio_unitario * (1 - l.bonificacion_pct / 100)) , series });
      continue;
    }
    if (ctl.lote && conLotes) { // RF19, RN25, EX14, EX15: lote y vencimiento por línea, que suman la cantidad
      if (!(await puedeLotes(ctx))) throw invalida('Cargar lotes en la recepción necesita su permiso.', 403, { codigo: 'SIN_PERMISO' });
      const lotes = dato.lotes ?? [];
      if (!lotes.length || lotes.some((x) => !String(x.codigo ?? '').trim() || !x.fecha_vencimiento)) { faltantes.push({ linea: l.linea, motivo: 'Este ítem maneja lote: cargá el lote y el vencimiento.', codigo: 'LOTE_FALTANTE' }); continue; }
      if (Math.abs(lotes.reduce((s, x) => s + Number(x.cantidad), 0) - l.cantidad) > 0.0005) { faltantes.push({ linea: l.linea, motivo: `Los lotes suman ${lotes.reduce((s, x) => s + Number(x.cantidad), 0)} y la línea es ${l.cantidad}.`, codigo: 'LOTES_NO_SUMAN' }); continue; }
      const vencido = lotes.find((x) => x.fecha_vencimiento < hoy());
      if (vencido) { faltantes.push({ linea: l.linea, motivo: `El lote ${vencido.codigo} vence antes de la fecha de recepción: no se ingresa, se reclama al proveedor.`, codigo: 'VENCIMIENTO_ANTERIOR' }); continue; }
      for (const x of lotes) salida.push({ ...base, cantidad: Number(x.cantidad), lote: { codigo: String(x.codigo).trim(), fecha_vencimiento: x.fecha_vencimiento, fecha_elaboracion: x.fecha_elaboracion } });
      continue;
    }
    salida.push({ ...base, cantidad: l.cantidad, ...(ctl.lote && lotesAuto && { lote_automatico: true }) }); // RN39: Stock crea un lote automático
  }
  if (faltantes.length) {
    if (d.pendiente_recepcion) { await pool.query("UPDATE cmp_comprobantes SET estado = 'pendiente_recepcion' WHERE id = ?", [c.id]); return { ...(await Comprobantes.obtener(c.id)), pendiente_recepcion: true, faltantes }; }
    throw invalida('Faltan datos de recepción: completalos o dejá el comprobante «Pendiente de recepción».', 409, { codigo: 'RECEPCION_INCOMPLETA', detalle: { lineas: faltantes } });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query("INSERT INTO cmp_vinculos_ingreso (comprobante_id, origen, id_operacion, user_id, ts_ms) VALUES (?, 'generado', 'x', ?, ?)", [c.id, ctx.userId ?? null, Date.now()]);
    const op = idOp(c, r.insertId, 'generar_ingreso');
    await conn.query('UPDATE cmp_vinculos_ingreso SET id_operacion = ? WHERE id = ?', [op, r.insertId]);
    // El ingreso viaja con la clave de la factura: Stock agrega su vínculo y no vuelve a reservarla (Usuarios RN84).
    const [[cl]] = c.clave ? await conn.query('SELECT id_clave FROM claves_comprobante WHERE clave = ?', [c.clave]) : [[null]];
    await M.publicar(conn, { origen: 'compras', destino: 'stock', tipo: 'generar_ingreso', docTipo: 'comprobante', docIdGlobal: c.id_global, docVersion: r.insertId, secuencia: 1, userId: ctx.userId,
      contenido: { comprobante_id_global: c.id_global, deposito_id: d.deposito_id, proveedor: prov.razon_social, user_id: ctx.userId ?? null,
        comprobante: { cuit: prov.cuit, clase: c.clase, tipo: c.tipo, punto_venta: c.punto_venta, numero: c.numero, cae: c.cae ?? undefined, id_clave: cl?.id_clave }, lineas: salida } });
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  M.despertar();
  await actualizarEstado(c, true, []);
  return { ...(await Comprobantes.obtener(c.id)), vinculos: await vinculos(c.id) };
};

const puedeLotes = async (ctx) => ctx.puedeLotes !== false;

// Una factura con ingresos vinculados no se anula: primero se desvinculan (RN08).
Comprobantes.alAnular(async (c) => {
  const [[v]] = await pool.query("SELECT COUNT(*) AS n FROM cmp_vinculos_ingreso WHERE comprobante_id = ? AND estado = 'activo'", [c.id]);
  return v.n ? { mensaje: 'El comprobante tiene ingresos de Stock vinculados: desvinculalos antes de anularlo.', codigo: 'TIENE_INGRESOS' } : null;
});

// Los comprobantes con diferencias contra lo recibido: los reclamos pendientes al proveedor (EX06).
const reclamos = async () => {
  const [filas] = await pool.query(
    `SELECT c.id, c.id_global, c.clase, c.tipo, c.punto_venta, c.numero, c.fecha, c.total, p.razon_social AS proveedor, v.diferencias FROM cmp_comprobantes c JOIN cmp_proveedores p ON p.id = c.proveedor_id
     JOIN cmp_vinculos_ingreso v ON v.comprobante_id = c.id AND v.estado = 'activo' WHERE c.estado = 'con_diferencias' AND v.diferencias IS NOT NULL ORDER BY c.fecha`);
  const por = new Map();
  for (const f of filas) if (!por.has(f.id)) por.set(f.id, { comprobante_id: f.id, proveedor: f.proveedor, comprobante: `${f.clase} ${f.tipo} ${f.punto_venta}-${f.numero}`, fecha: iso(f.fecha), total: Number(f.total), diferencias: JSON.parse(f.diferencias) });
  return [...por.values()];
};

module.exports = { pendientes, vincular, desvincular, vinculos, generar, reclamos, comparar, r2 };
