const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');

let api, pool, cerrar, token, M, n = 0, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  M = require('../src/mensajeria/servicio');
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

const insumo = async (nombre, stock = 100, unidad = 'kg') => (await api('POST', '/api/insumos', { token, body: { nombre, unidad, stock } })).json;
const producto = async (nombre, extra = {}) => (await api('POST', '/api/productos', { token, body: { nombre, precio: 100, ...extra } })).json;
const stockDe = async (tipo, id) => Number((await pool.query(`SELECT stock FROM ${tipo === 'insumo' ? 'insumos' : 'productos'} WHERE id = ?`, [id]))[0][0].stock);
const receta = (id, lineas) => api('PUT', `/api/recetas/${id}`, { token, body: { lineas } });
const movs = async (tipo, id) => (await pool.query(`SELECT * FROM stock_movimientos WHERE ${tipo}_id = ? ORDER BY id`, [id]))[0];

// Vende `cantidad` del producto en una mesa nueva y deja que Stock aplique el mensaje. Devuelve la respuesta del cierre.
const vender = async (p, cantidad, extra = {}) => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: p.id, cantidad }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-rec-${++k}-abcdef` }, body: { metodo_pago: 'efectivo', ...extra } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await esperarMensajes(pool);
  return r.json;
};
const devolver = async (idVenta, body) => {
  const r = await api('POST', '/api/devoluciones', { token, headers: { 'X-ID-Solicitud': `devol-rec-${++k}-abcdef` }, body: { venta_id_global: idVenta, motivo: 'prueba', ...body } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  await esperarMensajes(pool);
  return r.json;
};

test('Stock.RN50/RF07: el descuento llega como mensaje de Ventas con su ID_Operacion y Stock lo confirma', async () => {
  const p = await producto('Galletita', { stock: 10 });
  const v = await vender(p, 3);
  assert.equal(await stockDe('producto', p.id), 7);
  const [[m]] = await pool.query("SELECT * FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'descuento_stock'", [v.venta_id_global]);
  assert.equal(m.id_operacion, `ventas:descuento_stock:${v.venta_id_global}:1`);
  assert.equal(m.estado, 'confirmado');
  assert.deepEqual(JSON.parse(m.contenido).items, [{ linea: 0, producto_id: p.id, cantidad: 3, lote_indicado: null }]); // solo la línea vendida
  const mov = (await movs('producto', p.id)).find((x) => x.tipo === 'venta');
  assert.deepEqual([mov.documento_tipo, mov.documento, Number(mov.cantidad)], ['venta', v.venta_id_global, -3]);
});

test('Stock.RN50: el mismo mensaje dos veces descuenta una sola vez (idempotente por operación, línea e ítem)', async () => {
  const p = await producto('Alfajor', { stock: 10 });
  const v = await vender(p, 2);
  assert.equal(await stockDe('producto', p.id), 8);
  // Se simula la reentrega: el mensaje vuelve a pendiente y se borra su marca de procesado.
  const op = `ventas:descuento_stock:${v.venta_id_global}:1`;
  await pool.query("UPDATE mensajes_integracion SET estado = 'pendiente', proximo_intento_ms = 0 WHERE id_operacion = ?", [op]);
  await pool.query('DELETE FROM operaciones_procesadas WHERE id_operacion = ?', [op]);
  await esperarMensajes(pool);
  assert.equal(await stockDe('producto', p.id), 8); // no volvió a descontar
  assert.equal((await movs('producto', p.id)).filter((x) => x.tipo === 'venta').length, 1);
});

test('Stock.RF09/RN64: un combo no descuenta sus componentes además de sí mismo; un elaborado descuenta sus insumos, no el artículo', async () => {
  const cafe = await insumo('Café', 10);
  const espresso = await producto('Espresso', { tipo: 'elaborado' });
  assert.equal((await receta(espresso.id, [{ insumo_id: cafe.id, cantidad_consumida: 0.02 }])).status, 200);
  const tostado = await producto('Tostado', { stock: 20 });
  const combo = await producto('Desayuno', { tipo: 'combo' });
  await api('PUT', `/api/productos/${combo.id}/componentes`, { token, body: { componentes: [{ componente_id: espresso.id, cantidad: 1 }, { componente_id: tostado.id, cantidad: 2 }] } });
  await vender(combo, 3);
  assert.equal(await stockDe('insumo', cafe.id), 9.94); // 3 espressos x 20 g
  assert.equal(await stockDe('producto', tostado.id), 14); // 3 combos x 2 tostados
  assert.equal((await movs('producto', combo.id)).length, 0); // el combo no tiene stock propio
  assert.equal((await movs('producto', espresso.id)).length, 0); // el elaborado tampoco: se descuentan sus insumos
  await vender(espresso, 5);
  assert.equal(await stockDe('insumo', cafe.id), 9.84);
});

test('Stock.RF09: la receta rige solo para los elaborados; un artículo estándar se descuenta a sí mismo', async () => {
  const sal = await insumo('Sal', 10);
  const queso = await producto('Queso', { stock: 10 }); // estándar
  await api('POST', `/api/productos/${queso.id}/insumos`, { token, body: { insumo_id: sal.id, cantidad_consumida: 1 } });
  await vender(queso, 2);
  assert.deepEqual([await stockDe('producto', queso.id), await stockDe('insumo', sal.id)], [8, 10]);
  assert.equal((await receta(queso.id, [])).status, 409); // el PUT de recetas exige un elaborado
});

test('Stock.RF09: las sub-recetas se expanden hasta las hojas; no admiten ciclos ni más de 3 niveles', async () => {
  const harina = await insumo('Harina', 50);
  const manteca = await insumo('Manteca', 50);
  const masa = await producto('Masa base', { tipo: 'elaborado' });
  const medialuna = await producto('Medialuna', { tipo: 'elaborado' });
  assert.equal((await receta(masa.id, [{ insumo_id: harina.id, cantidad_consumida: 0.5 }])).status, 200);
  assert.equal((await receta(medialuna.id, [{ componente_producto_id: masa.id, cantidad_consumida: 0.1 }, { insumo_id: manteca.id, cantidad_consumida: 0.02 }])).status, 200);
  await vender(medialuna, 10);
  assert.deepEqual([await stockDe('insumo', harina.id), await stockDe('insumo', manteca.id)], [49.5, 49.8]); // 10 x (0,1 masa x 0,5 kg) y 10 x 0,02

  // Ciclo y autoreferencia
  assert.equal((await receta(masa.id, [{ componente_producto_id: medialuna.id, cantidad_consumida: 1 }])).status, 400);
  assert.equal((await receta(masa.id, [{ componente_producto_id: masa.id, cantidad_consumida: 1 }])).status, 400);
  // La sub-receta tiene que ser un elaborado
  const comun = await producto('Común');
  assert.equal((await receta(medialuna.id, [{ componente_producto_id: comun.id, cantidad_consumida: 1 }])).status, 400);
  // Profundidad: a > b > c > d > e (4 niveles de sub-recetas) se rechaza
  const [a, b, c, d, e] = await Promise.all(['ra', 'rb', 'rc', 'rd', 're'].map((nombre) => producto(nombre, { tipo: 'elaborado' })));
  assert.equal((await receta(e.id, [{ insumo_id: harina.id, cantidad_consumida: 1 }])).status, 200);
  assert.equal((await receta(d.id, [{ componente_producto_id: e.id, cantidad_consumida: 1 }])).status, 200);
  assert.equal((await receta(c.id, [{ componente_producto_id: d.id, cantidad_consumida: 1 }])).status, 200);
  assert.equal((await receta(b.id, [{ componente_producto_id: c.id, cantidad_consumida: 1 }])).status, 200); // b > c > d > e: 3 niveles
  assert.equal((await receta(a.id, [{ componente_producto_id: b.id, cantidad_consumida: 1 }])).status, 400); // a > b > c > d > e: 4
});

test('Stock.RF09: la receta admite porcentaje de merma, valida sus líneas y guarda cada cambio como una versión', async () => {
  const leche = await insumo('Leche', 100, 'l');
  const cappu = await producto('Cappuccino', { tipo: 'elaborado' });
  const lineaMal = [{ insumo_id: leche.id }, { insumo_id: 99999, cantidad_consumida: 1 }, { insumo_id: leche.id, cantidad_consumida: 1, merma_pct: 100 },
    { insumo_id: leche.id, componente_producto_id: cappu.id, cantidad_consumida: 1 }, { cantidad_consumida: 1 }];
  for (const l of lineaMal) assert.ok([400, 404].includes((await receta(cappu.id, [l])).status), JSON.stringify(l));
  assert.equal((await receta(cappu.id, [{ insumo_id: leche.id, cantidad_consumida: 0.2 }, { insumo_id: leche.id, cantidad_consumida: 0.1 }])).status, 400); // repetido

  const v1 = await receta(cappu.id, [{ insumo_id: leche.id, cantidad_consumida: 0.16, merma_pct: 20 }]); // 0,16 l netos, 20 % de merma
  assert.equal(v1.json.version, 1);
  await vender(cappu, 5);
  assert.equal(await stockDe('insumo', leche.id), 99); // 5 x 0,16 / 0,8 = 1 l
  const v2 = await receta(cappu.id, [{ insumo_id: leche.id, cantidad_consumida: 0.3 }]);
  assert.equal(v2.json.version, 2);
  // También el alta de una línea por el endpoint de siempre deja versión.
  await api('POST', `/api/productos/${cappu.id}/insumos`, { token, body: { insumo_id: (await insumo('Canela', 5)).id, cantidad_consumida: 0.001 } });
  const versiones = (await api('GET', `/api/recetas/${cappu.id}/versiones`, { token })).json;
  assert.deepEqual(versiones.map((v) => v.version), [1, 2, 3]);
  assert.equal(Number(versiones[0].lineas[0].merma_pct), 20); // la versión guarda cómo era
  assert.equal(versiones[2].lineas.length, 2);
  const actual = (await api('GET', `/api/recetas/${cappu.id}`, { token })).json;
  assert.deepEqual([actual.modo_descuento, actual.version, actual.lineas.length], ['componentes', 3, 2]);
  assert.equal((await api('GET', '/api/recetas/99999', { token })).status, 404);
});

test('Stock.RF08/RN66: la devolución reingresa en proporción, al mismo depósito y costo; la merma es ingreso más egreso', async () => {
  const harina = await insumo('Harina 0000', 20);
  const pan = await producto('Pan casero', { tipo: 'elaborado' });
  await receta(pan.id, [{ insumo_id: harina.id, cantidad_consumida: 0.5 }]);
  const v = await vender(pan, 4); // 2 kg
  assert.equal(await stockDe('insumo', harina.id), 18);
  await devolver(v.venta_id_global, { items: [{ linea: 0, cantidad: 1 }] }); // 1 de 4 -> 0,5 kg vuelven
  assert.equal(await stockDe('insumo', harina.id), 18.5);
  const dev = (await movs('insumo', harina.id)).find((m) => m.tipo === 'devolucion');
  assert.deepEqual([Number(dev.cantidad), dev.documento_tipo, dev.documento], [0.5, 'devolucion', v.venta_id_global]);
  await devolver(v.venta_id_global, { items: [{ linea: 0, cantidad: 3 }] });
  assert.equal(await stockDe('insumo', harina.id), 20); // todo reingresado, sin diferencias de redondeo

  // Con merma: el costo de la venta se revierte (ingreso) y la pérdida queda registrada (egreso "Devolución a merma").
  const v2 = await vender(pan, 2);
  await devolver(v2.venta_id_global, { todo: true, reingreso: 'merma' });
  assert.equal(await stockDe('insumo', harina.id), 19); // el stock no vuelve: es una pérdida
  const merma = (await movs('insumo', harina.id)).filter((m) => m.documento === v2.venta_id_global);
  assert.deepEqual(merma.map((m) => [m.tipo, m.motivo, Number(m.cantidad)]), [['venta', 'venta', -1], ['devolucion', 'devolucion_venta', 1], ['egreso', 'devolucion_merma', -1]]);
});

test('Stock.RN51/EX35: una devolución nunca se aplica antes que la venta original: espera a que su descuento esté confirmado', async () => {
  const p = await producto('Budín', { stock: 10 });
  const doc = 'TST01-ORDEN00000000000000000001';
  const publicar = async (tipo, secuencia, version, contenido) => {
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await M.publicar(conn, { origen: 'ventas', destino: 'stock', tipo, docTipo: 'venta', docIdGlobal: doc, docVersion: version, secuencia, contenido });
    await conn.commit();
    conn.release();
  };
  await publicar('descuento_stock', 1, 1, { doc_tipo: 'venta', items: [{ linea: 0, producto_id: p.id, cantidad: 4 }] });
  await pool.query("UPDATE mensajes_integracion SET proximo_intento_ms = ? WHERE doc_id_global = ? AND tipo = 'descuento_stock'", [Date.now() + 3600000, doc]); // todavía no le toca
  await publicar('reingreso_stock', 2, 1, { modo: 'reingreso', items: [{ linea: 0, cantidad: 4, cantidad_original: 4 }] });
  await M.procesarPendientes();
  const [[rev]] = await pool.query("SELECT retenido_por_orden, estado FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'reingreso_stock'", [doc]);
  assert.deepEqual([rev.retenido_por_orden, rev.estado], [1, 'pendiente']);
  assert.equal(await stockDe('producto', p.id), 10); // la devolución no tocó nada

  await pool.query("UPDATE mensajes_integracion SET proximo_intento_ms = 0 WHERE doc_id_global = ? AND tipo = 'descuento_stock'", [doc]);
  await esperarMensajes(pool);
  await esperarMensajes(pool);
  assert.equal(await stockDe('producto', p.id), 10); // primero salió 4 y después volvió 4
  assert.deepEqual((await movs('producto', p.id)).filter((m) => m.documento === doc).map((m) => m.tipo), ['venta', 'devolucion']);
});

test('Stock.RF07: el descuento de una silla que se cierra sola y el de la cuenta no se duplican; una venta no fiscal lleva la marca (RN88)', async () => {
  const p = await producto('Medialuna común', { stock: 30 });
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const s1 = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  const s2 = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  for (const [pedido, cantidad] of [[s1, 2], [s2, 3]]) await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: p.id, cantidad }] } });
  const c1 = await api('POST', `/api/pedidos/${s1.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `silla-rec-${++k}-abcdef` }, body: {} });
  assert.equal(c1.status, 200, JSON.stringify(c1.json));
  await esperarMensajes(pool);
  assert.equal(await stockDe('producto', p.id), 28); // solo lo de la silla cerrada
  const cuenta = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cuenta-rec-${++k}-abcdef` }, body: { metodo_pago: 'efectivo', modalidad: 'no_fiscal' } });
  assert.equal(cuenta.status, 200);
  await esperarMensajes(pool);
  assert.equal(await stockDe('producto', p.id), 25); // los 3 de la otra silla; los 2 de la primera no se descuentan de nuevo
  const ventas = (await movs('producto', p.id)).filter((m) => m.tipo === 'venta');
  assert.deepEqual(ventas.map((m) => [m.documento_tipo, m.venta_no_fiscal]), [['pedido', 0], ['venta', 1]]);
});
