const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { preparar } = require('./ayudas_contable');
const Monedas = require('../src/servicios/monedaService');

// Contable RN10: cada caja o cuenta en divisa de Financiero tiene su cuenta contable con importe en divisa y cotización; las operaciones de compra y venta de moneda se contabilizan.
let api, pool, cerrar, c, banco, usd, k = 0;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  c = await preparar(api, pool, { antes: async ({ adm }) => {
    assert.equal((await api('POST', '/api/modulos/financiero/instalar', { token: adm.token })).status, 200);
    assert.equal((await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['FIN-MONEDA-EXT'], motivo: 'prueba' } })).status, 200);
    await Monedas.cargar({ moneda: 'USD', comprador: 1000, vendedor: 1010 });
    banco = (await api('POST', '/api/financiero/cuentas', { token: adm.token, body: { tipo: 'banco', nombre: 'Banco pesos', saldo_inicial: 500000, limite_descubierto: 0 } })).json;
    usd = (await api('POST', '/api/financiero/cuentas', { token: adm.token, body: { tipo: 'banco', nombre: 'Banco USD', moneda: 'USD', saldo_inicial: 100 } })).json;
    assert.ok(usd.id_global, JSON.stringify(usd));
  } });
});
after(async () => { await cerrar(); });

const g = () => ({ token: c.gerente.token });
const sol = () => ({ 'X-ID-Solicitud': `div-${++k}-${Math.random().toString(36).slice(2, 10)}` });
const cuentaUsd = async () => (await api('GET', '/api/contable/cuentas', g())).json.find((x) => x.clave === `fin:${usd.id_global}`);
const lineaDe = (a, id, lado) => a.lineas.filter((l) => l.cuenta_id === id).reduce((s, l) => s + l[lado], 0);
const ultimoAsiento = async (tipoDoc) => {
  const [[o]] = await pool.query('SELECT asiento_id FROM con_asiento_origen WHERE tipo_documento = ? ORDER BY id DESC LIMIT 1', [tipoDoc]);
  return o ? (await api('GET', `/api/contable/asientos/${o.asiento_id}`, g())).json : null;
};

test('Contable.RN10: al iniciar, la caja o cuenta en divisa que ya existía tiene su cuenta contable en esa moneda', async () => {
  const cta = await cuentaUsd();
  assert.ok(cta, 'falta la cuenta contable');
  assert.deepEqual([cta.moneda, cta.tipo, cta.imputable, cta.codigo], ['USD', 'activo', true, '1.2.01']);
  assert.match(cta.nombre, /Banco USD \(USD\)/);
  // Una caja en divisa creada después también obtiene la suya, por el evento de Financiero.
  const otra = (await api('POST', '/api/financiero/cuentas', { token: c.adm.token, body: { tipo: 'banco', nombre: 'Caja de ahorro EUR', moneda: 'EUR', saldo_inicial: 0 } })).json;
  await esperarMensajes(pool);
  const cuentas = (await api('GET', '/api/contable/cuentas', g())).json;
  assert.ok(cuentas.some((x) => x.clave === `fin:${otra.id_global}` && x.moneda === 'EUR' && x.codigo === '1.2.02'));
});

test('Contable.RF13/RN10: el asiento de apertura propone el saldo en divisa a la cotización de hoy, con su importe en divisa', async () => {
  const p = (await api('GET', '/api/contable/apertura', g())).json;
  const cta = await cuentaUsd();
  const l = p.lineas.find((x) => x.cuenta_id === cta.id);
  assert.equal(l.debe, 100000); // 100 USD x 1000 (comprador)
  assert.equal(l.importe_divisa, 100);
  assert.equal(p.lineas.find((x) => x.cuenta_id === c.clave('bancos').id).debe, 500000);
  const ok = await api('POST', '/api/contable/apertura', { ...g(), headers: sol(), body: { lineas: p.lineas } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const [[g1]] = await pool.query('SELECT importe_divisa, cotizacion FROM con_asiento_lineas WHERE cuenta_id = ?', [cta.id]);
  assert.deepEqual([Number(g1.importe_divisa), Number(g1.cotizacion)], [100, 1000]);
});

test('Contable.RN10: la compra de divisas sube la cuenta en divisa por lo pagado y la venta la baja por su costo, con la diferencia de cambio a resultado', async () => {
  const cta = await cuentaUsd();
  const compra = await api('POST', '/api/financiero/divisas/operaciones', { token: c.adm.token, body: { tipo: 'compra', origen_id: banco.id, destino_id: usd.id, importe_divisa: 50, cotizacion: 1010, motivo: 'Compra de dólares' } });
  assert.equal(compra.status, 201, JSON.stringify(compra.json));
  await esperarMensajes(pool);
  const a = await ultimoAsiento('operacion_divisa');
  assert.ok(a, 'falta el asiento de la compra');
  assert.equal(lineaDe(a, cta.id, 'debe'), 50500);
  assert.equal(lineaDe(a, c.clave('bancos').id, 'haber'), 50500);
  // Venta de 30 USD a 1005: el costo promedio es (100000 + 50500) / 150 = 1003,33 por dólar.
  const venta = await api('POST', '/api/financiero/divisas/operaciones', { token: c.adm.token, body: { tipo: 'venta', origen_id: usd.id, destino_id: banco.id, importe_divisa: 30, cotizacion: 1005, motivo: 'Venta de dólares' } });
  assert.equal(venta.status, 201, JSON.stringify(venta.json));
  await esperarMensajes(pool);
  const v = (await pool.query("SELECT a.id FROM con_asientos a JOIN con_asiento_origen o ON o.asiento_id = a.id WHERE o.tipo_documento = 'operacion_divisa' ORDER BY o.id DESC LIMIT 1"))[0][0];
  const av = (await api('GET', `/api/contable/asientos/${v.id}`, g())).json;
  assert.equal(lineaDe(av, c.clave('bancos').id, 'debe'), 30150);
  assert.equal(lineaDe(av, cta.id, 'haber'), 30100);
  assert.equal(lineaDe(av, c.clave('diferencias_cambio_pos').id, 'haber'), 50); // ganancia por diferencia de cambio
  const [[lin]] = await pool.query('SELECT importe_divisa FROM con_asiento_lineas WHERE asiento_id = ? AND cuenta_id = ?', [v.id, cta.id]);
  assert.equal(Number(lin.importe_divisa), 30);
});

test('Contable.RF11: el control cruzado de divisas compara el saldo en divisa de cada moneda con el de Financiero', async () => {
  assert.equal((await api('PUT', '/api/contable/config', { ...g(), body: {} })).status, 200);
  const r = (await api('POST', '/api/contable/controles/ejecutar', { ...g(), body: {} })).json;
  const d = r.controles.find((x) => x.id === 'divisas:USD');
  assert.ok(d, JSON.stringify(r.controles.map((x) => x.id)));
  assert.deepEqual([d.estado, d.saldo_contable, d.saldo_modulo], ['ok', 120, 120]); // 100 + 50 - 30
});

test('Contable.RF09: la revaluación toma la cuenta en divisa creada por Financiero', async () => {
  assert.equal((await api('POST', '/api/funciones/cambiar', { token: c.adm.token, body: { activar: ['CON-REVALUACION'], motivo: 'prueba' } })).status, 200);
  const p = (await api('GET', `/api/contable/revaluacion?periodo=${c.hoy.slice(0, 7)}`, g())).json;
  const cta = await cuentaUsd();
  const l = p.lineas.find((x) => x.cuenta_id === cta.id);
  assert.ok(l, 'la cuenta en divisa no se revalúa');
  assert.equal(l.saldo_revaluado, 120000); // 120 USD x 1000 (comprador)
});
