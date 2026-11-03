const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');

let api, pool, cerrar, token, mario, marta, beto, ids = {}, n = 0, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    ids[username] = r.insertId;
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
  };
  token = await usuario('adm', 'administrador');
  mario = await usuario('mario', 'mozo');
  marta = await usuario('marta', 'mozo');
  beto = await usuario('beto', 'barista');
});
after(async () => { await cerrar(); });

const hoy = () => new Date().toLocaleDateString('sv-SE');
// Producto de $121 con IVA 21 %: neto $100 por unidad.
const producto = async (extra = {}) => (await api('POST', '/api/productos', { token, body: { nombre: `Prod ${++n}`, precio: 121, ...extra } })).json;
// Una venta de `cantidad` unidades abierta por el vendedor `t` y cobrada por el administrador.
const vender = async (t, p, cantidad = 1) => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token: t, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token: t, body: { productos: [{ producto_id: p.id, cantidad }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-com-${++k}-abcdef` }, body: { metodo_pago: 'efectivo' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await esperarMensajes(pool);
  await esperarMensajes(pool);
  return r.json.venta_id_global;
};
const regla = (body) => api('POST', '/api/comisiones/reglas', { token, body });
const previa = async () => (await api('GET', `/api/comisiones/previa?desde=${hoy()}&hasta=${hoy()}`, { token })).json;
const de = (p, nombre) => p.vendedores.find((v) => v.vendedor === nombre);
const liquidar = (body = {}) => api('POST', '/api/comisiones/liquidaciones', { token, body: { tipo: 'semanal', desde: hoy(), hasta: hoy(), ...body } });

test('Ventas.RF40: sin VEN-COMISIONES no hay comisiones; las reglas se validan', async () => {
  assert.equal((await api('GET', '/api/comisiones/reglas', { token })).status, 409);
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['VEN-COMISIONES'], motivo: 'prueba' } })).status, 200);
  assert.equal((await regla({ nombre: '', tipo: 'porcentaje', porcentaje: 5 })).status, 400);
  assert.equal((await regla({ nombre: 'x', tipo: 'porcentaje', porcentaje: 150 })).status, 400);
  assert.equal((await regla({ nombre: 'x', tipo: 'rara', porcentaje: 5 })).status, 400);
  assert.equal((await regla({ nombre: 'x', tipo: 'porcentaje', porcentaje: 5, user_id: 1, rol: 'mozo' })).status, 400);
  assert.equal((await regla({ nombre: 'x', tipo: 'porcentaje', porcentaje: 5, rol: 'inexistente' })).status, 404);
  assert.equal((await regla({ nombre: 'x', tipo: 'metas', tramos: [{ desde: 0, porcentaje: 2 }] })).status, 400); // pocos tramos
  assert.equal((await regla({ nombre: 'x', tipo: 'metas', tramos: [{ desde: 100, porcentaje: 2 }, { desde: 200, porcentaje: 3 }] })).status, 400); // no empieza en 0
  assert.equal((await regla({ nombre: 'x', tipo: 'metas', tramos: [{ desde: 0, porcentaje: 2 }, { desde: 0, porcentaje: 3 }] })).status, 400); // no crece
  const ok = await regla({ nombre: 'Mozos 10 %', tipo: 'porcentaje', porcentaje: 10, rol: 'mozo' });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal((await regla({ nombre: 'Mozos 10 %', tipo: 'porcentaje', porcentaje: 10 })).status, 409);
});

test('Ventas.RN38/RF41: la comisión sale del neto de IVA, se liquida una sola vez y la liquidación se paga', async () => {
  const p = await producto();
  const v1 = await vender(mario, p, 1); // neto 100
  await vender(mario, p, 2); // neto 200
  await vender(marta, p, 1); // neto 100
  const pr = await previa();
  assert.deepEqual([de(pr, 'mario').ventas, de(pr, 'mario').base, de(pr, 'mario').comisiones], [2, 300, 30]);
  assert.deepEqual([de(pr, 'marta').base, de(pr, 'marta').comisiones, pr.total], [100, 10, 40]);
  assert.equal((await liquidar({ tipo: 'semanal', desde: '2026-01-01', hasta: '2026-03-01' })).status, 400); // una semanal no cubre 2 meses
  assert.equal((await liquidar({ tipo: 'anual' })).status, 400);
  const l = await liquidar();
  assert.equal(l.status, 201, JSON.stringify(l.json));
  assert.deepEqual([l.json.estado, l.json.total, l.json.vendedores.length], ['cerrada', 40, 2]);
  assert.equal((await liquidar()).status, 409); // las mismas ventas no se liquidan dos veces
  assert.deepEqual((await api('GET', '/api/comisiones/mias?desde=2020-01-01&hasta=2020-01-02', { token: mario })).json.comision, 0);
  const csv = await api('GET', `/api/comisiones/liquidaciones/${l.json.id}?formato=csv`, { token });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /csv/);
  const pag = await api('POST', `/api/comisiones/liquidaciones/${l.json.id}/pagar`, { token, body: { medio_pago: 'efectivo' } });
  assert.equal(pag.json.estado, 'pagada'); // sin Financiero se marca a mano
  assert.equal((await api('POST', `/api/comisiones/liquidaciones/${l.json.id}/pagar`, { token, body: {} })).status, 409);
  // Una devolución posterior se descuenta en la liquidación siguiente como ajuste, sin tocar la cerrada (EX28).
  const dev = await api('POST', '/api/devoluciones', { token, headers: { 'X-ID-Solicitud': `devol-com-${++k}-abcdef` }, body: { venta_id_global: v1, motivo: 'prueba', todo: true } });
  assert.equal(dev.status, 201, JSON.stringify(dev.json));
  const l2 = await liquidar();
  assert.equal(l2.status, 201, JSON.stringify(l2.json));
  assert.deepEqual([l2.json.total, l2.json.items.map((i) => i.tipo)], [-10, ['ajuste']]);
  assert.equal((await api('GET', `/api/comisiones/liquidaciones/${l.json.id}`, { token })).json.total, 40);
  assert.equal((await liquidar()).status, 409); // el ajuste tampoco se repite
  assert.equal((await api('POST', '/api/comisiones/liquidaciones', { token: mario, body: { tipo: 'semanal', desde: hoy(), hasta: hoy() } })).status, 403);
});

test('Ventas.RF40: las metas escalonadas pagan cada tramo del acumulado y la regla del vendedor prima sobre la del rol', async () => {
  const p = await producto();
  const metas = await regla({ nombre: 'Metas Marta', tipo: 'metas', user_id: ids.marta, tramos: [{ desde: 0, porcentaje: 2 }, { desde: 200, porcentaje: 3 }] });
  assert.equal(metas.status, 201, JSON.stringify(metas.json));
  await vender(marta, p, 3); // neto 300: 200 al 2 % y 100 al 3 %
  await vender(mario, p, 1); // la del rol: 10 %
  const pr = await previa();
  assert.equal(de(pr, 'marta').comisiones, 7);
  assert.equal(de(pr, 'mario').comisiones, 10);
  await vender(marta, p, 1); // el acumulado del período sigue en el tramo del 3 %
  assert.equal(de(await previa(), 'marta').comisiones, 10);
  await liquidar();
});

test('Ventas.RN38/RN62: la comisión por margen usa el costo de la venta; sin costo rige el respaldo y lo pendiente de costo espera', async () => {
  const conCosto = await producto();
  await api('POST', '/api/stock/ingresos', { token, body: { motivo: 'compra', lineas: [{ item: { tipo: 'producto', id: conCosto.id }, cantidad: 20, costo_unitario: 40 }] } });
  const sinCosto = await producto();
  assert.equal((await regla({ nombre: 'Barra margen', tipo: 'margen', porcentaje: 20, user_id: ids.beto })).status, 201);
  const v = await vender(beto, conCosto, 1); // neto 100 − costo 40 = 60 → 20 % = 12
  const pr = await previa();
  assert.deepEqual([de(pr, 'beto').comisiones, de(pr, 'beto').base], [12, 100]);
  // Sin costo: por defecto no hay comisión por margen y se alerta; con respaldo "porcentaje" se paga ese porcentaje de la venta.
  await vender(beto, sinCosto, 1);
  assert.equal(de(await previa(), 'beto').comisiones, 12);
  await pool.query("UPDATE parametros SET valor = 'porcentaje' WHERE clave = 'comision_respaldo'");
  await pool.query("UPDATE parametros SET valor = '5' WHERE clave = 'comision_respaldo_pct'");
  assert.equal(de(await previa(), 'beto').comisiones, 17); // 12 + 5 % de 100
  // La venta cuyo costo todavía no llegó no entra: pasa a la liquidación siguiente.
  await pool.query('DELETE FROM lineas_costo WHERE doc_id_global = ?', [v]);
  const pend = await previa();
  assert.equal(de(pend, 'beto').comisiones, 5);
  assert.equal(pend.omitidas.pendientes_de_costo, 1);
  const l = await liquidar();
  assert.equal(l.json.total, 5);
  // Llega el costo y la venta entra en la liquidación siguiente.
  await pool.query("INSERT INTO lineas_costo (doc_tipo, doc_id_global, linea, costo_unitario, origen_costo) VALUES ('venta', ?, 0, 40, 'movimiento_stock')", [v]);
  assert.equal(de(await previa(), 'beto').comisiones, 12);
});
