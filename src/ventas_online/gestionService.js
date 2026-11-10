const pool = require('../config/db');
const Correo = require('../servicios/correoService');
const Mensajeria = require('../mensajeria/servicio');
const PedidoOnline = require('../services/pedidoOnlineService');
const Eventos = require('./eventos');
const Checkout = require('./checkoutService');
const Pagos = require('./pagoService');
const Reintegros = require('./reintegroService');
const { TiendaInvalida } = require('./tiendaService');

// Gestión de pedidos (Ventas Online RF12, RF13, RF25, RN36, RN43, RN44, RN45): entrega del pedido pagado a Ventas, estados que solo avanzan en orden, sincronía con la pantalla de cocina y
// barra, y un aviso al cliente por cada cambio (una sola vez). Un pedido con la reserva de stock sin confirmar no pasa a Ventas ni a la comanda (RN45).
const invalida = (m, status = 400, extra = {}) => Object.assign(new TiendaInvalida(m), { status, ...extra });

// ---- Entrega a Ventas ----

const pedido = async (id) => { const [[p]] = await pool.query('SELECT * FROM onl_pedidos WHERE id = ?', [id]); if (!p) throw invalida('Pedido no encontrado.', 404); return p; };

const FORMA = { plataforma: 'cobro_plataforma', pasarela: 'cobro_online', transferencia: 'transferencia', pago_al_retirar: 'efectivo', efectivo_contra_entrega: 'efectivo', cuenta_corriente: 'cuenta_corriente' };

const armarEntrega = async (p) => {
  const [lineas] = await pool.query('SELECT producto_id, titulo, cantidad, precio_unitario, importe, es_pesable, observaciones, opciones, descuento_linea, promociones FROM onl_pedido_lineas WHERE pedido_id = ? ORDER BY linea', [p.id]);
  const [[cta]] = p.cuenta_id ? await pool.query('SELECT cliente_id FROM onl_clientes WHERE id = ?', [p.cuenta_id]) : [[null]];
  const [[pago]] = await pool.query("SELECT id_externo FROM onl_pagos WHERE pedido_id = ? AND estado = 'aprobado' ORDER BY id LIMIT 1", [p.id]);
  const pagos = [];
  const canje = p.canje_datos ? JSON.parse(p.canje_datos) : null;
  if (canje) pagos.push({ forma: 'vale', importe: Number(p.canje_importe), instrumento: canje.codigo ?? null, puntos: !!canje.puntos, retencion_id: p.retencion_id });
  if (Number(p.a_pagar) > 0) pagos.push({ forma: FORMA[p.medio_pago] ?? 'otro', importe: Number(p.a_pagar), referencia: pago?.id_externo ?? p.id_global });
  const clienteId = cta?.cliente_id ?? null;
  return {
    idGlobal: p.id_global, referencia: `Online #${p.id}${p.numero_retiro ? ` ${p.numero_retiro}` : ''} ${p.nombre}`, modalidad: p.entrega_tipo === 'delivery' ? 'delivery' : 'retiro', transaccion: pago?.id_externo ?? null,
    // Un pesable viaja como una línea por su importe estimado: la cantidad de la línea de Ventas es entera; el peso real se ajusta después (RN51).
    lineas: lineas.map((l) => (l.es_pesable
      ? { producto_id: l.producto_id, titulo: `${l.titulo} (aprox. ${Number(l.cantidad)} kg)`, cantidad: 1, precio_unitario: Number(l.importe), observaciones: l.observaciones, opciones: [], descuento_linea: Number(l.descuento_linea), promociones: l.promociones ? JSON.parse(l.promociones) : [] }
      : { producto_id: l.producto_id, titulo: l.titulo, cantidad: Number(l.cantidad), precio_unitario: Number(l.precio_unitario), observaciones: l.observaciones, opciones: l.opciones ? JSON.parse(l.opciones) : [], descuento_linea: Number(l.descuento_linea), promociones: l.promociones ? JSON.parse(l.promociones) : [] })),
    envio: Number(p.envio), descuento: Number(p.descuento), total: Number(p.total), pagos, idCompromiso: p.reserva_id ?? null, clienteId,
    credito: p.credito_reserva_id && clienteId ? { clienteId, moneda: 'ARS', importe: Number(p.a_pagar), importePesos: Number(p.a_pagar), reservaId: p.credito_reserva_id } : null,
  };
};

// Entrega el pedido pagado a Ventas. Si Ventas no responde queda «pendiente» y se reintenta; repetirla no duplica nada (RN44).
const entregarAVentas = async (id) => {
  const p = await pedido(id);
  if (p.entrega_ventas_estado === 'entregado') return { estado: 'entregado', venta_id_global: p.venta_id_global, ya_procesado: true };
  if (!['pagado', 'en_preparacion', 'listo', 'despachado'].includes(p.estado)) throw invalida(`El pedido está ${p.estado}: todavía no pasa a Ventas.`, 409, { codigo: 'PEDIDO_NO_PAGADO' });
  if (['pendiente', 'fallido'].includes(p.reserva_estado)) throw invalida('La reserva de stock no está confirmada: el pedido no pasa a Ventas.', 409, { codigo: 'RESERVA_PENDIENTE' });
  try {
    const r = await PedidoOnline.recibir(await armarEntrega(p));
    await pool.query("UPDATE onl_pedidos SET entrega_ventas_estado = 'entregado', venta_id_global = ?, entrega_error = NULL, entrega_intentos = entrega_intentos + 1, updated_ms = ? WHERE id = ?", [r.venta_id_global, Date.now(), id]);
    return { estado: 'entregado', venta_id_global: r.venta_id_global, ya_procesado: r.ya_procesado };
  } catch (err) {
    await pool.query("UPDATE onl_pedidos SET entrega_ventas_estado = 'pendiente', entrega_error = ?, entrega_intentos = entrega_intentos + 1, updated_ms = ? WHERE id = ?", [String(err.message).slice(0, 255), Date.now(), id]);
    await Reintegros.alertar(`entrega-ventas-${id}`, 'alta', `El pedido online ${id} no pudo pasar a Ventas: ${err.message}. Se reintenta.`);
    return { estado: 'pendiente', error: err.message };
  }
};
const entregarPendientes = async () => {
  const [ids] = await pool.query("SELECT id FROM onl_pedidos WHERE entrega_ventas_estado = 'pendiente' AND estado IN ('pagado', 'en_preparacion', 'listo', 'despachado') AND reserva_estado NOT IN ('pendiente', 'rechazada') ORDER BY created_ms");
  const salida = { entregados: 0, pendientes: 0 };
  for (const { id } of ids) { const r = await entregarAVentas(id); if (r.estado === 'entregado') salida.entregados++; else salida.pendientes++; }
  return salida;
};

// ---- Avisos al cliente (RF13) ----

const TEXTOS = {
  pagado: ['Recibimos tu pedido', 'Ya tenemos tu pedido y lo estamos organizando.'],
  en_preparacion: ['Estamos preparando tu pedido', 'Tu pedido está en preparación.'],
  listo: ['Tu pedido está listo', 'Tu pedido está listo para retirar.'],
  despachado: ['Tu pedido salió', 'Tu pedido salió en camino.'],
  entregado: ['Entregamos tu pedido', 'Tu pedido fue entregado. ¡Gracias por tu compra!'],
  cancelado: ['Cancelamos tu pedido', 'Tu pedido fue cancelado.'],
  con_faltante: ['Tu pedido tiene un faltante', 'Nos quedamos sin algún artículo: te contactamos para esperar la reposición, cambiarlo o reintegrarte.'],
  devuelto: ['Registramos tu devolución', 'Registramos la devolución de tu pedido.'],
};
const notificar = async (id, evento) => {
  const t = TEXTOS[evento];
  if (!t) return false;
  const p = await pedido(id);
  const [r] = await pool.query('INSERT IGNORE INTO onl_notificaciones (pedido_id, evento, para, ts_ms) VALUES (?, ?, ?, ?)', [id, evento, p.email, Date.now()]);
  if (!r.affectedRows) return false; // ya se avisó
  const retiro = p.entrega_tipo === 'retiro' && evento === 'listo' ? ` Número para retirar: ${p.numero_retiro ?? p.id}.` : '';
  await Correo.encolar({ para: p.email, asunto: `${t[0]} (#${p.id})`, cuerpo: `Hola ${p.nombre}, ${t[1]}${retiro}\n` }).catch(() => {});
  return true;
};

// ---- Estados ----

// Solo se avanza en este orden. Cancelar y devolver tienen su propio camino (reintegro y nota de crédito); «Con faltante» se marca aparte.
const SIGUIENTE = { pagado: ['en_preparacion'], en_preparacion: ['listo'], listo: ['entregado', 'despachado'], despachado: ['entregado'], con_faltante: ['pagado'] };
const cambiarEstado = async (id, estado, { userId = null, motivo = null, origen = 'panel' } = {}) => {
  const p = await pedido(id);
  if (estado === 'cancelado' || estado === 'devuelto') throw invalida('La cancelación y la devolución tienen su propio camino (reintegro y nota de crédito).', 409, { codigo: 'USAR_CANCELACION' });
  if (!(SIGUIENTE[p.estado] ?? []).includes(estado)) throw invalida(`Un pedido ${p.estado} no puede pasar a ${estado}.`, 409, { codigo: 'ESTADO_INVALIDO', permitidos: SIGUIENTE[p.estado] ?? [] });
  if (estado === 'despachado' && p.entrega_tipo !== 'delivery') throw invalida('Solo el delivery se despacha.', 409);
  if (estado === 'entregado' && p.entrega_tipo === 'delivery' && p.estado !== 'despachado') throw invalida('El delivery se despacha antes de entregarse.', 409, { codigo: 'ESTADO_INVALIDO' });
  if (['en_preparacion', 'listo', 'despachado', 'entregado'].includes(estado) && !p.pagado_ms) throw invalida('El pedido no tiene el pago acreditado.', 409, { codigo: 'PEDIDO_NO_PAGADO' });
  if (['en_preparacion', 'listo'].includes(estado) && p.entrega_ventas_estado !== 'entregado') {
    const r = await entregarAVentas(id); // la preparación arranca con el pedido ya en Ventas y en la comanda
    if (r.estado !== 'entregado') throw invalida('El pedido todavía no pasó a Ventas: se reintenta.', 409, { codigo: 'ENTREGA_PENDIENTE' });
  }
  await pool.query('UPDATE onl_pedidos SET estado = ?, listo_ms = IF(? = \'listo\', ?, listo_ms), updated_ms = ? WHERE id = ?', [estado, estado, Date.now(), Date.now(), id]);
  await Checkout.historial(pool, id, estado, motivo ?? (origen === 'cocina' ? 'Avance en cocina/barra' : null), userId);
  await Eventos.estado(id, estado, motivo);
  return Checkout.vista(id);
};

// «Con faltante» a mano (sin Stock) sobre un pedido pagado (EX04).
const marcarConFaltante = async (id, { motivo, userId }) => {
  if (typeof motivo !== 'string' || motivo.trim().length < 3) throw invalida('Indicá qué falta.');
  const p = await pedido(id);
  if (!['pagado', 'en_preparacion', 'reserva_pendiente'].includes(p.estado)) throw invalida(`Un pedido ${p.estado} no se marca con faltante.`, 409);
  await pool.query("UPDATE onl_pedidos SET estado = 'con_faltante', updated_ms = ? WHERE id = ?", [Date.now(), id]);
  await Checkout.historial(pool, id, 'con_faltante', motivo.trim().slice(0, 255), userId);
  await Eventos.estado(id, 'con_faltante', motivo);
  return Checkout.vista(id);
};

// La pantalla de cocina y barra manda (RN36): «En preparación» → En preparación, «Listo» → Listo, «Entregado» → Entregado. Se avanza paso a paso para no saltear avisos.
const ORDEN = ['pagado', 'en_preparacion', 'listo', 'entregado'];
const sincronizarCocina = async () => {
  const [peds] = await pool.query("SELECT id, id_global, estado, entrega_tipo FROM onl_pedidos WHERE estado IN ('pagado', 'en_preparacion', 'listo') AND entrega_ventas_estado = 'entregado'");
  let cambios = 0;
  for (const p of peds) {
    const av = await PedidoOnline.avanceDe(p.id_global);
    const objetivo = { pendiente: 'pagado', en_preparacion: 'en_preparacion', listo: 'listo', entregado: 'entregado' }[av];
    if (!objetivo) continue;
    let actual = p.estado;
    while (ORDEN.indexOf(actual) < ORDEN.indexOf(objetivo)) {
      const sig = ORDEN[ORDEN.indexOf(actual) + 1];
      if (sig === 'entregado' && p.entrega_tipo === 'delivery') break; // el delivery lo despacha y entrega una persona con permiso
      await cambiarEstado(p.id, sig, { origen: 'cocina' });
      actual = sig; cambios++;
    }
  }
  return { revisados: peds.length, cambios };
};

// ---- Panel ----

const listar = async ({ estado, q, desde, hasta, alineacion, origen, limite = 200 } = {}) => {
  const w = [], par = [];
  if (estado) { w.push('estado = ?'); par.push(estado); }
  if (q) { w.push('(nombre LIKE ? OR email LIKE ? OR numero_retiro = ? OR id = ?)'); par.push(`%${q}%`, `%${q}%`, q, Number(q) || 0); }
  if (alineacion) { w.push('alineacion = ?'); par.push(alineacion); }
  if (origen) { w.push('origen = ?'); par.push(origen); }
  if (desde) { w.push('created_ms >= ?'); par.push(new Date(`${desde}T00:00:00`).getTime()); }
  if (hasta) { w.push('created_ms <= ?'); par.push(new Date(`${hasta}T23:59:59`).getTime()); }
  const [filas] = await pool.query(`SELECT id FROM onl_pedidos ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY COALESCE(programado_ms, created_ms), id LIMIT ?`, [...par, Math.min(Number(limite) || 200, 500)]);
  return Promise.all(filas.map(async ({ id }) => { const v = await Checkout.vista(id); const { lineas, ...resto } = v; return { ...resto, lineas: lineas.length }; }));
};
const detalle = async (id) => {
  const v = await Checkout.vista(id);
  if (!v) throw invalida('Pedido no encontrado.', 404);
  const p = await pedido(id);
  const [hist] = await pool.query('SELECT estado, detalle, user_id, ts_ms FROM onl_pedido_historial WHERE pedido_id = ? ORDER BY id', [id]);
  const integracion = p.venta_id_global ? await Mensajeria.estadoIntegracion(p.venta_id_global) : null;
  const Facturacion = require('./facturacionService'); // más tarde que la entrega a Ventas: sus enlaces se registran después
  return { ...v, alineacion: p.alineacion, comprobantes: await Facturacion.comprobantes(id), entrega_ventas: { estado: p.entrega_ventas_estado, venta_id_global: p.venta_id_global, intentos: p.entrega_intentos, error: p.entrega_error }, integracion, pagos: await Pagos.pagosDe(id),
    historial: hist.map((h) => ({ ...h, ts_ms: Number(h.ts_ms) })) };
};
// La lista de preparación: lo que hay que armar, por hora comprometida (RN36).
const preparacion = async () => {
  const [peds] = await pool.query("SELECT id, nombre, numero_retiro, entrega_tipo, programado_ms, tiempo_estimado_min, estado FROM onl_pedidos WHERE estado IN ('pagado', 'en_preparacion') ORDER BY COALESCE(programado_ms, created_ms), id");
  const salida = [];
  for (const p of peds) {
    const [ls] = await pool.query('SELECT titulo, cantidad, observaciones, opciones FROM onl_pedido_lineas WHERE pedido_id = ? ORDER BY linea', [p.id]);
    salida.push({ ...p, programado_ms: p.programado_ms ? Number(p.programado_ms) : null, items: ls.map((l) => ({ titulo: l.titulo, cantidad: Number(l.cantidad), observaciones: l.observaciones, opciones: l.opciones ? JSON.parse(l.opciones).map((o) => o.nombre) : [] })) });
  }
  return salida;
};

// Enlaces: cuando un pedido queda pagado se entrega a Ventas y se avisa al cliente; cada cambio de estado se avisa una sola vez.
Eventos.suscribirPagado(async (id) => { await entregarAVentas(id).catch(() => {}); await notificar(id, 'pagado'); });
Eventos.suscribirEstado(async (id, estado) => { if (estado !== 'pagado') await notificar(id, estado); });

module.exports = { entregarAVentas, entregarPendientes, cambiarEstado, marcarConFaltante, sincronizarCocina, listar, detalle, preparacion, notificar, SIGUIENTE };
