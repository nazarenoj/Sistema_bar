const crypto = require('crypto');
const pool = require('../config/db');
const puertos = require('../modulos/puertos');
const Correo = require('../servicios/correoService');
const PedidoOnline = require('../services/pedidoOnlineService');
const Comandas = require('../services/comandaService');
const Cupones = require('./cuponService');
const Checkout = require('./checkoutService');
const Reserva = require('./reservaPedidoService');
const Reintegros = require('./reintegroService');
const Facturacion = require('./facturacionService');
const Eventos = require('./eventos');
const { TiendaInvalida } = require('./tiendaService');

// Cancelaciones, devoluciones y arrepentimiento (Ventas Online RF15, RN15, RN52, EX11, EX35). Cancelar un pedido sin despachar o devolverlo después: Ventas registra la devolución (con su nota de
// crédito, el reingreso a Stock y el contramovimiento en Financiero) y SOLO después Ventas Online ejecuta el reintegro en la pasarela. Si la nota de crédito no sale, el reintegro queda retenido
// y se reintenta. Un pedido que nunca llegó a Ventas solo libera lo que reservó (stock, crédito, vales, cupón).
const invalida = (m, status = 400, extra = {}) => Object.assign(new TiendaInvalida(m), { status, ...extra });
const r2 = (x) => Math.round(Number(x) * 100) / 100;

const pedido = async (id) => { const [[p]] = await pool.query('SELECT * FROM onl_pedidos WHERE id = ?', [id]); if (!p) throw invalida('Pedido no encontrado.', 404); return p; };
const registrar = async (p, tipo, motivo, userId) => (await pool.query('INSERT INTO onl_devoluciones (pedido_id, tipo, motivo, estado, user_id, creado_ms, actualizado_ms) VALUES (?, ?, ?, ?, ?, ?, ?)', [p.id, tipo, String(motivo).slice(0, 255), 'iniciada', userId ?? null, Date.now(), Date.now()]))[0].insertId;
const actualizar = (id, c) => { const k = Object.keys(c); return pool.query(`UPDATE onl_devoluciones SET ${k.map((x) => `${x} = ?`).join(', ')}, actualizado_ms = ? WHERE id = ?`, [...k.map((x) => c[x]), Date.now(), id]); };

// Lo que se puede reintegrar por la pasarela: lo cobrado y no reintegrado de los pagos aprobados.
const reintegrables = async (pedidoId) => (await pool.query("SELECT id, proveedor, importe, reintegrado FROM onl_pagos WHERE pedido_id = ? AND estado IN ('aprobado', 'adicional') ORDER BY id", [pedidoId]))[0].map((x) => ({ ...x, libre: r2(Number(x.importe) - Number(x.reintegrado)) }));

// Ejecuta el reintegro de la devolución (después de la nota de crédito).
const reintegrar = async (devId, p, importe) => {
  let resto = r2(importe);
  let pendiente = false;
  for (const pago of await reintegrables(p.id)) {
    if (resto <= 0) break;
    const parte = Math.min(resto, pago.libre);
    if (parte <= 0) continue;
    const r = await Reintegros.solicitar({ pedidoId: p.id, pagoId: pago.id, importe: parte, motivo: 'devolucion', detalle: `devolución ${devId}`, solicitud: `dev:${devId}:${pago.id}` });
    if (r.estado !== 'ejecutado' && r.estado !== 'manual') pendiente = true; // EX11
    resto = r2(resto - parte);
  }
  await actualizar(devId, { reintegro_pasarela: r2(importe) - resto, estado: pendiente ? 'reintegro_pendiente' : 'completa' });
  return pendiente ? 'reintegro_pendiente' : 'completa';
};

// ---- Cancelar (antes del despacho) ----

const liberarReservas = async (p) => {
  await Reserva.liberar(p.reserva_id);
  const credito = await puertos.obtener('credito');
  if (p.credito_reserva_id) await credito.liberarReserva?.(p.credito_reserva_id)?.catch?.(() => {});
  if (p.retencion_id) await credito.liberarRetencion?.(p.retencion_id)?.catch?.(() => {});
};

const cancelar = async (id, { motivo, userId = null, cliente = false } = {}) => {
  if (typeof motivo !== 'string' || motivo.trim().length < 3) throw invalida('El motivo es obligatorio.');
  const p = await pedido(id);
  if (['cancelado', 'devuelto'].includes(p.estado)) throw invalida(`El pedido ya está ${p.estado}.`, 409);
  if (['despachado', 'entregado'].includes(p.estado)) throw invalida('Un pedido despachado se devuelve, no se cancela.', 409, { codigo: 'USAR_DEVOLUCION' });
  if (cliente && !['pendiente_pago', 'reserva_pendiente', 'pagado', 'con_faltante'].includes(p.estado)) throw invalida('Tu pedido ya está en preparación: pedile al comercio que lo cancele.', 409, { codigo: 'EN_PREPARACION' });
  if (p.estado === 'pendiente_pago') return { ...(await Checkout.abandonar(id, { motivo: motivo.trim() })), cancelado: true }; // nada cobrado: solo se libera todo
  const devId = await registrar(p, 'cancelacion', motivo, userId);
  let nc = null, total = Number(p.total), devuelta = null;
  if (p.entrega_ventas_estado === 'entregado') {
    try {
      const r = await PedidoOnline.devolverPedido({ idGlobal: p.id_global, todo: true, motivo: motivo.trim(), idSolicitud: `online:cancel:${devId}`, userId });
      devuelta = r.devolucion.id_global; nc = r.nota_credito; total = Number(r.devolucion.total);
    } catch (err) { await actualizar(devId, { estado: 'error', detalle: err.message.slice(0, 255) }); throw err; }
    // La comanda que ya estaba en cocina se anula (RN36): si había empezado, el administrador decide si fue merma.
    const [[m]] = await pool.query('SELECT mesa_id FROM ventas_pedidos_online WHERE pedido_global = ?', [p.id_global]);
    if (m) for (const c of (await pool.query("SELECT id FROM comandas WHERE mesa_id = ? AND estado = 'emitida' AND avance IN ('pendiente', 'en_preparacion')", [m.mesa_id]))[0]) await Comandas.anular(c.id, `Pedido online ${id} cancelado`, { id: userId, username: 'tienda-online', rol: 'sistema' }).catch(() => {});
  } else await liberarReservas(p); // todavía no pasó a Ventas: no hay venta ni reingreso, solo se libera la reserva
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE onl_pedidos SET estado = 'cancelado', motivo_cancelacion = ?, reserva_estado = IF(reserva_estado IN ('confirmada', 'firme'), 'liberada', reserva_estado), updated_ms = ? WHERE id = ?", [motivo.trim().slice(0, 255), Date.now(), id]);
    if (p.cupon_id) await Cupones.reponer(conn, p.cupon_id, p.id_global);
    await Checkout.historial(conn, id, 'cancelado', motivo.trim().slice(0, 255), userId);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  await actualizar(devId, { total_devuelto: total, venta_devolucion: devuelta, nc_factura_id: nc?.id ?? null });
  await Eventos.estado(id, 'cancelado', motivo);
  return finalizar(devId, p, total, nc);
};

// La secuencia fija: nota de crédito primero (si había comprobante) y solo después el reintegro.
const finalizar = async (devId, p, total, nc) => {
  if (nc && nc.estado !== 'aprobada') { // EX35: el reintegro queda retenido hasta que salga la nota
    await actualizar(devId, { estado: 'nota_credito_pendiente', detalle: 'ARCA no autorizó la nota de crédito: el reintegro espera' });
    await Reintegros.alertar(`nc-pendiente-${devId}`, 'alta', `La nota de crédito de la devolución del pedido ${p.id} no salió: el reintegro está retenido y se reintenta.`);
    await Facturacion.alinear(p.id).catch(() => {});
    return { devolucion_id: devId, estado: 'nota_credito_pendiente' };
  }
  const estado = await reintegrar(devId, p, total);
  await Facturacion.alinear(p.id).catch(() => {});
  return { devolucion_id: devId, estado };
};

// ---- Devolver (total o parcial, también después del despacho) ----

const devolver = async (id, { lineas, todo, motivo, reingreso = 'reingreso', userId = null }) => {
  if (typeof motivo !== 'string' || motivo.trim().length < 3) throw invalida('El motivo es obligatorio.');
  const p = await pedido(id);
  if (!['entregado', 'despachado', 'listo', 'en_preparacion', 'pagado'].includes(p.estado) || p.entrega_ventas_estado !== 'entregado') throw invalida(`Un pedido ${p.estado} no se devuelve.`, 409);
  if (!todo && (!Array.isArray(lineas) || !lineas.length)) throw invalida('Indicá qué líneas se devuelven (o todo).');
  const devId = await registrar(p, todo ? 'devolucion_total' : 'devolucion_parcial', motivo, userId);
  let r;
  try { r = await PedidoOnline.devolverPedido({ idGlobal: p.id_global, lineas, todo, motivo: motivo.trim(), reingreso, idSolicitud: `online:dev:${devId}`, userId }); } catch (err) { await actualizar(devId, { estado: 'error', detalle: String(err.message).slice(0, 255) }); throw err; }
  const total = Number(r.devolucion.total);
  await actualizar(devId, { total_devuelto: total, venta_devolucion: r.devolucion.id_global, nc_factura_id: r.nota_credito?.id ?? null });
  if (r.devolucion.tipo === 'total') {
    await pool.query("UPDATE onl_pedidos SET estado = 'devuelto', updated_ms = ? WHERE id = ?", [Date.now(), id]);
    await Checkout.historial(pool, id, 'devuelto', motivo.trim().slice(0, 255), userId);
    await Eventos.estado(id, 'devuelto', motivo);
  } else await Checkout.historial(pool, id, p.estado, `Devolución parcial de ${total}: ${motivo.trim()}`.slice(0, 255), userId);
  // Lo que se devuelve por la pasarela es la parte del reintegro que corresponde al cobro online (el resto, vales o efectivo, lo resuelve Ventas).
  const online = r.reintegros.filter((x) => ['cobro_online', 'cobro_plataforma'].includes(x.forma)).reduce((a, x) => a + Number(x.importe), 0);
  const res = await finalizar(devId, p, r2(online), r.nota_credito);
  return { ...res, total_devuelto: total, devolucion_tipo: r.devolucion.tipo };
};

// Reintentos: la nota de crédito que no salió (EX35) y, con ella, el reintegro retenido.
const reintentarPendientes = async () => {
  const [pend] = await pool.query("SELECT * FROM onl_devoluciones WHERE estado = 'nota_credito_pendiente'");
  const salida = { reanudadas: 0, pendientes: 0 };
  for (const d of pend) {
    const r = await PedidoOnline.reintentarNotaCredito(d.nc_factura_id);
    if (r.estado !== 'aprobada') { salida.pendientes++; continue; }
    const p = await pedido(d.pedido_id);
    const [[dev]] = await pool.query('SELECT total FROM devoluciones WHERE id_global = ?', [d.venta_devolucion]);
    await finalizar(d.id, p, Number(dev?.total ?? d.total_devuelto), null);
    salida.reanudadas++;
  }
  return salida;
};
const listar = async (pedidoId) => (await pool.query('SELECT id, tipo, motivo, total_devuelto, reintegro_pasarela, estado, detalle, creado_ms FROM onl_devoluciones WHERE pedido_id = ? ORDER BY id', [pedidoId]))[0].map((d) => ({ ...d, total_devuelto: Number(d.total_devuelto), reintegro_pasarela: Number(d.reintegro_pasarela), creado_ms: Number(d.creado_ms) }));

// ---- Arrepentimiento (RN15) ----

const solicitarArrepentimiento = async (idGlobal, { email, motivo = null }) => {
  const [[p]] = await pool.query('SELECT * FROM onl_pedidos WHERE id_global = ? AND email = ?', [idGlobal, String(email ?? '').toLowerCase()]);
  if (!p) throw invalida('Pedido no encontrado.', 404);
  if (!p.pagado_ms || ['cancelado', 'devuelto', 'pendiente_pago'].includes(p.estado)) throw invalida(`Un pedido ${p.estado} no tiene compra para revocar.`, 409);
  const [[t]] = await pool.query('SELECT arrepentimiento_dias, arrepentimiento_reingreso FROM onl_tienda WHERE id = 1');
  const [[ent]] = await pool.query("SELECT MAX(ts_ms) AS m FROM onl_pedido_historial WHERE pedido_id = ? AND estado = 'entregado'", [p.id]);
  const base = Math.max(Number(p.created_ms), Number(ent.m ?? 0)); // desde la entrega o desde la compra, lo que ocurra último
  const codigo = `ARR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const fueraDePlazo = Date.now() > base + t.arrepentimiento_dias * 86400000;
  const [r] = await pool.query('INSERT INTO onl_arrepentimientos (pedido_id, codigo, estado, motivo, detalle, solicitado_ms) VALUES (?, ?, ?, ?, ?, ?)',
    [p.id, codigo, fueraDePlazo ? 'rechazado' : 'solicitado', motivo ? String(motivo).slice(0, 255) : null, fueraDePlazo ? `Pasaron más de ${t.arrepentimiento_dias} días` : null, Date.now()]);
  if (fueraDePlazo) throw invalida(`Pasaron más de ${t.arrepentimiento_dias} días corridos desde la entrega o la compra: no corresponde el arrepentimiento.`, 409, { codigo: 'FUERA_DE_PLAZO' });
  await Correo.encolar({ para: p.email, asunto: `Recibimos tu pedido de arrepentimiento (${codigo})`, cuerpo: `Hola ${p.nombre}, tu código de trámite es ${codigo}. Vamos a devolverte el total de la compra; los gastos de la devolución corren por nuestra cuenta.\n` }).catch(() => {});
  // Se devuelve la compra completa: si todavía no se entregó se cancela, y si ya se entregó se registra la devolución total.
  const res = ['despachado', 'entregado'].includes(p.estado)
    ? await devolver(p.id, { todo: true, motivo: `Arrepentimiento ${codigo}`, reingreso: t.arrepentimiento_reingreso })
    : await cancelar(p.id, { motivo: `Arrepentimiento ${codigo}` });
  await pool.query("UPDATE onl_arrepentimientos SET estado = 'resuelto', resuelto_ms = ? WHERE id = ?", [Date.now(), r.insertId]);
  return { codigo, estado: 'resuelto', resultado: res.estado ?? 'cancelado' };
};
const arrepentimientos = async () => (await pool.query('SELECT a.id, a.pedido_id, a.codigo, a.estado, a.detalle, a.solicitado_ms, p.nombre, p.email FROM onl_arrepentimientos a JOIN onl_pedidos p ON p.id = a.pedido_id ORDER BY a.id DESC LIMIT 200'))[0].map((x) => ({ ...x, solicitado_ms: Number(x.solicitado_ms) }));

module.exports = { cancelar, devolver, reintentarPendientes, listar, solicitarArrepentimiento, arrepentimientos };
