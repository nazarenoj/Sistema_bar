const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { preparar } = require('./ayudas_contable');
const M = require('../src/mensajeria/servicio');

let api, pool, cerrar, c, k = 0;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  c = await preparar(api, pool, { antes: async ({ adm }) => {
    for (const m of ['compras', 'financiero', 'clientes']) assert.equal((await api('POST', `/api/modulos/${m}/instalar`, { token: adm.token })).status, 200, m);
    assert.equal((await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['CLI-FIDEL', 'VEN-COMISIONES', 'VEN-CC'], motivo: 'prueba' } })).status, 200);
  } });
});
after(async () => { await cerrar(); });

const g = () => ({ token: c.gerente.token });
// Publica un evento como lo haría su módulo de origen y espera a que Contable lo tome.
const publicar = async (origen, tipo, contenido, { docIdGlobal = `T-${tipo}-${++k}`, docVersion = 1, secuencia = 1 } = {}) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await M.publicar(conn, { origen, destino: 'contable', tipo, docTipo: 'doc', docIdGlobal, docVersion, secuencia, contenido: { fecha: c.hoy, ...contenido } });
    await conn.commit();
  } finally { conn.release(); }
  M.despertar();
  await esperarMensajes(pool);
  return docIdGlobal;
};
const estadoMsg = async (doc) => (await pool.query("SELECT estado, motivo_rechazo FROM mensajes_integracion WHERE doc_id_global = ? AND modulo_destino = 'contable' ORDER BY id LIMIT 1", [doc]))[0][0];

test('Contable.RF03/RN11: el plan y las reglas incluyen las cuentas de las funciones activas (gift cards, vales, comisiones, remitos) al iniciar', async () => {
  const claves = new Set(c.cuentas.map((x) => x.clave));
  for (const k2 of ['gift_cards', 'vales', 'comisiones_a_pagar', 'comisiones_vendedores', 'remitos_a_facturar', 'vencimiento_saldos', 'costo_insumos', 'mermas']) assert.ok(claves.has(k2), k2);
  const forms = (await api('GET', '/api/contable/formularios', g())).json.map((f) => f.id);
  for (const f of ['emision_gift_card', 'comision_vendedor', 'remito_a_facturar', 'comprobante_compra', 'orden_pago', 'diferencia_caja', 'retencion_sufrida']) assert.ok(forms.includes(f), f);
});

test('Contable.RF03: la compra se registra al cargar la factura: gasto neto, IVA crédito y percepciones contra Proveedores', async () => {
  const doc = await publicar('compras', 'comprobante_compra', { comprobante_id_global: 'C-1', clase: 'FACTURA', tipo: 'A', neto_gravado: 1000, no_gravado: 0, exento: 0, iva: 210, iva_computable: 210, percepciones_iva: 30, percepciones_iibb: 20, impuestos_internos: 0, otros_tributos: 0, total: 1260, moneda: 'ARS' });
  const a = await c.asientoDe(doc);
  assert.ok(a, JSON.stringify(await estadoMsg(doc)));
  assert.equal(c.linea(a, 'compras', 'debe'), 1000);
  assert.equal(c.linea(a, 'iva_credito', 'debe'), 210);
  assert.equal(c.linea(a, 'retenciones_sufridas', 'debe'), 50);
  assert.equal(c.linea(a, 'proveedores', 'haber'), 1260);
  // La nota de crédito invierte las cuentas.
  const nc = await publicar('compras', 'comprobante_compra', { comprobante_id_global: 'C-2', clase: 'NOTA_CREDITO', tipo: 'A', neto_gravado: 100, iva: 21, iva_computable: 21, total: 121 });
  const n = await c.asientoDe(nc);
  assert.equal(c.linea(n, 'proveedores', 'debe'), 121);
  assert.equal(c.linea(n, 'compras', 'haber'), 100);
});

test('Contable.RN20/RN29: anular un comprobante de compra es un contraasiento a la fecha actual y no se aplica antes que el original', async () => {
  const doc = await publicar('compras', 'comprobante_compra', { comprobante_id_global: 'C-3', clase: 'FACTURA', tipo: 'B', neto_gravado: 500, iva: 0, iva_computable: 0, total: 500 }, { docIdGlobal: 'C-3' });
  const anul = await publicar('compras', 'comprobante_compra_anulado', { comprobante_id_global: 'C-3', motivo: 'Cargada dos veces' }, { docIdGlobal: 'C-3', docVersion: 2, secuencia: 2 });
  const origen = (await pool.query("SELECT asiento_id, tipo_documento FROM con_asiento_origen WHERE id_documento = 'C-3' ORDER BY id"))[0];
  assert.deepEqual(origen.map((o) => o.tipo_documento), ['comprobante_compra', 'comprobante_compra_anulado']);
  const contra = (await api('GET', `/api/contable/asientos/${origen[1].asiento_id}`, g())).json;
  assert.equal(c.linea(contra, 'proveedores', 'debe'), 500);
  assert.equal(c.linea(contra, 'compras', 'haber'), 500);
  assert.ok(anul && doc);
});

test('Contable.RF03: la orden de pago cancela la deuda con el proveedor contra los medios y las retenciones practicadas', async () => {
  const doc = await publicar('compras', 'orden_pago', { orden_id_global: 'OP-1', deuda_aplicada: 1000, retenciones: 100, medios: 900 }, { docIdGlobal: 'OP-1' });
  const a = await c.asientoDe(doc);
  assert.equal(c.linea(a, 'proveedores', 'debe'), 1000);
  assert.equal(c.linea(a, 'caja', 'haber'), 900);
  assert.equal(c.linea(a, 'retenciones_a_depositar', 'haber'), 100);
  await publicar('compras', 'orden_pago_anulada', { orden_id_global: 'OP-1', motivo: 'Error' }, { docIdGlobal: 'OP-1', docVersion: 3, secuencia: 3 });
  const [[{ n }]] = await pool.query("SELECT COUNT(DISTINCT asiento_id) n FROM con_asiento_origen WHERE id_documento = 'OP-1'");
  assert.equal(Number(n), 2);
});

test('Contable.RF03: la retención sufrida (Clientes) debita Retenciones sufridas contra Deudores', async () => {
  const doc = await publicar('clientes', 'retencion_sufrida', { recibo: 'R-1', importe: 75, impuesto: 'IIBB', nro_certificado: 'CERT1' });
  const a = await c.asientoDe(doc);
  assert.equal(c.linea(a, 'retenciones_sufridas', 'debe'), 75);
  assert.equal(c.linea(a, 'deudores', 'haber'), 75);
});

test('Contable.RF21/EX14: la diferencia de caja va a resultado y un nuevo cierre tras reabrir corrige solo el cambio', async () => {
  const falta = await publicar('financiero', 'cierre_turno', { turno_id_global: 'TU-1', caja: 'Caja 1', diferencia: -50, version: 1, fecha_ms: Date.now() }, { docIdGlobal: 'TU-1', docVersion: 1 });
  const a = await c.asientoDe(falta);
  assert.equal(c.linea(a, 'diferencias_caja', 'debe'), 50);
  assert.equal(c.linea(a, 'caja', 'haber'), 50);
  // Reapertura: sin asiento; el cierre nuevo con -20 devuelve 30 a la caja.
  const reab = await publicar('financiero', 'reapertura_turno', { turno_id_global: 'TU-1', motivo: 'Se encontró un billete', fecha_ms: Date.now() }, { docIdGlobal: 'TU-1', docVersion: 1001 });
  assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM con_asiento_origen WHERE tipo_documento = 'reapertura_turno'"))[0][0].n), 0); // la reapertura no es un asiento
  assert.equal((await pool.query("SELECT estado FROM mensajes_integracion WHERE tipo = 'reapertura_turno'"))[0][0].estado, 'confirmado');
  assert.ok(reab);
  const v2 = await publicar('financiero', 'cierre_turno', { turno_id_global: 'TU-1', caja: 'Caja 1', diferencia: -20, version: 2, fecha_ms: Date.now() }, { docIdGlobal: 'TU-1', docVersion: 2, secuencia: 2 });
  const [[o]] = await pool.query("SELECT asiento_id FROM con_asiento_origen WHERE id_documento = 'TU-1' AND tipo_documento = 'cierre_turno' ORDER BY id DESC LIMIT 1");
  const aj = (await api('GET', `/api/contable/asientos/${o.asiento_id}`, g())).json;
  assert.equal(c.linea(aj, 'caja', 'debe'), 30); // el faltante pasó de 50 a 20
  assert.equal(c.linea(aj, 'diferencias_caja', 'haber'), 30);
  assert.ok(v2);
});

test('Contable.RF25/RN22: la gift card es una deuda hasta el canje y no una venta; se cobra con la forma de pago de la venta', async () => {
  // La venta de la gift card (200) y de un producto (250) se pagaron 450 en efectivo: el exceso sobre el comprobante es de la gift card.
  const venta = 'V-GC-1';
  await publicar('ventas', 'venta_confirmada', { total: 450, pagos: [{ forma: 'efectivo', importe: 450 }], modalidad: 'salon',
    lineas_contables: [{ producto_id: 1, importe: 250, alicuota_iva: 21 }, { producto_id: 2, importe: 200, alicuota_iva: 0, gift_card: true }] }, { docIdGlobal: venta });
  const v = await c.asientoDe(venta);
  assert.equal(c.linea(v, 'caja', 'debe'), 250); // el cobro del comprobante no incluye la gift card
  assert.equal(c.linea(v, 'ventas_salon', 'haber'), 206.61);
  const gc = await publicar('clientes', 'pasivo_instrumento', { tipo: 'gift_card', codigo: 'LOCAL-GC-1', importe: 200, venta_id_global: venta }, { docIdGlobal: 'LOCAL-GC-1' });
  const a = await c.asientoDe(gc);
  assert.equal(c.linea(a, 'caja', 'debe'), 200);
  assert.equal(c.linea(a, 'gift_cards', 'haber'), 200);
  assert.equal(c.linea(a, 'ventas_salon', 'haber'), 0);
});

test('Contable.RF17: el canje con la forma «vale» cancela el pasivo de gift cards', async () => {
  const doc = await publicar('ventas', 'venta_confirmada', { total: 121, pagos: [{ forma: 'vale', importe: 121 }], modalidad: 'salon', lineas_contables: [{ producto_id: 1, importe: 121, alicuota_iva: 21 }] }, { docIdGlobal: 'V-CANJE' });
  const a = await c.asientoDe(doc);
  assert.equal(c.linea(a, 'gift_cards', 'debe'), 121);
  assert.equal(c.linea(a, 'deudores', 'haber'), 121);
});

test('Contable.RF18/RN23: la comisión de vendedores se devenga al liquidarse (gasto contra Comisiones a pagar)', async () => {
  const doc = await publicar('ventas', 'comision_liquidada', { liquidacion_id_global: 'LQ-1', total: 380, fecha_ms: Date.now() }, { docIdGlobal: 'LQ-1' });
  const a = await c.asientoDe(doc);
  assert.equal(c.linea(a, 'comisiones_vendedores', 'debe'), 380);
  assert.equal(c.linea(a, 'comisiones_a_pagar', 'haber'), 380);
});

test('Contable.RF24/RN35: un remito asignado a una cuenta es deuda y transitorio, no venta', async () => {
  const doc = await publicar('ventas', 'remito_emitido', { remito_id_global: 'RM-1', importe: 600 }, { docIdGlobal: 'RM-1' });
  const a = await c.asientoDe(doc);
  assert.equal(c.linea(a, 'deudores', 'debe'), 600);
  assert.equal(c.linea(a, 'remitos_a_facturar', 'haber'), 600);
  assert.equal(c.linea(a, 'ventas_salon', 'haber'), 0);
});

test('Contable.RF20/RN25: la merma de Stock se imputa a su cuenta de resultado (flujo real: egreso por merma)', async () => {
  const insumo = (await api('POST', '/api/insumos', { token: c.adm.token, body: { nombre: 'Leche', unidad: 'l' } })).json;
  assert.ok(insumo.id, JSON.stringify(insumo));
  assert.equal((await api('POST', '/api/stock/ingresos', { token: c.adm.token, body: { motivo: 'compra', lineas: [{ item: { tipo: 'insumo', id: insumo.id }, cantidad: 20, costo_unitario: 50 }] } })).status, 201);
  const e = await api('POST', '/api/stock/egresos', { token: c.adm.token, body: { motivo: 'merma_fin_dia', lineas: [{ item: { tipo: 'insumo', id: insumo.id }, cantidad: 4 }] } });
  assert.equal(e.status, 201, JSON.stringify(e.json));
  await esperarMensajes(pool);
  const a = await c.asientoDe(e.json.documento);
  assert.ok(a, 'falta el asiento de la merma');
  assert.equal(c.linea(a, 'mermas', 'debe'), 200);
  assert.equal(c.linea(a, 'insumos', 'haber'), 200);
});

test('Contable.RF03: el costo de ventas es el costo congelado en el descuento de Stock (flujo real: venta de un producto con costo)', async () => {
  const mesa = (await api('POST', '/api/mesas', { token: c.adm.token, body: { numero_mesa: 91, salon_id: 1 } })).json;
  const p = (await api('POST', '/api/productos', { token: c.adm.token, body: { nombre: 'Alfajor', precio: 300, stock: 0 } })).json;
  assert.equal((await api('POST', '/api/stock/ingresos', { token: c.adm.token, body: { motivo: 'compra', lineas: [{ item: { tipo: 'producto', id: p.id }, cantidad: 10, costo_unitario: 80 }] } })).status, 201);
  const pedido = (await api('POST', '/api/pedidos', { token: c.adm.token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token: c.adm.token, body: { productos: [{ producto_id: p.id, cantidad: 2 }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token: c.adm.token, headers: { 'X-ID-Solicitud': 'venta-costo-abcdef' }, body: { metodo_pago: 'efectivo' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await esperarMensajes(pool);
  const [[o]] = await pool.query("SELECT asiento_id FROM con_asiento_origen WHERE tipo_documento = 'costo_venta' AND id_documento = ?", [r.json.venta_id_global]);
  assert.ok(o, 'falta el asiento del costo');
  const a = (await api('GET', `/api/contable/asientos/${o.asiento_id}`, g())).json;
  assert.equal(c.linea(a, 'costo_insumos', 'debe'), 160);
  assert.equal(c.linea(a, 'insumos', 'haber'), 160);
});

test('Contable.RN31: un concepto sin módulo fuente no genera nada: sin Stock no hay costo, sin la función no hay formulario', async () => {
  // Una instancia sin un formulario disponible no ofrece reglas nuevas para él (RF03).
  await api('POST', '/api/funciones/cambiar', { token: c.adm.token, body: { desactivar: ['VEN-COMISIONES'], motivo: 'prueba' } });
  const forms = (await api('GET', '/api/contable/formularios', g())).json.map((f) => f.id);
  assert.ok(!forms.includes('comision_vendedor'));
  // Pero las reglas ya definidas se conservan para los documentos que traen la función en su instantánea (RN34).
  assert.ok((await api('GET', '/api/contable/reglas?formulario=comision_vendedor', g())).json.length >= 1);
});
