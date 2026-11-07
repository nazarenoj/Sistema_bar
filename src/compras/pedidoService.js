const PDFDocument = require('pdfkit');
const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const puertos = require('../modulos/puertos');
const Modulos = require('../modulos/registro');
const Funciones = require('../funciones/servicio');
const Correo = require('../servicios/correoService');
const Presentacion = require('../models/presentacionModel');
const Repo = require('../stock/reposicionAutoService');
const StockCompras = require('../stock/comprasReceptor');
const Proveedores = require('./proveedorService');
const Ingresos = require('./ingresoService');
const { idGlobal } = require('../utils/idGlobal');
const { invalida, r2, r4, hoy, iso } = require('./comun');

// Pedidos a proveedores (Compras RF12, RF17, RF20, RN22, RN26, EX17). Un pedido nace en borrador, un usuario con permiso lo confirma (queda Pendiente) y otro paso lo envía (PDF o correo):
// uno enviado no se edita, se reemplaza. Con Stock, la recepción de los ingresos vinculados a facturas lo cierra de a poco y Stock recibe el pedido en tránsito por mensajes.
// Compras nunca compra sola: la sugerencia de Stock es una propuesta que se confirma a mano (RN26).
const DIAS = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];
const exigir = async () => { if (!(await Funciones.estaActiva('CMP-PEDIDOS'))) throw invalida('Los pedidos necesitan la función CMP-PEDIDOS.', 409, { codigo: 'FUNCION_INACTIVA' }); };
const conStock = () => Modulos.estaInstalado('stock');
const fechaDe = (d) => new Date(`${d}T12:00:00Z`);
const sumarDias = (d, n) => { const x = fechaDe(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// RN22: el plazo se cuenta desde el día del pedido (o del siguiente, si se confirma pasada la hora de corte) y la entrega cae en el primer día de entrega igual o posterior.
const entregaPrevista = (prov, fecha, ahora = new Date()) => {
  if (prov.plazo_entrega_dias === null || prov.plazo_entrega_dias === undefined) return null;
  let desde = fecha;
  const hhmm = `${String(ahora.getHours()).padStart(2, '0')}:${String(ahora.getMinutes()).padStart(2, '0')}`;
  if (prov.hora_corte && fecha === hoy() && hhmm > prov.hora_corte) desde = sumarDias(fecha, 1);
  let f = sumarDias(desde, prov.plazo_entrega_dias);
  const dias = prov.dias_entrega ?? [];
  if (dias.length) for (let i = 0; i < 7 && !dias.includes(DIAS[fechaDe(f).getUTCDay()]); i++) f = sumarDias(f, 1);
  return f;
};

// El puerto «Plazos de entrega del proveedor» (RF17): el plazo del proveedor principal del ítem; sin proveedor, Stock usa el plazo manual.
puertos.registrar('plazosEntrega', {
  plazo: async (item) => {
    const tipo = item.tipo ?? item.item_tipo, id = Number(item.id ?? item.item_id);
    const [[r]] = await pool.query('SELECT p.plazo_entrega_dias AS plazo FROM cmp_costos_reposicion c JOIN cmp_proveedores p ON p.id = c.proveedor_principal_id WHERE c.item_tipo = ? AND c.item_id = ?', [tipo, id]);
    return r && r.plazo !== null ? Number(r.plazo) : null;
  },
});

// ---- Lectura ----

const lineasDe = async (id) => (await pool.query('SELECT * FROM cmp_pedido_lineas WHERE pedido_id = ? ORDER BY linea', [id]))[0].map((l) => ({
  linea: l.linea, item_tipo: l.item_tipo, item_id: l.item_id, descripcion: l.descripcion, presentacion_id: l.presentacion_id, factor_aplicado: Number(l.factor_aplicado), unidad: l.unidad, cantidad: Number(l.cantidad),
  cantidad_sugerida: l.cantidad_sugerida === null ? null : Number(l.cantidad_sugerida), cantidad_recibida: Number(l.cantidad_recibida), precio_estimado: l.precio_estimado === null ? null : Number(l.precio_estimado), explicacion: l.explicacion ? JSON.parse(l.explicacion) : null }));
const vista = (p, lineas) => ({ id: p.id, id_global: p.id_global, proveedor_id: p.proveedor_id, proveedor: p.proveedor, estado: p.estado, fecha: iso(p.fecha), entrega_prevista: iso(p.entrega_prevista), moneda: p.moneda, origen: p.origen,
  observacion: p.observacion, enviado: p.enviado_ms !== null, enviado_ms: p.enviado_ms === null ? null : Number(p.enviado_ms), enviado_a: p.enviado_a, reemplaza_id: p.reemplaza_id, reemplazado_por: p.reemplazado_por, motivo_cancelacion: p.motivo_cancelacion,
  total_estimado: r2(lineas.reduce((s, l) => s + l.cantidad * (l.precio_estimado ?? 0), 0)), lineas });
const fila = async (id, db = pool) => {
  const [[p]] = await db.query('SELECT p.*, pr.razon_social AS proveedor FROM cmp_pedidos p JOIN cmp_proveedores pr ON pr.id = p.proveedor_id WHERE p.id = ?', [id]);
  if (!p) throw invalida('Pedido no encontrado.', 404);
  return p;
};
const obtener = async (id) => vista(await fila(id), await lineasDe(id));
const listar = async ({ proveedorId, estado, limite = 200 } = {}) => {
  const w = [], p = [];
  if (proveedorId) { w.push('p.proveedor_id = ?'); p.push(Number(proveedorId)); }
  if (estado) { w.push('p.estado = ?'); p.push(estado); }
  const [f] = await pool.query(`SELECT p.*, pr.razon_social AS proveedor FROM cmp_pedidos p JOIN cmp_proveedores pr ON pr.id = p.proveedor_id ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY p.id DESC LIMIT ?`, [...p, Math.min(Number(limite) || 200, 500)]);
  return Promise.all(f.map(async (x) => vista(x, await lineasDe(x.id))));
};

// ---- Pedido en tránsito hacia Stock ----

const publicarTransito = async (conn, p, lineas) => {
  if (!(await conn7stock())) return;
  const abierto = ['pendiente', 'recibido_parcial'].includes(p.estado);
  const doc = p.id_global;
  const [[{ v }]] = await conn.query("SELECT COALESCE(MAX(doc_version), 0) + 1 AS v FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'pedido_en_transito'", [doc]);
  await M.publicar(conn, { origen: 'compras', destino: 'stock', tipo: 'pedido_en_transito', docTipo: 'pedido', docIdGlobal: doc, docVersion: v,
    contenido: { pedido_id_global: doc, abierto, lineas: abierto ? lineas.filter((l) => l.item_id && l.cantidad * l.factor_aplicado - l.cantidad_recibida > 0).map((l) => ({ item_tipo: l.item_tipo, item_id: l.item_id, cantidad: r4(l.cantidad * l.factor_aplicado - l.cantidad_recibida) })) : [] } });
};
const conn7stock = conStock;

// ---- Altas y cambios ----

const normalizarLineas = async (prov, lineas) => {
  if (!Array.isArray(lineas) || !lineas.length) throw invalida('El pedido necesita al menos una línea.');
  const stock = await conStock();
  const salida = [];
  for (const [i, l] of lineas.entries()) {
    const cantidad = Number(l.cantidad);
    if (!(cantidad > 0)) throw invalida(`La cantidad de la línea ${i + 1} debe ser mayor a cero.`);
    const item = l.item ?? (l.item_tipo ? { tipo: l.item_tipo, id: l.item_id } : null);
    let descripcion = String(l.descripcion ?? '').trim(), factor = 1, unidad = l.unidad ?? null, presentacionId = null;
    if (item) {
      if (!['insumo', 'producto'].includes(item.tipo) || !Number.isInteger(Number(item.id))) throw invalida(`El ítem de la línea ${i + 1} no es válido.`);
      const [[x]] = await pool.query(`SELECT nombre FROM ${item.tipo === 'insumo' ? 'insumos' : 'productos'} WHERE id = ?`, [item.id]);
      if (!x) throw invalida(`El ítem de la línea ${i + 1} no existe.`, 404);
      descripcion = descripcion || x.nombre;
    }
    if (!descripcion) throw invalida(`La línea ${i + 1} necesita una descripción.`);
    if (l.presentacion_id) {
      if (!stock || !item) throw invalida(`La presentación de la línea ${i + 1} necesita un ítem de Stock.`);
      const p = await Presentacion.getById(Number(l.presentacion_id));
      if (!p || p.insumo_id !== Number(item.id) || !String(p.usos).split(',').includes('compra')) throw invalida(`La presentación de la línea ${i + 1} no es de compra de ese ítem.`, 409, { codigo: 'PRESENTACION_NO_EXISTE' });
      factor = Number(p.factor); unidad = p.nombre; presentacionId = p.id;
    }
    salida.push({ item_tipo: item?.tipo ?? null, item_id: item ? Number(item.id) : null, descripcion: descripcion.slice(0, 200), presentacion_id: presentacionId, factor, unidad, cantidad, cantidad_sugerida: l.cantidad_sugerida ?? null,
      precio_estimado: l.precio_estimado === undefined || l.precio_estimado === null ? null : Number(l.precio_estimado), explicacion: l.explicacion ? JSON.stringify(l.explicacion) : null });
  }
  void prov;
  return salida;
};

const insertarLineas = async (conn, pedidoId, lineas) => {
  for (const [i, l] of lineas.entries()) await conn.query(
    'INSERT INTO cmp_pedido_lineas (pedido_id, linea, item_tipo, item_id, descripcion, presentacion_id, factor_aplicado, unidad, cantidad, cantidad_sugerida, precio_estimado, explicacion) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [pedidoId, i + 1, l.item_tipo, l.item_id, l.descripcion, l.presentacion_id, l.factor, l.unidad, l.cantidad, l.cantidad_sugerida, l.precio_estimado, l.explicacion]);
};

const proveedorActivo = async (id) => {
  const prov = await Proveedores.obtener(Number(id));
  if (prov.estado !== 'activo') throw invalida('El proveedor está desactivado.', 409);
  return prov;
};

const crearCon = async (d, ctx, extra = {}) => {
  await exigir();
  const prov = await proveedorActivo(d.proveedor_id);
  const fecha = d.fecha ?? hoy();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) throw invalida('La fecha va como AAAA-MM-DD.');
  const lineas = await normalizarLineas(prov, d.lineas);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query('INSERT INTO cmp_pedidos (id_global, proveedor_id, fecha, entrega_prevista, moneda, origen, sugerencia_ms, observacion, reemplaza_id, user_id, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [await idGlobal(), prov.id, fecha, entregaPrevista(prov, fecha, ctx.ahora), prov.moneda, extra.origen ?? 'manual', extra.sugerenciaMs ?? null, d.observacion ? String(d.observacion).slice(0, 255) : null, extra.reemplazaId ?? null, ctx.userId ?? null, Date.now()]);
    await insertarLineas(conn, r.insertId, lineas);
    await conn.commit();
    return obtener(r.insertId);
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};
const crear = (d, ctx = {}) => crearCon(d, ctx);

const editable = (p) => {
  if (p.enviado_ms !== null) throw invalida('Un pedido enviado no se edita: se reemplaza.', 409, { codigo: 'PEDIDO_ENVIADO' });
  if (!['borrador', 'pendiente'].includes(p.estado)) throw invalida(`Un pedido ${p.estado} no se edita.`, 409);
};

const editar = async (id, d, ctx = {}) => {
  await exigir();
  const p = await fila(id);
  editable(p);
  const prov = await Proveedores.obtener(p.proveedor_id);
  const lineas = d.lineas !== undefined ? await normalizarLineas(prov, d.lineas) : null;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (d.observacion !== undefined) await conn.query('UPDATE cmp_pedidos SET observacion = ? WHERE id = ?', [d.observacion ? String(d.observacion).slice(0, 255) : null, id]);
    if (d.fecha !== undefined) await conn.query('UPDATE cmp_pedidos SET fecha = ?, entrega_prevista = ? WHERE id = ?', [d.fecha, entregaPrevista(prov, d.fecha, ctx.ahora), id]);
    if (lineas) { await conn.query('DELETE FROM cmp_pedido_lineas WHERE pedido_id = ?', [id]); await insertarLineas(conn, id, lineas); }
    if (p.estado === 'pendiente') await publicarTransito(conn, p, await lineasDe2(conn, id));
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  M.despertar();
  return obtener(id);
};
const lineasDe2 = async (conn, id) => (await conn.query('SELECT item_tipo, item_id, factor_aplicado, cantidad, cantidad_recibida FROM cmp_pedido_lineas WHERE pedido_id = ?', [id]))[0]
  .map((l) => ({ ...l, factor_aplicado: Number(l.factor_aplicado), cantidad: Number(l.cantidad), cantidad_recibida: Number(l.cantidad_recibida) }));

const confirmar = async (id, ctx = {}) => {
  await exigir();
  const p = await fila(id);
  if (p.estado !== 'borrador') throw invalida(`El pedido ya está ${p.estado}.`, 409);
  const prov = await Proveedores.obtener(p.proveedor_id);
  const lineas = await lineasDe(id);
  const total = lineas.reduce((s, l) => s + l.cantidad * (l.precio_estimado ?? 0), 0);
  const advertencias = [];
  if (prov.pedido_minimo !== null && prov.pedido_minimo !== undefined && total < Number(prov.pedido_minimo)) advertencias.push(`El pedido (${r2(total)}) está por debajo del mínimo del proveedor (${prov.pedido_minimo}).`); // EX17: advierte sin bloquear
  const entrega = entregaPrevista(prov, iso(p.fecha), ctx.ahora);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE cmp_pedidos SET estado = 'pendiente', entrega_prevista = ? WHERE id = ?", [entrega, id]);
    await publicarTransito(conn, { ...p, estado: 'pendiente' }, await lineasDe2(conn, id));
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  M.despertar();
  return { ...(await obtener(id)), advertencias };
};

const cerrar = async (id, estado, motivo) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE cmp_pedidos SET estado = ?, motivo_cancelacion = COALESCE(?, motivo_cancelacion) WHERE id = ?', [estado, motivo ?? null, id]);
    const p = await fila(id, conn);
    await publicarTransito(conn, p, await lineasDe2(conn, id));
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  M.despertar();
};

const cancelar = async (id, { motivo } = {}) => {
  if (typeof motivo !== 'string' || motivo.trim().length < 3) throw invalida('El motivo es obligatorio.');
  const p = await fila(id);
  if (['recibido', 'cancelado'].includes(p.estado)) throw invalida(`El pedido ya está ${p.estado}.`, 409);
  await cerrar(id, 'cancelado', motivo.trim().slice(0, 255));
  return obtener(id);
};

// Sin Stock el estado de recepción se actualiza a mano (RF12).
const marcarRecepcion = async (id, { estado }) => {
  if (await conStock()) throw invalida('Con Stock el estado lo actualiza la recepción de los ingresos vinculados.', 409, { codigo: 'CON_STOCK' });
  if (!['recibido_parcial', 'recibido'].includes(estado)) throw invalida('El estado es recibido_parcial o recibido.');
  const p = await fila(id);
  if (!['pendiente', 'recibido_parcial'].includes(p.estado)) throw invalida(`Un pedido ${p.estado} no recibe mercadería.`, 409);
  await cerrar(id, estado);
  return obtener(id);
};

// Un pedido enviado se reemplaza: el original queda cancelado y nace un borrador nuevo, con las líneas corregidas o las mismas.
const reemplazar = async (id, d = {}, ctx = {}) => {
  await exigir();
  const p = await fila(id);
  if (p.enviado_ms === null) throw invalida('Un pedido que no se envió se edita directamente.', 409);
  if (!['pendiente', 'recibido_parcial'].includes(p.estado)) throw invalida(`Un pedido ${p.estado} no se reemplaza.`, 409);
  if (typeof d.motivo !== 'string' || d.motivo.trim().length < 3) throw invalida('El motivo es obligatorio.');
  const actual = await lineasDe(id);
  const nuevo = await crearCon({ proveedor_id: p.proveedor_id, observacion: d.observacion ?? p.observacion, fecha: d.fecha, lineas: d.lineas ?? actual.map((l) => ({ item_tipo: l.item_tipo, item_id: l.item_id, descripcion: l.descripcion, presentacion_id: l.presentacion_id, cantidad: l.cantidad, precio_estimado: l.precio_estimado })) },
    ctx, { origen: p.origen, sugerenciaMs: p.sugerencia_ms, reemplazaId: id });
  await pool.query('UPDATE cmp_pedidos SET reemplazado_por = ? WHERE id = ?', [nuevo.id, id]);
  await cerrar(id, 'cancelado', `Reemplazado por el pedido ${nuevo.id}: ${d.motivo.trim()}`.slice(0, 255));
  return nuevo;
};

// ---- Envío ----

const pdf = async (id) => {
  const p = await obtener(id);
  const prov = await Proveedores.obtener(p.proveedor_id);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 }), partes = [];
    doc.on('data', (b) => partes.push(b)); doc.on('end', () => resolve(Buffer.concat(partes))); doc.on('error', reject);
    doc.fontSize(16).text(`Pedido ${p.id}`).fontSize(10).moveDown(0.5).text(`Proveedor: ${prov.razon_social} (CUIT ${prov.cuit})`).text(`Fecha: ${p.fecha}${p.entrega_prevista ? `   Entrega prevista: ${p.entrega_prevista}` : ''}`);
    if (p.observacion) doc.text(`Observación: ${p.observacion}`);
    doc.moveDown();
    for (const l of p.lineas) doc.text(`${l.linea}. ${l.descripcion} — ${l.cantidad}${l.unidad ? ` ${l.unidad}` : ''}${l.precio_estimado !== null ? ` a ${l.precio_estimado}` : ''}`);
    doc.end();
  });
};
const textoCorreo = async (p) => `Pedido ${p.id} - entrega prevista ${p.entrega_prevista ?? 'a confirmar'}\n\n${p.lineas.map((l) => `${l.linea}. ${l.descripcion}: ${l.cantidad}${l.unidad ? ` ${l.unidad}` : ''}`).join('\n')}${p.observacion ? `\n\n${p.observacion}` : ''}\n`;

// Por correo el mensaje entra a la cola (que reintenta sin conexión); por PDF el pedido se entrega por otra vía y se marca como enviado.
const enviar = async (id, { via = 'correo', para } = {}) => {
  await exigir();
  const p = await obtener(id);
  if (p.estado !== 'pendiente') throw invalida(p.estado === 'borrador' ? 'Confirmá el pedido antes de enviarlo.' : `Un pedido ${p.estado} no se envía.`, 409);
  if (p.enviado) throw invalida('El pedido ya se envió: para cambiarlo, reemplazalo.', 409, { codigo: 'PEDIDO_ENVIADO' });
  let destino = null;
  if (via === 'correo') {
    const prov = await Proveedores.obtener(p.proveedor_id);
    destino = para ?? prov.contactos.find((c) => c.email)?.email;
    if (!destino) throw invalida('El proveedor no tiene un correo cargado.', 409, { codigo: 'SIN_CORREO' });
    await Correo.encolar({ para: destino, asunto: `Pedido ${p.id} - ${prov.razon_social}`.slice(0, 200), cuerpo: await textoCorreo(p) });
  } else if (via !== 'pdf') throw invalida('La vía de envío es correo o pdf.');
  await pool.query('UPDATE cmp_pedidos SET enviado_ms = ?, enviado_a = ? WHERE id = ?', [Date.now(), destino ?? 'PDF', id]);
  return obtener(id);
};

// ---- Recepción por ingresos vinculados (RF12) ----

const registrarRecepcion = async (proveedorId, ingresos) => {
  const abiertos = (await pool.query("SELECT id FROM cmp_pedidos WHERE proveedor_id = ? AND estado IN ('pendiente', 'recibido_parcial') ORDER BY id", [proveedorId]))[0];
  if (!abiertos.length) return;
  for (const ing of ingresos) {
    const det = await StockCompras.detalle(ing).catch(() => null);
    if (!det) continue;
    const restante = new Map(det.items.map((i) => [`${i.item_tipo}:${i.item_id}`, i.cantidad]));
    for (const { id } of abiertos) {
      const [ya] = await pool.query('SELECT 1 FROM cmp_pedido_recepciones WHERE pedido_id = ? AND ingreso_id_global = ?', [id, ing]);
      if (ya.length) continue;
      const lineas = (await pool.query('SELECT * FROM cmp_pedido_lineas WHERE pedido_id = ? AND item_id IS NOT NULL', [id]))[0];
      let toco = false;
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        for (const l of lineas) {
          const k = `${l.item_tipo}:${l.item_id}`, disp = restante.get(k) ?? 0;
          const falta = Number(l.cantidad) * Number(l.factor_aplicado) - Number(l.cantidad_recibida);
          if (disp <= 0 || falta <= 0) continue;
          const toma = Math.min(disp, falta);
          await conn.query('UPDATE cmp_pedido_lineas SET cantidad_recibida = cantidad_recibida + ? WHERE id = ?', [toma, l.id]);
          restante.set(k, disp - toma); toco = true;
        }
        if (toco) {
          await conn.query('INSERT INTO cmp_pedido_recepciones (pedido_id, ingreso_id_global) VALUES (?, ?)', [id, ing]);
          const todas = await lineasDe2(conn, id);
          const completo = todas.filter((l) => l.item_id).every((l) => l.cantidad_recibida >= l.cantidad * l.factor_aplicado - 0.0005);
          await conn.query('UPDATE cmp_pedidos SET estado = ? WHERE id = ?', [completo ? 'recibido' : 'recibido_parcial', id]);
          await publicarTransito(conn, await fila(id, conn), todas);
        }
        await conn.commit();
      } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
    }
  }
  M.despertar();
};
Ingresos.alVincular(registrarRecepcion);

// ---- Pedido sugerido (RF20, RN26, EX17) ----

const exigirSugerido = async () => {
  await exigir();
  if (!(await conStock())) throw invalida('Sin Stock el pedido se arma a mano.', 409, { codigo: 'SIN_STOCK' });
  for (const f of ['CMP-PEDIDO-SUGERIDO', 'STK-REPO-AUTO']) if (!(await Funciones.estaActiva(f))) throw invalida(`El pedido sugerido necesita la función ${f}.`, 409, { codigo: 'FUNCION_INACTIVA' });
};
const parametroHoras = async () => Number((await pool.query("SELECT valor FROM parametros WHERE clave = 'cmp_sugerencia_horas'"))[0][0]?.valor ?? 24);

// Agrupa lo que sugiere Stock por proveedor principal del ítem, redondea a múltiplos de la presentación de compra y explica cada línea. Lo que no tiene proveedor queda afuera.
const sugerencia = async ({ depositoId, ahora } = {}) => {
  await exigirSugerido();
  const filas = (await Repo.sugerir({ deposito_id: depositoId, hoy: ahora })).filter((f) => f.sugerida > 0);
  const grupos = new Map(), sinProveedor = [];
  for (const f of filas) {
    const [[cr]] = await pool.query('SELECT proveedor_principal_id AS prov, costo FROM cmp_costos_reposicion WHERE item_tipo = ? AND item_id = ?', [f.item_tipo, f.item_id]);
    if (!cr?.prov) { sinProveedor.push({ item_tipo: f.item_tipo, item_id: f.item_id, nombre: f.nombre, sugerida: f.sugerida }); continue; }
    let pres = null;
    if (f.item_tipo === 'insumo') pres = (await Presentacion.listar({ insumo_id: f.item_id, vigentes: true })).find((p) => String(p.usos).split(',').includes('compra')) ?? null;
    const factor = pres ? Number(pres.factor) : 1;
    const cantidad = pres ? Math.ceil(f.sugerida / factor - 1e-9) : f.sugerida;
    const g = grupos.get(cr.prov) ?? [];
    g.push({ item: { tipo: f.item_tipo, id: f.item_id }, descripcion: f.nombre, presentacion_id: pres?.id ?? null, unidad: pres?.nombre ?? null, cantidad, cantidad_sugerida: f.sugerida, precio_estimado: pres ? r4(Number(cr.costo) * factor) : Number(cr.costo),
      explicacion: { consumo_diario: f.consumo_diario, dias_cobertura: f.dias_cobertura, plazo_entrega_dias: f.plazo_entrega_dias, stock_seguridad: f.stock_seguridad, disponible: f.disponible, en_transito: f.en_transito ?? 0 } });
    grupos.set(cr.prov, g);
  }
  const propuestas = [];
  for (const [provId, lineas] of grupos) {
    const prov = await Proveedores.obtener(provId);
    const total = lineas.reduce((s, l) => s + l.cantidad * l.precio_estimado, 0);
    propuestas.push({ proveedor_id: provId, proveedor: prov.razon_social, entrega_prevista: entregaPrevista(prov, hoy(), ahora), total_estimado: r2(total),
      advertencias: prov.pedido_minimo !== null && prov.pedido_minimo !== undefined && total < Number(prov.pedido_minimo) ? [`Por debajo del pedido mínimo del proveedor (${prov.pedido_minimo}).`] : [], lineas });
  }
  return { calculada_ms: Date.now(), propuestas, sin_proveedor: sinProveedor };
};

// Un usuario confirma (a mano) lo que propone la sugerencia, editado o no: queda un borrador con la cantidad sugerida y la pedida.
const crearDesdeSugerencia = async (d, ctx = {}) => {
  await exigirSugerido();
  const horas = await parametroHoras();
  if (!d.calculada_ms || Date.now() - Number(d.calculada_ms) > horas * 3600000) throw invalida(`La sugerencia tiene más de ${horas} horas: recalculala antes de armar el pedido.`, 409, { codigo: 'SUGERENCIA_VIEJA' }); // EX17
  for (const [i, l] of (d.lineas ?? []).entries()) {
    const item = l.item ?? { tipo: l.item_tipo, id: l.item_id };
    const [[cr]] = await pool.query('SELECT proveedor_principal_id AS prov FROM cmp_costos_reposicion WHERE item_tipo = ? AND item_id = ?', [item.tipo, item.id]);
    if (!cr?.prov || cr.prov !== Number(d.proveedor_id)) throw invalida(`La línea ${i + 1} no tiene a este proveedor como principal: asignale uno antes de pedirla.`, 409, { codigo: 'ITEM_SIN_PROVEEDOR' });
  }
  return crearCon(d, ctx, { origen: 'sugerencia', sugerenciaMs: Number(d.calculada_ms) });
};

module.exports = { entregaPrevista, crear, editar, confirmar, cancelar, marcarRecepcion, reemplazar, enviar, pdf, obtener, listar, registrarRecepcion, sugerencia, crearDesdeSugerencia };
