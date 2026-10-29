const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');

let api, pool, cerrar, token, n = 0, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

const insumo = async (nombre, unidad = 'kg', stock = 10) => (await api('POST', '/api/insumos', { token, body: { nombre, unidad, stock } })).json;
const presentacion = (body) => api('POST', '/api/presentaciones', { token, body });
const stockDe = async (id) => Number((await pool.query('SELECT stock FROM insumos WHERE id = ?', [id]))[0][0].stock);

test('Stock.RF03: hay un depósito predeterminado, se crean otros y el predeterminado cambia de forma atómica', async () => {
  const lista = (await api('GET', '/api/depositos', { token })).json;
  assert.deepEqual(lista.map((d) => [d.nombre, d.predeterminado]), [['Depósito principal', 1]]);
  const cocina = (await api('POST', '/api/depositos', { token, body: { nombre: 'Cocina' } })).json;
  assert.equal((await api('POST', '/api/depositos', { token, body: { nombre: 'Cocina' } })).status, 409);
  assert.equal((await api('POST', '/api/depositos', { token, body: {} })).status, 400);
  assert.equal((await api('PUT', `/api/depositos/${lista[0].id}`, { token, body: { nombre: 'Depósito principal', activo: false } })).status, 409); // el predeterminado no se desactiva
  assert.equal((await api('POST', `/api/depositos/${cocina.id}/predeterminado`, { token })).status, 200);
  const despues = (await api('GET', '/api/depositos', { token })).json;
  assert.equal(despues.filter((d) => d.predeterminado).length, 1);
  assert.equal(despues.find((d) => d.predeterminado).nombre, 'Cocina');
  assert.equal((await api('PUT', `/api/depositos/${cocina.id}`, { token, body: { nombre: 'Cocina', activo: false } })).status, 409);
  await api('PUT', `/api/depositos/${lista[0].id}`, { token, body: { nombre: 'Principal' } });
  await api('POST', `/api/depositos/${lista[0].id}/predeterminado`, { token }); // vuelve el original
  assert.equal((await api('POST', '/api/depositos/99999/predeterminado', { token })).status, 404);
});

test('Stock.RF03: cada sector de comanda descuenta de su depósito; sin asignar, del predeterminado', async () => {
  const Deposito = require('../src/models/depositoModel');
  const barra = (await api('POST', '/api/sectores', { token, body: { nombre: 'Barra' } })).json;
  const cocina = (await api('POST', '/api/sectores', { token, body: { nombre: 'Cocina' } })).json;
  const vitrina = (await api('POST', '/api/depositos', { token, body: { nombre: 'Vitrina' } })).json;
  assert.equal((await Deposito.depositoDeSector(barra.id)).nombre, 'Principal'); // sin asignar
  assert.equal((await api('PUT', `/api/depositos/sectores/${barra.id}`, { token, body: { deposito_id: vitrina.id } })).status, 200);
  assert.equal((await Deposito.depositoDeSector(barra.id)).nombre, 'Vitrina');
  assert.equal((await Deposito.depositoDeSector(cocina.id)).nombre, 'Principal');
  assert.equal((await Deposito.depositoDeSector(null)).nombre, 'Principal'); // artículo sin sector
  assert.equal((await api('PUT', `/api/depositos/sectores/${barra.id}`, { token, body: { deposito_id: 99999 } })).status, 400);
  const lista = (await api('GET', '/api/depositos/sectores', { token })).json;
  assert.equal(lista.find((s) => s.sector === 'Barra').deposito_id, vitrina.id);
  assert.equal((await api('PUT', `/api/depositos/sectores/${barra.id}`, { token, body: { deposito_id: null } })).json.quitado, true);
  assert.equal((await Deposito.depositoDeSector(barra.id)).nombre, 'Principal');
});

test('Stock.RF01: cada ítem define si controla stock, si es de control estricto o admite negativo, y su mínimo por depósito', async () => {
  const harina = await insumo('Harina');
  const dep = (await api('GET', '/api/depositos', { token })).json.find((d) => d.predeterminado);
  const base = (await api('GET', `/api/insumos/${harina.id}/configuracion`, { token })).json;
  assert.deepEqual([base.controla_stock, base.control_estricto, base.permite_negativo], [1, 0, 0]);
  const r = await api('PUT', `/api/insumos/${harina.id}/configuracion`, { token, body: { control_estricto: true, permite_negativo: true, depositos: [{ deposito_id: dep.id, stock_minimo: 2, punto_reposicion: 5 }] } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.controla_stock, r.json.control_estricto, r.json.permite_negativo], [1, 1, 1]);
  assert.deepEqual(r.json.depositos.map((d) => [Number(d.stock_minimo), Number(d.punto_reposicion)]), [[2, 5]]);
  assert.equal((await api('PUT', `/api/insumos/${harina.id}/configuracion`, { token, body: { controla_stock: 'si' } })).status, 400);
  assert.equal((await api('PUT', `/api/insumos/${harina.id}/configuracion`, { token, body: { depositos: [{ deposito_id: 99999, stock_minimo: 1, punto_reposicion: 1 }] } })).status, 400);
  assert.equal((await api('PUT', `/api/insumos/${harina.id}/configuracion`, { token, body: { depositos: [{ deposito_id: dep.id, stock_minimo: -1, punto_reposicion: 1 }] } })).status, 400);
  assert.equal((await api('PUT', '/api/insumos/99999/configuracion', { token, body: {} })).status, 404);
});

test('Stock.RF02: una presentación tiene factor a la unidad base, usos y precisión configurada', async () => {
  const leche = await insumo('Leche', 'l');
  const caja = await presentacion({ insumo_id: leche.id, nombre: 'caja x12', factor: 12, usos: ['compra'] });
  assert.equal(caja.status, 201);
  assert.deepEqual([caja.json.version, Number(caja.json.factor), caja.json.usos], [1, 12, 'compra']);
  assert.equal((await presentacion({ insumo_id: leche.id, nombre: 'caja x12', factor: 6, usos: ['compra'] })).status, 409); // ya hay una vigente
  for (const mal of [{ factor: 0 }, { factor: -2 }, { factor: 'x' }, { factor: 1.1234567 }, { usos: [] }, { usos: ['regalo'] }, { nombre: ' ' }])
    assert.equal((await presentacion({ insumo_id: leche.id, nombre: 'sachet', factor: 1, usos: ['compra'], ...mal })).status, 400, JSON.stringify(mal));
  assert.equal((await presentacion({ insumo_id: 99999, nombre: 'x', factor: 1, usos: ['compra'] })).status, 404);
  assert.equal((await presentacion({ insumo_id: leche.id, nombre: 'mililitro', factor: 0.001, usos: ['receta', 'venta'] })).status, 201);
  assert.deepEqual((await api('GET', `/api/presentaciones?insumo_id=${leche.id}`, { token })).json.map((p) => p.nombre), ['caja x12', 'mililitro']);
});

test('Stock.RN61/EX46: una presentación que se usó no se edita: se crea una versión nueva y la anterior vence', async () => {
  const cafe = await insumo('Café', 'kg');
  const gramo = (await presentacion({ insumo_id: cafe.id, nombre: 'gramo', factor: 0.001, usos: ['receta'] })).json;
  // Sin usos, se edita en el lugar.
  const enLugar = await api('PUT', `/api/presentaciones/${gramo.id}`, { token, body: { factor: 0.0011 } });
  assert.deepEqual([enLugar.json.nueva_version, enLugar.json.id, Number(enLugar.json.factor)], [false, gramo.id, 0.0011]);
  assert.equal((await api('PUT', `/api/presentaciones/${gramo.id}`, { token, body: { factor: 0 } })).status, 400);

  // La usa una receta: ahora queda congelada.
  const producto = (await api('POST', '/api/productos', { token, body: { nombre: 'Espresso', precio: 100, stock: 100 } })).json;
  const linea = await api('POST', `/api/productos/${producto.id}/insumos`, { token, body: { insumo_id: cafe.id, cantidad_consumida: 18, presentacion_id: gramo.id } });
  assert.equal(linea.status, 201);
  assert.equal(Number(linea.json.factor_aplicado), 0.0011); // instantánea del factor
  assert.equal((await api('GET', `/api/presentaciones/${gramo.id}`, { token })).json.en_uso, true);

  const nueva = await api('PUT', `/api/presentaciones/${gramo.id}`, { token, body: { factor: 0.0012 } });
  assert.equal(nueva.status, 200);
  assert.deepEqual([nueva.json.nueva_version, nueva.json.version, nueva.json.version_anterior_id, Number(nueva.json.factor)], [true, 2, gramo.id, 0.0012]);
  const vieja = (await api('GET', `/api/presentaciones/${gramo.id}`, { token })).json;
  assert.ok(vieja.vigente_hasta); // la anterior venció
  assert.equal(Number(vieja.factor), 0.0011); // y conserva su factor
  // La receta ya cargada sigue con el factor que tenía.
  assert.equal(Number((await api('GET', `/api/productos/${producto.id}/insumos`, { token })).json[0].factor_aplicado), 0.0011);
  assert.equal((await api('PUT', `/api/presentaciones/${gramo.id}`, { token, body: { factor: 0.5 } })).status, 409); // la vencida no se edita
  assert.deepEqual((await api('GET', `/api/presentaciones?insumo_id=${cafe.id}&vigentes=1`, { token })).json.map((p) => p.version), [2]);
  assert.equal((await api('POST', `/api/presentaciones/${nueva.json.id}/baja`, { token })).status, 200);
  assert.equal((await api('POST', `/api/presentaciones/${nueva.json.id}/baja`, { token })).status, 404);
});

test('Stock.RF02: una receta en gramos de un ítem que se controla en kg descuenta en unidades base', async () => {
  const Producto = require('../src/models/productoModel');
  const harina = await insumo('Harina 000', 'kg', 10);
  const gramo = (await presentacion({ insumo_id: harina.id, nombre: 'gramo', factor: 0.001, usos: ['receta'] })).json;
  const kilo = (await presentacion({ insumo_id: harina.id, nombre: 'bolsa 25 kg', factor: 25, usos: ['compra'] })).json;
  const otro = await insumo('Azúcar', 'kg');
  const pan = (await api('POST', '/api/productos', { token, body: { nombre: 'Pan', tipo: 'elaborado', precio: 100 } })).json;
  const agregar = (body) => api('POST', `/api/productos/${pan.id}/insumos`, { token, body });
  assert.equal((await agregar({ insumo_id: harina.id, cantidad_consumida: 200, presentacion_id: kilo.id })).status, 400); // no es de uso "receta"
  assert.equal((await agregar({ insumo_id: otro.id, cantidad_consumida: 200, presentacion_id: gramo.id })).status, 400); // es de otro insumo
  assert.equal((await agregar({ insumo_id: harina.id, cantidad_consumida: 200, presentacion_id: 99999 })).status, 400);
  assert.equal((await agregar({ insumo_id: harina.id, cantidad_consumida: 200, presentacion_id: gramo.id })).status, 201); // 200 g

  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: pan.id, cantidad: 2 }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-stock-${++k}-abcdef` }, body: { metodo_pago: 'efectivo' } });
  assert.equal(r.status, 200);
  await esperarMensajes(pool);
  assert.equal(await stockDe(harina.id), 9.6); // 2 panes x 200 g = 0,4 kg
  const dev = await api('POST', '/api/devoluciones', { token, headers: { 'X-ID-Solicitud': `devol-stock-${++k}-abcdef` }, body: { venta_id_global: r.json.venta_id_global, motivo: 'prueba', todo: true } });
  assert.equal(dev.status, 201);
  await esperarMensajes(pool);
  assert.equal(await stockDe(harina.id), 10); // el reingreso usa el mismo factor
  assert.ok(Producto);
});
