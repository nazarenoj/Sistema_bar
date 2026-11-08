const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp } = require('./ayudas');
const { preparar } = require('./ayudas_contable');

let api, pool, cerrar, c, k = 0;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  c = await preparar(api, pool);
  // Movimientos: dos ventas (una con tarjeta), una devolución, un aporte y un gasto manual.
  const a = await c.vender('efectivo');
  await c.vender('tarjeta_debito');
  const { esperarMensajes } = require('./ayudas');
  const r = await api('POST', '/api/devoluciones', { token: c.adm.token, headers: { 'X-ID-Solicitud': `devol-${++k}-abcdef` }, body: { venta_id_global: a, motivo: 'el cliente se arrepintió', items: [{ linea: 0, cantidad: 1 }] } });
  assert.equal(r.status, 201);
  await esperarMensajes(pool);
  for (const [leyenda, lineas] of [['Aporte', [{ cuenta_id: c.clave('caja').id, debe: 1000 }, { cuenta_id: c.clave('capital').id, haber: 1000 }]], ['Compra de café', [{ cuenta_id: c.clave('compras').id, debe: 300 }, { cuenta_id: c.clave('caja').id, haber: 300 }]]])
    assert.equal((await api('POST', '/api/contable/asientos-manuales', { token: c.gerente.token, headers: { 'X-ID-Solicitud': `man-${++k}-abcdefgh` }, body: { fecha: c.hoy, leyenda, lineas } })).status, 201);
});
after(async () => { await cerrar(); });

const g = () => ({ token: c.gerente.token });

test('Contable.RF06: el diario lista los asientos del período con numeración correlativa y debe = haber', async () => {
  const d = (await api('GET', `/api/contable/libros/diario?periodo=${c.hoy.slice(0, 7)}`, g())).json;
  assert.ok(d.asientos.length >= 5);
  assert.deepEqual(d.asientos.map((a) => a.numero), d.asientos.map((_, i) => i + 1)); // sin saltos
  assert.equal(d.total_debe, d.total_haber);
  assert.ok(d.asientos.every((a) => a.lineas.reduce((s, l) => s + l.debe, 0).toFixed(2) === a.lineas.reduce((s, l) => s + l.haber, 0).toFixed(2)));
  assert.equal((await api('GET', '/api/contable/libros/diario?desde=2020-01-01&hasta=2020-01-31', g())).json.asientos.length, 0);
  assert.equal((await api('GET', '/api/contable/libros/diario?periodo=2026', g())).status, 400);
});

test('Contable.RF07: el mayor muestra saldo inicial, movimientos y saldo acumulado, con el asiento y el documento de origen', async () => {
  const caja = c.clave('caja');
  const m = (await api('GET', `/api/contable/libros/mayor?cuenta_id=${caja.id}&periodo=${c.hoy.slice(0, 7)}`, g())).json;
  assert.equal(m.saldo_inicial, 0);
  assert.ok(m.movimientos.length >= 4);
  // El saldo acumulado de cada línea es el anterior más debe menos haber (la caja es de activo).
  let esperado = m.saldo_inicial;
  for (const mv of m.movimientos) { esperado = Math.round((esperado + mv.debe - mv.haber) * 100) / 100; assert.equal(mv.saldo, esperado); }
  assert.equal(m.saldo_final, esperado);
  // Efectivo: 250 de la venta - 100 devueltos + 1000 de aporte - 300 de compra.
  assert.equal(m.saldo_final, 850);
  const deVenta = m.movimientos.find((mv) => mv.origen?.modulo === 'ventas');
  assert.ok(deVenta.origen.id_documento && deVenta.asiento_id);
  assert.equal(m.movimientos.find((mv) => !mv.origen).origen, null); // los manuales no tienen documento
  // Un saldo inicial aparece cuando el mayor empieza más tarde.
  const manana = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const despues = (await api('GET', `/api/contable/libros/mayor?cuenta_id=${caja.id}&desde=${manana}&hasta=9999-12-31`, g())).json;
  assert.equal(despues.saldo_inicial, 850);
  assert.equal(despues.movimientos.length, 0);
  assert.equal((await api('GET', '/api/contable/libros/mayor', g())).status, 400);
  assert.equal((await api('GET', '/api/contable/libros/mayor?cuenta_id=99999', g())).status, 404);
});

test('Contable.RF07: el mayor de un rubro suma las cuentas de su rama y el de una cuenta de pasivo crece por el haber', async () => {
  const activoCorriente = c.cuentas.find((x) => x.codigo === '1.1');
  const rubro = (await api('GET', `/api/contable/libros/mayor?cuenta_id=${activoCorriente.id}&periodo=${c.hoy.slice(0, 7)}`, g())).json;
  const caja = (await api('GET', `/api/contable/libros/mayor?cuenta_id=${c.clave('caja').id}&periodo=${c.hoy.slice(0, 7)}`, g())).json;
  const bancos = (await api('GET', `/api/contable/libros/mayor?cuenta_id=${c.clave('bancos').id}&periodo=${c.hoy.slice(0, 7)}`, g())).json;
  assert.ok(rubro.saldo_final >= caja.saldo_final + bancos.saldo_final - 0.001);
  const iva = (await api('GET', `/api/contable/libros/mayor?cuenta_id=${c.clave('iva_debito').id}&periodo=${c.hoy.slice(0, 7)}`, g())).json;
  assert.equal(iva.saldo_final, Math.round((iva.total_haber - iva.total_debe) * 100) / 100); // pasivo: saldo acreedor positivo
});

test('Contable.RF08: el balance de sumas y saldos suma cero (debe = haber y saldos deudores = acreedores) y concilia con el diario', async () => {
  const b = (await api('GET', `/api/contable/libros/balance?periodo=${c.hoy.slice(0, 7)}`, g())).json;
  assert.equal(b.cuadra, true);
  assert.equal(b.totales.debe_acum, b.totales.haber_acum);
  assert.equal(b.totales.saldo_deudor, b.totales.saldo_acreedor);
  const d = (await api('GET', `/api/contable/libros/diario?periodo=${c.hoy.slice(0, 7)}`, g())).json;
  assert.equal(b.totales.debe, d.total_debe);
  assert.equal(b.totales.haber, d.total_haber);
  // El mayor concilia con el balance cuenta por cuenta.
  const caja = b.filas.find((f) => f.cuenta_id === c.clave('caja').id);
  const m = (await api('GET', `/api/contable/libros/mayor?cuenta_id=${caja.cuenta_id}&periodo=${c.hoy.slice(0, 7)}`, g())).json;
  assert.equal(caja.saldo_deudor, m.saldo_final);
  assert.equal(caja.debe, m.total_debe);
});

test('Contable.RF08: el balance se arma por nivel de cuenta y compara entre períodos', async () => {
  const n1 = (await api('GET', `/api/contable/libros/balance?periodo=${c.hoy.slice(0, 7)}&nivel=1`, g())).json;
  assert.ok(n1.filas.length >= 3 && n1.filas.length <= 5); // activo, pasivo, patrimonio, ingresos, gastos
  assert.deepEqual(n1.filas.map((f) => f.codigo).every((x) => !x.includes('.')), true);
  assert.equal(n1.cuadra, true);
  const n3 = (await api('GET', `/api/contable/libros/balance?periodo=${c.hoy.slice(0, 7)}`, g())).json;
  assert.equal(n3.totales.debe_acum, n1.totales.debe_acum); // el nivel no cambia los totales
  const ant = new Date(); ant.setMonth(ant.getMonth() - 1);
  const comp = (await api('GET', `/api/contable/libros/balance?periodo=${c.hoy.slice(0, 7)}&comparar_periodo=${ant.toISOString().slice(0, 7)}`, g())).json;
  assert.ok(comp.comparacion);
  const caja = comp.filas.find((f) => f.cuenta_id === c.clave('caja').id);
  assert.equal(caja.saldo_comparado, 0);
  assert.equal(caja.diferencia, caja.saldo_deudor);
});

test('Contable.RF06: exportar el diario, el mayor y el balance exige el permiso de exportar y queda auditado', async () => {
  const csv = await api('GET', `/api/contable/libros/balance?periodo=${c.hoy.slice(0, 7)}&formato=csv`, g());
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /sumas-y-saldos\.csv/);
  assert.equal((await api('GET', `/api/contable/libros/diario?periodo=${c.hoy.slice(0, 7)}&formato=xlsx`, g())).status, 200);
  assert.equal((await api('GET', `/api/contable/libros/diario?periodo=${c.hoy.slice(0, 7)}&formato=zip`, g())).status, 400);
  // Un rol que ve pero no exporta (administrativo ve el libro, no lo descarga).
  const { usuario } = require('./ayudas_financiero');
  const adm2 = await usuario(api, pool, 'admin2', 'administrativo');
  assert.equal((await api('GET', `/api/contable/libros/diario?periodo=${c.hoy.slice(0, 7)}`, { token: adm2.token })).status, 200);
  assert.equal((await api('GET', `/api/contable/libros/diario?periodo=${c.hoy.slice(0, 7)}&formato=csv`, { token: adm2.token })).status, 403);
  const [[a]] = await pool.query("SELECT COUNT(*) n FROM auditoria WHERE modulo = 'contable' AND accion = 'exportar'");
  assert.ok(Number(a.n) >= 2);
});
