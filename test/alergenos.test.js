const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token, cat;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
  cat = Object.fromEntries((await api('GET', '/api/alergenos', { token })).json.map((a) => [a.codigo, a.id]));
});
after(async () => { await cerrar(); });

const insumo = async (nombre) => (await api('POST', '/api/insumos', { token, body: { nombre, unidad: 'kg' } })).json;
const producto = async (nombre, tipo = 'elaborado') => (await api('POST', '/api/productos', { token, body: { nombre, precio: 100, tipo } })).json;
const declarar = (tipo, id, alergenos) => api('PUT', `/api/alergenos/item/${tipo}/${id}`, { token, body: { alergenos } });
const receta = (id, lineas) => api('PUT', `/api/recetas/${id}`, { token, body: { lineas } });
const articulo = async (id) => (await api('GET', `/api/alergenos/articulo/${id}`, { token })).json;
const tipos = (r) => Object.fromEntries(r.alergenos.map((a) => [a.codigo, a.tipo]));

test('Stock.RF22/RN33: un elaborado hereda los alérgenos de sus insumos y sub-recetas; contiene prevalece sobre trazas', async () => {
  const harina = await insumo('Harina A');
  const leche = await insumo('Leche A');
  const sal = await insumo('Sal A');
  await declarar('insumo', harina.id, [{ alergeno_id: cat.gluten, tipo: 'contiene' }, { alergeno_id: cat.soja, tipo: 'trazas' }]);
  await declarar('insumo', leche.id, [{ alergeno_id: cat.lacteos, tipo: 'contiene' }, { alergeno_id: cat.soja, tipo: 'contiene' }]);
  await declarar('insumo', sal.id, []); // revisado: no tiene
  const masa = await producto('Masa A');
  await receta(masa.id, [{ insumo_id: harina.id, cantidad_consumida: 1 }, { insumo_id: sal.id, cantidad_consumida: 0.01 }]);
  const torta = await producto('Torta A');
  await receta(torta.id, [{ componente_producto_id: masa.id, cantidad_consumida: 1 }, { insumo_id: leche.id, cantidad_consumida: 0.2 }]);
  const r = await articulo(torta.id);
  assert.deepEqual(tipos(r), { gluten: 'contiene', lacteos: 'contiene', soja: 'contiene' }); // la soja en trazas y contiene → contiene
  assert.equal(r.incompletos, false);
  assert.deepEqual(r.alergenos.find((a) => a.codigo === 'gluten').origenes, ['derivado']);
  // Si cambia un insumo, el derivado cambia solo (RN34).
  await declarar('insumo', harina.id, []);
  assert.deepEqual(tipos(await articulo(torta.id)), { lacteos: 'contiene', soja: 'contiene' });
});

test('Stock.EX22: un componente sin alérgenos declarados deja el elaborado como "incompleto" sin bloquear', async () => {
  const huevo = await insumo('Huevo B');
  const azucar = await insumo('Azúcar B');
  await declarar('insumo', huevo.id, [{ alergeno_id: cat.huevo, tipo: 'contiene' }]);
  const flan = await producto('Flan B');
  await receta(flan.id, [{ insumo_id: huevo.id, cantidad_consumida: 1 }, { insumo_id: azucar.id, cantidad_consumida: 1 }]);
  const r = await articulo(flan.id);
  assert.equal(r.incompletos, true);
  assert.deepEqual(r.faltantes, ['Azúcar B']);
  assert.deepEqual(tipos(r), { huevo: 'contiene' });
  await declarar('insumo', azucar.id, []);
  assert.equal((await articulo(flan.id)).incompletos, false);
});

test('Stock.RN33: quitar un derivado exige motivo y queda auditado; lo declarado a mano se suma', async () => {
  const mani = await insumo('Maní C');
  await declarar('insumo', mani.id, [{ alergeno_id: cat.mani, tipo: 'trazas' }]);
  const barra = await producto('Barra C');
  await receta(barra.id, [{ insumo_id: mani.id, cantidad_consumida: 1 }]);
  await declarar('producto', barra.id, [{ alergeno_id: cat.gluten, tipo: 'contiene' }]);
  assert.deepEqual(tipos(await articulo(barra.id)), { mani: 'trazas', gluten: 'contiene' });
  assert.equal((await api('POST', `/api/alergenos/articulo/${barra.id}/quitar`, { token, body: { alergeno_id: cat.mani } })).status, 400); // sin motivo
  const q = await api('POST', `/api/alergenos/articulo/${barra.id}/quitar`, { token, body: { alergeno_id: cat.mani, motivo: 'Proveedor certificó libre de maní' } });
  assert.equal(q.status, 200, JSON.stringify(q.json));
  assert.deepEqual(tipos(q.json), { gluten: 'contiene' });
  const [[a]] = await pool.query("SELECT COUNT(*) AS n FROM auditoria WHERE accion = 'alergeno_quitado'");
  assert.equal(a.n, 1);
  await api('DELETE', `/api/alergenos/articulo/${barra.id}/quitar/${cat.mani}`, { token });
  assert.equal(tipos(await articulo(barra.id)).mani, 'trazas');
});

test('Stock.RF39/RN77: una línea suma las opciones elegidas y los componentes de un combo, y una sustitución no quita nada', async () => {
  const leche = await insumo('Leche D');
  const avena = await insumo('Bebida de avena D');
  const soja = await insumo('Bebida de soja D');
  await declarar('insumo', leche.id, [{ alergeno_id: cat.lacteos, tipo: 'contiene' }]);
  await declarar('insumo', avena.id, [{ alergeno_id: cat.gluten, tipo: 'trazas' }]);
  await declarar('insumo', soja.id, [{ alergeno_id: cat.soja, tipo: 'contiene' }]);
  const cafe = await producto('Café con leche D');
  await receta(cafe.id, [{ insumo_id: leche.id, cantidad_consumida: 0.2 }]);
  const l = await api('POST', '/api/alergenos/linea', { token, body: { producto_id: cafe.id, opciones: [{ insumo_id: soja.id }, { insumo_id: avena.id }] } });
  assert.equal(l.status, 200, JSON.stringify(l.json));
  assert.deepEqual(tipos(l.json), { lacteos: 'contiene', soja: 'contiene', gluten: 'trazas' }); // el lácteo del base se conserva
  assert.deepEqual(l.json.alergenos.find((a) => a.codigo === 'soja').origenes, ['opcion']);
  // Combo: los de sus componentes, recursivamente.
  const combo = await producto('Combo D', 'combo');
  assert.equal((await api('PUT', `/api/productos/${combo.id}/componentes`, { token, body: { componentes: [{ componente_id: cafe.id, cantidad: 1 }] } })).status, 200);
  assert.deepEqual(tipos(await articulo(combo.id)), { lacteos: 'contiene' });
});

test('Stock.RF22: el catálogo se amplía sin duplicar y el puerto de Stock entrega la línea a Ventas', async () => {
  assert.equal((await api('POST', '/api/alergenos', { token, body: { codigo: 'sesamo', nombre: 'Sésamo' } })).status, 201);
  assert.equal((await api('POST', '/api/alergenos', { token, body: { codigo: 'sesamo', nombre: 'Otro' } })).status, 409);
  const simple = await producto('Agua E', 'estandar');
  const puertos = require('../src/modulos/puertos');
  const p = await puertos.obtener('stock');
  assert.equal(typeof p.alergenosLinea, 'function');
  assert.equal((await p.alergenosLinea(simple.id, [])).incompletos, true); // artículo sin declarar ni revisar
});
