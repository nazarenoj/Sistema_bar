const pool = require('../config/db');
const llamar = require('../modulos/llamar');
const PedidoOnline = require('../services/pedidoOnlineService');
const Eventos = require('./eventos');
const Reintegros = require('./reintegroService');
const { TiendaInvalida } = require('./tiendaService');

// Facturación del pedido y alineación (Ventas Online RF14, RN10, RN50, EX06, EX35, EX36). El comprobante lo emite Ventas con los datos de facturación del checkout, en el momento que
// configura la tienda («al confirmarse el pago» o «al despachar»); un pedido con pesables se factura siempre después del pesaje real confirmado (al despachar el envío, al entregar el retiro).
// Si Ventas no logra emitirlo, el pedido queda «Pendiente de facturación» y se reintenta. Lo cobrado menos lo reintegrado tiene que ser igual a lo facturado neto: Ventas Online lo compara
// con los totales que le informa Ventas (llamada n.º 19) y guarda el estado de alineación, sin corregir nada por su cuenta.
const invalida = (m, status = 400, extra = {}) => Object.assign(new TiendaInvalida(m), { status, ...extra });
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const COND = { 'responsable inscripto': 1, exento: 4, monotributo: 6, monotributista: 6, 'consumidor final': 5 };

const pedido = async (id) => { const [[p]] = await pool.query('SELECT * FROM onl_pedidos WHERE id = ?', [id]); if (!p) throw invalida('Pedido no encontrado.', 404); return p; };

// El comprador, para el comprobante: consumidor final, o CUIT y condición de IVA para la factura A (RN10).
const receptorDe = (p) => {
  const f = JSON.parse(p.facturacion);
  if (f.tipo !== 'factura_a') return { doc_tipo: 99, doc_nro: '0', condicion_iva_receptor_id: 5, nombre: p.nombre };
  return { doc_tipo: 80, doc_nro: f.cuit, condicion_iva_receptor_id: COND[String(f.condicion_iva).toLowerCase()] ?? 1, nombre: f.razon_social, domicilio: f.domicilio };
};

// ¿Ya es el momento de facturar este pedido?
const listoParaFacturar = async (p) => {
  if (!p.pagado_ms || p.entrega_ventas_estado !== 'entregado' || ['cancelado', 'devuelto', 'pendiente_pago', 'reserva_pendiente'].includes(p.estado)) return false;
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM onl_ajustes WHERE pedido_id = ? AND estado IN ('requiere_aceptacion', 'cobro_pendiente')", [p.id]);
  if (n) return false; // un cobro adicional se aprueba antes de facturar lo no cobrado
  const delivery = p.entrega_tipo === 'delivery';
  if (p.tiene_pesables) return p.pesaje_estado === 'confirmado' && (delivery ? ['despachado', 'entregado'] : ['entregado']).includes(p.estado);
  const [[t]] = await pool.query('SELECT facturar_en FROM onl_tienda WHERE id = 1');
  if (t.facturar_en === 'despacho') return (delivery ? ['despachado', 'entregado'] : ['listo', 'entregado']).includes(p.estado);
  return true;
};

const facturaEmitida = async (id) => (await pool.query("SELECT * FROM onl_comprobantes WHERE pedido_id = ? AND tipo = 'factura' ORDER BY id LIMIT 1", [id]))[0][0] ?? null;

// Pide a Ventas la factura por el importe real (el total, o el que quedó tras el pesaje). Repetir no emite otra (la clave de intento es la del pedido).
const facturar = async (id) => {
  const p = await pedido(id);
  const previa = await facturaEmitida(id);
  if (previa) return { estado: 'emitida', comprobante: previa, ya_procesado: true };
  if (!(await listoParaFacturar(p))) return { estado: 'espera' };
  const importe = p.total_real === null ? Number(p.total) : Number(p.total_real);
  try {
    const r = await PedidoOnline.facturar({ idGlobal: p.id_global, receptor: receptorDe(p), importe, idIntento: `online:fac:${p.id_global}` });
    await pool.query('INSERT INTO onl_comprobantes (pedido_id, tipo, tipo_comprobante, punto_venta, numero, cae, importe, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, 'factura', r.tipo_comprobante, r.punto_venta, r.numero, r.cae, importe, Date.now()]);
    await Eventos.facturado?.(id);
    await alinear(id);
    return { estado: 'emitida', comprobante: await facturaEmitida(id), ya_procesado: false };
  } catch (err) {
    await pool.query('UPDATE onl_pedidos SET entrega_error = ? WHERE id = ?', [`Factura: ${String(err.message).slice(0, 230)}`, id]);
    await alinear(id).catch(() => {});
    return { estado: 'pendiente', error: err.message }; // EX06: queda pendiente de facturación y se reintenta
  }
};
const intentar = async (id) => { try { return await facturar(id); } catch { return { estado: 'error' }; } };
const reintentarPendientes = async () => {
  const [ids] = await pool.query("SELECT p.id FROM onl_pedidos p WHERE p.entrega_ventas_estado = 'entregado' AND p.pagado_ms IS NOT NULL AND NOT EXISTS (SELECT 1 FROM onl_comprobantes c WHERE c.pedido_id = p.id AND c.tipo = 'factura') AND p.estado NOT IN ('cancelado', 'devuelto') ORDER BY p.id");
  const salida = { emitidas: 0, pendientes: 0, en_espera: 0 };
  for (const { id } of ids) { const r = await intentar(id); if (r.estado === 'emitida') salida.emitidas++; else if (r.estado === 'pendiente') salida.pendientes++; else salida.en_espera++; }
  return salida;
};

// ---- Alineación (RN50) ----

const alinear = async (id) => {
  const p = await pedido(id);
  const r = await llamar(19, 'ventas_online', async () => PedidoOnline.totales(p.id_global));
  if (r.fallo) { await pool.query("UPDATE onl_pedidos SET alineacion = 'no_verificado' WHERE id = ?", [id]); return { alineacion: 'no_verificado' }; } // Ventas no responde: se reintenta
  const { cobrado, reintegrado, facturado_neto: fact } = r.valor;
  const pendiente = r2(await Reintegros.pendientesDe(id));
  const [[{ aj }]] = await pool.query("SELECT COUNT(*) AS aj FROM onl_ajustes WHERE pedido_id = ? AND estado IN ('pendiente_reintegro', 'pendiente_comprobante')", [id]);
  let estado;
  if (pendiente > 0 || aj > 0) estado = 'pendiente_reintegro';
  else if (Math.abs(r2(cobrado - reintegrado) - fact) < 0.01) estado = 'alineado';
  else if (r2(cobrado - reintegrado) > fact) estado = 'pendiente_facturacion';
  else estado = 'con_diferencia'; // EX36: ninguna operación pendiente lo explica
  await pool.query('UPDATE onl_pedidos SET alineacion = ?, updated_ms = ? WHERE id = ?', [estado, Date.now(), id]);
  if (estado === 'con_diferencia') await Reintegros.alertar(`diferencia-${id}`, 'alta', `El pedido online ${id} tiene diferencias entre lo cobrado (${cobrado}), lo reintegrado (${reintegrado}) y lo facturado (${fact}).`);
  return { alineacion: estado, cobrado, reintegrado, facturado_neto: fact };
};
const alinearTodos = async () => {
  const [ids] = await pool.query("SELECT id FROM onl_pedidos WHERE pagado_ms IS NOT NULL ORDER BY id DESC LIMIT 500");
  const salida = {};
  for (const { id } of ids) { const r = await alinear(id).catch(() => ({ alineacion: 'error' })); salida[r.alineacion] = (salida[r.alineacion] ?? 0) + 1; }
  return salida;
};

const comprobantes = async (id) => (await pool.query('SELECT tipo, tipo_comprobante, punto_venta, numero, cae, importe, ts_ms FROM onl_comprobantes WHERE pedido_id = ? ORDER BY id', [id]))[0].map((c) => ({ ...c, numero: c.numero === null ? null : Number(c.numero), importe: Number(c.importe), ts_ms: Number(c.ts_ms) }));

// Enlaces: el pedido se factura al pagarse (si corresponde) y cada cambio de estado puede ser el momento.
Eventos.suscribirPagado(async (id) => { await intentar(id); }, 10);
Eventos.suscribirEstado(async (id) => { await intentar(id); }, 10);

module.exports = { facturar, intentar, reintentarPendientes, alinear, alinearTodos, receptorDe, listoParaFacturar, comprobantes, facturaEmitida };
