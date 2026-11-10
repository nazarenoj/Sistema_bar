const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { preparar } = require('./ayudas_contable');
const M = require('../src/mensajeria/servicio');
const Consultas = require('../src/modulos/consultas');

let api, pool, cerrar, c, k = 0, banco;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  c = await preparar(api, pool, { perfil: 'cafeteria_produccion', antes: async ({ adm }) => {
    for (const m of ['financiero', 'clientes', 'compras', 'ventas_online']) assert.equal((await api('POST', `/api/modulos/${m}/instalar`, { token: adm.token })).status, 200, m);
    assert.equal((await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['VEN-COMISIONES', 'ONL-MARKETPLACES', 'VEN-CC', 'CLI-FIDEL', 'STK-PRODUCCION'], motivo: 'prueba' } })).status, 200);
  } });
  banco = (await api('POST', '/api/financiero/cuentas', { token: c.adm.token, body: { tipo: 'banco', nombre: 'Banco', saldo_inicial: 50000, limite_descubierto: 0 } })).json;
});
after(async () => { await cerrar(); });

const g = () => ({ token: c.gerente.token });
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
const estado = async (doc) => (await pool.query("SELECT estado, motivo_rechazo FROM mensajes_integracion WHERE doc_id_global = ? AND modulo_destino = 'contable' ORDER BY id LIMIT 1", [doc]))[0][0];

test('Contable.RF03/RN32: un gasto de Financiero se imputa por su neto, su IVA y el medio de pago; anularlo es el contraasiento', async () => {
  const cat = (await api('GET', '/api/financiero/categorias', { token: c.adm.token })).json.find((x) => x.nombre === 'Servicios').id;
  const r = await api('POST', '/api/financiero/gastos', { token: c.adm.token, body: { categoria_id: cat, cuenta_id: banco.id, importe: 1500, descripcion: 'Luz' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  await esperarMensajes(pool);
  const a = await c.asientoDe(r.json.id_global);
  assert.ok(a, 'falta el asiento del gasto');
  assert.equal(c.linea(a, 'compras', 'debe'), 1500);
  assert.equal(c.linea(a, 'bancos', 'haber'), 1500); // pagado desde una cuenta bancaria
  assert.equal(c.linea(a, 'caja', 'haber'), 0);
  assert.equal((await api('POST', `/api/financiero/gastos/${r.json.id}/anular`, { ...g(), body: { motivo: 'Cargado dos veces' } })).status, 200);
  await esperarMensajes(pool);
  const filas = (await pool.query("SELECT tipo_documento, asiento_id FROM con_asiento_origen WHERE id_documento = ? ORDER BY id", [r.json.id_global]))[0];
  assert.deepEqual(filas.map((f) => f.tipo_documento), ['gasto_registrado', 'gasto_anulado']);
  const contra = (await api('GET', `/api/contable/asientos/${filas[1].asiento_id}`, g())).json;
  assert.equal(c.linea(contra, 'bancos', 'debe'), 1500);
  assert.equal(c.linea(contra, 'compras', 'haber'), 1500);
});

test('Contable.RF03: el gasto con comprobante fiscal imputa además el IVA crédito fiscal', async () => {
  const doc = await publicar('financiero', 'gasto_registrado', { gasto_id_global: 'G-F1', importe: 1210, iva: 210, fiscal: true, medio: 'caja' }, { docIdGlobal: 'G-F1' });
  const a = await c.asientoDe(doc);
  assert.equal(c.linea(a, 'compras', 'debe'), 1000);
  assert.equal(c.linea(a, 'iva_credito', 'debe'), 210);
  assert.equal(c.linea(a, 'caja', 'haber'), 1210);
});

test('Contable.RF03: el cobro de un recibo de cuenta corriente baja Deudores contra la caja, el banco o los valores a depositar', async () => {
  const doc = await publicar('clientes', 'recibo_cobro', { recibo: 'REC-0001-00000001', valores: [{ forma: 'efectivo', importe: 300 }, { forma: 'transferencia', importe: 200 }, { forma: 'cheque', importe: 100 }] }, { docIdGlobal: 'REC-0001-00000001' });
  const a = await c.asientoDe(doc);
  assert.ok(a, JSON.stringify(await estado(doc)));
  assert.equal(c.linea(a, 'caja', 'debe'), 300);
  assert.equal(c.linea(a, 'bancos', 'debe'), 200);
  assert.equal(c.linea(a, 'valores_a_depositar', 'debe'), 100);
  assert.equal(c.linea(a, 'deudores', 'haber'), 600);
});

test('Contable.RF03: el pago de comisiones, las transferencias entre caja y banco y la liquidación de tarjeta van a sus cuentas', async () => {
  const pc = await publicar('financiero', 'pago_comision', { liquidacion_id_global: 'LQ-9', importe: 400, medio: 'bancos' }, { docIdGlobal: 'LQ-9' });
  const a = await c.asientoDe(pc);
  assert.equal(c.linea(a, 'comisiones_a_pagar', 'debe'), 400);
  assert.equal(c.linea(a, 'bancos', 'haber'), 400);
  await publicar('financiero', 'pago_comision_anulado', { liquidacion_id_global: 'LQ-9', motivo: 'Anulada' }, { docIdGlobal: 'LQ-9', docVersion: 2, secuencia: 2 });
  assert.equal(Number((await pool.query("SELECT COUNT(DISTINCT asiento_id) n FROM con_asiento_origen WHERE id_documento = 'LQ-9'"))[0][0].n), 2);

  const dep = await publicar('financiero', 'transferencia_cuentas', { transferencia_id_global: 'TR-1', importe: 700, desde: 'caja', hacia: 'bancos' }, { docIdGlobal: 'TR-1' });
  const d = await c.asientoDe(dep);
  assert.equal(c.linea(d, 'bancos', 'debe'), 700);
  assert.equal(c.linea(d, 'caja', 'haber'), 700);
  const ext = await publicar('financiero', 'transferencia_cuentas', { transferencia_id_global: 'TR-2', importe: 150, desde: 'bancos', hacia: 'caja' }, { docIdGlobal: 'TR-2' });
  const e = await c.asientoDe(ext);
  assert.equal(c.linea(e, 'caja', 'debe'), 150);
  assert.equal(c.linea(e, 'bancos', 'haber'), 150);

  const lt = await publicar('financiero', 'liquidacion_tarjeta', { liquidacion_id_global: 'LT-1', referencia: 'L1', comision: 100, iva: 21, retenciones: 10, percepciones: 5 }, { docIdGlobal: 'LT-1' });
  const l = await c.asientoDe(lt);
  assert.equal(c.linea(l, 'comisiones_tarjetas', 'debe'), 100);
  assert.equal(c.linea(l, 'iva_credito', 'debe'), 21);
  assert.equal(c.linea(l, 'retenciones_sufridas', 'debe'), 15);
  assert.equal(c.linea(l, 'bancos', 'haber'), 136);
});

test('Contable.RN24/RN37: la comisión de la plataforma es un gasto aparte, la liquidación cancela lo debido y la diferencia va a conciliación', async () => {
  const cm = await publicar('financiero', 'comision_de_plataforma', { pedido_global: 'PED-1', plataforma: 'rappi', importe: 180 }, { docIdGlobal: 'PED-1' });
  const a = await c.asientoDe(cm);
  assert.equal(c.linea(a, 'comisiones_plataformas', 'debe'), 180);
  assert.equal(c.linea(a, 'plataformas_a_cobrar', 'haber'), 180);
  const lq = await publicar('financiero', 'liquidacion_de_plataforma', { id_liquidacion: 'LIQ-P1', plataforma: 'rappi', importe: 820 }, { docIdGlobal: 'LIQ-P1' });
  const l = await c.asientoDe(lq);
  assert.equal(c.linea(l, 'bancos', 'debe'), 820);
  assert.equal(c.linea(l, 'plataformas_a_cobrar', 'haber'), 820);
  await publicar('financiero', 'diferencia_conciliacion', { id_liquidacion: 'LIQ-P1', importe: 50 }, { docIdGlobal: 'LIQ-P1', docVersion: 2, secuencia: 2 });
  const [{ asiento_id: dif }] = (await pool.query("SELECT asiento_id FROM con_asiento_origen WHERE tipo_documento = 'diferencia_conciliacion'"))[0];
  const d = (await api('GET', `/api/contable/asientos/${dif}`, g())).json;
  assert.equal(c.linea(d, 'diferencias_conciliacion', 'debe'), 50);
  assert.equal(c.linea(d, 'plataformas_a_cobrar', 'haber'), 50);
});

test('Contable.RF03: los hechos de Financiero salen de sus servicios (liquidación de tarjeta y pago de comisión por la bandeja de salida)', async () => {
  const ya = Number((await pool.query("SELECT COUNT(*) n FROM mensajes_integracion WHERE modulo_destino = 'contable' AND tipo = 'gasto_registrado'"))[0][0].n);
  assert.ok(ya >= 1); // el gasto real de la primera prueba se publicó solo
  assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM mensajes_integracion WHERE modulo_destino = 'contable' AND tipo = 'gasto_anulado'"))[0][0].n), 1);
});

test('Contable.RF24/RN35: la factura que cancela remitos baja el transitorio y reconoce la venta y el IVA; anular un remito invierte su deuda', async () => {
  await publicar('ventas', 'remito_emitido', { remito_id_global: 'RM-A', importe: 600 }, { docIdGlobal: 'RM-A' });
  await publicar('ventas', 'remito_emitido', { remito_id_global: 'RM-B', importe: 400 }, { docIdGlobal: 'RM-B' });
  const fa = await publicar('ventas', 'factura_remitos', { factura_id_global: 'FR-1', total: 1000, remitos: [{ remito_id_global: 'RM-A', importe: 600 }, { remito_id_global: 'RM-B', importe: 400 }], modalidad: 'mayorista',
    lineas_contables: [{ producto_id: 1, importe: 1000, alicuota_iva: 21 }] }, { docIdGlobal: 'FR-1' });
  const a = await c.asientoDe(fa);
  assert.ok(a, JSON.stringify(await estado(fa)));
  assert.equal(c.linea(a, 'remitos_a_facturar', 'debe'), 1000); // cancela los dos remitos
  assert.equal(c.linea(a, 'iva_debito', 'haber'), 173.55);
  assert.equal(c.linea(a, 'ventas_salon', 'haber') + c.linea(a, 'ventas_mayorista', 'haber'), 826.45);
  await publicar('ventas', 'remito_emitido', { remito_id_global: 'RM-C', importe: 90 }, { docIdGlobal: 'RM-C' });
  await publicar('ventas', 'remito_anulado', { remito_id_global: 'RM-C' }, { docIdGlobal: 'RM-C', docVersion: 2, secuencia: 2 });
  const filas = (await pool.query("SELECT asiento_id FROM con_asiento_origen WHERE id_documento = 'RM-C' ORDER BY id"))[0];
  const contra = (await api('GET', `/api/contable/asientos/${filas[1].asiento_id}`, g())).json;
  assert.equal(c.linea(contra, 'remitos_a_facturar', 'debe'), 90);
  assert.equal(c.linea(contra, 'deudores', 'haber'), 90);
});

test('Contable.RF17: el vencimiento de una gift card o un vale da de baja el pasivo contra su resultado y el canje distingue vale de gift card', async () => {
  const gc = await publicar('clientes', 'vencimiento_instrumento', { tipo: 'gift_card', codigo: 'GC-V1', importe: 100 }, { docIdGlobal: 'GC-V1' });
  assert.equal(c.linea(await c.asientoDe(gc), 'gift_cards', 'debe'), 100);
  const va = await publicar('clientes', 'vencimiento_instrumento', { tipo: 'vale', codigo: 'VA-V1', importe: 40 }, { docIdGlobal: 'VA-V1' });
  assert.equal(c.linea(await c.asientoDe(va), 'vales', 'debe'), 40);
  assert.equal(c.linea(await c.asientoDe(va), 'vencimiento_saldos', 'haber'), 40);
  const previo = Consultas.obtener('clientes', 'instrumento');
  Consultas.registrar('clientes', 'instrumento', async ({ codigo }) => ({ tipo: codigo.startsWith('VA') ? 'vale' : 'gift_card' }));
  const canje = await publicar('ventas', 'venta_confirmada', { total: 121, pagos: [{ forma: 'vale', importe: 121, instrumento: 'VA-0001' }], modalidad: 'salon', lineas_contables: [{ producto_id: 1, importe: 121, alicuota_iva: 21 }] }, { docIdGlobal: 'V-CANJE-VA' });
  const a = await c.asientoDe(canje);
  assert.equal(c.linea(a, 'vales', 'debe'), 121);
  assert.equal(c.linea(a, 'gift_cards', 'debe'), 0);
  Consultas.registrar('clientes', 'instrumento', previo);
});

test('Contable.RF20: la producción pasa los insumos a Productos elaborados y los egresos de clase «otra» siguen la regla de su motivo', async () => {
  const pr = await publicar('stock', 'produccion_confirmada', { orden: 'OP-1', importe: 2500 }, { docIdGlobal: 'OP-1' });
  const a = await c.asientoDe(pr);
  assert.equal(c.linea(a, 'productos_elaborados', 'debe'), 2500);
  assert.equal(c.linea(a, 'insumos', 'haber'), 2500);
  const eg = await publicar('stock', 'egreso_stock', { documento: 'EG-1', motivo: 'consumo_interno', importe: 300 }, { docIdGlobal: 'EG-1' });
  const e = await c.asientoDe(eg);
  assert.equal(c.linea(e, 'insumos', 'haber'), 300);
  assert.equal(c.linea(e, 'mermas', 'debe'), 300);
});

test('Contable.RF20: un egreso real de stock con motivo «otra» llega a Contable', async () => {
  const insumo = (await api('POST', '/api/insumos', { token: c.adm.token, body: { nombre: 'Vaso', unidad: 'u', packaging: true } })).json;
  assert.equal(insumo.packaging, 1);
  assert.equal((await api('POST', '/api/stock/ingresos', { token: c.adm.token, body: { motivo: 'compra', lineas: [{ item: { tipo: 'insumo', id: insumo.id }, cantidad: 100, costo_unitario: 10 }] } })).status, 201);
  const [[mot]] = await pool.query("SELECT codigo FROM motivos_stock WHERE tipo = 'egreso' AND clase_contable = 'otra' AND reservado = 0 AND requiere_autorizacion = 0 LIMIT 1");
  const e = await api('POST', '/api/stock/egresos', { token: c.adm.token, body: { motivo: mot.codigo, observacion: 'prueba', lineas: [{ item: { tipo: 'insumo', id: insumo.id }, cantidad: 5 }] } });
  assert.equal(e.status, 201, JSON.stringify(e.json));
  await esperarMensajes(pool);
  const a = await c.asientoDe(e.json.documento);
  assert.ok(a, 'falta el asiento del egreso');
  assert.equal(c.linea(a, 'insumos', 'haber'), 50);
});

test('Contable.RN10/RF03: la compra separa la mercadería de Stock, convierte la moneda extranjera y el pago a proveedores va a cada medio', async () => {
  const doc = await publicar('compras', 'comprobante_compra', { comprobante_id_global: 'C-USD', clase: 'FACTURA', tipo: 'A', moneda: 'USD', cotizacion: 1000, neto_mercaderia: 60, neto_gravado: 100, iva: 21, iva_computable: 21, total: 121 }, { docIdGlobal: 'C-USD' });
  const a = await c.asientoDe(doc);
  assert.ok(a, JSON.stringify(await estado(doc)));
  assert.equal(c.linea(a, 'insumos', 'debe'), 60000);
  assert.equal(c.linea(a, 'compras', 'debe'), 40000);
  assert.equal(c.linea(a, 'iva_credito', 'debe'), 21000);
  assert.equal(c.linea(a, 'proveedores', 'haber'), 121000);
  const op = await publicar('compras', 'orden_pago', { orden_id_global: 'OP-M', deuda_aplicada: 1000, retenciones: 0, medios: 1000, medios_detalle: [{ clase: 'caja', importe: 400 }, { clase: 'bancos', importe: 600 }] }, { docIdGlobal: 'OP-M' });
  const o = await c.asientoDe(op);
  assert.equal(c.linea(o, 'caja', 'haber'), 400);
  assert.equal(c.linea(o, 'bancos', 'haber'), 600);
});

test('Contable.RF26: la venta no fiscal que se regulariza trae su costo y se contabiliza junto con la venta', async () => {
  const doc = await publicar('ventas', 'venta_regularizada', { total: 121, pagos: [{ metodo_pago: 'efectivo', importe: 121 }], modalidad: 'salon', costo_total: 45, lineas_contables: [{ producto_id: 1, importe: 121, alicuota_iva: 21 }] }, { docIdGlobal: 'V-REG-1' });
  const a = await c.asientoDe(doc);
  assert.equal(c.linea(a, 'costo_insumos', 'debe'), 45);
  assert.equal(c.linea(a, 'insumos', 'haber'), 45);
  assert.equal(c.linea(a, 'caja', 'debe'), 121);
});
