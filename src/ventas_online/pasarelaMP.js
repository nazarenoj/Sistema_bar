const crypto = require('crypto');
const pool = require('../config/db');

// Mercado Pago detrás de una interfaz interna (Ventas Online RF10): Checkout Pro para abrir el cobro, webhooks firmados con HMAC, consulta de pagos y reintegros por API. La tienda no
// toca tarjetas (RN08): el cliente paga en la página de la pasarela. Cualquier otro proveedor implementa las mismas cinco operaciones; las pruebas usan uno simulado (`usarProveedor`).
const API = 'https://api.mercadopago.com';
const credenciales = async () => (await pool.query('SELECT mp_access_token, mp_webhook_secret FROM onl_tienda WHERE id = 1'))[0][0];

const llamar = async (metodo, ruta, { token, cuerpo, idem } = {}) => {
  const r = await fetch(`${API}${ruta}`, { method: metodo, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(idem && { 'X-Idempotency-Key': idem }) }, ...(cuerpo && { body: JSON.stringify(cuerpo) }), signal: AbortSignal.timeout(15000) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`Mercado Pago ${r.status}: ${json.message ?? json.error ?? 'error'}`), { status: r.status });
  return json;
};
const pagoDe = (p) => ({ id: String(p.id), estado: p.status, monto: Number(p.transaction_amount), referencia: p.external_reference ?? null, metodo: p.payment_method_id ?? null, detalle: p.status_detail ?? null });

const mercadoPago = {
  nombre: 'mercadopago',
  // Abre el cobro (preferencia de Checkout Pro) y devuelve la dirección de pago.
  crearCobro: async ({ referencia, importe, titulo, urlRetorno, urlNotificacion, idSolicitud }) => {
    const c = await credenciales();
    if (!c.mp_access_token) throw Object.assign(new Error('Falta configurar las credenciales de Mercado Pago.'), { status: 409, codigo: 'PASARELA_SIN_CREDENCIALES' });
    const p = await llamar('POST', '/checkout/preferences', { token: c.mp_access_token, idem: idSolicitud, cuerpo: {
      items: [{ title: titulo, quantity: 1, currency_id: 'ARS', unit_price: importe }], external_reference: referencia, notification_url: urlNotificacion, back_urls: { success: urlRetorno, failure: urlRetorno, pending: urlRetorno }, auto_return: 'approved' } });
    return { preferencia_id: p.id, url: p.init_point };
  },
  obtenerPago: async (id) => pagoDe(await llamar('GET', `/v1/payments/${encodeURIComponent(id)}`, { token: (await credenciales()).mp_access_token })),
  buscarPagos: async (referencia) => ((await llamar('GET', `/v1/payments/search?external_reference=${encodeURIComponent(referencia)}`, { token: (await credenciales()).mp_access_token })).results ?? []).map(pagoDe),
  reintegrar: async (id, monto, idSolicitud) => {
    const r = await llamar('POST', `/v1/payments/${encodeURIComponent(id)}/refunds`, { token: (await credenciales()).mp_access_token, idem: idSolicitud, cuerpo: monto ? { amount: monto } : {} });
    return { id: String(r.id), estado: r.status ?? 'approved' };
  },
  // La notificación llega con `x-signature: ts=...,v1=...` y `x-request-id`; la firma es el HMAC-SHA256 de «id:<data.id>;request-id:<x-request-id>;ts:<ts>;» con el secreto del webhook.
  verificarFirma: async ({ headers, dataId }) => {
    const secreto = (await credenciales()).mp_webhook_secret;
    if (!secreto) return false;
    const firma = String(headers['x-signature'] ?? '');
    const ts = firma.match(/ts=([^,]+)/)?.[1], v1 = firma.match(/v1=([a-f0-9]+)/i)?.[1];
    if (!ts || !v1) return false;
    const esperado = crypto.createHmac('sha256', secreto).update(`id:${/^[a-z0-9]+$/i.test(dataId) ? String(dataId).toLowerCase() : dataId};request-id:${headers['x-request-id'] ?? ''};ts:${ts};`).digest('hex');
    const a = Buffer.from(esperado), b = Buffer.from(v1.toLowerCase());
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },
};

let actual = mercadoPago;
const proveedor = () => actual;
const usarProveedor = (p) => { actual = p ?? mercadoPago; };

module.exports = { proveedor, usarProveedor, mercadoPago };
