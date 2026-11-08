process.env.AFIP_CONDICION_IVA_EMISOR = 'responsable_inscripto';
process.env.AFIP_PUNTO_VENTA = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const Pasarela = require('../src/ventas_online/pasarelaMP');
const PedidoOnline = require('../src/services/pedidoOnlineService');
const Facturacion = require('../src/ventas_online/facturacionService');
const Pesaje = require('../src/ventas_online/pesajeService');
const Pagos = require('../src/ventas_online/pagoService');
const wsfe = require('../src/afip/wsfeClient');

let api, pool, cerrar, adm, gerente, encargado, cajero, B, P, k = 0, ultimo = 0, caeFalla = false, llamadasCAE = 0;
const T = '/tienda/cafe-fac';
const pagos = new Map();
const reintegros = [];

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  wsfe.compUltimoAutorizado = async () => { if (caeFalla) throw new Error('ARCA sin conexion'); return ultimo; }; // cae antes de enviar nada: no queda ningun intento indeterminado
  wsfe.compConsultar = async () => null;
  wsfe.solicitarCAE = async ({ item }) => {
    llamadasCAE++;
    ultimo = item.CbteDesde;
    return { FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CAE: `7000000000${String(ultimo).padStart(4, '0')}`, CAEFchVto: '20261231' }] } };
  };
  Pasarela.usarProveedor({ nombre: 'mercadopago', crearCobro: async ({ referencia, importe }) => ({ preferencia_id: `P-${referencia}`, url: `https://pago.test/${referencia}?importe=${importe}` }),
    obtenerPago: async (id) => ({ ...pagos.get(String(id)), id: String(id) }), buscarPagos: async () => [], reintegrar: async (id, monto, sol) => { reintegros.push({ id, monto, sol }); return { id: `RF-${reintegros.length}`, estado: 'approved' }; }, verificarFirma: async () => true });
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  encargado = await usuario(api, pool, 'enzo', 'encargado');
  cajero = await usuario(api, pool, 'cami', 'cajero');
  await api('POST', '/api/modulos/ventas_online/instalar', { token: adm.token });
  await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { codigo: 'cafe-fac', nombre: 'Cafe', razon_social: 'Cafe SA', cuit: '30711111111', domicilio: 'Mitre 1', activa: true } });
  B = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Medialuna', precio: 300, stock: 0 } })).json;
  P = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Queso por kilo', precio: 1000, stock: 0 } })).json;
  await pool.query("UPDATE productos SET tipo = 'pesable', peso_minimo = 0.4, peso_maximo = 0.7 WHERE id = ?", [P.id]);
  for (const x of [B, P]) await api('PUT', `/api/ventas-online/catalogo/${x.id}`, { token: gerente.token, body: { categoria_online: 'Menu' } });
});
after(async () => { Pasarela.usarProveedor(null); await cerrar(); });

const nuevo = async (items, { medio = 'pago_al_retirar', facturacion = { tipo: 'consumidor_final' }, entrega = { tipo: 'retiro' }, aceptar = true } = {}) => {
  require('../src/ventas_online/limites').pedidos.reiniciar();
  let c;
  for (const [i, it] of items.entries()) c = i === 0 ? (await api('POST', `${T}/carrito`, { body: it })).json : (await api('POST', `${T}/carrito/${c.token}/items`, { body: it })).json;
  const r = await api('POST', `${T}/checkout`, { headers: { 'X-ID-Solicitud': `sol-fac-${++k}-abcdef` }, body: { carrito: c.token, contacto: { nombre: 'Ana', email: `ana${k}@mail.test` }, facturacion, entrega, medio_pago: medio, acepta_terminos: true, total_confirmado: c.total } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  if (aceptar && medio !== 'pasarela') assert.equal((await api('POST', `/api/ventas-online/pedidos/${r.json.id}/aceptar`, { token: gerente.token })).status, 200);
  return r.json;
};
const det = async (p) => (await api('GET', `/api/ventas-online/pedidos/${p.id}`, { token: gerente.token })).json;
const estado = (p, e) => api('POST', `/api/ventas-online/pedidos/${p.id}/estado`, { token: gerente.token, body: { estado: e } });
const hastaEntregado = async (p) => { for (const e of ['en_preparacion', 'listo', 'entregado']) assert.equal((await estado(p, e)).status, 200, e); };
const config = (b) => api('PUT', '/api/ventas-online/facturacion/configuracion', { token: gerente.token, body: b });
const pesar = (p, linea, body, t = encargado) => api('POST', `/api/ventas-online/pedidos/${p.id}/pesaje/${linea}`, { token: t.token, body });

test('Ventas Online.RF14/RN10: al confirmarse el pago Ventas emite la factura con los datos del checkout y el pedido queda alineado', async () => {
  const p = await nuevo([{ producto_id: B.id, cantidad: 2 }]);
  const d = await det(p);
  assert.equal(d.comprobantes.length, 1);
  assert.deepEqual([d.comprobantes[0].tipo, d.comprobantes[0].tipo_comprobante, d.comprobantes[0].importe], ['factura', 6, 600]); // consumidor final: factura B
  assert.match(d.comprobantes[0].cae, /^70000000/);
  assert.equal(d.alineacion, 'alineado');
  const a = await nuevo([{ producto_id: B.id, cantidad: 1 }], { facturacion: { tipo: 'factura_a', cuit: '30-50001091-2', razon_social: 'Cliente SA', condicion_iva: 'Responsable Inscripto' } });
  assert.equal((await det(a)).comprobantes[0].tipo_comprobante, 1); // CUIT y condicion de IVA: factura A
  const [[f]] = await pool.query("SELECT doc_tipo, doc_nro, condicion_iva_receptor_id FROM facturas WHERE importe_total = 300 ORDER BY id DESC LIMIT 1");
  assert.deepEqual([f.doc_tipo, f.doc_nro, f.condicion_iva_receptor_id], [80, '30500010912', 1]);
});

test('Ventas Online.RN44: pedir la factura de nuevo no emite otra ni vuelve a ARCA', async () => {
  const p = await nuevo([{ producto_id: B.id, cantidad: 1 }]);
  const antes = llamadasCAE;
  const r = await api('POST', `/api/ventas-online/pedidos/${p.id}/facturar`, { token: gerente.token });
  assert.equal(r.json.ya_procesado, true);
  assert.equal(llamadasCAE, antes);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM onl_comprobantes WHERE pedido_id = ?', [p.id]))[0][0].n, 1);
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${p.id}/facturar`, { token: cajero.token })).status, 403);
});

test('Ventas Online.EX06: si Ventas no logra emitir queda pendiente de facturacion, se ve en la alineacion y se reintenta', async () => {
  caeFalla = true;
  const p = await nuevo([{ producto_id: B.id, cantidad: 1 }]);
  caeFalla = false;
  const d = await det(p);
  assert.equal(d.comprobantes.length, 0); assert.equal(d.alineacion, 'pendiente_facturacion'); assert.equal(d.estado, 'pagado');
  assert.deepEqual((await api('GET', '/api/ventas-online/pedidos?alineacion=pendiente_facturacion', { token: gerente.token })).json.map((x) => x.id).includes(p.id), true);
  const r = await api('POST', '/api/ventas-online/facturacion/reintentar', { token: gerente.token });
  assert.ok(r.json.emitidas >= 1, JSON.stringify(r.json));
  const d2 = await det(p);
  assert.equal(d2.comprobantes.length, 1); assert.equal(d2.alineacion, 'alineado');
});

test('Ventas Online.RF14: con «al despachar» se factura recien cuando el pedido esta listo (retiro) o despachado (envio)', async () => {
  assert.equal((await config({ facturar_en: 'nunca' })).status, 400);
  assert.equal((await config({ facturar_en: 'despacho' })).json.facturar_en, 'despacho');
  const p = await nuevo([{ producto_id: B.id, cantidad: 1 }]);
  assert.equal((await det(p)).comprobantes.length, 0); assert.equal((await det(p)).alineacion, 'pendiente_facturacion');
  await estado(p, 'en_preparacion');
  assert.equal((await det(p)).comprobantes.length, 0);
  await estado(p, 'listo');
  assert.equal((await det(p)).comprobantes.length, 1);
  await config({ facturar_en: 'pago' });
});

test('Ventas Online.RN50: la alineacion compara lo cobrado, lo reintegrado y lo facturado que informa Ventas, y no corrige nada por su cuenta', async () => {
  const p = await nuevo([{ producto_id: B.id, cantidad: 2 }]);
  const r = await api('POST', `/api/ventas-online/pedidos/${p.id}/alineacion`, { token: gerente.token });
  assert.deepEqual([r.json.alineacion, r.json.cobrado, r.json.reintegrado, r.json.facturado_neto], ['alineado', 600, 0, 600]);
  // Una factura de mas que ninguna operacion pendiente explica: «con diferencia» y alerta (EX36).
  await pool.query("INSERT INTO ventas_online_movs (pedido_global, tipo, importe, referencia, ts_ms) VALUES (?, 'factura', 50, 'manual-1', ?)", [p.id_global, Date.now()]);
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${p.id}/alineacion`, { token: gerente.token })).json.alineacion, 'con_diferencia');
  assert.ok((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE tipo = 'reintegro' AND mensaje LIKE '%diferencias%'"))[0][0].n >= 1);
  assert.equal((await det(p)).comprobantes.length, 1); // Ventas Online no toco los comprobantes
  // Ventas sin responder: «No verificado».
  const original = PedidoOnline.totales;
  PedidoOnline.totales = async () => { throw new Error('Ventas caida'); };
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${p.id}/alineacion`, { token: gerente.token })).json.alineacion, 'no_verificado');
  PedidoOnline.totales = original;
  assert.ok((await api('POST', '/api/ventas-online/alineacion/recalcular', { token: gerente.token })).json.con_diferencia >= 1);
});

const pesable = async (kg, extra = {}) => nuevo([{ producto_id: P.id, cantidad: kg }], extra); // cobra kg * 1000

test('Ventas Online.RN51: los pesables se facturan despues del pesaje real, al entregar el retiro, y lo pesado de menos se reintegra despues de la factura', async () => {
  const p = await pesable(0.5, { medio: 'pasarela', aceptar: false });
  pagos.set('PESA1', { estado: 'approved', monto: 500, referencia: p.id_global, metodo: 'visa', detalle: null });
  await Pagos.procesarPago('PESA1');
  assert.equal((await det(p)).estado, 'pagado'); assert.equal((await det(p)).comprobantes.length, 0);
  assert.equal((await det(p)).alineacion, 'pendiente_facturacion'); // la espera normal del pesaje, sin alerta
  await estado(p, 'en_preparacion');
  assert.equal((await pesar(p, 1, { peso: 0, estable: true })).json.codigo, 'PESO_INVALIDO');
  assert.equal((await pesar(p, 1, { peso: -1, estable: true })).json.codigo, 'PESO_INVALIDO');
  assert.equal((await pesar(p, 1, { peso: 0.45, estable: false })).json.codigo, 'LECTURA_INESTABLE');
  assert.equal((await pesar(p, 1, { peso: 0.45, manual: true, motivo: 'balanza rota' })).status, 403); // el encargado no tiene el ingreso manual
  assert.equal((await pesar(p, 1, { peso: 0.45, estable: true }, cajero)).status, 403);
  assert.equal((await pesar(p, 1, { peso: 0.3, estable: true })).json.codigo, 'FUERA_DE_RANGO'); // fuera del 0,4 a 0,7 publicado
  const ok = await pesar(p, 1, { peso: 0.45, estable: true });
  assert.deepEqual([ok.json.estado, ok.json.delta], ['confirmado', -50]);
  const s = (await api('GET', `/api/ventas-online/pedidos/${p.id}/pesaje`, { token: gerente.token })).json;
  assert.deepEqual([s.pesaje, s.total_cobrado, s.total_real], ['confirmado', 500, 450]);
  assert.equal((await det(p)).comprobantes.length, 0); // todavia no se entrego el retiro
  assert.equal(reintegros.filter((r) => r.id === 'PESA1').length, 0); // el reintegro espera a la factura
  await estado(p, 'listo'); await estado(p, 'entregado');
  const d = await det(p);
  assert.deepEqual([d.comprobantes[0].importe, d.alineacion], [450, 'alineado']); // se factura el importe real
  assert.deepEqual(reintegros.filter((r) => r.id === 'PESA1').map((r) => r.monto), [50]);
  assert.equal((await pool.query("SELECT COALESCE(SUM(importe), 0) AS t FROM ventas_online_movs WHERE pedido_global = ? AND tipo = 'devolucion'", [p.id_global]))[0][0].t, '50.00');
});

test('Ventas Online.RN51: hasta la tolerancia el comercio absorbe el exceso y se factura lo cobrado; el manual necesita permiso y motivo', async () => {
  const p = await pesable(0.5);
  await estado(p, 'en_preparacion');
  const r = await pesar(p, 1, { peso: 0.52, estable: true }); // +20 sobre 500, la tolerancia es 25
  assert.deepEqual([r.json.estado, r.json.delta, r.json.tolerancia], ['confirmado', 20, 25]);
  await estado(p, 'listo'); await estado(p, 'entregado');
  const d = await det(p);
  assert.deepEqual([d.comprobantes[0].importe, d.alineacion], [500, 'alineado']); // nunca se factura ni se cobra de mas
  // Manual con permiso y motivo.
  const q = await pesable(0.5);
  await estado(q, 'en_preparacion');
  assert.equal((await pesar(q, 1, { peso: 0.49, manual: true, motivo: 'x' }, gerente)).status, 400);
  assert.equal((await pesar(q, 1, { peso: 0.49, manual: true, motivo: 'balanza sin pantalla' }, gerente)).json.estado, 'confirmado');
  assert.equal((await pool.query('SELECT pesaje_manual FROM onl_pedido_lineas WHERE pedido_id = ?', [q.id]))[0][0].pesaje_manual, 1);
  assert.equal((await pesar(q, 1, { peso: 0.48, estable: true })).status, 409); // ya confirmado
});

test('Ventas Online.RN51: por encima de la tolerancia el pesaje no se confirma; el preparador reduce el peso o pide la aceptacion del cliente', async () => {
  const p = await pesable(0.5);
  await estado(p, 'en_preparacion');
  const r = await pesar(p, 1, { peso: 0.62, estable: true }); // +120
  assert.equal(r.json.estado, 'requiere_aceptacion'); assert.deepEqual(r.json.opciones, ['reducir_peso', 'solicitar_aceptacion']);
  assert.equal((await det(p)).comprobantes.length, 0);
  assert.equal((await pesar(p, 1, { peso: 0.51, estable: true })).json.estado, 'confirmado'); // reduce el peso a un valor dentro de la tolerancia
  await estado(p, 'listo'); await estado(p, 'entregado');
  assert.equal((await det(p)).comprobantes[0].importe, 500);
});

test('Ventas Online.RN51: el cliente acepta la diferencia por correo y la paga (cobro adicional); se factura el real y queda alineado', async () => {
  const p = await pesable(0.5, { medio: 'pasarela', aceptar: false });
  pagos.set('PESA2', { estado: 'approved', monto: 500, referencia: p.id_global, metodo: 'visa', detalle: null });
  await Pagos.procesarPago('PESA2');
  await estado(p, 'en_preparacion');
  assert.equal((await pesar(p, 1, { peso: 0.6, estable: true })).json.estado, 'requiere_aceptacion'); // +100
  const sol = await api('POST', `/api/ventas-online/pedidos/${p.id}/pesaje/1/solicitar-aceptacion`, { token: encargado.token, body: {} });
  assert.equal(sol.status, 201, JSON.stringify(sol.json));
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${p.id}/pesaje/1/solicitar-aceptacion`, { token: encargado.token, body: {} })).status, 409);
  const [[mail]] = await pool.query("SELECT cuerpo FROM correo_cola WHERE para = ? ORDER BY id DESC LIMIT 1", [p.email]);
  const token = mail.cuerpo.match(/token=([0-9a-f]{48})/)[1];
  const url = `${T}/pedidos/${p.id_global}/aceptar-diferencia`;
  assert.equal((await api('POST', url, { body: { token: 'x'.repeat(48), email: p.email, acepta: true } })).json.codigo, 'ENLACE_INVALIDO');
  const ac = await api('POST', url, { body: { token, email: p.email, acepta: true } });
  assert.equal(ac.json.estado, 'cobro_pendiente', JSON.stringify(ac.json));
  assert.match(ac.json.url, /pago\.test/);
  assert.equal((await det(p)).comprobantes.length, 0); // no se factura lo no cobrado
  pagos.set('PESA2AJ', { estado: 'approved', monto: 100, referencia: `${p.id_global}:AJ${(await pool.query('SELECT id FROM onl_ajustes WHERE pedido_id = ?', [p.id]))[0][0].id}`, metodo: 'visa', detalle: null });
  assert.equal((await Pagos.procesarPago('PESA2AJ')).estado, 'adicional');
  assert.equal((await Pagos.procesarPago('PESA2AJ')).ya_procesado, true); // la notificacion repetida no cobra dos veces
  const [[ped]] = await pool.query('SELECT total_real, pesaje_estado FROM onl_pedidos WHERE id = ?', [p.id]);
  assert.deepEqual([Number(ped.total_real), ped.pesaje_estado], [600, 'confirmado']);
  await estado(p, 'listo'); await estado(p, 'entregado');
  const d = await det(p);
  assert.deepEqual([d.comprobantes[0].importe, d.alineacion], [600, 'alineado']); // cobrado 500 + 100 = facturado 600
  const aj = (await api('GET', `/api/ventas-online/pedidos/${p.id}/pesaje`, { token: gerente.token })).json.ajustes[0];
  assert.ok(aj.aceptado_ms); assert.equal(aj.aceptado_medio, 'enlace_correo'); // queda registrada la aceptacion
});

test('Ventas Online.RN51: si el cliente rechaza o la solicitud vence, el comercio absorbe hasta la tolerancia y nunca se cobra de mas', async () => {
  const p = await pesable(0.5);
  await estado(p, 'en_preparacion');
  await pesar(p, 1, { peso: 0.62, estable: true });
  await api('POST', `/api/ventas-online/pedidos/${p.id}/pesaje/1/solicitar-aceptacion`, { token: encargado.token, body: {} });
  const [[mail]] = await pool.query("SELECT cuerpo FROM correo_cola WHERE para = ? ORDER BY id DESC LIMIT 1", [p.email]);
  const rech = await api('POST', `${T}/pedidos/${p.id_global}/aceptar-diferencia`, { body: { token: mail.cuerpo.match(/token=([0-9a-f]{48})/)[1], email: p.email, acepta: false } });
  assert.equal(rech.json.estado, 'rechazado');
  const [[l]] = await pool.query('SELECT peso_real, delta, pesaje_estado FROM onl_pedido_lineas WHERE pedido_id = ?', [p.id]);
  assert.deepEqual([Number(l.peso_real), Number(l.delta), l.pesaje_estado], [0.525, 25, 'confirmado']); // el maximo que entra en la tolerancia
  await estado(p, 'listo'); await estado(p, 'entregado');
  assert.equal((await det(p)).comprobantes[0].importe, 500);
  // Vencimiento: sin respuesta en la vigencia pasa lo mismo.
  const q = await pesable(0.5);
  await estado(q, 'en_preparacion');
  await pesar(q, 1, { peso: 0.62, estable: true });
  await api('POST', `/api/ventas-online/pedidos/${q.id}/pesaje/1/solicitar-aceptacion`, { token: encargado.token, body: {} });
  await pool.query("UPDATE onl_ajustes SET aceptacion_vence_ms = ? WHERE pedido_id = ?", [Date.now() - 1000, q.id]);
  assert.equal(await Pesaje.vencerAceptaciones(), 1);
  assert.equal((await pool.query('SELECT pesaje_estado FROM onl_pedido_lineas WHERE pedido_id = ?', [q.id]))[0][0].pesaje_estado, 'confirmado');
  assert.ok(esperarMensajes);
});

test('Ventas Online.RN51 g: en pago al retirar lo pesado de menos no se reintegra online pero Ventas lo registra y el pedido queda alineado', async () => {
  const p = await pesable(0.5); // pago al retirar
  await estado(p, 'en_preparacion');
  await pesar(p, 1, { peso: 0.45, estable: true });
  await estado(p, 'listo'); await estado(p, 'entregado');
  const d = await det(p);
  assert.deepEqual([d.comprobantes[0].importe, d.alineacion], [450, 'alineado']);
  assert.equal(reintegros.filter((r) => r.id.includes(p.id_global)).length, 0);
});

test('Ventas Online.RF14: un pedido mixto con pesables se factura completo despues del pesaje', async () => {
  const p = await nuevo([{ producto_id: B.id, cantidad: 2 }, { producto_id: P.id, cantidad: 0.5 }]); // 600 + 500
  assert.equal((await det(p)).comprobantes.length, 0); // espera el pesaje aunque la configuracion diga «al pagar»
  await estado(p, 'en_preparacion');
  await pesar(p, 2, { peso: 0.45, estable: true });
  await estado(p, 'listo'); await estado(p, 'entregado');
  assert.equal((await det(p)).comprobantes[0].importe, 1050);
  assert.ok(Facturacion);
});
