const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [r] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [r.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

const crear = (body) => api('POST', '/api/productos', { token, body: { nombre: 'P', precio: 10, ...body } });
const combo = async (nombre) => (await crear({ nombre, tipo: 'combo' })).json.id;
const componentes = (id, hijos) => api('PUT', `/api/productos/${id}/componentes`, { token, body: { componentes: hijos.map((c) => ({ componente_id: c, cantidad: 1 })) } });

test('Ventas.RN02: SKU y código de barras duplicados se bloquean; sin valor pueden repetirse', async () => {
  assert.equal((await crear({ nombre: 'A', sku: 'X1', codigo_barras: '779' })).status, 201);
  const dup = await crear({ nombre: 'B', sku: 'X1' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.codigo, 'CODIGO_DUPLICADO');
  assert.equal((await crear({ nombre: 'C', codigo_barras: '779' })).status, 409);
  assert.equal((await crear({ nombre: 'D' })).status, 201);
  assert.equal((await crear({ nombre: 'E' })).status, 201);
});

test('Ventas.RF01: tipo, IVA y pesos inválidos se rechazan; los datos del catálogo se guardan', async () => {
  assert.equal((await crear({ tipo: 'raro' })).status, 400);
  assert.equal((await crear({ alicuota_iva: 13 })).status, 400);
  assert.equal((await crear({ tipo: 'pesable', peso_minimo: 5, peso_maximo: 1 })).status, 400);
  const cat = (await api('POST', '/api/categorias', { token, body: { nombre: 'Bebidas' } })).json;
  const sec = (await api('POST', '/api/sectores', { token, body: { nombre: 'Barra' } })).json;
  const p = await crear({ nombre: 'Queso', tipo: 'pesable', alicuota_iva: 10.5, categoria_id: cat.id, sector_id: sec.id, tara: 0.05, peso_minimo: 0.1, peso_maximo: 2 });
  assert.equal(p.status, 201);
  assert.equal(p.json.tipo, 'pesable');
  assert.equal(Number(p.json.alicuota_iva), 10.5);
  assert.equal((await crear({ categoria_id: 99999 })).status, 400);
  assert.equal((await api('DELETE', `/api/categorias/${cat.id}`, { token })).status, 409); // en uso
});

test('Ventas.RN04/EX55: peso cero, inestable o fuera de rango se rechaza', () => {
  const { validarPeso } = require('../src/controllers/productoController');
  const queso = { tara: 0.05, peso_minimo: 0.1, peso_maximo: 2 };
  assert.equal(validarPeso(queso, 0.55, true), 0.5);
  assert.throws(() => validarPeso(queso, 0.55, false), /estable/);
  assert.throws(() => validarPeso(queso, 0.05, true), /mayor que cero/);
  assert.throws(() => validarPeso(queso, 0.1, true), /mínimo/);
  assert.throws(() => validarPeso(queso, 3, true), /máximo/);
});

test('Ventas.RN03: un combo con ciclo o con más de 3 niveles se rechaza y no cambia nada', async () => {
  const [a, b, c, d, e] = await Promise.all(['ca', 'cb', 'cc', 'cd', 'ce'].map(combo));
  assert.equal((await componentes(a, [a])).status, 400); // se contiene a sí mismo
  assert.equal((await componentes(a, [b])).status, 200);
  assert.equal((await componentes(b, [c])).status, 200);
  assert.equal((await componentes(c, [d])).status, 200); // a > b > c > d: 3 niveles
  assert.equal((await componentes(d, [e])).status, 400); // 4 niveles
  assert.equal((await componentes(d, [a])).status, 400); // ciclo
  assert.equal((await api('GET', `/api/productos/${d}/componentes`, { token })).json.length, 0);
  assert.equal((await componentes((await crear({ nombre: 'comun' })).json.id, [a])).status, 400); // no es combo
});

test('Ventas.RF01: un producto agotado no se puede cargar a un pedido', async () => {
  const p = (await crear({ nombre: 'Agotable', agotado: true })).json;
  assert.equal(p.agotado, 1);
  const r = await api('POST', '/api/pedidos/1/productos', { token, body: { productos: [{ producto_id: p.id, cantidad: 1 }] } });
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'PRODUCTO_AGOTADO');
});
