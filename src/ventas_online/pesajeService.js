const crypto = require('crypto');
const pool = require('../config/db');
const Correo = require('../servicios/correoService');
const PedidoOnline = require('../services/pedidoOnlineService');
const Pasarela = require('./pasarelaMP');
const Reintegros = require('./reintegroService');
const Facturacion = require('./facturacionService');
const M = require('../mensajeria/servicio');
const { TiendaInvalida } = require('./tiendaService');

// Pesaje real y aceptación de la diferencia (Ventas Online RF29, RN11, RN51, RN52). Los pesables se cobran por el peso estimado y se facturan por el real, que se carga al preparar. Un peso
// menor reintegra la diferencia; hasta la tolerancia, el comercio absorbe el exceso; por encima, el pesaje no se confirma con ese peso: se reduce o el cliente acepta (y paga) el cobro
// adicional dentro de su vigencia. Nunca se cobra de más sin aceptación expresa. Reintegros y cobros de un mismo pesaje se compensan en una sola operación neta, y el reintegro sale recién
// después de emitido el comprobante (RN52).
// shortcut: el descuento de Stock se hace con el peso estimado al pasar a Ventas; el ajuste al peso real (Ventas Online RN51 j) queda para cuando Stock acepte ajustes sobre la reserva.
const invalida = (m, status = 400, extra = {}) => Object.assign(new TiendaInvalida(m), { status, ...extra });
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const r3 = (x) => Math.round(Number(x) * 1000) / 1000;

const pedido = async (id) => { const [[p]] = await pool.query('SELECT * FROM onl_pedidos WHERE id = ?', [id]); if (!p) throw invalida('Pedido no encontrado.', 404); return p; };
const tolerancia = async (importeLinea) => {
  const [[t]] = await pool.query('SELECT tolerancia_peso_pct, tolerancia_peso_importe FROM onl_tienda WHERE id = 1');
  return r2(t.tolerancia_peso_importe !== null ? Number(t.tolerancia_peso_importe) : importeLinea * Number(t.tolerancia_peso_pct) / 100);
};
const lineaVista = (l, tol = null) => ({ linea: l.linea, titulo: l.titulo, peso_estimado: Number(l.cantidad), peso_min: l.peso_min === null ? null : Number(l.peso_min), peso_max: l.peso_max === null ? null : Number(l.peso_max), precio_unitario: Number(l.precio_unitario),
  cobrado: Number(l.importe), peso_real: l.peso_real === null ? null : Number(l.peso_real), delta: l.delta === null ? null : Number(l.delta), estado: l.pesaje_estado, tolerancia: tol });
const estadoPesaje = async (id) => {
  const p = await pedido(id);
  const [ls] = await pool.query('SELECT * FROM onl_pedido_lineas WHERE pedido_id = ? AND es_pesable = 1 ORDER BY linea', [id]);
  const lineas = [];
  for (const l of ls) lineas.push(lineaVista(l, await tolerancia(Number(l.importe))));
  const [aj] = await pool.query('SELECT id, estado, delta_neto, adicional, reintegro, aceptacion_vence_ms, aceptado_ms, aceptado_medio FROM onl_ajustes WHERE pedido_id = ? ORDER BY id', [id]);
  return { pedido_id: id, pesaje: p.pesaje_estado, total_cobrado: Number(p.total), total_real: p.total_real === null ? null : Number(p.total_real), lineas, ajustes: aj.map((a) => ({ ...a, delta_neto: Number(a.delta_neto), adicional: Number(a.adicional), reintegro: Number(a.reintegro) })) };
};

// ---- Carga del peso ----

const registrarPeso = async (id, linea, { peso, estable = true, manual = false, motivo = null, fuera_de_rango: fuera = false }, { puedeManual = false } = {}) => {
  const p = await pedido(id);
  if (!p.tiene_pesables) throw invalida('El pedido no tiene pesables.', 409);
  if (!['pagado', 'en_preparacion'].includes(p.estado) || p.entrega_ventas_estado !== 'entregado') throw invalida(`El pedido está ${p.estado}: se pesa al prepararlo.`, 409, { codigo: 'ESTADO_INVALIDO' });
  const [[l]] = await pool.query('SELECT * FROM onl_pedido_lineas WHERE pedido_id = ? AND linea = ? AND es_pesable = 1', [id, linea]);
  if (!l) throw invalida('La línea no es un pesable del pedido.', 404);
  if (l.pesaje_estado === 'confirmado') throw invalida('Ese pesaje ya está confirmado.', 409);
  const kg = Number(peso);
  if (!(kg > 0)) throw invalida('El peso tiene que ser mayor a cero.', 400, { codigo: 'PESO_INVALIDO' }); // la balanza no admite cero ni negativos
  if (manual) {
    if (!puedeManual) throw invalida('El ingreso manual del peso necesita permiso.', 403, { codigo: 'SIN_PERMISO' });
    if (typeof motivo !== 'string' || motivo.trim().length < 3) throw invalida('El ingreso manual del peso necesita un motivo.', 400);
  } else if (estable !== true) throw invalida('La lectura de la balanza no está estable: esperá y volvé a pesar.', 409, { codigo: 'LECTURA_INESTABLE' });
  const fueraRango = (l.peso_min !== null && kg < Number(l.peso_min)) || (l.peso_max !== null && kg > Number(l.peso_max));
  if (fueraRango && !(fuera === true && typeof motivo === 'string' && motivo.trim().length >= 3)) throw invalida(`El peso está fuera del rango publicado (${l.peso_min ?? '-'} a ${l.peso_max ?? '-'}): confirmalo con un motivo.`, 409, { codigo: 'FUERA_DE_RANGO' });
  const real = r2(Number(l.precio_unitario) * kg), delta = r2(real - Number(l.importe)), tol = await tolerancia(Number(l.importe));
  const estado = delta <= tol ? 'confirmado' : 'requiere_aceptacion'; // Δ negativa o dentro de la tolerancia: se confirma; por encima, no
  await pool.query('UPDATE onl_pedido_lineas SET peso_real = ?, delta = ?, pesaje_estado = ?, pesaje_manual = ?, pesaje_motivo = ? WHERE id = ?', [r3(kg), delta, estado, manual ? 1 : 0, motivo ? String(motivo).slice(0, 160) : null, l.id]);
  if (estado === 'confirmado') await cerrarPesajeSiCompleto(id);
  return { estado, delta, tolerancia: tol, importe_real: real, ...(estado === 'requiere_aceptacion' && { opciones: ['reducir_peso', 'solicitar_aceptacion'] }) };
};

// ---- Aceptación del cliente (RN51 f) ----

const solicitarAceptacion = async (id, linea, { baseUrl }) => {
  const p = await pedido(id);
  const [[l]] = await pool.query("SELECT * FROM onl_pedido_lineas WHERE pedido_id = ? AND linea = ? AND pesaje_estado = 'requiere_aceptacion'", [id, linea]);
  if (!l) throw invalida('No hay un pesaje que supere la tolerancia en esa línea.', 409);
  const [[ya]] = await pool.query("SELECT id FROM onl_ajustes WHERE pedido_id = ? AND estado = 'requiere_aceptacion' AND detalle = ?", [id, `linea:${linea}`]);
  if (ya) throw invalida('Ya se le pidió la aceptación al cliente.', 409);
  const [[t]] = await pool.query('SELECT aceptacion_horas FROM onl_tienda WHERE id = 1');
  const token = crypto.randomBytes(24).toString('hex');
  const ahora = Date.now();
  const tol = await tolerancia(Number(l.importe));
  const [r] = await pool.query("INSERT INTO onl_ajustes (pedido_id, tipo, estado, delta_neto, adicional, aceptacion_hash, aceptacion_vence_ms, detalle, ts_ms, actualizado_ms) VALUES (?, 'pesaje', 'requiere_aceptacion', ?, ?, ?, ?, ?, ?, ?)",
    [id, l.delta, r2(Number(l.delta)), crypto.createHash('sha256').update(token).digest('hex'), ahora + t.aceptacion_horas * 3600000, `linea:${linea}`, ahora, ahora]);
  const enlace = `${baseUrl}/pedidos/${p.id_global}/aceptar-diferencia?token=${token}&email=${encodeURIComponent(p.email)}`;
  await Correo.encolar({ para: p.email, asunto: `Tu pedido #${p.id} pesó más de lo previsto`, cuerpo: `Hola ${p.nombre}, "${l.titulo}" pesó ${Number(l.peso_real)} y la diferencia es de ${Number(l.delta)} (el comercio absorbe hasta ${tol}). Si estás de acuerdo con pagar la diferencia, aceptala acá (vale ${t.aceptacion_horas} horas): ${enlace}\n` }).catch(() => {});
  return { ajuste_id: r.insertId, vence_ms: ahora + t.aceptacion_horas * 3600000, enlace_enviado_a: p.email, _token: token };
};

const ajusteConToken = async (idGlobal, token, email) => {
  const [[p]] = await pool.query('SELECT * FROM onl_pedidos WHERE id_global = ? AND email = ?', [idGlobal, String(email ?? '').toLowerCase()]);
  if (!p) throw invalida('Pedido no encontrado.', 404);
  const [[a]] = await pool.query('SELECT * FROM onl_ajustes WHERE pedido_id = ? AND aceptacion_hash = ?', [p.id, crypto.createHash('sha256').update(String(token ?? '')).digest('hex')]);
  if (!a) throw invalida('El enlace no es válido.', 404, { codigo: 'ENLACE_INVALIDO' });
  return { p, a };
};

// El peso se ajusta al máximo que entra en la tolerancia y se aplica como diferencia absorbida (rechazo o vencimiento).
const absorber = async (p, a) => {
  const linea = Number(String(a.detalle).split(':')[1]);
  const [[l]] = await pool.query('SELECT * FROM onl_pedido_lineas WHERE pedido_id = ? AND linea = ?', [p.id, linea]);
  const tol = await tolerancia(Number(l.importe));
  const kg = r3(Math.floor(((Number(l.importe) + tol) / Number(l.precio_unitario)) * 1000) / 1000);
  await pool.query("UPDATE onl_pedido_lineas SET peso_real = ?, delta = ?, pesaje_estado = 'confirmado' WHERE id = ?", [kg, r2(Number(l.precio_unitario) * kg - Number(l.importe)), l.id]);
  await pool.query("UPDATE onl_ajustes SET estado = 'rechazado', actualizado_ms = ? WHERE id = ?", [Date.now(), a.id]);
  await cerrarPesajeSiCompleto(p.id);
};

// Responde el cliente: acepta (y paga la diferencia por la pasarela) o rechaza. La aceptación queda con fecha, hora y medio.
const responder = async (idGlobal, { token, email, acepta, medio = 'enlace_correo' }, { baseUrl }) => {
  const { p, a } = await ajusteConToken(idGlobal, token, email);
  if (a.estado !== 'requiere_aceptacion') throw invalida(`La solicitud ya está ${a.estado}.`, 409);
  if (Number(a.aceptacion_vence_ms) <= Date.now()) { await absorber(p, a); throw invalida('La solicitud venció: el comercio absorbe la diferencia hasta su tolerancia.', 409, { codigo: 'SOLICITUD_VENCIDA' }); }
  if (!acepta) { await absorber(p, a); return { estado: 'rechazado', mensaje: 'Listo: el comercio absorbe la diferencia hasta su tolerancia.' }; }
  await pool.query('UPDATE onl_ajustes SET aceptado_ms = ?, aceptado_medio = ?, actualizado_ms = ? WHERE id = ?', [Date.now(), medio, Date.now(), a.id]);
  if (p.medio_pago !== 'pasarela') { // pago al retirar o efectivo contra entrega: el importe real se cobra al entregar
    await pool.query("UPDATE onl_ajustes SET estado = 'aceptado_en_entrega', actualizado_ms = ? WHERE id = ?", [Date.now(), a.id]);
    await confirmarLinea(p, a);
    return { estado: 'aceptado_en_entrega' };
  }
  const ref = `${p.id_global}:AJ${a.id}`;
  const c = await Pasarela.proveedor().crearCobro({ referencia: ref, importe: Number(a.adicional), titulo: `Diferencia de peso del pedido ${p.id}`, urlRetorno: `${baseUrl}/pedidos/${p.id_global}`, urlNotificacion: `${baseUrl}/webhooks/mercadopago`, idSolicitud: `aj-${a.id}` });
  await pool.query("UPDATE onl_ajustes SET estado = 'cobro_pendiente', cobro_ref = ?, actualizado_ms = ? WHERE id = ?", [ref, Date.now(), a.id]);
  return { estado: 'cobro_pendiente', url: c.url };
};
const confirmarLinea = async (p, a) => {
  const linea = Number(String(a.detalle).split(':')[1]);
  await pool.query("UPDATE onl_pedido_lineas SET pesaje_estado = 'confirmado' WHERE pedido_id = ? AND linea = ?", [p.id, linea]);
  await cerrarPesajeSiCompleto(p.id);
};
// La pasarela aprobó el cobro adicional (la notificación trae la referencia ...:AJ<id>).
const cobroAdicionalAprobado = async (referencia, { idExterno, monto }) => {
  const m = String(referencia).match(/^(.*):AJ(\d+)$/);
  if (!m) return null;
  const [[a]] = await pool.query('SELECT * FROM onl_ajustes WHERE id = ?', [Number(m[2])]);
  if (!a || a.estado !== 'cobro_pendiente') return { ya_procesado: true };
  const p = await pedido(a.pedido_id);
  await PedidoOnline.registrarCobroAdicional({ idGlobal: p.id_global, importe: monto, referencia: `adic:${idExterno}` });
  await pool.query("UPDATE onl_ajustes SET estado = 'cobrado', actualizado_ms = ? WHERE id = ?", [Date.now(), a.id]);
  await confirmarLinea(p, a);
  return { estado: 'cobrado' };
};
const vencerAceptaciones = async () => {
  const [vencidas] = await pool.query("SELECT * FROM onl_ajustes WHERE estado = 'requiere_aceptacion' AND aceptacion_vence_ms <= ?", [Date.now()]);
  for (const a of vencidas) await absorber(await pedido(a.pedido_id), a);
  return vencidas.length;
};

// ---- Pesaje completo: total real y ajuste (RN52) ----

// Stock descuenta el peso real (Ventas Online RN51 j): al pasar a Ventas el pesable viaja como una unidad (1 kg en la unidad de Stock), así que al confirmarse el pesaje se descuenta la diferencia con
// el peso real (si pesó más) o se reingresa (si pesó menos). Es lo único que corrige el stock: el reintegro de lo pesado de menos solo se anota en el pedido y no registra una devolución en Ventas, así
// que nada se cuenta dos veces. Cada línea se ajusta una sola vez (la ID de la operación lleva la línea). Sin Stock el mensaje no se genera.
const ajustarStock = async (p, lineas) => {
  if (!p.venta_id_global) return;
  const [todas] = await pool.query('SELECT linea FROM onl_pedido_lineas WHERE pedido_id = ? ORDER BY linea', [p.id]);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const l of lineas) {
      const delta = r3(Number(l.peso_real) - 1);
      if (delta === 0) continue;
      const idx = todas.findIndex((x) => x.linea === l.linea); // posición de la línea en la venta de Ventas
      if (delta > 0) await M.publicar(conn, { origen: 'ventas_online', destino: 'stock', tipo: 'descuento_stock', docTipo: 'venta', docIdGlobal: p.venta_id_global, docVersion: 1000 + l.linea, secuencia: 2,
        contenido: { doc_tipo: 'venta', items: [{ linea: 1000 + l.linea, producto_id: l.producto_id, cantidad: delta }], no_fiscal: false, user_id: null, modalidad: p.entrega_tipo === 'delivery' ? 'delivery' : 'retiro' } });
      else await M.publicar(conn, { origen: 'ventas_online', destino: 'stock', tipo: 'reingreso_stock', docTipo: 'venta', docIdGlobal: p.venta_id_global, docVersion: 1000 + l.linea, secuencia: 2,
        contenido: { modo: 'reingreso', items: [{ linea: idx, producto_id: l.producto_id, cantidad: -delta, cantidad_original: 1 }], user_id: null } });
    }
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  M.despertar();
};

const cerrarPesajeSiCompleto = async (id) => {
  const [ls] = await pool.query('SELECT * FROM onl_pedido_lineas WHERE pedido_id = ? AND es_pesable = 1', [id]);
  if (!ls.length || ls.some((l) => l.pesaje_estado !== 'confirmado')) return null;
  const p = await pedido(id);
  if (p.pesaje_estado === 'confirmado') return null;
  // Efecto de cada línea: la diferencia a favor del cliente se reintegra; lo que absorbe el comercio no cambia lo facturado; lo aceptado se cobró de más y se factura (compensados en una sola operación neta).
  let neto = 0;
  for (const l of ls) {
    const tol = await tolerancia(Number(l.importe));
    const [[acept]] = await pool.query("SELECT id FROM onl_ajustes WHERE pedido_id = ? AND detalle = ? AND estado IN ('cobrado', 'aceptado_en_entrega')", [id, `linea:${l.linea}`]);
    const d = Number(l.delta);
    neto += d < 0 ? d : (d > tol && acept ? d : 0);
  }
  neto = r2(neto);
  await ajustarStock(p, ls);
  await pool.query("UPDATE onl_pedidos SET pesaje_estado = 'confirmado', total_real = ?, updated_ms = ? WHERE id = ?", [r2(Number(p.total) + neto), Date.now(), id]);
  if (neto < 0) await pool.query("INSERT INTO onl_ajustes (pedido_id, tipo, estado, delta_neto, reintegro, detalle, ts_ms, actualizado_ms) VALUES (?, 'pesaje', 'pendiente_comprobante', ?, ?, 'neto', ?, ?)", [id, neto, -neto, Date.now(), Date.now()]);
  await Facturacion.intentar(id);
  await completarAjustes(id);
  return { total_real: r2(Number(p.total) + neto), neto };
};

// Con el comprobante emitido (la nota de crédito siempre va primero) se ejecuta el reintegro y Ventas registra la devolución (RN52 4 y 5).
const completarAjustes = async (id) => {
  if (!(await Facturacion.facturaEmitida(id))) return { esperando_comprobante: true };
  const p = await pedido(id);
  const [aj] = await pool.query("SELECT * FROM onl_ajustes WHERE pedido_id = ? AND estado IN ('pendiente_comprobante', 'pendiente_reintegro') AND detalle = 'neto'", [id]);
  for (const a of aj) {
    if (p.medio_pago !== 'pasarela') { // se cobra el real al entregar: no hay reintegro online, pero Ventas registra la devolución del excedente
      await PedidoOnline.registrarDevolucion({ idGlobal: p.id_global, importe: Number(a.reintegro), referencia: `aj:${a.id}`, medio: 'ajuste al entregar' });
      await pool.query("UPDATE onl_ajustes SET estado = 'completo', actualizado_ms = ? WHERE id = ?", [Date.now(), a.id]);
      continue;
    }
    const [[pago]] = await pool.query("SELECT id FROM onl_pagos WHERE pedido_id = ? AND estado = 'aprobado' ORDER BY id LIMIT 1", [id]);
    const r = await Reintegros.solicitar({ pedidoId: id, pagoId: pago.id, importe: Number(a.reintegro), motivo: 'diferencia_peso', solicitud: `ajuste:${a.id}` });
    if (r.estado === 'ejecutado' || r.estado === 'manual') {
      await PedidoOnline.registrarDevolucion({ idGlobal: p.id_global, importe: Number(a.reintegro), referencia: `rf:${r.id}`, medio: r.estado === 'manual' ? r.medio_manual : 'pasarela' });
      await pool.query("UPDATE onl_ajustes SET estado = 'completo', actualizado_ms = ? WHERE id = ?", [Date.now(), a.id]);
    } else await pool.query("UPDATE onl_ajustes SET estado = 'pendiente_reintegro', actualizado_ms = ? WHERE id = ?", [Date.now(), a.id]);
  }
  await Facturacion.alinear(id);
  return { completados: aj.length };
};
// Reintentos: reintegros pendientes (EX11) que ya se pueden registrar en Ventas.
const reintentarAjustes = async () => {
  const [ids] = await pool.query("SELECT DISTINCT pedido_id FROM onl_ajustes WHERE estado IN ('pendiente_comprobante', 'pendiente_reintegro')");
  for (const { pedido_id: id } of ids) {
    const [pend] = await pool.query("SELECT a.id FROM onl_ajustes a WHERE a.pedido_id = ? AND a.estado = 'pendiente_reintegro'", [id]);
    for (const a of pend) {
      const [[rf]] = await pool.query("SELECT * FROM onl_reintegros WHERE id_solicitud = ? AND estado IN ('ejecutado', 'manual')", [`ajuste:${a.id}`]);
      if (rf) {
        const p = await pedido(id);
        await PedidoOnline.registrarDevolucion({ idGlobal: p.id_global, importe: Number(rf.importe), referencia: `rf:${rf.id}`, medio: rf.estado === 'manual' ? rf.medio_manual : 'pasarela' });
        await pool.query("UPDATE onl_ajustes SET estado = 'completo', actualizado_ms = ? WHERE id = ?", [Date.now(), a.id]);
      }
    }
    await completarAjustes(id);
  }
  return ids.length;
};

// Emitido el comprobante, sale el reintegro de lo pesado de menos (RN52).
require('./eventos').suscribirFacturado(async (id) => { await completarAjustes(id); });

module.exports = { registrarPeso, solicitarAceptacion, responder, cobroAdicionalAprobado, vencerAceptaciones, estadoPesaje, completarAjustes, reintentarAjustes, tolerancia };
