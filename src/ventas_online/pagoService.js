const pool = require('../config/db');
const puertos = require('../modulos/puertos');
const Funciones = require('../funciones/servicio');
const Pasarela = require('./pasarelaMP');
const Reserva = require('./reservaPedidoService');
const Reintegros = require('./reintegroService');
const Eventos = require('./eventos');
const Checkout = require('./checkoutService');
const { TiendaInvalida } = require('./tiendaService');

// Pagos de la tienda (Ventas Online RF10, RN06, RN08, RN09, EX01 a EX03, EX29). El cobro por pasarela se abre solo con la reserva de stock confirmada y se confirma por la notificación firmada de
// la pasarela, una sola vez por transacción. Los medios sin pasarela (transferencia, pago al retirar, efectivo contra entrega, cuenta corriente) los confirma el comercio. Ventas Online no registra
// cobros en Financiero: deja el Pago_Online y entrega el pedido pagado a Ventas (I8).
const invalida = (m, status = 400, extra = {}) => Object.assign(new TiendaInvalida(m), { status, ...extra });
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const alerta = (clave, mensaje, severidad = 'alta') => Reintegros.alertar(clave, severidad, mensaje);

const pedido = async (id, conn = pool) => {
  const [[p]] = await conn.query('SELECT * FROM onl_pedidos WHERE id = ?', [id]);
  if (!p) throw invalida('Pedido no encontrado.', 404);
  return p;
};
const lineasDe = async (id) => (await pool.query('SELECT producto_id, cantidad FROM onl_pedido_lineas WHERE pedido_id = ?', [id]))[0];

// ---- Apertura del cobro ----

// Abre el cobro en la pasarela. Si la reserva venció se pide una nueva primero (EX28); si ya no hay disponible no se abre el cobro (EX27). Repetir la clave devuelve el mismo cobro.
const abrirCobro = async (id, { baseUrl, idSolicitud }) => {
  if (!(await Funciones.estaActiva('ONL-PASARELA'))) throw invalida('El pago online no está habilitado.', 409, { codigo: 'FUNCION_INACTIVA' });
  let p = await pedido(id);
  if (p.medio_pago !== 'pasarela') throw invalida('Este pedido no se paga por la pasarela.', 409);
  if (p.estado !== 'pendiente_pago') throw invalida(`El pedido está ${p.estado}.`, 409);
  const sol = String(idSolicitud ?? `${p.id_global}:cobro:${p.reserva_intento}`);
  const [[previo]] = await pool.query('SELECT * FROM onl_cobros WHERE id_solicitud = ?', [sol]);
  if (previo) return { cobro_id: previo.id, url: previo.url, preferencia_id: previo.preferencia_id, repetido: true };
  if (p.reserva_estado === 'confirmada' && Number(p.reserva_vence_ms) <= Date.now()) await pool.query("UPDATE onl_pedidos SET reserva_estado = 'vencida' WHERE id = ?", [id]);
  p = await pedido(id);
  if (p.reserva_estado === 'vencida') {
    const r = await Reserva.reintentar(p, await lineasDe(id));
    if (r.estado === 'rechazada') throw invalida('La reserva venció y ya no hay disponible suficiente: ajustá el pedido.', 409, { codigo: 'SIN_DISPONIBLE', detalle: r.sin_disponible });
    p = await pedido(id);
  }
  const c = await Pasarela.proveedor().crearCobro({ referencia: p.id_global, importe: Number(p.a_pagar), titulo: `Pedido ${p.id}`, urlRetorno: `${baseUrl}/pedidos/${p.id_global}`, urlNotificacion: `${baseUrl}/webhooks/mercadopago`, idSolicitud: sol });
  const [r] = await pool.query('INSERT INTO onl_cobros (pedido_id, proveedor, id_solicitud, preferencia_id, url, importe, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, Pasarela.proveedor().nombre, sol, c.preferencia_id, c.url, p.a_pagar, Date.now()]);
  return { cobro_id: r.insertId, url: c.url, preferencia_id: c.preferencia_id, repetido: false, reserva: (await Checkout.vista(id)).reserva };
};

// ---- Pedido pagado ----

const pasarAPagado = async (p, detalle) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE onl_pedidos SET estado = 'pagado', pagado_ms = ?, updated_ms = ? WHERE id = ? AND estado IN ('pendiente_pago', 'reserva_pendiente', 'con_faltante')", [Date.now(), Date.now(), p.id]);
    await Checkout.historial(conn, p.id, 'pagado', detalle);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  await Eventos.estado(p.id, 'pagado', detalle);
  await Eventos.pagado(p.id);
};
const cambiarEstado = async (p, estado, detalle) => {
  await pool.query('UPDATE onl_pedidos SET estado = ?, updated_ms = ? WHERE id = ?', [estado, Date.now(), p.id]);
  await Checkout.historial(pool, p.id, estado, detalle);
  await Eventos.estado(p.id, estado, detalle);
};

// El pago quedó aprobado: la reserva se hace firme y el pedido pasa a «Pagado». Con la reserva vencida se intenta de nuevo (EX29); con Stock sin respuesta queda «Reserva pendiente de
// confirmación» (RN45); sin disponible, «Con faltante» (EX04).
const confirmarPago = async (id, detalle) => {
  let p = await pedido(id);
  if (p.estado !== 'pendiente_pago') return { estado: p.estado };
  const vencida = p.reserva_estado === 'vencida' || (p.reserva_estado === 'confirmada' && Number(p.reserva_vence_ms) <= Date.now());
  if (vencida) {
    const r = await Reserva.reintentar(p, await lineasDe(id));
    p = await pedido(id);
    if (r.estado === 'rechazada') { await cambiarEstado(p, 'con_faltante', 'Pago aprobado con la reserva vencida y sin disponible'); await alerta(`faltante-${id}`, `El pedido ${id} se pagó y ya no hay stock: esperar, reemplazar o reintegrar.`); return { estado: 'con_faltante' }; }
  }
  p = await pedido(id);
  if (p.reserva_estado === 'pendiente') { await cambiarEstado(p, 'reserva_pendiente', 'Pago aprobado; la reserva se confirma cuando Stock responda'); return { estado: 'reserva_pendiente' }; }
  if (p.reserva_estado === 'confirmada' && p.reserva_id) {
    await llamarFirmar(p.reserva_id);
    await pool.query("UPDATE onl_pedidos SET reserva_estado = 'firme', reserva_vence_ms = NULL WHERE id = ?", [id]);
  }
  await pasarAPagado(p, detalle);
  return { estado: 'pagado' };
};
const llamarFirmar = async (idReserva) => { const s = await puertos.obtener('stock'); await s.firmarCompromiso?.(idReserva); };

// ---- Notificación de la pasarela ----

// Una notificación repetida de la misma transacción responde «ya procesado» con el resultado original (RN09); dos transacciones distintas aprobadas para un pedido: solo la primera cobra, la
// segunda se marca «duplicado» y se reintegra sola (EX03). Un pago acreditado cuyo pedido ya no puede cobrarse genera alerta y reintegro, no se descarta.
const procesarPago = async (idExterno) => {
  const prov = Pasarela.proveedor();
  const x = await prov.obtenerPago(idExterno);
  const estadoLocal = { approved: 'aprobado', rejected: 'rechazado', cancelled: 'rechazado', pending: 'pendiente', in_process: 'pendiente', refunded: 'reintegrado', charged_back: 'reintegrado' }[x.estado] ?? 'pendiente';
  const [[ped]] = await pool.query('SELECT * FROM onl_pedidos WHERE id_global = ?', [x.referencia ?? '']);
  const [[previo]] = await pool.query('SELECT * FROM onl_pagos WHERE proveedor = ? AND id_externo = ?', [prov.nombre, x.id]);
  if (previo && previo.estado === estadoLocal) return { ya_procesado: true, estado: previo.estado, pedido_estado: ped?.estado ?? null };
  if (previo && ['duplicado', 'sin_pedido'].includes(previo.estado)) return { ya_procesado: true, estado: previo.estado }; // ya tuvo su desenlace: no se reintegra dos veces
  if (previo && ['aprobado', 'duplicado', 'sin_pedido', 'importe_distinto'].includes(previo.estado) && estadoLocal === 'pendiente') return { ya_procesado: true, estado: previo.estado }; // una pendiente tardía no retrocede
  const ahora = Date.now();
  if (!previo) {
    await pool.query('INSERT INTO onl_pagos (pedido_id, proveedor, id_externo, referencia, estado, importe, metodo, detalle, creado_ms, actualizado_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [ped?.id ?? null, prov.nombre, x.id, x.referencia, estadoLocal === 'aprobado' ? 'recibido' : estadoLocal, x.monto, x.metodo, x.detalle, ahora, ahora]);
  } else if (!['aprobado'].includes(previo.estado)) await pool.query('UPDATE onl_pagos SET estado = ?, detalle = ?, actualizado_ms = ? WHERE id = ?', [estadoLocal === 'aprobado' ? 'recibido' : estadoLocal, x.detalle, ahora, previo.id]);
  const [[pago]] = await pool.query('SELECT * FROM onl_pagos WHERE proveedor = ? AND id_externo = ?', [prov.nombre, x.id]);
  const marcar = (estado, detalle) => pool.query('UPDATE onl_pagos SET estado = ?, detalle = ?, actualizado_ms = ? WHERE id = ?', [estado, detalle ?? null, Date.now(), pago.id]);
  if (estadoLocal !== 'aprobado') return { ya_procesado: false, estado: estadoLocal, pedido_estado: ped?.estado ?? null }; // EX01: rechazado, el pedido sigue pendiente de pago con la misma reserva
  if (!ped) { await marcar('sin_pedido', 'Pago sin pedido conocido'); await alerta(`pago-huerfano-${pago.id}`, `Se acreditó el pago ${x.id} (${x.monto}) que no corresponde a ningún pedido.`); return { ya_procesado: false, estado: 'sin_pedido' }; }
  const aprobadoAntes = (await pool.query("SELECT id FROM onl_pagos WHERE pedido_id = ? AND estado = 'aprobado' AND id <> ?", [ped.id, pago.id]))[0].length > 0;
  if (aprobadoAntes) { // EX03
    await marcar('duplicado', 'Segundo pago aprobado del mismo pedido');
    await alerta(`pago-duplicado-${pago.id}`, `El pedido ${ped.id} recibió un segundo pago aprobado (${x.id}): se reintegra.`);
    await Reintegros.solicitar({ pedidoId: ped.id, pagoId: pago.id, importe: x.monto, motivo: 'duplicado', solicitud: `dup:${prov.nombre}:${x.id}` });
    return { ya_procesado: false, estado: 'duplicado' };
  }
  if (!['pendiente_pago'].includes(ped.estado)) { // pago tardío de un pedido cancelado o ya resuelto
    await marcar('sin_pedido', `El pedido estaba ${ped.estado}`);
    await alerta(`pago-tardio-${pago.id}`, `Se acreditó el pago ${x.id} del pedido ${ped.id}, que está ${ped.estado}: se reintegra.`);
    await Reintegros.solicitar({ pedidoId: ped.id, pagoId: pago.id, importe: x.monto, motivo: 'pedido_cerrado', solicitud: `tardio:${prov.nombre}:${x.id}` });
    return { ya_procesado: false, estado: 'sin_pedido' };
  }
  if (Math.abs(x.monto - Number(ped.a_pagar)) > 0.004) {
    await marcar('importe_distinto', `Cobró ${x.monto} y el pedido pide ${Number(ped.a_pagar)}`);
    await alerta(`pago-importe-${pago.id}`, `El pago ${x.id} es de ${x.monto} y el pedido ${ped.id} pide ${Number(ped.a_pagar)}: revisalo.`);
    return { ya_procesado: false, estado: 'importe_distinto' };
  }
  await marcar('aprobado', x.detalle);
  const r = await confirmarPago(ped.id, `Pago ${x.id} aprobado`);
  return { ya_procesado: false, estado: 'aprobado', pedido_estado: r.estado };
};

// EX02: si la notificación no llega, se consulta la pasarela por la referencia del pedido antes de cancelarlo por tiempo.
const consultarPendientes = async () => {
  const [peds] = await pool.query("SELECT id, id_global FROM onl_pedidos WHERE estado = 'pendiente_pago' AND medio_pago = 'pasarela' AND EXISTS (SELECT 1 FROM onl_cobros c WHERE c.pedido_id = onl_pedidos.id)");
  const salida = { revisados: peds.length, aprobados: 0 };
  for (const p of peds) {
    const pagos = await Pasarela.proveedor().buscarPagos(p.id_global).catch(() => []);
    for (const x of pagos.filter((y) => y.estado === 'approved')) { const r = await procesarPago(x.id); if (r.estado === 'aprobado') salida.aprobados++; }
  }
  return salida;
};

// ---- Medios que no pasan por la pasarela (RN06) ----

// Transferencia con confirmación manual: queda el Pago_Online con la referencia que cargó el comercio.
const confirmarTransferencia = async (id, { referencia, userId }) => {
  const p = await pedido(id);
  if (p.medio_pago !== 'transferencia') throw invalida('El pedido no se paga por transferencia.', 409);
  if (p.estado !== 'pendiente_pago') throw invalida(`El pedido está ${p.estado}.`, 409);
  if (typeof referencia !== 'string' || referencia.trim().length < 3) throw invalida('Cargá la referencia de la transferencia.');
  const ahora = Date.now();
  const [r] = await pool.query('INSERT IGNORE INTO onl_pagos (pedido_id, proveedor, id_externo, referencia, estado, importe, metodo, detalle, creado_ms, actualizado_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, 'manual', `transferencia:${p.id_global}`, p.id_global, 'aprobado', p.a_pagar, 'transferencia', referencia.trim().slice(0, 200), ahora, ahora]);
  if (!r.affectedRows) throw invalida('La transferencia ya estaba confirmada.', 409);
  void userId;
  return confirmarPago(id, `Transferencia confirmada (${referencia.trim()})`);
};
// Pago al retirar, efectivo contra entrega, cuenta corriente y canje total: se confirman al aceptar el pedido, con la reserva ya confirmada (RN06).
const aceptarPedido = async (id, { userId } = {}) => {
  const p = await pedido(id);
  if (!['pago_al_retirar', 'efectivo_contra_entrega', 'cuenta_corriente', 'canje'].includes(p.medio_pago)) throw invalida('Este medio de pago no se acepta a mano.', 409);
  if (p.estado !== 'pendiente_pago') throw invalida(`El pedido está ${p.estado}.`, 409);
  if (p.medio_pago === 'canje' && Number(p.a_pagar) > 0) throw invalida('El canje no cubre el total del pedido.', 409);
  if (p.medio_pago === 'cuenta_corriente' && !p.credito_reserva_id) throw invalida('El pedido no tiene la reserva de crédito.', 409);
  if (p.reserva_estado === 'pendiente') throw invalida('La reserva de stock todavía no está confirmada.', 409, { codigo: 'RESERVA_PENDIENTE' });
  void userId;
  return confirmarPago(id, 'Pedido aceptado por el comercio');
};

const pagosDe = async (pedidoId) => (await pool.query('SELECT id, proveedor, id_externo, estado, importe, metodo, detalle, reintegrado FROM onl_pagos WHERE pedido_id = ? ORDER BY id', [pedidoId]))[0]
  .map((x) => ({ ...x, importe: Number(x.importe), reintegrado: Number(x.reintegrado) }));

// Configuración de la pasarela (las credenciales no se devuelven).
const configurar = async ({ access_token: token, webhook_secret: secreto }) => {
  if (token !== undefined) await pool.query('UPDATE onl_tienda SET mp_access_token = ? WHERE id = 1', [token ? String(token).slice(0, 255) : null]);
  if (secreto !== undefined) await pool.query('UPDATE onl_tienda SET mp_webhook_secret = ? WHERE id = 1', [secreto ? String(secreto).slice(0, 120) : null]);
  return estadoConfig();
};
const estadoConfig = async () => { const [[t]] = await pool.query('SELECT mp_access_token, mp_webhook_secret FROM onl_tienda WHERE id = 1'); return { access_token: !!t.mp_access_token, webhook_secret: !!t.mp_webhook_secret }; };

module.exports = { abrirCobro, procesarPago, consultarPendientes, confirmarPago, confirmarTransferencia, aceptarPedido, pagosDe, configurar, estadoConfig, r2 };
