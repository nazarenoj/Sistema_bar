process.env.AFIP_CONDICION_IVA_EMISOR = 'responsable_inscripto';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const Mov = require('../src/stock/movimientoService');

let api, pool, cerrar, adm, gerente, administrativo, contador, deposito, prov, dep, harina, cafe, k = 0, neto0 = 900;
const CUIT = '30711111111';
const hoyIso = new Date().toISOString().slice(0, 10);

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  contador = await usuario(api, pool, 'cora', 'contador');
  deposito = await usuario(api, pool, 'dani', 'deposito');
  await api('POST', '/api/modulos/compras/instalar', { token: adm.token });
  dep = (await api('GET', '/api/depositos', { token: adm.token })).json[0].id;
  prov = (await api('POST', '/api/compras/proveedores', { token: administrativo.token, body: { cuit: CUIT, razon_social: 'Molino Devoluciones SA', condicion_iva: 'Responsable Inscripto', consultar_arca: false, condicion_pago_dias: 0 } })).json;
  const insumo = async (nombre) => (await api('POST', '/api/insumos', { token: adm.token, body: { nombre, unidad: 'kg' } })).json;
  harina = await insumo('Harina devoluciones'); cafe = await insumo('Cafe devoluciones');
});
after(async () => { await cerrar(); });

// Un ingreso de Stock del proveedor y su devolucion (el egreso lo registra Stock y lo informa a Compras por un mensaje).
const devolver = async (item, comprados, devueltos, costo = 100) => {
  const ing = await Mov.ingresar({ deposito_id: dep, motivo: 'compra', proveedor: 'Molino Devoluciones SA', comprobante: { cuit: CUIT, clase: 'REMITO', tipo: 'X', punto_venta: '1', numero: String(++k + 500) },
    lineas: [{ item: { tipo: 'insumo', id: item.id }, cantidad: comprados, costo_unitario: costo }] }, { userId: 1 });
  const [[mov]] = await pool.query("SELECT id FROM stock_movimientos WHERE documento_tipo = 'ingreso' AND documento = ? LIMIT 1", [ing.id_global]);
  const r = await api('POST', '/api/stock-ingresos/devoluciones-proveedor', { token: adm.token, body: { movimiento_id: mov.id, cantidad: devueltos, motivo: 'Mal estado' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  await esperarMensajes(pool);
  return r.json;
};
const nota = (neto, lineas, extra = {}) => api('POST', '/api/compras/comprobantes', { token: administrativo.token, body: { cuit: CUIT, clase: 'NOTA_CREDITO', tipo: 'A', punto_venta: 2, numero: String(++k + 100), fecha: hoyIso, alicuotas: [{ alicuota: 21, neto, iva: Math.round(neto * 21) / 100 }],
  otros_tributos: k, total: Math.round((neto * 1.21 + k) * 100) / 100, lineas, ...extra } });
const linea = (item, cantidad, precio) => ({ tipo: 'mercaderia', item: { tipo: 'insumo', id: item.id }, descripcion: 'x', cantidad, precio_unitario: precio });
const vincular = (id, body, t = administrativo) => api('POST', `/api/compras/comprobantes/${id}/vincular-devoluciones`, { token: t.token, body });
const pendientes = async () => (await api('GET', '/api/compras/devoluciones?estado=pendiente_nc', { token: gerente.token })).json;

test('Compras.RF25: la devolucion de Stock llega a Compras como reclamo pendiente de nota de credito, una sola vez', async () => {
  const d = await devolver(harina, 10, 4);
  const p = await pendientes();
  const x = p.find((y) => y.id_global === d.id_global);
  assert.ok(x, JSON.stringify(p));
  assert.equal(x.cantidad, 4); assert.equal(x.costo_devuelto, 400); assert.equal(x.proveedor_id, prov.id); assert.equal(x.estado, 'pendiente_nc');
  assert.equal((await api('GET', '/api/compras/devoluciones', { token: contador.token })).status, 200);
});

test('Compras.RF25/EX24: la nota se vincula al egreso del mismo proveedor, viaja a Stock y reduce la deuda', async () => {
  const d = await devolver(harina, 10, 3); // 300 de costo devuelto
  const n = (await nota(300, [linea(harina, 3, 100)])).json;
  assert.equal(n.clase, 'NOTA_CREDITO');
  assert.equal((await vincular(n.id, { devolucion_ids: [] })).status, 400);
  assert.equal((await vincular(n.id, { devolucion_ids: [999999] })).status, 404);
  assert.equal((await vincular(n.id, { devolucion_ids: [(await pendientes()).find((y) => y.id_global === d.id_global).id] }, deposito)).status, 403);
  const dev = (await pendientes()).find((y) => y.id_global === d.id_global);
  const v = await vincular(n.id, { devolucion_ids: [dev.id] });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  assert.equal(v.json.diferencia, 0);
  assert.equal(v.json.devoluciones[0].estado, 'con_nc');
  await esperarMensajes(pool);
  const [[s]] = await pool.query('SELECT estado, nota_credito_clave FROM devoluciones_proveedor WHERE id_global = ?', [d.id_global]);
  assert.equal(s.estado, 'con_nc'); assert.ok(s.nota_credito_clave); // Stock marca el egreso con la nota
  assert.equal((await vincular(n.id, { devolucion_ids: [dev.id] })).json.codigo, 'DEVOLUCION_CON_NC');
  const cuenta = (await api('GET', `/api/compras/proveedores/${prov.id}/cuenta`, { token: gerente.token })).json;
  assert.ok(cuenta.saldo < 0); // la nota reduce la deuda (RN08)
});

test('Compras.EX24: no se acredita mas cantidad que la devuelta ni se vincula a otro proveedor; una diferencia de importe pide confirmacion con motivo', async () => {
  const d = await devolver(cafe, 10, 2); // 200 devueltos
  const dev = (await pendientes()).find((y) => y.id_global === d.id_global);
  const exceso = (await nota(500, [linea(cafe, 5, 100)])).json;
  assert.equal((await vincular(exceso.id, { devolucion_ids: [dev.id] })).json.codigo, 'CANTIDAD_SUPERA_DEVUELTA');
  const otro = (await api('POST', '/api/compras/proveedores', { token: administrativo.token, body: { cuit: '30500010912', razon_social: 'Otro proveedor SA', consultar_arca: false } })).json;
  const deOtro = (await api('POST', '/api/compras/comprobantes', { token: administrativo.token, body: { cuit: '30500010912', clase: 'NOTA_CREDITO', tipo: 'A', punto_venta: 2, numero: String(++k + 100), fecha: hoyIso, alicuotas: [{ alicuota: 21, neto: 200, iva: 42 }], otros_tributos: k, total: 242 + k } })).json;
  assert.equal((await vincular(deOtro.id, { devolucion_ids: [dev.id] })).json.codigo, 'OTRO_PROVEEDOR');
  assert.ok(otro.id);
  const menor = (await nota(180, [linea(cafe, 2, 90)])).json; // acredita 180 y se devolvieron 200
  const sin = await vincular(menor.id, { devolucion_ids: [dev.id] });
  assert.equal(sin.json.codigo, 'IMPORTE_DIFIERE'); assert.equal(sin.json.detalle.diferencia, -20);
  assert.equal((await vincular(menor.id, { devolucion_ids: [dev.id], confirmar_diferencia: { motivo: 'x' } })).json.codigo, 'IMPORTE_DIFIERE'); // motivo muy corto
  const ok = await vincular(menor.id, { devolucion_ids: [dev.id], confirmar_diferencia: { motivo: 'bonificacion por mal estado' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.devoluciones[0].diferencia_importe, -20);
  assert.equal((await vincular(menor.id, { devolucion_ids: [dev.id] })).status, 409);
});

test('Compras.RN38: una nota por bonificacion baja el costo de reposicion con la regla; una que solo devuelve cantidades no lo cambia', async () => {
  const costo = async () => (await api('GET', '/api/compras/costos', { token: gerente.token })).json.find((c) => c.item_id === harina.id)?.costo;
  const fc = await api('POST', '/api/compras/comprobantes', { token: administrativo.token, body: { cuit: CUIT, clase: 'FACTURA', tipo: 'A', punto_venta: 1, numero: String(++k + 300), fecha: hoyIso, alicuotas: [{ alicuota: 21, neto: 10000, iva: 2100 }], otros_tributos: k, total: 12100 + k,
    lineas: [linea(harina, 100, 100)], observacion: 'x' } });
  assert.equal(fc.status, 201, JSON.stringify(fc.json));
  assert.equal(await costo(), 100);
  await nota(500, [linea(harina, 5, 100)]); // devolucion de cantidades al mismo precio: sin ajuste
  assert.equal(await costo(), 100);
  const bon = await nota(1000, [linea(harina, 100, 10)], { ajuste_costo: true }); // bonificacion posterior de $10 por unidad
  assert.equal(bon.status, 201, JSON.stringify(bon.json));
  assert.equal(await costo(), 90);
});

test('Compras.RF16: los informes se filtran, se exportan y respetan el permiso', async () => {
  assert.equal((await api('GET', '/api/compras/informes', { token: deposito.token })).status, 403);
  assert.ok((await api('GET', '/api/compras/informes', { token: contador.token })).json.includes('compras-proveedor'));
  const inf = async (t, q = '') => (await api('GET', `/api/compras/informes/${t}${q}`, { token: gerente.token }));
  const prv = (await inf('compras-proveedor')).json;
  assert.equal(prv.filas.find((f) => f.proveedor === 'Molino Devoluciones SA').comprobantes >= 3, true);
  assert.equal((await inf('compras-proveedor', '?desde=2020-01-01&hasta=2020-01-31')).json.filas.length, 0);
  assert.equal((await inf('compras-proveedor', '?desde=hoy')).status, 400);
  assert.equal((await inf('nada')).status, 404);
  for (const t of ['deuda', 'vencimientos', 'compras-rubro', 'compras-articulo', 'compras-categoria', 'evolucion-costos']) assert.equal((await inf(t)).status, 200, t);
  assert.ok((await inf('compras-articulo')).json.filas.some((f) => f.articulo === 'Harina devoluciones'));
  assert.equal((await inf('retenciones')).json.codigo, 'FUNCION_INACTIVA'); // CMP-RETENCIONES nace desactivada
  assert.equal((await inf('evolucion-costos', `?item_tipo=insumo&item_id=${harina.id}`)).json.filas[0].moneda, 'ARS');
  const csv = await api('GET', '/api/compras/informes/deuda?formato=csv', { token: gerente.token });
  assert.equal(csv.status, 200);
});

test('Compras.RF22: los indicadores del tablero se calculan con los datos de la instancia', async () => {
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['USU-TABLERO'], motivo: 'prueba' } });
  const disp = (await api('GET', '/api/tablero/indicadores', { token: gerente.token })).json.map((i) => i.id);
  for (const id of ['compras.deuda', 'compras.vencimientos', 'compras.periodo', 'compras.rubros', 'compras.costos']) assert.ok(disp.includes(id), id);
  const cajero = await usuario(api, pool, 'cami', 'cajero');
  assert.ok(!(await api('GET', '/api/tablero/indicadores', { token: cajero.token })).json.some((i) => i.id.startsWith('compras.')));
  await api('PUT', '/api/tablero', { token: gerente.token, body: { indicadores: ['compras.deuda', 'compras.periodo', 'compras.costos'], periodo: 'mes' } });
  const tab = (await api('GET', '/api/tablero', { token: gerente.token })).json;
  const v = (id) => tab.indicadores.find((i) => i.id === id);
  assert.equal(typeof v('compras.deuda').valor, 'number');
  assert.ok(v('compras.periodo').comparacion);
  assert.equal(typeof v('compras.costos').valor, 'number');
});
