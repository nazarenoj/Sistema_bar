const pool = require('../config/db');
const puertos = require('../modulos/puertos');
const llamar = require('../modulos/llamar');
const Funciones = require('../funciones/servicio');
const { idGlobal } = require('../utils/idGlobal');
const { cuitValido } = require('../services/padronService');
const Carrito = require('./carritoService');
const Cupones = require('./cuponService');
const Envios = require('./envioService');
const Reserva = require('./reservaPedidoService');
const Tienda = require('./tiendaService');

// Checkout (Ventas Online RF09, RF24, RN05, RN06, RN07, RN19, RN48, RN49, EX09, EX14, EX27): arma el pedido desde el carrito, fija los precios, y en un orden siempre igual reserva primero
// (stock, crédito, vales) y recién después deja el pedido listo para cobrar. Una confirmación repetida con la misma clave de solicitud devuelve el mismo pedido (RN48).
const invalida = (m, status = 400, extra = {}) => Object.assign(new Tienda.TiendaInvalida(m), { status, ...extra });
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const MEDIOS = ['pasarela', 'transferencia', 'pago_al_retirar', 'efectivo_contra_entrega', 'cuenta_corriente', 'canje'];
const FUNCIONES_PEDIDO = ['ONL-CUPONES', 'ONL-PASARELA', 'ONL-ENVIOS-TRANSPORTISTA', 'ONL-RESERVAS', 'VEN-LISTAS', 'VEN-PROMOS', 'VEN-MODIF', 'CLI-FIDEL', 'STK-LOTES', 'VEN-SERIE'];

const historial = (conn, pedidoId, estado, detalle = null, userId = null) => conn.query('INSERT INTO onl_pedido_historial (pedido_id, estado, detalle, user_id, ts_ms) VALUES (?, ?, ?, ?, ?)', [pedidoId, estado, detalle, userId, Date.now()]);

// ---- Datos del cliente ----

const contacto = (c) => {
  const nombre = String(c?.nombre ?? '').trim(), email = String(c?.email ?? '').trim().toLowerCase();
  if (!nombre || nombre.length > 100) throw invalida('Falta el nombre.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) throw invalida('El correo no es válido.');
  return { nombre, email, telefono: c?.telefono ? String(c.telefono).slice(0, 40) : null };
};
// Consumidor final, o factura A con CUIT válido y condición frente al IVA (EX14: con un CUIT inválido no se puede pedir factura A y se sugiere consumidor final).
const facturacion = (f) => {
  if (!f || f.tipo === 'consumidor_final') return { tipo: 'consumidor_final' };
  if (f.tipo !== 'factura_a') throw invalida('La facturación es consumidor_final o factura_a.');
  const cuit = String(f.cuit ?? '').replace(/\D/g, '');
  if (!cuitValido(cuit)) throw invalida('El CUIT no es válido: no se puede pedir factura A. Podés pedir la factura como consumidor final.', 400, { codigo: 'CUIT_INVALIDO' });
  if (!String(f.condicion_iva ?? '').trim() || !String(f.razon_social ?? '').trim()) throw invalida('Para factura A indicá la razón social y la condición frente al IVA.');
  return { tipo: 'factura_a', cuit, razon_social: String(f.razon_social).trim().slice(0, 150), condicion_iva: String(f.condicion_iva).trim().slice(0, 40), domicilio: String(f.domicilio ?? '').slice(0, 200) };
};

// La unión de los alérgenos de las líneas, que se muestra antes de pagar (RF09, RF22).
const unionAlergenos = (lineas) => {
  const m = new Map();
  for (const l of lineas) for (const a of l.alergenos ?? []) m.set(a.codigo, a);
  return [...m.values()];
};

// ---- Resumen (sin reservar nada) ----

const armar = async (token, d, cuenta) => {
  const c = await Carrito.exigirCarrito(token);
  const r = await Carrito.calcular(c, cuenta);
  if (!r.lineas.length) throw invalida('El carrito está vacío.', 409, { codigo: 'CARRITO_VACIO' });
  const entrega = await Envios.cotizar({ entrega: d?.entrega ?? { tipo: 'retiro' }, subtotal: r.subtotal, lineas: r.lineas });
  const envio = r.envio_gratis.gratis ? 0 : entrega.costo;
  const total = r2(r.total + envio);
  const alerg = unionAlergenos(r.lineas);
  return { carrito: c, calculo: r, entrega, envio, total, alergenos: alerg, alergenos_pendientes: r.lineas.some((l) => l.alergenos_pendientes) };
};
const vistaResumen = (a) => ({
  lineas: a.calculo.lineas.map((l) => ({ linea: l.linea, producto_id: l.producto_id, titulo: l.titulo, cantidad: l.cantidad, precio_unitario: l.precio_unitario, importe: l.importe, opciones: l.opciones, alergenos: l.alergenos })),
  alergenos: a.alergenos, subtotal: a.calculo.subtotal, descuento: a.calculo.descuento, cupon: a.calculo.cupon, envio: a.envio, envio_gratis: a.calculo.envio_gratis.gratis, total: a.total, avisos: a.calculo.avisos,
  requiere_aceptar_alergenos: a.alergenos.length > 0,
});
const resumen = async (token, d, cuenta) => vistaResumen(await armar(token, d ?? {}, cuenta));

// ---- Confirmación ----

const vista = async (id) => {
  const [[p]] = await pool.query('SELECT * FROM onl_pedidos WHERE id = ?', [id]);
  if (!p) return null;
  const [lineas] = await pool.query('SELECT linea, producto_id, titulo, cantidad, precio_unitario, importe, opciones, alergenos, observaciones, lista FROM onl_pedido_lineas WHERE pedido_id = ? ORDER BY linea', [id]);
  return {
    id: p.id, id_global: p.id_global, estado: p.estado, nombre: p.nombre, email: p.email, telefono: p.telefono, facturacion: JSON.parse(p.facturacion), entrega: { tipo: p.entrega_tipo, ...(p.entrega_datos ? JSON.parse(p.entrega_datos) : {}) },
    medio_pago: p.medio_pago, subtotal: Number(p.subtotal), descuento: Number(p.descuento), envio: Number(p.envio), total: Number(p.total), canje: Number(p.canje_importe), a_pagar: Number(p.a_pagar), cupon: p.cupon_codigo,
    reserva: { estado: p.reserva_estado, vence_ms: p.reserva_vence_ms ? Number(p.reserva_vence_ms) : null, segundos_restantes: p.reserva_vence_ms ? Math.max(0, Math.floor((Number(p.reserva_vence_ms) - Date.now()) / 1000)) : null, intento: p.reserva_intento },
    programado_ms: p.programado_ms ? Number(p.programado_ms) : null, tiempo_estimado_min: p.tiempo_estimado_min, numero_retiro: p.numero_retiro,
    created_ms: Number(p.created_ms), pagado_ms: p.pagado_ms ? Number(p.pagado_ms) : null, motivo_cancelacion: p.motivo_cancelacion,
    lineas: lineas.map((l) => ({ ...l, cantidad: Number(l.cantidad), precio_unitario: Number(l.precio_unitario), importe: Number(l.importe), opciones: l.opciones ? JSON.parse(l.opciones) : [], alergenos: l.alergenos ? JSON.parse(l.alergenos) : [] })),
  };
};

const confirmar = async (token, d, cuenta, { idSolicitud } = {}) => {
  const solicitud = idSolicitud ?? d.id_solicitud;
  if (!solicitud || !/^[A-Za-z0-9._:-]{8,64}$/.test(String(solicitud))) throw invalida('Falta la clave de solicitud (8 a 64 caracteres).', 400, { codigo: 'FALTA_SOLICITUD' });
  const [[previo]] = await pool.query('SELECT id FROM onl_pedidos WHERE id_solicitud = ?', [solicitud]);
  if (previo) return { ...(await vista(previo.id)), repetido: true };

  const cont = contacto(d.contacto ?? (cuenta && { nombre: cuenta.nombre, email: cuenta.email, telefono: cuenta.telefono }));
  const fact = facturacion(d.facturacion);
  if (d.acepta_terminos !== true) throw invalida('Aceptá los términos y condiciones para confirmar.', 400, { codigo: 'TERMINOS_NO_ACEPTADOS' });
  const medio = d.medio_pago;
  if (!MEDIOS.includes(medio)) throw invalida(`El medio de pago es uno de: ${MEDIOS.join(', ')}.`);
  if (medio === 'pasarela' && !(await Funciones.estaActiva('ONL-PASARELA'))) throw invalida('El pago online no está habilitado.', 409, { codigo: 'FUNCION_INACTIVA' });
  if (medio === 'cuenta_corriente' && !(cuenta && cuenta.cliente_id)) throw invalida('La cuenta corriente es solo para clientes registrados y vinculados.', 409, { codigo: 'CUENTA_CORRIENTE_NO_DISPONIBLE' });

  const a = await armar(token, d, cuenta);
  if (a.calculo.lineas.some((l) => l.sin_stock || l.faltante)) throw invalida('Hay artículos agotados o con menos cantidad disponible: ajustá el carrito.', 409, { codigo: 'SIN_DISPONIBLE', detalle: a.calculo.lineas.filter((l) => l.sin_stock || l.faltante).map((l) => ({ linea: l.linea, titulo: l.titulo, disponible: l.disponible })) });
  // EX09: si cambió el total desde que se mostró, se informa y se pide confirmar de nuevo.
  if (d.total_confirmado === undefined || Math.abs(Number(d.total_confirmado) - a.total) > 0.004)
    throw invalida(`El total es ${a.total}: confirmá de nuevo con el importe actualizado.`, 409, { codigo: 'TOTAL_CAMBIO', resumen: vistaResumen(a) });
  if (a.alergenos.length && d.acepta_alergenos !== true) throw invalida('Revisá los alérgenos del pedido y aceptalos para continuar.', 400, { codigo: 'ALERGENOS_NO_ACEPTADOS', alergenos: a.alergenos });
  if (medio === 'canje' && !(d.canje && Number(d.canje.importe) >= a.total)) throw invalida('El canje tiene que cubrir el total del pedido; si no, elegí otro medio para el resto.', 400, { codigo: 'CANJE_PARCIAL' });
  if (medio === 'efectivo_contra_entrega' && a.entrega.tipo !== 'delivery') throw invalida('El efectivo contra entrega es solo para delivery.', 400);

  // Canje de vale, gift card o puntos: es una forma de pago y puede ser parcial (RF24, llamada n.º 9).
  let canje = null, canjeImporte = 0;
  const cfgNum = Number;
  void cfgNum;
  const pedirReserva = async () => Reserva.reservar({ lineas: a.calculo.lineas, solicitud: `${solicitud}:reserva:1` });

  // 1) Reserva de stock, antes del cobro (RN07). Si no alcanza no se abre el cobro y no queda ninguna reserva (EX27).
  const rs = await pedirReserva();
  if (rs.estado === 'rechazada') throw invalida('No hay disponible suficiente para algún artículo: ajustá el pedido.', 409, { codigo: 'SIN_DISPONIBLE', detalle: rs.sin_disponible, lote_no_disponible: rs.lote_no_disponible });
  const liberarTodo = async () => { await Reserva.liberar(rs.id); if (canje?.id_retencion) await puertos.obtener('credito').then((p) => p.liberarRetencion?.(canje.id_retencion)).catch(() => {}); };

  let creditoId = null;
  try {
    if (d.canje) {
      if (!(await Funciones.estaActiva('CLI-FIDEL'))) throw invalida('El canje con vales, gift cards o puntos no está habilitado.', 409, { codigo: 'CANJE_NO_DISPONIBLE' });
      const puerto = await puertos.obtener('credito');
      if (!puerto.fidelizacion) throw invalida('El canje necesita el módulo Clientes con la fidelización activa.', 409, { codigo: 'CANJE_NO_DISPONIBLE' });
      const imp = r2(Math.min(Number(d.canje.importe), a.total));
      if (!(imp > 0) || (!d.canje.codigo && !d.canje.puntos)) throw invalida('Indicá el código del vale o gift card (o los puntos) y el importe a canjear.');
      if (d.canje.puntos && !cuenta?.cliente_id) throw invalida('Para canjear puntos iniciá sesión con tu cuenta vinculada.', 409, { codigo: 'CANJE_NO_DISPONIBLE' });
      let rr;
      try { rr = await llamar(9, 'ventas_online', async () => puerto.retenerSaldo({ codigo: d.canje.codigo ?? undefined, cliente_id: d.canje.puntos ? cuenta.cliente_id : undefined, importe: imp, idSolicitud: `${solicitud}:canje` })); } catch (err) {
        if (err.codigo === 'LLAMADA_CERRADA') throw invalida('Clientes no respondió: el canje no se ofrece ahora. Pagá con otro medio.', 409, { codigo: 'CANJE_NO_DISPONIBLE' });
        throw err;
      }
      const v = rr.valor;
      if (!v || rr.fallo) throw invalida('El canje no está disponible. Pagá con otro medio.', 409, { codigo: 'CANJE_NO_DISPONIBLE' });
      if (v.estado === 'saldo_insuficiente') throw invalida(`El saldo disponible es ${v.saldo_actual}: usá ese importe y pagá el resto con otro medio.`, 409, { codigo: 'SALDO_INSUFICIENTE', saldo: v.saldo_actual });
      if (v.estado === 'rechazada') throw invalida(v.motivo, 409, { codigo: 'INSTRUMENTO_RECHAZADO' });
      canje = { id_retencion: v.id_retencion, importe: imp, codigo: d.canje.codigo ?? null, puntos: !!d.canje.puntos };
      canjeImporte = imp;
    }
    const aPagar = r2(a.total - canjeImporte);
    // 2) Crédito de la cuenta corriente, con el veredicto de Clientes (RN19, llamada n.º 8): Ventas Online no evalúa límites ni mora.
    if (medio === 'cuenta_corriente') {
      if (!(await Funciones.estaActiva('VEN-CC'))) throw invalida('La cuenta corriente no está habilitada.', 409, { codigo: 'CUENTA_CORRIENTE_NO_DISPONIBLE' });
      const puerto = await puertos.obtener('credito');
      if (!puerto.disponible) throw invalida('La cuenta corriente necesita el módulo Clientes.', 409, { codigo: 'CUENTA_CORRIENTE_NO_DISPONIBLE' });
      let rr;
      try { rr = await llamar(8, 'ventas_online', async () => puerto.reservar({ cliente_id: cuenta.cliente_id, moneda: 'ARS', importe: aPagar, idSolicitud: `${solicitud}:credito`, origen: `online:${solicitud}` })); } catch (err) {
        if (err.codigo === 'LLAMADA_CERRADA') throw invalida('Clientes no respondió: pagá con otro medio.', 409, { codigo: 'CREDITO_NO_RESPONDE' });
        throw err;
      }
      const v = rr.valor;
      if (v.veredicto === 'bloqueada') throw invalida((v.motivos ?? ['Cuenta bloqueada.']).join(' '), 409, { codigo: 'CREDITO_BLOQUEADO' });
      if (v.veredicto === 'requiere_autorizacion') throw invalida((v.motivos ?? []).join(' ') || 'La cuenta corriente necesita autorización del comercio.', 409, { codigo: 'CREDITO_REQUIERE_AUTORIZACION' });
      creditoId = v.id_reserva ?? null;
    }

    // 3) El pedido, con sus precios fijos (RN05) y las reglas con que se abre (RN49).
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const cfg = await Funciones.estado(conn);
      const activas = cfg.funciones.filter((f) => f.activa && FUNCIONES_PEDIDO.includes(f.id)).map((f) => f.id);
      const idG = await idGlobal();
      const quien = cuenta ? `c:${cuenta.id}` : `e:${cont.email}`;
      const ahora = Date.now();
      // El cupón se vuelve a evaluar con el tope por cliente real (el invitado se identifica por su correo).
      let cuponId = null, descuento = a.calculo.descuento;
      if (a.calculo.cupon?.valido !== false && a.calculo.cupon) {
        const e = await Cupones.evaluar(a.calculo.cupon.codigo, a.calculo.lineas.map((l) => ({ linea: l.linea, producto_id: l.producto_id, categoria_id: l.categoria_id, importe: l.importe })), { quien });
        if (!e.valido) throw invalida(e.motivo, 409, { codigo: 'CUPON_INVALIDO' });
        cuponId = e.cupon.id; descuento = e.descuento;
      }
      const [r] = await conn.query(
        `INSERT INTO onl_pedidos (id_global, id_solicitud, estado, cuenta_id, nombre, email, telefono, facturacion, entrega_tipo, entrega_datos, medio_pago, subtotal, descuento, envio, total, canje_importe, a_pagar, cupon_id, cupon_codigo,
           reserva_id, reserva_estado, reserva_vence_ms, credito_reserva_id, retencion_id, canje_datos, config_version, config_instantanea, terminos_ms, observaciones, created_ms, updated_ms)
         VALUES (?, ?, 'pendiente_pago', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [idG, solicitud, cuenta?.id ?? null, cont.nombre, cont.email, cont.telefono, JSON.stringify(fact), a.entrega.tipo, JSON.stringify(a.entrega.datos ?? {}), medio, a.calculo.subtotal, descuento, a.envio, a.total, canjeImporte, aPagar, cuponId, a.calculo.cupon?.codigo ?? null,
          rs.id ?? null, rs.estado, rs.vence_ms ?? null, creditoId, canje?.id_retencion ?? null, canje ? JSON.stringify(canje) : null, cfg.version, JSON.stringify(activas), ahora, d.observaciones ? String(d.observaciones).slice(0, 255) : null, ahora, ahora]);
      const inicioDia = new Date(); inicioDia.setHours(0, 0, 0, 0);
      const [[{ hoyN }]] = await conn.query('SELECT COUNT(*) AS hoyN FROM onl_pedidos WHERE created_ms >= ?', [inicioDia.getTime()]);
      await conn.query('UPDATE onl_pedidos SET programado_ms = ?, tiempo_estimado_min = ?, zona_id = ?, numero_retiro = ? WHERE id = ?', [a.entrega.programado_ms ?? null, a.entrega.tiempo_estimado_min ?? 0, a.entrega.zona_id ?? null, a.entrega.tipo === 'retiro' ? `R${String(hoyN).padStart(3, '0')}` : null, r.insertId]);
      for (const l of a.calculo.lineas) await conn.query('INSERT INTO onl_pedido_lineas (pedido_id, linea, producto_id, titulo, cantidad, precio_unitario, importe, opciones, alergenos, observaciones, lista) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [r.insertId, l.linea, l.producto_id, l.titulo, l.cantidad, l.precio_unitario, l.importe, JSON.stringify(l.opciones), JSON.stringify(l.alergenos), l.observaciones, null]);
      if (cuponId) await Cupones.consumir(conn, cuponId, { quien, pedidoId: idG, importe: descuento });
      await historial(conn, r.insertId, 'pendiente_pago', rs.estado === 'pendiente' ? 'Stock no respondió: reserva pendiente de confirmación' : null);
      await conn.query('DELETE FROM onl_carritos WHERE token = ?', [token]);
      await conn.commit();
      return { ...(await vista(r.insertId)), repetido: false, ...(rs.estado === 'pendiente' && { aviso: 'La disponibilidad se confirma en cuanto Stock responda.' }) };
    } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  } catch (err) {
    await liberarTodo();
    if (creditoId) await puertos.obtener('credito').then((p) => p.liberarReserva(creditoId)).catch(() => {});
    if (err.code === 'ER_DUP_ENTRY') { const [[p]] = await pool.query('SELECT id FROM onl_pedidos WHERE id_solicitud = ?', [solicitud]); if (p) return { ...(await vista(p.id)), repetido: true }; }
    throw err;
  }
};

// ---- Después de confirmar ----

const obtener = async (id, { cuentaId = null, email = null, interno = false } = {}) => {
  const p = await vista(id);
  if (!p) return null;
  const [[o]] = await pool.query('SELECT cuenta_id, email FROM onl_pedidos WHERE id = ?', [id]);
  if (!interno && !((cuentaId && o.cuenta_id === cuentaId) || (email && o.email === String(email).toLowerCase()))) return null; // la parte pública solo ve sus propios pedidos
  return p;
};

// El cliente sigue en el checkout: se renueva la reserva (hasta 3 veces) y se muestra el tiempo restante.
const renovarReserva = async (id) => {
  const [[p]] = await pool.query('SELECT * FROM onl_pedidos WHERE id = ?', [id]);
  if (!p) throw invalida('Pedido no encontrado.', 404);
  const r = await Reserva.renovar(p);
  return { reserva: (await vista(id)).reserva, renovacion: r };
};

// Abandono o cancelación antes de pagar: la reserva se libera de inmediato y el cupón y el canje vuelven (EX28).
const abandonar = async (id, { motivo = 'Abandonado por el cliente' } = {}) => {
  const conn = await pool.getConnection();
  let p;
  try {
    await conn.beginTransaction();
    [[p]] = await conn.query('SELECT * FROM onl_pedidos WHERE id = ? FOR UPDATE', [id]);
    if (!p) throw invalida('Pedido no encontrado.', 404);
    if (p.estado !== 'pendiente_pago') throw invalida(`Un pedido ${p.estado} no se abandona.`, 409);
    await conn.query("UPDATE onl_pedidos SET estado = 'cancelado', reserva_estado = IF(reserva_estado = 'confirmada', 'liberada', reserva_estado), motivo_cancelacion = ?, updated_ms = ? WHERE id = ?", [motivo, Date.now(), id]);
    if (p.cupon_id) await Cupones.reponer(conn, p.cupon_id, p.id_global);
    await historial(conn, id, 'cancelado', motivo);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  await Reserva.liberar(p.reserva_id);
  const credito = await puertos.obtener('credito');
  if (p.credito_reserva_id) await credito.liberarReserva?.(p.credito_reserva_id)?.catch?.(() => {});
  if (p.retencion_id) await credito.liberarRetencion?.(p.retencion_id)?.catch?.(() => {});
  return vista(id);
};

// Los impagos se cancelan pasadas N horas (RN06) y liberan todo lo que reservaron.
const cancelarImpagos = async () => {
  const [[t]] = await pool.query('SELECT impagos_horas FROM onl_tienda WHERE id = 1');
  const [ids] = await pool.query("SELECT id FROM onl_pedidos WHERE estado = 'pendiente_pago' AND created_ms < ?", [Date.now() - t.impagos_horas * 3600000]);
  let n = 0;
  for (const { id } of ids) { await abandonar(id, { motivo: `Sin pago pasadas ${t.impagos_horas} horas` }).then(() => n++).catch(() => {}); }
  return n;
};

module.exports = { resumen, confirmar, obtener, renovarReserva, abandonar, cancelarImpagos, vista, historial, MEDIOS, FUNCIONES_PEDIDO };
