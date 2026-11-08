const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const Mensajeria = require('../mensajeria/servicio');
const puertos = require('../modulos/puertos');
const afipService = require('./afipService');
const afipConfig = require('../config/afipConfig');
const Caea = require('./caeaService');
const Venta = require('./ventaService');
const { letraFactura } = require('./notaFiscalService');
const { idGlobal } = require('../utils/idGlobal');

// Remitos de entrega y facturación agrupada (Ventas RF12, RF17, RF27, RN31, RN73, RN74, EX36). El remito es un comprobante no fiscal con numeración propia; asignado
// a la cuenta de un cliente pide el veredicto y la reserva de crédito como una venta a cuenta y publica un único «Remito emitido» (Clientes lo registra como
// débito de tipo Remito). La facturación agrupada emite UN comprobante fiscal por los remitos pendientes de un cliente, con los precios del día, y los pasa
// a «Facturado» sin volver a mover stock ni deuda.
class RemitoInvalido extends Error {}
const invalida = (m, status = 400, extra = {}) => Object.assign(new RemitoInvalido(m), { status, ...extra });
const num = (x) => Math.round(Number(x) * 100) / 100;
const REMITO_SQL = 'SELECT * FROM remitos WHERE id_global = ?';

const publico = (r) => ({ ...r, total: num(r.total), detalle: JSON.parse(r.detalle), cuenta_asignada: !!r.cuenta_asignada, en_contingencia: !!r.en_contingencia });
const obtener = async (idGlobalRemito) => {
  const [[r]] = await pool.query(REMITO_SQL, [idGlobalRemito]);
  return r ? publico(r) : null;
};
const listar = async ({ cliente_id: clienteId, facturacion, estado } = {}) => (await pool.query(
  `SELECT * FROM remitos WHERE (? IS NULL OR cliente_id = ?) AND (? IS NULL OR facturacion = ?) AND (? IS NULL OR estado = ?) ORDER BY id DESC LIMIT 200`,
  [clienteId ?? null, clienteId ?? null, facturacion ?? null, facturacion ?? null, estado ?? null, estado ?? null]))[0].map(publico);

const lineas = async (items) => {
  if (!Array.isArray(items) || !items.length) throw invalida('Indicá al menos un ítem en el remito.');
  const out = [];
  for (const i of items) {
    const [[p]] = await pool.query('SELECT id, nombre, precio FROM productos WHERE id = ?', [i.producto_id]);
    if (!p) throw invalida(`El producto ${i.producto_id} no existe.`, 404);
    if (!(Number(i.cantidad) > 0)) throw invalida('La cantidad de cada ítem es mayor que cero.');
    out.push({ producto_id: p.id, nombre: p.nombre, cantidad: Number(i.cantidad), precio_unitario: num(p.precio) });
  }
  return out;
};
const totalDe = (ls) => num(ls.reduce((a, l) => a + l.cantidad * l.precio_unitario, 0));

// Emite un remito. Con `asignar_a_cuenta` pide el veredicto y la reserva de crédito por el total (RN73) y publica «Remito emitido» en la misma transacción.
const emitir = async (d, { userId = null, idSolicitud = null, autorizar = null } = {}) => {
  const ls = await lineas(d.items);
  const total = totalDe(ls);
  if (idSolicitud) { const [[p]] = await pool.query('SELECT id_global FROM remitos WHERE id_solicitud = ?', [idSolicitud]); if (p) return { ...(await obtener(p.id_global)), ya_procesado: true }; }
  let credito = null;
  if (d.asignar_a_cuenta) {
    credito = await Venta.reservarCredito([{ forma: 'cuenta_corriente', importe: total }], { clienteId: d.cliente_id, idSolicitud: idSolicitud ?? `remito:${Date.now()}`, userId, autorizar, motivoContingencia: d.motivo_contingencia });
  } else if (d.cliente_id) {
    const c = await (await puertos.obtener('credito')).resolverCliente(d.cliente_id);
    if (!c) throw invalida('El cliente no existe.', 404);
  }
  const items = ls.map((l) => ({ producto_id: l.producto_id, cantidad: l.cantidad, nombre: l.nombre, precio_unitario: l.precio_unitario }));
  const idCompromiso = await Venta.comprometerStock(items, { idSolicitud: idSolicitud ?? 'remito', userId, autorizar }).catch(async (err) => { await Venta.liberarCredito(credito); throw err; });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const id = await idGlobal();
    const numero = await Caea.siguienteNumero('NF:remito', conn);
    const [r] = await conn.query(
      'INSERT INTO remitos (id_global, numero, cliente_id, total, detalle, cuenta_asignada, id_reserva_credito, en_contingencia, id_solicitud, creado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, numero, d.cliente_id ?? null, total, JSON.stringify(ls), credito ? 1 : 0, credito?.reservaId ?? null, credito?.contingencia ? 1 : 0, idSolicitud, userId]);
    await Venta.publicarDescuento(conn, { docTipo: 'remito', docIdGlobal: id, items, userId, solicitud: idSolicitud, noFiscal: true, idCompromiso }); // el stock se descuenta con el remito
    if (credito) await Mensajeria.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'remito_emitido', docTipo: 'remito', docIdGlobal: id, userId, solicitud: idSolicitud,
      contenido: { cliente_id: credito.clienteId, moneda: credito.moneda, importe: credito.importe, remito_id_global: id, fecha: new Date().toISOString().slice(0, 10), reserva_id: credito.reservaId, contingencia: credito.contingencia, concepto: `Remito N° ${numero}` } });
    // Un remito asignado a una cuenta es deuda, no venta: Contable lo registra contra «Remitos a facturar» (RF24); sin cuenta no se informa (RF26).
    if (credito && await Funciones.estaActiva('VEN-CC', conn)) await Mensajeria.publicar(conn, { origen: 'ventas', destino: 'contable', tipo: 'remito_emitido', docTipo: 'remito', docIdGlobal: id, userId, solicitud: idSolicitud,
      contenido: { remito_id_global: id, importe: credito.importePesos ?? credito.importe, fecha_ms: Date.now() } });
    await conn.commit();
    Mensajeria.despertar();
    return { id: r.insertId, ...(await obtener(id)) };
  } catch (err) {
    await conn.rollback();
    await Venta.liberarCompromiso(idCompromiso);
    await Venta.liberarCredito(credito);
    throw err;
  } finally { conn.release(); }
};

// Anular un remito aún no facturado (RN74): revierte el débito en la cuenta con el mensaje inverso de «Remito emitido» y el stock con el reingreso.
const anular = async (idGlobalRemito, { userId = null } = {}) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[r]] = await conn.query(`${REMITO_SQL} FOR UPDATE`, [idGlobalRemito]);
    if (!r) throw invalida('Remito no encontrado.', 404);
    if (r.estado === 'anulado') throw invalida('El remito ya está anulado.', 409);
    if (r.facturacion === 'facturado') throw invalida('El remito ya se facturó: se corrige con una nota de crédito sobre la factura (RN74).', 409);
    await conn.query("UPDATE remitos SET estado = 'anulado' WHERE id = ?", [r.id]);
    const ls = JSON.parse(r.detalle);
    const [[conDescuento]] = await conn.query("SELECT 1 AS si FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'descuento_stock' LIMIT 1", [r.id_global]);
    if (conDescuento) await Mensajeria.publicar(conn, { origen: 'ventas', destino: 'stock', tipo: 'reingreso_stock', docTipo: 'remito', docIdGlobal: r.id_global, docVersion: 2, secuencia: 2, userId,
      contenido: { modo: 'reingreso', items: ls.map((l, linea) => ({ linea, producto_id: l.producto_id, cantidad: l.cantidad, cantidad_original: l.cantidad })), user_id: userId } });
    if (r.cuenta_asignada) await Mensajeria.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'anulacion_remito', docTipo: 'remito', docIdGlobal: r.id_global, docVersion: 2, secuencia: 2, userId, contenido: { remito_id_global: r.id_global } });
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  Mensajeria.despertar();
  return obtener(idGlobalRemito);
};

// ---------- Facturación agrupada (RF27) ----------
// Devuelve siempre { ok, ... }: los rechazos de negocio llegan estructurados (la llamada entre módulos no deja pasar el detalle de una excepción).
const facturar = async ({ cliente_id: clienteId, remitos: ids, aceptar_diferencias: aceptar = false, continuar_con_validos: continuar = false, previa = false }, { userId = null, idSolicitud = null } = {}) => {
  if (!Array.isArray(ids) || !ids.length) return { ok: false, status: 400, error: 'Indicá los remitos a facturar.' };
  if (ids.length > 1 && !(await Funciones.estaActiva('CLI-FACT-AGRUPADA')))
    return { ok: false, status: 409, codigo: 'SIN_FACTURACION_AGRUPADA', error: 'Sin CLI-FACT-AGRUPADA cada remito se factura por separado.' };
  const puerto = await puertos.obtener('credito');
  const cli = await puerto.resolverCliente(clienteId);
  if (!cli) return { ok: false, status: 404, error: 'El cliente no existe.' };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM remitos WHERE id_global IN (?) FOR UPDATE', [ids]);
    const porId = new Map(rows.map((r) => [r.id_global, r]));
    const validos = [], invalidos = [];
    for (const id of ids) {
      const r = porId.get(id);
      const motivo = !r ? 'no existe' : r.cliente_id !== cli.id ? 'es de otro cliente' : r.estado === 'anulado' ? 'está anulado' : r.facturacion === 'facturado' ? 'ya está facturado' : null;
      (motivo ? invalidos : validos).push(motivo ? { remito: id, motivo } : r);
    }
    if (invalidos.length && !(continuar && validos.length)) { // EX36: el remito inválido se rechaza con su motivo y sigue con los válidos solo si el usuario lo confirma
      await conn.rollback();
      return { ok: false, status: 409, codigo: 'REMITOS_INVALIDOS', error: 'Hay remitos que no se pueden facturar.', invalidos, puede_continuar: validos.length > 0 };
    }
    // Se factura con los precios vigentes del día (RN31); antes de emitir se muestra por remito la diferencia y el usuario debe aceptarla.
    const detalle = [];
    for (const r of validos) {
      let nuevo = 0;
      for (const l of JSON.parse(r.detalle)) {
        const [[p]] = await conn.query('SELECT precio FROM productos WHERE id = ?', [l.producto_id]);
        nuevo += l.cantidad * Number(p?.precio ?? l.precio_unitario);
      }
      detalle.push({ remito: r.id_global, numero: r.numero, importe_remito: num(r.total), importe_a_facturar: num(nuevo), diferencia: num(nuevo - Number(r.total)) });
    }
    const total = num(detalle.reduce((a, d) => a + d.importe_a_facturar, 0));
    const hayDiferencias = detalle.some((d) => d.diferencia !== 0);
    const vista = { cliente_id: cli.id, remitos: detalle, total, hay_diferencias: hayDiferencias, invalidos };
    if (previa) { await conn.rollback(); return { ok: true, previa: true, ...vista }; }
    if (hayDiferencias && !aceptar) { await conn.rollback(); return { ok: false, status: 409, codigo: 'DIFERENCIA_NO_ACEPTADA', error: 'Hay diferencias entre los remitos y lo que se facturará: aceptalas para emitir.', ...vista }; }
    const receptor = { doc_tipo: cli.doc_tipo, doc_nro: cli.nro_documento, condicion_iva_receptor_id: cli.condicion_iva_receptor_id };
    const tipoComprobante = letraFactura(receptor);
    const idIntento = idSolicitud ? `fact-agrup-${idSolicitud}` : `fact-agrup-${validos.map((r) => r.id).join('-')}-${Date.now()}`;
    let emitida;
    try {
      emitida = await afipService.emitirFactura({ tipoComprobante, docTipo: receptor.doc_tipo, docNro: Number(receptor.doc_nro), condicionIvaReceptorId: receptor.condicion_iva_receptor_id, importeTotal: total, idIntento });
    } catch (err) { await conn.rollback(); return { ok: false, status: err.status ?? 502, codigo: 'EMISION_FALLIDA', error: `No se pudo emitir el comprobante: ${err.message}` }; }
    if (emitida.estado && emitida.estado !== 'aprobada') { await conn.rollback(); return { ok: false, status: 409, codigo: 'EMISION_RECHAZADA', error: `ARCA no aprobó el comprobante (${emitida.estado}).` }; }
    const id = await idGlobal();
    const [f] = await conn.query(
      'INSERT INTO facturas_remitos (id_global, cliente_id, tipo_comprobante, punto_venta, numero, cae, cae_vencimiento, importe_total, detalle, id_intento, creado_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, cli.id, tipoComprobante, afipConfig.puntoVenta, emitida.numero ?? null, emitida.cae ?? null, emitida.caeVencimiento ?? null, total, JSON.stringify(detalle), idIntento, userId]);
    await conn.query("UPDATE remitos SET facturacion = 'facturado', factura_agrupada_id = ? WHERE id IN (?)", [f.insertId, validos.map((r) => r.id)]);
    // El evento lleva cada remito que cancela; no incluye stock ni cobro (ya ocurrieron con el remito, RN73). Clientes reemplaza el saldo de los remitos por el de la factura.
    await Mensajeria.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'remitos_facturados', docTipo: 'factura_remitos', docIdGlobal: id, userId, solicitud: idSolicitud,
      contenido: { cliente_id: cli.id, factura_id_global: id, importe: total, fecha: new Date().toISOString().slice(0, 10), remitos: detalle.map((d) => ({ remito_id_global: d.remito, importe_remito: d.importe_remito, importe_facturado: d.importe_a_facturar })) } });
    await conn.commit();
    Mensajeria.despertar();
    return { ok: true, factura: { id_global: id, tipo_comprobante: tipoComprobante, punto_venta: afipConfig.puntoVenta, numero: emitida.numero ?? null, cae: emitida.cae ?? null, importe_total: total }, ...vista };
  } catch (err) { await conn.rollback().catch(() => {}); throw err; } finally { conn.release(); }
};

// Remitos pendientes de facturación: impiden desactivar CLI-FACT-AGRUPADA (y, en cascada, VEN-CC) hasta facturarlos o desasignarlos (Clientes RN20, Ventas EX34).
const pendientesDeFacturar = async () => {
  const [filas] = await pool.query("SELECT cliente_id, COUNT(*) AS n FROM remitos WHERE estado = 'emitido' AND facturacion = 'pendiente' AND cuenta_asignada = 1 GROUP BY cliente_id");
  return filas.map((f) => `${f.n} remito(s) pendiente(s) de facturar del cliente ${f.cliente_id}`);
};
Funciones.registrarComprobacion('CLI-FACT-AGRUPADA', { datosVigentes: pendientesDeFacturar });

module.exports = { RemitoInvalido, emitir, anular, facturar, obtener, listar, pendientesDeFacturar };
