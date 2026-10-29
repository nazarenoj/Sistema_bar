const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');

let api, pool, cerrar, token, tokenBarista, principal, n = 0, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
  };
  token = await usuario('adm', 'administrador');
  tokenBarista = await usuario('bea', 'barista');
  principal = (await api('GET', '/api/depositos', { token })).json.find((d) => d.predeterminado);
});
after(async () => { await cerrar(); });

const insumo = async (nombre, extra = {}) => (await api('POST', '/api/insumos', { token, body: { nombre, unidad: 'kg', ...extra } })).json;
const producto = async (nombre, extra = {}) => (await api('POST', '/api/productos', { token, body: { nombre, precio: 1000, ...extra } })).json;
const metodo = (m, t = token) => api('PUT', '/api/stock/valuacion', { token: t, body: { metodo: m } });
const ingreso = (item, cantidad, costo) => api('POST', '/api/stock/ingresos', { token, body: { motivo: 'compra', lineas: [{ item: { tipo: item.tipo ?? 'insumo', id: item.id }, cantidad, costo_unitario: costo }] } });
const egreso = async (item, cantidad) => (await api('POST', '/api/stock/egresos', { token, body: { motivo: 'consumo_interno', lineas: [{ item: { tipo: item.tipo ?? 'insumo', id: item.id }, cantidad }] } })).json;
const mov = async (id) => (await pool.query('SELECT * FROM stock_movimientos WHERE id = ?', [id]))[0][0];
const costoDe = async (resp) => { const m = await mov(resp.movimientos[0].id); return [m.costo_unitario === null ? null : Number(m.costo_unitario), m.costo_provisorio]; };

const vender = async (p, cantidad) => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: p.id, cantidad }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-cos-${++k}-abcdef` }, body: { metodo_pago: 'efectivo' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await esperarMensajes(pool);
  await esperarMensajes(pool); // el costo vuelve a Ventas en un segundo mensaje
  return r.json;
};
const venta = async (id) => (await api('GET', `/api/ventas/${id}`, { token })).json;

test('Stock.RF17: con costo promedio ponderado cada egreso congela el promedio de ese momento', async () => {
  const harina = await insumo('Harina');
  await ingreso(harina, 10, 100);
  await ingreso(harina, 10, 200); // promedio 150
  const e1 = await egreso(harina, 5);
  assert.deepEqual(await costoDe(e1), [150, 0]);
  await ingreso(harina, 10, 300); // quedan 15 a 150 y entran 10 a 300: promedio 210
  const e2 = await egreso(harina, 5);
  assert.deepEqual(await costoDe(e2), [210, 0]);
  assert.deepEqual(await costoDe(e1), [150, 0]); // el anterior queda como estaba (RN63)
});

test('Stock.RF17: con PEPS sale primero lo que entró primero; con último costo, el del último ingreso', async () => {
  assert.equal((await metodo('peps')).status, 200);
  const azucar = await insumo('Azúcar');
  await ingreso(azucar, 10, 100);
  await ingreso(azucar, 10, 200);
  assert.deepEqual(await costoDe(await egreso(azucar, 15)), [133.3333, 0]); // 10 a 100 y 5 a 200
  assert.deepEqual(await costoDe(await egreso(azucar, 5)), [200, 0]); // lo que queda de la segunda capa

  assert.equal((await metodo('ultimo')).status, 200);
  const sal = await insumo('Sal');
  await ingreso(sal, 10, 100);
  await ingreso(sal, 10, 200);
  assert.deepEqual(await costoDe(await egreso(sal, 5)), [200, 0]);
  await ingreso(sal, 10, 50);
  assert.deepEqual(await costoDe(await egreso(sal, 5)), [50, 0]);
  assert.equal((await metodo('promedio')).status, 200);
});

test('Stock.RN16/RN63: cambiar el método es del Administrador, queda auditado y no modifica los costos ya congelados', async () => {
  const cacao = await insumo('Cacao');
  await ingreso(cacao, 10, 100);
  await ingreso(cacao, 10, 300);
  const antes = await egreso(cacao, 4); // promedio: 200
  assert.deepEqual(await costoDe(antes), [200, 0]);
  assert.equal((await metodo('peps', tokenBarista)).status, 403);
  assert.equal((await metodo('fifo')).status, 400);
  const r = await metodo('ultimo');
  assert.deepEqual([r.status, r.json.anterior], [200, 'promedio']);
  assert.deepEqual(await costoDe(antes), [200, 0]); // sigue valiendo lo que valía
  assert.deepEqual(await costoDe(await egreso(cacao, 1)), [300, 0]); // y el nuevo usa el método nuevo
  assert.equal((await api('GET', '/api/stock/valuacion', { token })).json.metodo, 'ultimo');
  assert.ok((await pool.query("SELECT COUNT(*) n FROM auditoria WHERE accion = 'cambio_metodo_valuacion'"))[0][0].n >= 1);
  await metodo('promedio');
});

test('Stock.RF13: la transferencia conserva el costo con que salió; un egreso sin stock se valora al último costo y queda provisorio', async () => {
  const t = await insumo('Té');
  const otro = (await api('POST', '/api/depositos', { token, body: { nombre: 'Cocina' } })).json;
  await ingreso(t, 10, 80);
  const tr = await api('POST', '/api/stock/transferencias', { token, body: { origen_id: principal.id, destino_id: otro.id, lineas: [{ item: { tipo: 'insumo', id: t.id }, cantidad: 4 }] } });
  assert.equal(tr.status, 201);
  assert.deepEqual(await Promise.all(tr.json.movimientos.map(async (m) => (await costoDe({ movimientos: [m] }))[0])), [80, 80]);
  const caps = (await pool.query("SELECT cantidad_restante FROM stock_capas WHERE item_tipo = 'insumo' AND item_id = ?", [t.id]))[0];
  assert.deepEqual(caps.map((c) => Number(c.cantidad_restante)), [10]); // una transferencia no consume capas
  assert.deepEqual(await costoDe(await egreso(t, 20)), [80, 1]); // 10 en stock + 10 de más: provisorio
});

test('Stock.RF18: el inventario valorizado suma cantidad por costo congelado y separa lo que no tiene costo', async () => {
  const v = await insumo('Vainilla', { stock: 3 }); // saldo inicial: sin costo
  await ingreso(v, 10, 100);
  await egreso(v, 4);
  const val = (await api('GET', '/api/stock/valorizado', { token })).json;
  const f = val.items.find((i) => i.tipo === 'insumo' && i.item_id === v.id);
  assert.deepEqual([f.cantidad, f.valor, f.cantidad_sin_costo], [9, 600, 3]); // 10 a 100 menos 4 a 100; 3 sin costo
  assert.equal(val.metodo, 'promedio');
  assert.ok(val.total >= 600);
  const ayer = (await api('GET', '/api/stock/valorizado?fecha=2000-01-01', { token })).json;
  assert.deepEqual(ayer.items, []);
  assert.equal(ayer.total, 0);
});

test('Stock.RN63/Ventas.RN62: la venta guarda el costo con que salió cada línea (combo y elaborado incluidos)', async () => {
  const cafe = await insumo('Café 1');
  await ingreso(cafe, 10, 8000);
  const espresso = await producto('Espresso', { tipo: 'elaborado' });
  await api('PUT', `/api/recetas/${espresso.id}`, { token, body: { lineas: [{ insumo_id: cafe.id, cantidad_consumida: 0.02 }] } });
  const tostado = await producto('Tostado', { stock: 0 });
  await ingreso({ tipo: 'producto', id: tostado.id }, 20, 500);
  const combo = await producto('Desayuno', { tipo: 'combo' });
  await api('PUT', `/api/productos/${combo.id}/componentes`, { token, body: { componentes: [{ componente_id: espresso.id, cantidad: 1 }, { componente_id: tostado.id, cantidad: 2 }] } });

  const vEsp = await vender(espresso, 2);
  const d = (await venta(vEsp.venta_id_global)).detalle[0];
  assert.deepEqual(d.costo, { costo_unitario: 160, origen_costo: 'movimiento_stock', provisorio: false }); // 0,02 kg a $8.000
  const vCombo = await vender(combo, 1);
  assert.equal((await venta(vCombo.venta_id_global)).detalle[0].costo.costo_unitario, 1160); // 160 + 2 x 500
  assert.equal((await venta(vCombo.venta_id_global)).pendiente_de_costo, false);
  await assert.rejects(pool.query('UPDATE ventas SET total = 1'), /solo lectura/); // el costo se guarda aparte: la venta no se toca
});

test('Ventas.EX47/RN75: una venta sin costo no se bloquea; con costo provisorio queda marcada; el margen sale "parcial"', async () => {
  const sinCosto = await producto('Sin costo', { stock: 5 }); // el saldo inicial no trae costo
  const vSin = await vender(sinCosto, 1);
  assert.deepEqual((await venta(vSin.venta_id_global)).detalle[0].costo, { costo_unitario: null, origen_costo: 'sin_costo', provisorio: false });

  const manual = await insumo('Cardamomo', { stock: 5, costo_unitario: 1000 }); // solo tiene el costo cargado a mano
  const rec = await producto('Chai', { tipo: 'elaborado' });
  await api('PUT', `/api/recetas/${rec.id}`, { token, body: { lineas: [{ insumo_id: manual.id, cantidad_consumida: 0.1 }] } });
  const vProv = await vender(rec, 1);
  assert.deepEqual((await venta(vProv.venta_id_global)).detalle[0].costo, { costo_unitario: 100, origen_costo: 'movimiento_stock', provisorio: true });

  const margen = (await api('GET', '/api/ventas/margen', { token })).json;
  const sin = margen.find((m) => m.producto_id === sinCosto.id);
  assert.deepEqual([sin.parcial, sin.motivos], [true, ['hay ventas sin costo']]);
  const prov = margen.find((m) => m.producto_id === rec.id);
  assert.deepEqual([prov.ingresos, prov.costo, prov.margen, prov.parcial, prov.motivos], [1000, 100, 900, true, ['hay costo provisorio']]);
  const completo = margen.find((m) => m.nombre === 'Espresso');
  assert.deepEqual([completo.ingresos, completo.costo, completo.margen, completo.parcial], [2000, 320, 1680, false]); // el espresso de la prueba anterior

  // "Pendiente de costo": con el descuento en camino y sin costo todavía.
  await pool.query('DELETE FROM lineas_costo WHERE doc_id_global = ?', [vSin.venta_id_global]);
  assert.equal((await venta(vSin.venta_id_global)).pendiente_de_costo, true);
  const pend = (await api('GET', '/api/ventas?pendiente_costo=1', { token })).json.ventas.map((x) => x.id_global);
  assert.deepEqual(pend, [vSin.venta_id_global]);
});

test('Stock.RF08/RN63: el reingreso por devolución usa el costo original de la línea, aunque los costos hayan cambiado', async () => {
  const leche = await insumo('Leche 1');
  await ingreso(leche, 10, 100);
  const flat = await producto('Flat white', { tipo: 'elaborado' });
  await api('PUT', `/api/recetas/${flat.id}`, { token, body: { lineas: [{ insumo_id: leche.id, cantidad_consumida: 0.2 }] } });
  const v = await vender(flat, 5); // 1 kg a 100
  await ingreso(leche, 10, 900); // el promedio sube
  const d = await api('POST', '/api/devoluciones', { token, headers: { 'X-ID-Solicitud': `devol-cos-${++k}-abcdef` }, body: { venta_id_global: v.venta_id_global, motivo: 'prueba', todo: true } });
  assert.equal(d.status, 201);
  await esperarMensajes(pool);
  const dev = (await pool.query("SELECT costo_unitario FROM stock_movimientos WHERE insumo_id = ? AND tipo = 'devolucion'", [leche.id]))[0][0];
  assert.equal(Number(dev.costo_unitario), 100);
});

test('Stock.RN62: el puerto de costos informa CI o CP de un artículo, con las marcas "parcial" y "sin costo"', async () => {
  const puertos = require('../src/modulos/puertos');
  const harina = await insumo('Harina 2');
  const sal = await insumo('Sal 2');
  await ingreso(harina, 10, 100);
  const masa = await producto('Masa', { tipo: 'elaborado' });
  await api('PUT', `/api/recetas/${masa.id}`, { token, body: { lineas: [{ insumo_id: harina.id, cantidad_consumida: 0.5 }, { insumo_id: sal.id, cantidad_consumida: 0.01 }] } });
  const parcial = await (await puertos.obtener('costoInventario')).costo(masa.id);
  assert.deepEqual([parcial.tipo, parcial.costo, parcial.parcial, parcial.sin_costo], ['CP', 50, true, false]); // a la sal le falta el costo
  await ingreso(sal, 10, 400);
  const completo = (await api('GET', `/api/stock/costos/producto/${masa.id}`, { token })).json;
  assert.deepEqual([completo.tipo, completo.costo, completo.parcial], ['CP', 54, false]);
  const propio = await producto('Alfajor', { stock: 0 });
  assert.deepEqual([(await api('GET', `/api/stock/costos/producto/${propio.id}`, { token })).json.sin_costo, (await api('GET', `/api/stock/costos/insumo/${harina.id}`, { token })).json.costo], [true, 100]);
  assert.equal((await api('GET', '/api/stock/costos/raro/1', { token })).status, 400);
});
