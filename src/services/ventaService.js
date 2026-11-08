const SerieVenta = require('./serieVentaService');
const { lineasContables } = require('./lineasContables');
const Monedas = require('../servicios/monedaService');
const pool = require('../config/db');
const Mensajeria = require('../mensajeria/servicio');
const llamar = require('../modulos/llamar');
const puertos = require('../modulos/puertos');
const Funciones = require('../funciones/servicio');
const { idGlobal } = require('../utils/idGlobal');
const Caea = require('./caeaService');
const Factura = require('../models/facturaModel');
const afipService = require('./afipService');
const afipConfig = require('../config/afipConfig');
const TIPOS_NO_FISCAL = ['ticket', 'presupuesto', 'remito'];

// Efectos de una venta cerrada en otros módulos (Ventas RN58). Cada uno es un mensaje de la bandeja de
// salida; si el módulo receptor no está instalado, no se genera (Mensajeria.publicar). El descuento de
// stock también viaja como mensaje (ver publicarDescuento).
const EFECTOS = [
  { destino: 'financiero', tipo: 'cobro_registrado' },
  { destino: 'contable', tipo: 'venta_confirmada' },
];

class PagoInvalido extends Error {}

const centavos = (n) => Math.round(Number(n) * 100);

// Valida los pagos de una cuenta contra las formas de pago configuradas (RF09, RN16): forma activa,
// referencia si la forma la pide, vuelto solo donde se admite, y la suma de lo aplicado igual al total.
// `pagos`: [{ forma, importe, referencia?, recibido? }]. Devuelve los pagos normalizados con su vuelto.
const redondear2 = (x) => Math.round(Number(x) * 100) / 100;

// Cotización con la que se cobra en una divisa (RN44, EX32): la que el cajero fijó al iniciar el cobro (`cotizacion_id`) o la vigente, siempre
// dentro de la antigüedad permitida; si no hay una, la forma no se puede usar y se ofrece cobrar en pesos. Ventas usa la compradora: el comercio
// compra la divisa que recibe.
const cotizacionDeCobro = async (moneda, cotizacionId) => {
  const c = cotizacionId ? await Monedas.porId(cotizacionId) : await Monedas.vigente(moneda);
  if (cotizacionId && (!c || c.moneda !== moneda)) throw new PagoInvalido(`La cotización indicada no es de ${moneda}.`);
  if (!c || c.vencida) throw Object.assign(new PagoInvalido(`No hay una cotización de ${moneda} dentro de la antigüedad permitida: cobrá en pesos.`), { codigo: 'SIN_COTIZACION' });
  return c;
};

// Valida los pagos de una cuenta contra las formas de pago configuradas (RF09, RN16): forma activa,
// importe positivo, referencia si la forma la exige, vuelto solo si la admite, y suma igual al total.
// `pagos`: [{ forma, importe, referencia?, recibido? }]. Una forma en divisa (VEN-DIVISA) se paga con `importe_divisa` (o con `importe` en pesos) y
// `recibido_divisa`; el total, el comprobante y el vuelto quedan en pesos y el pago guarda la moneda y la cotización fijadas (RN44).
const validarPagos = async (conn, pagos, total) => {
  if (!Array.isArray(pagos) || !pagos.length) throw new PagoInvalido('Indicá al menos una forma de pago.');
  const [formas] = await conn.query('SELECT * FROM formas_pago WHERE activa = 1');
  const porCodigo = new Map(formas.map((f) => [f.codigo, f]));
  const normalizados = [];
  for (const p of pagos) {
    const f = porCodigo.get(p.forma);
    if (!f) throw new PagoInvalido(`La forma de pago "${p.forma}" no existe o está desactivada.`);
    if (p.forma === 'vale' && !(await Funciones.estaActiva('CLI-FIDEL', conn))) throw new PagoInvalido('La forma de pago "Vale / Gift card / Puntos" necesita la función CLI-FIDEL.');
    if (p.forma === 'cuenta_corriente' && !(await Funciones.estaActiva('VEN-CC', conn))) throw new PagoInvalido('La forma de pago "Cuenta Corriente" necesita la función VEN-CC.');
    let importe = Number(p.importe);
    let divisa = {};
    let vuelto = 0;
    if (f.moneda && f.moneda !== 'ARS') {
      if (!(await Funciones.estaActiva('VEN-DIVISA', conn))) throw new PagoInvalido(`"${f.nombre}" es en moneda extranjera y VEN-DIVISA está inactiva.`);
      const dest = await (await puertos.obtener('cobros')).destinoDe(f.codigo);
      if (!dest.asignado) throw Object.assign(new PagoInvalido(`"${f.nombre}" no tiene una caja o cuenta de destino en ${f.moneda}: cobrá con otra forma de pago.`), { codigo: 'SIN_DESTINO_DIVISA' });
      const cot = await cotizacionDeCobro(f.moneda, p.cotizacion_id);
      if (p.importe_divisa !== undefined && p.importe_divisa !== null) {
        if (!(Number(p.importe_divisa) > 0)) throw new PagoInvalido(`El importe en ${f.moneda} de "${f.nombre}" debe ser mayor a cero.`);
        importe = redondear2(Number(p.importe_divisa) * cot.comprador);
      }
      if (!(importe > 0)) throw new PagoInvalido(`El importe de "${f.nombre}" debe ser mayor a cero.`);
      const importeDivisa = p.importe_divisa !== undefined && p.importe_divisa !== null ? Number(p.importe_divisa) : redondear2(importe / cot.comprador);
      divisa = { moneda: f.moneda, importe_divisa: importeDivisa, cotizacion: cot.comprador, cotizacion_id: cot.id };
      if (p.recibido_divisa !== undefined && p.recibido_divisa !== null) {
        if (!f.admite_vuelto) throw new PagoInvalido(`"${f.nombre}" no admite vuelto.`);
        if (Number(p.recibido_divisa) < importeDivisa) throw new PagoInvalido(`Lo recibido en ${f.moneda} es menor que el importe.`);
        vuelto = redondear2((Number(p.recibido_divisa) - importeDivisa) * cot.comprador); // el vuelto siempre se entrega en pesos
      }
    }
    if (!(importe > 0)) throw new PagoInvalido(`El importe de "${f.nombre}" debe ser mayor a cero.`);
    const referencia = typeof p.referencia === 'string' ? p.referencia.trim() || null : null;
    if (f.requiere_referencia && !referencia) throw new PagoInvalido(`"${f.nombre}" requiere una referencia.`);
    if (!divisa.moneda && p.recibido !== undefined && p.recibido !== null) {
      if (!f.admite_vuelto) throw new PagoInvalido(`"${f.nombre}" no admite vuelto.`);
      if (centavos(p.recibido) < centavos(importe)) throw new PagoInvalido(`Lo recibido en "${f.nombre}" es menor que el importe.`);
      vuelto = (centavos(p.recibido) - centavos(importe)) / 100;
    }
    normalizados.push({ forma: f.codigo, importe, referencia, recibido: p.recibido ?? null, vuelto, ...divisa, ...(f.codigo === 'vale' && { instrumento: p.instrumento ?? null, puntos: !!p.puntos }) });
  }
  const suma = normalizados.reduce((a, p) => a + centavos(p.importe), 0);
  if (suma !== centavos(total)) throw new PagoInvalido(`La suma de los pagos (${suma / 100}) no coincide con el total de la cuenta (${Number(total)}).`);
  return normalizados;
};

// Cobro en efectivo con turno de caja (Ventas RN43, Financiero RN04, EX01): se consulta a Financiero por la llamada n.º 5. Si la instancia lo exige y la terminal no
// tiene turno abierto, no se cobra. Si Financiero no responde en 3 s, el cobro sigue solo con la autorización de un supervisor y la venta queda marcada
// «turno no verificado». Sin Financiero instalado no hay turno que verificar.
const verificarTurno = async (pagos, { terminalId, autorizar }) => {
  if (!pagos.some((p) => p.forma === 'efectivo')) return { turnoNoVerificado: false };
  const r = await llamar(5, 'ventas', async () => (await puertos.obtener('cobros')).turnoAbierto({ terminalId }));
  if (r.fallo && r.degradado && /no instalado/.test(r.motivo)) return { turnoNoVerificado: false }; // sin Financiero no hay turno que verificar
  if (r.fallo) {
    const aut = await autorizar();
    if (!aut?.ok) throw Object.assign(new Error('Financiero no responde: el cobro en efectivo necesita la autorización de un supervisor.'), { codigo: 'TURNO_NO_VERIFICADO', status: aut?.status ?? 409 });
    return { turnoNoVerificado: true };
  }
  if (r.valor.exigido && !r.valor.abierto)
    throw Object.assign(new Error(`Abrí el turno de la caja${r.valor.caja ? ` "${r.valor.caja}"` : ''} antes de cobrar en efectivo.`), { codigo: 'SIN_TURNO_ABIERTO', status: 409 });
  return { turnoNoVerificado: false };
};

// Lo que se guarda en pedidos y facturas: el código de la forma, o 'mixto' si hay varias.
const metodoResumen = (pagos) => (pagos.length > 1 ? 'mixto' : pagos[0].forma);

// Mensaje de descuento de stock (Stock RF07): trae solo la línea vendida, nunca los componentes; Stock la expande según el
// modo de descuento del artículo. `items`: filas con producto_id y cantidad, en el orden de la venta (la posición es la línea).
const publicarDescuento = async (conn, { docTipo, docIdGlobal, items, userId, solicitud, noFiscal = false, idCompromiso = null, modalidad = null, seriesRegistradas = false, clienteId = null }) => {
  if (!seriesRegistradas) items = await SerieVenta.registrarVenta(conn, items, docIdGlobal); // cada serie vendida con su garantía (RN79)
  return Mensajeria.publicar(conn, {
  origen: 'ventas', destino: 'stock', tipo: 'descuento_stock', docTipo, docIdGlobal, userId, solicitud,
  contenido: { doc_tipo: docTipo, cliente_id: clienteId, items: items.map((i, linea) => ({ linea, producto_id: i.producto_id, cantidad: i.cantidad, lote_indicado: i.lote_indicado ?? null, ...(i.opciones?.length && { opciones: i.opciones }), ...(i.serie && { serie: i.serie, fecha_fin_garantia: i.fecha_fin_garantia ?? null }) })), modalidad, no_fiscal: noFiscal, user_id: userId ?? null, id_compromiso: idCompromiso },
  });
};

// Compromiso de venta antes de confirmar (Ventas RN63): pide a Stock, con timeout de 3 s, comprometer la línea vendida. Solo
// bloquean los ítems que no admiten stock negativo. "Sin disponible" no se cierra; si Stock no responde, la política es abrir con
// la autorización de un supervisor (`autorizar`). Devuelve el ID_Compromiso (o null si no hizo falta).
const comprometerStock = async (items, { idSolicitud, userId, autorizar }) => {
  const r = await llamar(3, 'ventas', async () => (await puertos.obtener('stock')).comprometer(items, { idSolicitud: `${idSolicitud}:compromiso`, userId }));
  if (r.fallo) {
    if (r.degradado) return null; // Stock no está instalado: se vende sin control de existencias (RN01)
    const a = autorizar ? await autorizar() : null;
    if (!a?.ok) throw Object.assign(new Error('Stock no respondió: el cierre necesita la autorización de un supervisor.'), { status: 409, codigo: 'STOCK_NO_RESPONDE' });
    return null;
  }
  if (r.valor.serie_no_disponible) throw Object.assign(new Error(`Serie no disponible: ${r.valor.serie_no_disponible.map((s) => `${s.serie} (${s.motivo})`).join('; ')}.`), { status: 409, codigo: 'SERIE_NO_DISPONIBLE', detalle: r.valor.serie_no_disponible });
  if (r.valor.lote_no_disponible) throw Object.assign(new Error(`Lote no disponible: ${r.valor.lote_no_disponible.map((l) => `${l.lote} (${l.motivo})`).join('; ')}. Elegí otro lote o dejá que se asigne por FEFO.`), { status: 409, codigo: 'LOTE_NO_DISPONIBLE', detalle: r.valor.lote_no_disponible });
  if (!r.valor.ok) throw Object.assign(new Error(`Sin disponible: ${r.valor.sin_disponible.map((s) => `${s.nombre} (${s.deposito}): quedan ${s.disponible}, hacen falta ${s.requerido}`).join('; ')}.`), { status: 409, codigo: 'SIN_DISPONIBLE', detalle: r.valor.sin_disponible });
  return r.valor.id_compromiso;
};

// Venta a cuenta corriente (Ventas RF16, RN27; Clientes RF12, RF26, RF27): antes de cerrar pide a Clientes el veredicto y la reserva de crédito por el
// importe a cuenta y los cumple sin reglas propias. «Requiere autorización» solo se resuelve con un supervisor; «Bloqueada» no admite autorización. Si
// Clientes no responde en 3 s, la venta no se cierra salvo autorización de un supervisor con motivo (contingencia).
const importeACuenta = (pagos) => redondear2((pagos ?? []).filter((p) => p.forma === 'cuenta_corriente').reduce((a, p) => a + Number(p.importe), 0));
const reservarCredito = async (pagos, { clienteId, idSolicitud, userId, autorizar, moneda = 'ARS', motivoContingencia }) => {
  const importePesos = importeACuenta(pagos);
  if (!importePesos) return null;
  // Cuenta en moneda extranjera: el importe ya convertido a la moneda de la cuenta con la cotización vendedora vigente (Ventas RN87, Clientes RF11).
  let importe = importePesos, cotizacion = null;
  if (moneda !== 'ARS') {
    const c = await Monedas.vigente(moneda).catch(() => null);
    if (!c) throw falla(409, 'COTIZACION_NO_DISPONIBLE', `No hay una cotización cargada de ${moneda}: vendé a la cuenta en pesos.`);
    cotizacion = c.vendedor; importe = redondear2(importePesos / cotizacion);
  }
  if (!(await Funciones.estaActiva('VEN-CC'))) throw new PagoInvalido('La forma de pago "Cuenta Corriente" necesita la función VEN-CC.');
  const falla = (status, codigo, error, detalle) => Object.assign(new Error(error), { status, codigo, detalle });
  if (!clienteId) throw falla(400, 'CLIENTE_NO_IDENTIFICADO', 'Para vender a cuenta corriente identificá al cliente.');
  const puerto = await puertos.obtener('credito');
  if (!puerto.disponible) throw falla(409, 'CUENTA_CORRIENTE_NO_DISPONIBLE', 'La cuenta corriente no está disponible: falta el módulo Clientes.');
  const pedir = (extra = {}) => llamar(1, 'ventas', async () => puerto.reservar({ cliente_id: clienteId, moneda, importe, idSolicitud: `${idSolicitud}:credito${extra.autorizado ? ':aut' : ''}`, origen: `venta:${idSolicitud}`, ...extra }));
  let r;
  try { r = await pedir(); } catch (err) {
    if (err.codigo !== 'LLAMADA_CERRADA') throw err;
    // Clientes no responde (EX20): contingencia solo con la autorización de un supervisor y un motivo; no se reserva.
    const a = autorizar ? await autorizar() : null;
    if (!a?.ok || !String(motivoContingencia ?? '').trim()) throw falla(409, 'CREDITO_NO_RESPONDE', 'Clientes no respondió: la venta a cuenta necesita la autorización de un supervisor y el motivo de la contingencia.');
    return { clienteId, importe, importePesos, cotizacion, moneda, reservaId: null, contingencia: true, supervisorId: a.supervisor.id, motivo: motivoContingencia.trim() };
  }
  let v = r.valor;
  if (v.veredicto === 'bloqueada') throw falla(409, 'CREDITO_BLOQUEADO', v.motivos.join(' '), v);
  if (v.veredicto === 'requiere_autorizacion') {
    const a = autorizar ? await autorizar() : null;
    if (!a?.ok) throw falla(403, 'CREDITO_REQUIERE_AUTORIZACION', v.motivos.join(' '), v);
    v = (await pedir({ autorizado: true, supervisorId: a.supervisor.id })).valor;
    if (!v.id_reserva) throw falla(409, 'CREDITO_BLOQUEADO', (v.motivos ?? []).join(' '), v);
  }
  return { clienteId, importe, importePesos, cotizacion, moneda, reservaId: v.id_reserva, contingencia: false, aviso: v.aviso ?? null };
};
const falla = (status, codigo, error, detalle) => Object.assign(new Error(error), { status, codigo, detalle });

// Canje con vale, gift card, saldo a favor o puntos (Clientes RF31, Ventas RN25): antes de cerrar retiene el saldo por el importe (llamada n.º 2, política «cerrar» y sin
// contingencia: si Clientes no responde la forma de pago no se ofrece, para no permitir un doble gasto). Con saldo insuficiente informa el saldo actual para cobrar el resto con otra forma.
const retenerCanjes = async (pagos, { clienteId, idSolicitud }) => {
  const canjes = (pagos ?? []).filter((p) => p.forma === 'vale');
  if (!canjes.length) return [];
  const puerto = await puertos.obtener('credito');
  if (!puerto.fidelizacion) throw falla(409, 'CANJE_NO_DISPONIBLE', 'El canje con vales, gift cards o puntos necesita el módulo Clientes con la fidelización activa.');
  const hechas = [];
  try {
    for (const [i, p] of canjes.entries()) {
      if (!p.instrumento && !p.puntos) throw new PagoInvalido('Indicá el código del instrumento o los puntos a canjear.');
      let r;
      try { r = await llamar(2, 'ventas', async () => puerto.retenerSaldo({ codigo: p.instrumento ?? undefined, cliente_id: p.puntos ? clienteId : undefined, importe: p.importe, idSolicitud: `${idSolicitud}:canje${i}` })); } catch (err) {
        if (err.codigo === 'LLAMADA_CERRADA') throw falla(409, 'CANJE_NO_DISPONIBLE', 'Clientes no respondió: la forma de pago de canje no se ofrece en este momento. Cobrá con otra forma.');
        throw err;
      }
      const v = r.valor;
      if (r.fallo || !v) throw falla(409, 'CANJE_NO_DISPONIBLE', 'La forma de pago de canje no está disponible. Cobrá con otra forma.');
      if (v.estado === 'saldo_insuficiente') throw falla(409, 'SALDO_INSUFICIENTE', `El saldo disponible es ${v.saldo_actual}: usá ese importe y cobrá el resto con otra forma de pago.`, v); // EX13, EX16
      if (v.estado === 'rechazada') throw falla(409, 'INSTRUMENTO_RECHAZADO', v.motivo, v); // EX14
      p.retencion_id = v.id_retencion;
      hechas.push(v.id_retencion);
    }
  } catch (err) { for (const id of hechas) await puerto.liberarRetencion(id).catch(() => {}); throw err; }
  return hechas;
};
const liberarCanjes = async (ids) => { if (ids?.length) { const puerto = await puertos.obtener('credito'); for (const id of ids) await puerto.liberarRetencion?.(id)?.catch?.(() => {}); } };

// Premio de sellos alcanzado: se aplica en el cobro como regla aprobada del programa (sin el permiso de descuentos), sobre las líneas de la cuenta (Clientes RF24).
const aplicarPremio = async (conn, pedidoIds, { clienteId, premio }) => {
  if (!premio) return null;
  const puerto = await puertos.obtener('credito');
  if (!clienteId || !puerto.fidelizacion) throw falla(409, 'PREMIO_NO_DISPONIBLE', 'El premio de sellos necesita un socio identificado y la fidelización activa.');
  let p;
  try { p = (await llamar(2, 'ventas', async () => puerto.premio(clienteId, premio.regla_id))).valor; } catch (err) { throw falla(409, 'PREMIO_NO_DISPONIBLE', err.causa?.message ?? err.message); }
  if (!p) throw falla(409, 'PREMIO_NO_DISPONIBLE', 'Clientes no respondió: no se puede aplicar el premio ahora.');
  const [lineas] = await conn.query('SELECT id, producto_id, cantidad, precio_unitario, importe_descuento FROM pedido_productos WHERE pedido_id IN (?) ORDER BY id', [pedidoIds]);
  const libre = (l) => redondear2(Number(l.cantidad) * Number(l.precio_unitario) - Number(l.importe_descuento));
  let linea, monto;
  if (p.tipo === 'producto_gratis') {
    linea = lineas.find((l) => l.producto_id === p.producto_id && libre(l) >= Number(l.precio_unitario));
    if (!linea) throw falla(409, 'PREMIO_NO_DISPONIBLE', 'El premio es un producto gratis y no está en la cuenta.');
    monto = Number(linea.precio_unitario);
  } else {
    linea = [...lineas].sort((a, b) => libre(b) - libre(a))[0];
    monto = Math.min(Number(p.importe), linea ? libre(linea) : 0);
    if (!linea || monto <= 0) throw falla(409, 'PREMIO_NO_DISPONIBLE', 'No hay importe sobre el cual aplicar el descuento del premio.');
  }
  await conn.query('UPDATE pedido_productos SET importe_descuento = importe_descuento + ? WHERE id = ?', [monto, linea.id]);
  return { ...p, monto, producto_id: p.producto_id ?? null };
};

// Condición de socio de un cliente según la copia local de Ventas (Clientes RN42): se resuelve el alias de una ficha unificada.
const esSocioLocal = async (clienteId, conn = pool) => {
  if (!clienteId) return false;
  const [[a]] = await conn.query('SELECT resultante_id FROM ventas_cliente_alias WHERE alias_id = ?', [clienteId]);
  const [[c]] = await conn.query('SELECT socio FROM ventas_clientes_copia WHERE cliente_id = ?', [a?.resultante_id ?? clienteId]);
  return !!c?.socio;
};

const liberarCredito = async (credito) => { if (credito?.reservaId) await (await puertos.obtener('credito')).liberarReserva(credito.reservaId).catch(() => {}); };

const liberarCompromiso = async (id) => { if (id) await (await puertos.obtener('stock')).liberarCompromiso(id).catch(() => {}); };
// Libera las series que tomó un cierre que no se completó.
const liberarSeries = async (idSolicitud) => { if (idSolicitud) await (await puertos.obtener('stock')).liberarSeries(idSolicitud).catch(() => {}); };

// Registra la venta de una cuenta cerrada. Va con la `conn` de la transacción del cierre: si el cierre
// se revierte, no queda ni la venta ni sus mensajes. Un efecto que falle después nunca revierte la venta.
const registrar = async (conn, { mesa_id, sesion_apertura, items, total, pagos, idSolicitud, userId, tipoNoFiscal = null, modalidad = 'salon', mozoId = null, idCompromiso = null, credito = null, fid = null, clienteId = null, terminalId = null, turnoNoVerificado = false }) => {
  const id_global = await idGlobal();
  // Un no fiscal tiene numeración propia, diferenciada de la fiscal, y queda "pendiente de facturación" (RF12, RN84).
  const numeroNoFiscal = tipoNoFiscal ? await Caea.siguienteNumero(`NF:${tipoNoFiscal}`, conn) : null;
  const snap = await Funciones.instantanea('pedido');
  const [promos] = items.length ? await conn.query('SELECT item_id, nombre, importe FROM promociones_aplicadas WHERE item_id IN (?)', [items.map((i) => i.id)]) : [[]];
  items = await SerieVenta.registrarVenta(conn, items, id_global);
  const detalle = items.map((i) => ({ producto_id: i.producto_id, nombre: i.nombre, cantidad: i.cantidad, precio_unitario: Number(i.precio_unitario), ...(i.serie && { serie: i.serie, fecha_fin_garantia: i.fecha_fin_garantia }), ...(i.modificadores && { modificadores: i.modificadores }), ...(i.alergenos && { alergenos: i.alergenos }), ...(i.lista && { lista: i.lista }),
    ...(Number(i.importe_descuento) > 0 && { importe_descuento: Number(i.importe_descuento), promociones: promos.filter((p) => p.item_id === i.id).map((p) => ({ nombre: p.nombre, importe: Number(p.importe) })) }) }));
  const [r] = await conn.query(
    'INSERT INTO ventas (id_global, mesa_id, sesion_apertura, total, detalle, id_solicitud, config_version, creado_por, condicion_fiscal, tipo_no_fiscal, numero_no_fiscal, modalidad, mozo_id, cliente_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id_global, mesa_id, sesion_apertura, total, JSON.stringify(detalle), idSolicitud ?? null, snap.version, userId ?? null, tipoNoFiscal ? 'no_fiscal' : 'fiscal', tipoNoFiscal, numeroNoFiscal, modalidad, mozoId, clienteId ?? fid?.clienteId ?? credito?.clienteId ?? null]
  );
  for (const p of pagos) {
    await conn.query('INSERT INTO pago_venta (venta_id, metodo_pago, importe, referencia, recibido, vuelto, moneda, importe_divisa, cotizacion, cotizacion_id, instrumento, retencion_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [r.insertId, p.forma, p.importe, p.referencia, p.recibido, p.vuelto, p.moneda ?? null, p.importe_divisa ?? null, p.cotizacion ?? null, p.cotizacion_id ?? null, p.instrumento ?? null, p.retencion_id ?? null]);
  }
  const lineas_contables = await lineasContables(conn, detalle);
  for (const e of EFECTOS) {
    if (tipoNoFiscal && e.destino === 'contable') continue; // una venta no fiscal no se informa a Contable (RN84)
    await Mensajeria.publicar(conn, {
      origen: 'ventas', destino: e.destino, tipo: e.tipo, docTipo: 'venta', docIdGlobal: id_global, userId,
      solicitud: idSolicitud, contenido: { total, pagos, items: detalle, terminal_id: terminalId, no_fiscal: !!tipoNoFiscal, turno_no_verificado: !!turnoNoVerificado, fecha_ms: Date.now(), ...(e.destino === 'contable' && { modalidad, lineas_contables }) },
    });
  }
  await publicarDescuento(conn, { docTipo: 'venta', docIdGlobal: id_global, items, userId, solicitud: idSolicitud, noFiscal: !!tipoNoFiscal, idCompromiso, modalidad, seriesRegistradas: true, clienteId: fid?.clienteId ?? credito?.clienteId ?? null }); // el cliente identificado viaja para el alcance de un retiro de lote (Clientes RF30)
  // Fidelización (Clientes RF22, RF29): canjes de vale o puntos, acumulación del socio, premio de sellos y emisión de las gift cards vendidas. Cada efecto es un mensaje
  // independiente en esta misma transacción; el canje no es ingreso de dinero y la gift card vendida no es venta (Ventas RN77).
  const fidActiva = await Funciones.estaActiva('CLI-FIDEL', conn);
  const [tiposProd] = items.length ? await conn.query('SELECT id, tipo, categoria_id FROM productos WHERE id IN (?)', [[...new Set(items.map((i) => i.producto_id))]]) : [[]];
  const prod = new Map(tiposProd.map((t) => [t.id, t]));
  const giftCards = items.filter((i) => prod.get(i.producto_id)?.tipo === 'gift_card');
  if (fidActiva) {
    for (const [i, p] of pagos.filter((x) => x.retencion_id).entries())
      await Mensajeria.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'canje_instrumento', docTipo: 'venta', docIdGlobal: id_global, docVersion: i + 1, userId, solicitud: idSolicitud, contenido: { id_retencion: p.retencion_id, venta_id_global: id_global } });
    if (fid?.clienteId) {
      const valeados = pagos.filter((p) => p.forma === 'vale').reduce((a, p) => a + Number(p.importe), 0);
      const enGiftCard = giftCards.reduce((a, i) => a + Number(i.cantidad) * Number(i.precio_unitario), 0);
      const lineasFid = items.filter((i) => prod.get(i.producto_id)?.tipo !== 'gift_card').map((i) => ({ producto_id: i.producto_id, categoria_id: prod.get(i.producto_id)?.categoria_id ?? null, cantidad: Number(i.cantidad) - (fid.premio?.producto_id === i.producto_id ? 1 : 0) })).filter((l) => l.cantidad > 0);
      await Mensajeria.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'acumulacion_fidelizacion', docTipo: 'venta', docIdGlobal: id_global, userId, solicitud: idSolicitud,
        contenido: { cliente_id: fid.clienteId, venta_id_global: id_global, lineas: lineasFid, importe_pagado: Math.max(redondear2(total - valeados - enGiftCard), 0) } });
      if (fid.premio) await Mensajeria.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'canje_sellos', docTipo: 'venta', docIdGlobal: id_global, userId, solicitud: idSolicitud, contenido: { cliente_id: fid.clienteId, regla_id: fid.premio.regla_id, venta_id_global: id_global } });
    }
    const [[inst]] = giftCards.length ? await conn.query('SELECT codigo_instancia AS c FROM configuracion_instancia WHERE id = 1') : [[null]];
    let n = 0;
    for (const g of giftCards) for (let u = 0; u < Number(g.cantidad); u++)
      await Mensajeria.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'emision_gift_card', docTipo: 'venta', docIdGlobal: id_global, docVersion: ++n, userId, solicitud: idSolicitud,
        contenido: { codigo: `${inst?.c ?? 'LOCAL'}-GC-${require('crypto').randomBytes(5).toString('hex').toUpperCase()}`, importe: Number(g.precio_unitario), cliente_id: fid?.clienteId ?? null, venta_id_global: id_global, linea: items.indexOf(g) } });
  }
  // El débito a la cuenta viaja por el protocolo de integración, en esta misma transacción; la reserva de crédito se convierte en deuda en el mismo registro (Clientes RF04).
  if (credito) await Mensajeria.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'debito_venta', docTipo: 'venta', docIdGlobal: id_global, userId, solicitud: idSolicitud,
    contenido: { cliente_id: credito.clienteId, moneda: credito.moneda, importe: credito.importe, importe_pesos: credito.importePesos ?? credito.importe, cotizacion: credito.cotizacion ?? null, venta_id_global: id_global, fecha: new Date().toISOString().slice(0, 10), reserva_id: credito.reservaId, contingencia: credito.contingencia, concepto: credito.contingencia ? `Contingencia: ${credito.motivo}` : null } });
  return { id: r.insertId, id_global, numero_no_fiscal: numeroNoFiscal };
};

// La venta con su estado de integración (Completa / Parcial, con la lista de efectos).
const obtener = async (id_global) => {
  const [[venta]] = await pool.query('SELECT * FROM ventas WHERE id_global = ?', [id_global]);
  if (!venta) return null;
  const [pagos] = await pool.query('SELECT metodo_pago, importe, referencia, recibido, vuelto, moneda, importe_divisa, cotizacion, cotizacion_id FROM pago_venta WHERE venta_id = ?', [venta.id]);
  // La venta no cambia (RN19): su estado sale de lo devuelto.
  const [[{ devuelto }]] = await pool.query('SELECT COALESCE(SUM(total), 0) AS devuelto FROM devoluciones WHERE venta_id = ?', [venta.id]);
  const estado = Number(devuelto) === 0 ? 'cerrada' : Math.round(Number(devuelto) * 100) >= Math.round(Number(venta.total) * 100) ? 'anulada' : 'devuelta_parcial';
  // Costo de cada línea (copia local de lo que informó Stock). Sin costo todavía y con descuento en camino: "pendiente de costo".
  const [costos] = await pool.query('SELECT linea, costo_unitario, origen_costo, provisorio FROM lineas_costo WHERE doc_id_global = ?', [id_global]);
  const costoDe = new Map(costos.map((c) => [c.linea, { costo_unitario: c.costo_unitario === null ? null : Number(c.costo_unitario), origen_costo: c.origen_costo, provisorio: !!c.provisorio }]));
  const [[{ conDescuento }]] = await pool.query("SELECT COUNT(*) AS conDescuento FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'descuento_stock'", [id_global]);
  const detalleVenta = JSON.parse(venta.detalle).map((l, i) => ({ ...l, costo: costoDe.get(i) ?? null }));
  const pendienteDeCosto = conDescuento > 0 && costos.length < detalleVenta.length;
  const [reimpresiones] = await pool.query('SELECT username, formato, motivo, created_at FROM reimpresiones WHERE venta_id = ? ORDER BY id', [venta.id]);
  return { ...venta, detalle: detalleVenta, pendiente_de_costo: pendienteDeCosto, pagos, devuelto: Number(devuelto), estado, reimpresiones, integracion: await Mensajeria.estadoIntegracion(id_global) };
};

// Cobros en divisa discriminados por moneda, importe cobrado y cotización (Ventas RF28): sin Financiero son el único registro de lo cobrado en divisa.
const porMoneda = async ({ desde, hasta } = {}) => (await pool.query(
  `SELECT pv.moneda, COUNT(*) AS cobros, SUM(pv.importe_divisa) AS total_divisa, SUM(pv.importe) AS total_pesos, ROUND(AVG(pv.cotizacion), 4) AS cotizacion_promedio
   FROM pago_venta pv JOIN ventas v ON v.id = pv.venta_id WHERE pv.moneda IS NOT NULL
   AND (? IS NULL OR v.created_at >= ?) AND (? IS NULL OR v.created_at < DATE_ADD(?, INTERVAL 1 DAY)) GROUP BY pv.moneda ORDER BY pv.moneda`, [desde ?? null, desde ?? null, hasta ?? null, hasta ?? null]))[0]
  .map((r) => ({ ...r, cobros: Number(r.cobros), total_divisa: Number(r.total_divisa), total_pesos: Number(r.total_pesos), cotizacion_promedio: Number(r.cotizacion_promedio) }));

// Total cobrado por forma de pago en un rango de fechas (cierre de caja y reportes, RF09).
const porFormaPago = async ({ desde, hasta } = {}) => {
  const [rows] = await pool.query(
    `SELECT pv.metodo_pago AS forma, COUNT(*) AS pagos, SUM(pv.importe) AS total
     FROM pago_venta pv JOIN ventas v ON v.id = pv.venta_id
     WHERE (? IS NULL OR v.created_at >= ?) AND (? IS NULL OR v.created_at < DATE_ADD(?, INTERVAL 1 DAY))
     GROUP BY pv.metodo_pago ORDER BY total DESC`, [desde ?? null, desde ?? null, hasta ?? null, hasta ?? null]);
  return rows;
};

// Emite la factura que regulariza una venta no fiscal (RN84). Con la factura aprobada la venta deja de estar
// pendiente; no se repite descuento de stock ni cobro: solo se publica "Venta regularizada" (hacia Contable).
const regularizar = async (idGlobal, receptor, { idIntento, userId } = {}) => {
  const venta = await obtener(idGlobal);
  if (!venta) throw Object.assign(new Error('Venta no encontrada.'), { status: 404 });
  if (venta.condicion_fiscal !== 'no_fiscal') throw Object.assign(new Error('La venta no es un comprobante no fiscal.'), { status: 400 });
  let factura = await Factura.getBySesion(venta.mesa_id, venta.sesion_apertura);
  if (factura?.estado === 'aprobada') throw Object.assign(new Error('La venta ya está regularizada.'), { status: 409 });
  factura ||= await Factura.create({
    mesa_id: venta.mesa_id, sesion_apertura: venta.sesion_apertura, metodo_pago: venta.pagos.length > 1 ? 'mixto' : venta.pagos[0].metodo_pago,
    tipo_comprobante: receptor.tipo_comprobante, punto_venta: afipConfig.puntoVenta, doc_tipo: receptor.doc_tipo, doc_nro: String(receptor.doc_nro),
    condicion_iva_receptor_id: receptor.condicion_iva_receptor_id, receptor_nombre: receptor.receptor_nombre, domicilio_receptor: receptor.domicilio_receptor,
    importe_total: venta.total, entorno: afipConfig.entorno, creado_por: userId,
  });
  try {
    const resultado = await afipService.emitirFactura({
      tipoComprobante: factura.tipo_comprobante, docTipo: factura.doc_tipo, docNro: factura.doc_nro,
      condicionIvaReceptorId: factura.condicion_iva_receptor_id, importeTotal: Number(venta.total), idIntento, facturaId: factura.id,
    });
    await Factura.updateResultado(factura.id, resultado);
  } catch (err) {
    await Factura.updateResultado(factura.id, { estado: 'error', importeTotal: venta.total, observaciones: err.message });
    throw Object.assign(err, { factura_id: factura.id });
  }
  factura = await Factura.getById(factura.id);
  if (factura.estado === 'aprobada') await publicarRegularizada(venta, factura, userId);
  return factura;
};

const publicarRegularizada = async (venta, factura, userId) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await Mensajeria.publicar(conn, { origen: 'ventas', destino: 'contable', tipo: 'venta_regularizada', docTipo: 'venta', docIdGlobal: venta.id_global, userId,
      contenido: { total: venta.total, pagos: venta.pagos, factura_id_global: factura.id_global, modalidad: venta.modalidad, lineas_contables: await lineasContables(conn, venta.detalle), fecha_ms: Date.now() } });
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  Mensajeria.despertar();
};

// Si la factura aprobada en un reintento (`/facturas/:id/reintentar`) regulariza una venta no fiscal, publica «Venta regularizada».
const regularizadaPorReintento = async (factura, userId) => {
  const [[v]] = await pool.query("SELECT id_global FROM ventas WHERE mesa_id = ? AND sesion_apertura = ? AND condicion_fiscal = 'no_fiscal' LIMIT 1", [factura.mesa_id, factura.sesion_apertura]);
  if (v) await publicarRegularizada(await obtener(v.id_global), factura, userId);
};

// Margen realizado por producto (Ventas RN62, RN75): ingresos menos el costo de la venta (CV) que informó Stock, con la
// marca "parcial" cuando hay ventas sin costo, costo provisorio u orígenes mezclados. No corrige ningún dato.
// shortcut: no descuenta las devoluciones del período; sumarlas cuando se necesite el margen neto.
const margen = async ({ desde, hasta } = {}) => {
  const donde = [];
  const params = [];
  if (desde) { donde.push('created_at >= ?'); params.push(`${desde} 00:00:00`); }
  if (hasta) { donde.push('created_at <= ?'); params.push(`${hasta} 23:59:59`); }
  const [ventas] = await pool.query(`SELECT id_global, detalle FROM ventas ${donde.length ? `WHERE ${donde.join(' AND ')}` : ''} ORDER BY id LIMIT 5000`, params);
  const costos = new Map();
  if (ventas.length) {
    const [rows] = await pool.query(`SELECT doc_id_global, linea, costo_unitario, origen_costo, provisorio FROM lineas_costo WHERE doc_id_global IN (${ventas.map(() => '?').join(',')})`, ventas.map((v) => v.id_global));
    for (const r of rows) costos.set(`${r.doc_id_global}|${r.linea}`, r);
  }
  const porProducto = new Map();
  for (const v of ventas) {
    JSON.parse(v.detalle).forEach((l, i) => {
      const p = porProducto.get(l.producto_id) ?? { producto_id: l.producto_id, nombre: l.nombre, unidades: 0, ingresos: 0, costo: 0, lineas_sin_costo: 0, lineas_provisorias: 0, origenes: new Set() };
      const c = costos.get(`${v.id_global}|${i}`);
      p.unidades += l.cantidad;
      p.ingresos += l.cantidad * l.precio_unitario;
      if (!c || c.costo_unitario === null) p.lineas_sin_costo++;
      else { p.costo += l.cantidad * Number(c.costo_unitario); p.origenes.add(c.origen_costo); if (c.provisorio) p.lineas_provisorias++; }
      porProducto.set(l.producto_id, p);
    });
  }
  return [...porProducto.values()].map((p) => {
    const motivos = [];
    if (p.lineas_sin_costo) motivos.push('hay ventas sin costo');
    if (p.lineas_provisorias) motivos.push('hay costo provisorio');
    if (p.origenes.size > 1) motivos.push('orígenes de costo mezclados');
    const ingresos = Math.round(p.ingresos * 100) / 100;
    const costo = Math.round(p.costo * 100) / 100;
    return { producto_id: p.producto_id, nombre: p.nombre, unidades: p.unidades, ingresos, costo, margen: Math.round((ingresos - costo) * 100) / 100, parcial: motivos.length > 0, motivos };
  }).sort((a, b) => b.margen - a.margen);
};

module.exports = { verificarTurno, retenerCanjes, liberarCanjes, aplicarPremio, esSocioLocal, reservarCredito, liberarCredito, importeACuenta, porMoneda, comprometerStock, liberarCompromiso, liberarSeries, margen, regularizar, regularizadaPorReintento, TIPOS_NO_FISCAL, publicarDescuento, registrar, obtener, validarPagos, metodoResumen, porFormaPago, PagoInvalido, EFECTOS };
