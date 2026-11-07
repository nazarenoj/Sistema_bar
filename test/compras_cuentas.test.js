process.env.AFIP_CONDICION_IVA_EMISOR = 'responsable_inscripto';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const Vencimientos = require('../src/compras/vencimientoService');

let api, pool, cerrar, adm, gerente, administrativo, prov, prov2, k = 0;
const CUIT = '30711111111', CUIT2 = '20123456786';
const hoyMas = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  await api('POST', '/api/modulos/compras/instalar', { token: adm.token });
  await api('POST', '/api/modulos/financiero/instalar', { token: adm.token });
  prov = (await api('POST', '/api/compras/proveedores', { token: administrativo.token, body: { cuit: CUIT, razon_social: 'Tostadores del Sur SA', condicion_pago_dias: 30, consultar_arca: false } })).json;
  prov2 = (await api('POST', '/api/compras/proveedores', { token: administrativo.token, body: { cuit: CUIT2, razon_social: 'Lácteos del Valle', condicion_pago_dias: 0, consultar_arca: false } })).json;
});
after(async () => { await cerrar(); });

// Una factura de `neto` + 21% de IVA; el número y las fechas distintos evitan que dos cargas parezcan la misma.
const comp = (neto, b = {}, t = administrativo) => api('POST', '/api/compras/comprobantes', { token: t.token, body: {
  cuit: CUIT, clase: 'FACTURA', tipo: 'A', punto_venta: 1, numero: String(++k), fecha: hoyMas(-1), alicuotas: [{ alicuota: 21, neto, iva: Math.round(neto * 21) / 100 }], total: Math.round(neto * 121) / 100, ...b } });
const cuenta = async (id = prov.id, q = '') => (await api('GET', `/api/compras/proveedores/${id}/cuenta${q}`, { token: gerente.token })).json;

test('Compras.RF05: un comprobante tiene una cuota a la condición de pago del proveedor o las cuotas que se indican, que tienen que sumar el total; una nota de crédito no vence', async () => {
  const f = await comp(1000, { fecha: hoyMas(-10) });
  assert.equal(f.status, 201, JSON.stringify(f.json));
  const v = (await api('GET', `/api/compras/vencimientos?proveedor_id=${prov.id}`, { token: gerente.token })).json;
  assert.equal(v.length, 1);
  assert.deepEqual([v[0].fecha, v[0].importe, v[0].saldo, v[0].cuota], [hoyMas(20), 1210, 1210, 1]); // 10 días atrás + 30 de plazo
  const mal = await comp(1000, { vencimientos: [{ fecha: hoyMas(5), importe: 600 }, { fecha: hoyMas(35), importe: 500 }] });
  assert.equal(mal.status, 400);
  assert.equal(mal.json.codigo, 'CUOTAS_NO_SUMAN');
  assert.equal((await comp(1001, { vencimientos: [{ fecha: '05/11/2026', importe: 1211.21 }] })).status, 400);
  assert.equal((await comp(1002, { vencimientos: [{ fecha: hoyMas(5), importe: 0 }] })).status, 400);
  const cuotas = await comp(2000, { vencimientos: [{ fecha: hoyMas(5), importe: 1210 }, { fecha: hoyMas(35), importe: 1210 }] });
  assert.equal(cuotas.status, 201, JSON.stringify(cuotas.json));
  const vc = (await api('GET', `/api/compras/vencimientos?comprobante_id=${cuotas.json.id}`, { token: gerente.token })).json;
  assert.deepEqual(vc.map((x) => [x.cuota, x.importe]), [[1, 1210], [2, 1210]]);
  const nc = await comp(300, { clase: 'NOTA_CREDITO', tipo: 'A' });
  assert.equal(nc.status, 201);
  assert.equal((await api('GET', `/api/compras/vencimientos?comprobante_id=${nc.json.id}`, { token: gerente.token })).json.length, 0);
  // Sin condición de pago vence el día de la fecha.
  const contado = await comp(100, { cuit: CUIT2, fecha: hoyMas(-3) });
  assert.equal((await api('GET', `/api/compras/vencimientos?proveedor_id=${prov2.id}`, { token: gerente.token })).json[0].fecha, hoyMas(-3));
  assert.equal(contado.status, 201);
});

test('Compras.RF05: las cuotas se cambian mientras no tengan pagos; la agenda se filtra y marca lo vencido', async () => {
  const f = (await comp(500, { fecha: hoyMas(0) })).json;
  const put = (b, t = administrativo) => api('PUT', `/api/compras/comprobantes/${f.id}/vencimientos`, { token: t.token, body: b });
  assert.equal((await put({ vencimientos: [{ fecha: hoyMas(10), importe: 100 }] })).status, 400); // no suman
  assert.equal((await put({ vencimientos: [{ fecha: hoyMas(10), importe: 300 }, { fecha: hoyMas(20), importe: 305 }] }, { token: (await usuario(api, pool, 'cami', 'cajero')).token })).status, 403);
  const ok = await put({ vencimientos: [{ fecha: hoyMas(10), importe: 300 }, { fecha: hoyMas(20), importe: 305 }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.map((c) => [c.cuota, c.importe]), [[1, 300], [2, 305]]);
  await pool.query('UPDATE cmp_vencimientos SET saldo = 100 WHERE comprobante_id = ? AND cuota = 1', [f.id]); // un pago aplicado (H5)
  const bloq = await put({ vencimientos: [{ fecha: hoyMas(15), importe: 605 }] });
  assert.equal(bloq.status, 409);
  assert.equal(bloq.json.codigo, 'CON_PAGOS');
  await pool.query('UPDATE cmp_vencimientos SET saldo = importe WHERE comprobante_id = ?', [f.id]);
  const vencida = (await comp(700, { fecha: hoyMas(-60), vencimientos: [{ fecha: hoyMas(-5), importe: 847 }] })).json;
  const agenda = (await api('GET', '/api/compras/vencimientos?estado=pendiente', { token: gerente.token })).json;
  assert.equal(agenda.find((x) => x.comprobante_id === vencida.id).vencido, true);
  assert.equal(agenda.find((x) => x.comprobante_id === f.id).vencido, false);
  assert.deepEqual(agenda.map((x) => x.fecha), [...agenda.map((x) => x.fecha)].sort()); // por fecha
  assert.equal((await api('GET', `/api/compras/vencimientos?hasta=${hoyMas(-4)}`, { token: gerente.token })).json.every((x) => x.fecha <= hoyMas(-4)), true);
});

test('Compras.RF05: la agenda avisa N días antes de cada vencimiento (parametrizable), una alerta por cuota, y el aviso se resuelve al pagarse', async () => {
  const antes = (await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE tipo = 'vencimiento_proveedor'"))[0][0].n;
  assert.equal(antes, 0);
  await api('PUT', '/api/compras/config', { token: gerente.token, body: { aviso_vencimiento_dias: 7 } });
  const r = await api('POST', '/api/compras/vencimientos/avisos', { token: administrativo.token, body: {} });
  assert.equal(r.status, 200);
  const venc = (await api('GET', `/api/compras/vencimientos?hasta=${hoyMas(7)}`, { token: gerente.token })).json;
  assert.equal(r.json.emitidos, venc.length);
  assert.ok(venc.length >= 3);
  await Vencimientos.avisos();
  const abiertas = (await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE tipo = 'vencimiento_proveedor' AND estado <> 'resuelta'"))[0][0].n;
  assert.equal(abiertas, venc.length); // repetir no duplica
  const vencida = venc.find((x) => x.vencido);
  assert.ok((await pool.query("SELECT severidad FROM notificaciones WHERE clave = ?", [`cmp-venc:${vencida.id}`]))[0][0].severidad === 'alta'); // lo vencido es más urgente
  await Vencimientos.resolverAviso(vencida.id);
  assert.equal((await pool.query("SELECT estado FROM notificaciones WHERE clave = ?", [`cmp-venc:${vencida.id}`]))[0][0].estado, 'resuelta');
  await api('PUT', '/api/compras/config', { token: gerente.token, body: { aviso_vencimiento_dias: 1 } });
  assert.ok((await Vencimientos.avisos()).emitidos < venc.length);
});

test('Compras.RF02/RN08: el saldo del proveedor se deriva de los comprobantes (facturas y débitos suman, créditos restan, lo anulado no cuenta) y se ve por moneda con su composición y antigüedad', async () => {
  const c = await cuenta();
  // 1.210 + 2.420 + 847 + 605 + 1.452... se calcula contra los comprobantes de verdad.
  const [[{ deuda }]] = await pool.query("SELECT SUM(CASE WHEN clase = 'NOTA_CREDITO' THEN -total ELSE total END) AS deuda FROM cmp_comprobantes WHERE proveedor_id = ? AND estado NOT IN ('anulado', 'borrador') AND moneda = 'ARS'", [prov.id]);
  assert.equal(c.saldo, Number(deuda));
  assert.ok(c.movimientos.some((m) => m.importe < 0)); // la nota de crédito resta
  assert.equal(c.movimientos[c.movimientos.length - 1].saldo, c.saldo); // el saldo corrido termina en el saldo
  assert.ok(c.composicion.length >= 4);
  assert.deepEqual(c.antiguedad.tramos, ['al día', 'hasta 30 días', '31 a 60 días', '61 a 90 días', 'más de 90 días']);
  assert.equal(c.antiguedad.importes.length, 5);
  const [vencida] = c.composicion.filter((x) => x.vencido);
  assert.ok(vencida && c.antiguedad.importes[1] >= vencida.saldo); // vencida hace 5 días: primer tramo
  assert.equal(c.antiguedad.importes.reduce((s, x) => s + x, 0), c.composicion.reduce((s, x) => s + x.saldo, 0));
  // Una factura anulada sale del saldo y de la agenda.
  const extra = (await comp(900, { fecha: hoyMas(-2) })).json;
  assert.equal((await cuenta()).saldo, c.saldo + 1089);
  assert.equal((await api('POST', `/api/compras/comprobantes/${extra.id}/anular`, { token: gerente.token, body: { motivo: 'cargada dos veces' } })).json.estado, 'anulado');
  assert.equal((await cuenta()).saldo, c.saldo);
  assert.ok(!(await api('GET', `/api/compras/vencimientos?comprobante_id=${extra.id}`, { token: gerente.token })).json.length);
  // Por moneda.
  assert.equal((await comp(100, { fecha: hoyMas(-2), moneda: 'USD', cotizacion: 1000 })).status, 201);
  assert.equal((await cuenta(prov.id, '?moneda=USD')).saldo, 121);
  assert.equal((await cuenta()).saldo, c.saldo); // los pesos no se mezclan con los dólares
  const deudas = (await api('GET', '/api/compras/deuda', { token: gerente.token })).json;
  assert.ok(deudas.some((d) => d.proveedor_id === prov.id && d.moneda === 'USD' && d.saldo === 121));
  assert.ok(deudas.some((d) => d.proveedor_id === prov2.id && d.moneda === 'ARS'));
  assert.equal((await api('GET', `/api/compras/proveedores/${prov.id}/cuenta`, { token: (await usuario(api, pool, 'dani', 'deposito')).token })).status, 403);
});

test('Compras→Financiero RF13: los vencimientos a pagar viajan como evento a la proyección de fondos, sin que Financiero consulte a Compras', async () => {
  await Vencimientos.publicar();
  await esperarMensajes(pool);
  const filas = (await pool.query("SELECT sentido, fecha, importe FROM fin_vencimientos_externos WHERE origen = 'compras'"))[0];
  assert.ok(filas.length >= 3);
  assert.ok(filas.every((f) => f.sentido === 'pagar'));
  const pendiente = (await pool.query("SELECT SUM(v.saldo) AS n FROM cmp_vencimientos v JOIN cmp_comprobantes c ON c.id = v.comprobante_id WHERE v.estado = 'pendiente' AND c.moneda = 'ARS'"))[0][0].n;
  assert.equal(Number(filas.reduce((s, f) => s + Number(f.importe), 0)), Number(pendiente)); // la foto trae todo lo pendiente en pesos
  const flujo = (await api('GET', '/api/financiero/informes/flujo?periodo=dia&dias=60', { token: gerente.token })).json;
  assert.ok(flujo.componentes.includes('vencimientos_compras'));
  assert.ok(flujo.filas.some((f) => f.egresos > 0));
  // Un pago que baja el saldo cambia la foto siguiente.
  const antes = filas.length;
  await pool.query("UPDATE cmp_vencimientos SET saldo = 0, estado = 'pagado' WHERE id = (SELECT id FROM (SELECT MIN(id) AS id FROM cmp_vencimientos WHERE estado = 'pendiente') x)");
  await Vencimientos.publicar();
  await esperarMensajes(pool);
  assert.ok((await pool.query("SELECT COUNT(*) AS n FROM fin_vencimientos_externos WHERE origen = 'compras'"))[0][0].n <= antes);
});
