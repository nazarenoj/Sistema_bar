const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');

let api, pool, cerrar, adm, gerente, administrativo, cajero, A, B, C, combo;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  cajero = await usuario(api, pool, 'cami', 'cajero');
  await api('POST', '/api/modulos/ventas_online/instalar', { token: adm.token });
  const r = await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { codigo: 'cafe-catalogo', nombre: 'Cafe', razon_social: 'Cafe SA', cuit: '30711111111', domicilio: 'Mitre 1', activa: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // A y C no admiten stock negativo (se controlan); B no controla stock.
  const estricto = async (nombre, stock, precio = 100) => {
    const p = (await api('POST', '/api/productos', { token: adm.token, body: { nombre, precio, stock } })).json;
    await api('PUT', `/api/stock/configuracion/producto/${p.id}`, { token: adm.token, body: { permite_negativo: false } });
    return p;
  };
  A = await estricto('Cafe en grano 250 g', 5, 1000);
  C = await estricto('Budin agotado', 0, 300);
  B = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Cafe de filtro', precio: 500, stock: 0 } })).json;
  combo = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Pack degustacion', precio: 1800, stock: 0 } })).json;
  await pool.query("UPDATE productos SET tipo = 'combo' WHERE id = ?", [combo.id]);
  await pool.query('INSERT INTO producto_componentes (combo_id, componente_id, cantidad) VALUES (?, ?, 2)', [combo.id, A.id]);
});
after(async () => { await cerrar(); });

const pub = (id, body, t = gerente) => api('PUT', `/api/ventas-online/catalogo/${id}`, { token: t.token, body });
const cat = async (q = '') => (await api('GET', `/tienda/cafe-catalogo/catalogo${q}`)).json;
const de = (lista, p) => lista.find((x) => x.id === p.id);

test('Ventas Online.RF02: se eligen los articulos a publicar con titulo, fotos, categoria y visibilidad programada', async () => {
  assert.deepEqual(await cat(), []);
  assert.equal((await pub(A.id, { titulo: 'Cafe 250 g' }, cajero)).status, 403);
  assert.equal((await pub(99999, {})).status, 404);
  assert.equal((await pub(A.id, { fotos: ['javascript:x'] })).status, 400);
  assert.equal((await pub(A.id, { visible_desde: '2030-02-01', visible_hasta: '2030-01-01' })).status, 400);
  const r = await pub(A.id, { titulo: 'Cafe en grano 250 g', descripcion: 'Tostado de la casa', fotos: ['https://x.test/a.jpg'], categoria_online: 'Cafe', orden: 1, atributos: { molienda: ['grano', 'espresso'] }, margen_seguridad: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.publicado, true);
  await pub(B.id, { categoria_online: 'Bebidas', orden: 2 });
  await pub(C.id, { categoria_online: 'Panaderia', orden: 3 });
  await pub(combo.id, { titulo: 'Pack degustacion', categoria_online: 'Cafe', orden: 4 });
  const l = await cat();
  assert.equal(l.length, 4);
  assert.equal(de(l, A).titulo, 'Cafe en grano 250 g'); assert.deepEqual(de(l, A).atributos.molienda, ['grano', 'espresso']);
  assert.equal(l.find((x) => x.id === B.id).titulo, 'Cafe de filtro'); // sin titulo online usa el de Ventas
  // Visibilidad programada: un articulo fuera de ventana no se muestra.
  await pub(B.id, { visible_desde: '2099-01-01' });
  assert.equal((await cat()).some((x) => x.id === B.id), false);
  await pub(B.id, { visible_desde: null });
  assert.equal((await cat()).some((x) => x.id === B.id), true);
  assert.deepEqual((await api('GET', '/tienda/cafe-catalogo/categorias')).json.map((c) => c.nombre), ['Bebidas', 'Cafe', 'Panaderia']);
  assert.equal((await api('DELETE', `/api/ventas-online/catalogo/${C.id}`, { token: gerente.token })).status, 200);
  assert.equal((await api('DELETE', `/api/ventas-online/catalogo/${C.id}`, { token: gerente.token })).status, 404);
  await pub(C.id, { categoria_online: 'Panaderia', orden: 3 });
});

test('Ventas Online.RF03: sin listas el precio es el de Ventas mas el ajuste global o por categoria', async () => {
  assert.equal(de(await cat(), A).precio, 1000);
  assert.equal((await api('PUT', '/api/ventas-online/precios/ajustes', { token: gerente.token, body: { global: 1000 } })).status, 400);
  assert.equal((await api('PUT', '/api/ventas-online/precios/ajustes', { token: gerente.token, body: { global: 10 } })).json.global, 10);
  assert.equal(de(await cat(), A).precio, 1100);
  const [[c]] = [await pool.query("INSERT INTO categorias_producto (nombre) VALUES ('Granos')").then(([r]) => [{ id: r.insertId }])];
  await pool.query('UPDATE productos SET categoria_id = ? WHERE id = ?', [c.id, A.id]);
  await api('PUT', '/api/ventas-online/precios/ajustes', { token: gerente.token, body: { categorias: [{ categoria_id: c.id, pct: -20 }] } });
  assert.equal(de(await cat(), A).precio, 800); // la categoria manda sobre el ajuste global
  assert.equal(de(await cat(), B).precio, 550);
  assert.equal((await api('PUT', '/api/ventas-online/precios/ajustes', { token: gerente.token, body: { categorias: [{ categoria_id: 99999, pct: 5 }] } })).status, 404);
});

test('Ventas Online.RF03: con VEN-LISTAS el precio online es el de la lista Online y, sin precio en ella, el base', async () => {
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['VEN-LISTAS'], motivo: 'prueba' } });
  const [l] = await pool.query("INSERT INTO listas_precio (nombre, tipo) VALUES ('Online', 'online')");
  await pool.query('INSERT INTO lista_precio_items (lista_id, producto_id, precio) VALUES (?, ?, 900)', [l.insertId, A.id]);
  const lista = await cat();
  assert.equal(de(lista, A).precio, 900); assert.equal(de(lista, A).lista, 'Online');
  assert.equal(de(lista, B).precio, 500); assert.equal(de(lista, B).lista, 'Minorista'); // sin precio en la lista: el base, sin ajuste
});

test('Ventas Online.RF04/RN03: la sincronizacion publica lo que hay en Stock menos el margen; un articulo sin disponible no se vende', async () => {
  assert.equal((await api('POST', '/api/ventas-online/sincronizar', { token: cajero.token })).status, 403);
  const s = await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const l = await cat();
  assert.equal(de(l, A).disponible, 4); assert.equal(de(l, A).vendible, true); // 5 en Stock menos el margen de 1
  assert.equal(de(l, C).disponible, 0); assert.equal(de(l, C).vendible, false); // sin stock: no se vende
  assert.equal(de(l, B).disponible, null); assert.equal(de(l, B).vendible, true); // no controla stock
  assert.equal(de(l, combo).disponible, 2); // combo virtual: 5 de A / 2 por combo
});

test('Ventas Online.RN03: lo comprometido por una venta baja lo publicado en el siguiente ciclo y el agotado manual se respeta', async () => {
  const Comp = require('../src/stock/compromisoService');
  const r = await Comp.comprometer({ idSolicitud: 'prueba-online-1', lineas: [{ linea: 0, producto_id: A.id, cantidad: 3 }] });
  assert.equal(r.ok, true);
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
  assert.equal(de(await cat(), A).disponible, 1); // 5 - 3 comprometidos - margen 1
  await Comp.liberar(r.id_compromiso);
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
  assert.equal(de(await cat(), A).disponible, 4);
  const m = await api('PUT', `/api/ventas-online/catalogo/${B.id}/disponibilidad`, { token: gerente.token, body: { agotado: true } });
  assert.equal(m.status, 200); assert.equal(m.json.agotado, true);
  assert.equal(de(await cat(), B).vendible, false);
  assert.equal((await api('PUT', `/api/ventas-online/catalogo/${B.id}/disponibilidad`, { token: gerente.token, body: { cantidad: -1 } })).status, 400);
  await api('PUT', `/api/ventas-online/catalogo/${B.id}/disponibilidad`, { token: gerente.token, body: { agotado: false, cantidad: 7 } });
  assert.equal(de(await cat(), B).disponible, 7);
  // Un articulo marcado agotado en Ventas tampoco se vende.
  await pool.query('UPDATE productos SET agotado = 1 WHERE id = ?', [B.id]);
  assert.equal(de(await cat(), B).vendible, false);
  await pool.query('UPDATE productos SET agotado = 0 WHERE id = ?', [B.id]);
});

test('Ventas Online.RN04: con la disponibilidad desactualizada se avisa y la tienda sigue mostrando lo ultimo publicado', async () => {
  const antes = await cat();
  await pool.query('UPDATE onl_sync SET ultima_ms = ? WHERE id = 1', [Date.now() - 31 * 60000]);
  const est = (await api('GET', '/api/ventas-online/sincronizacion', { token: gerente.token })).json;
  assert.equal(est.desactualizada, true);
  const l = await cat();
  assert.equal(l.length, antes.length); // sigue mostrando (RN02)
  assert.equal(de(l, A).disponibilidad_no_confirmada, true);
  assert.equal(de(l, B).disponibilidad_no_confirmada, true);
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
  assert.equal((await api('GET', '/api/ventas-online/sincronizacion', { token: gerente.token })).json.desactualizada, false);
});

test('Ventas Online.RF02: busqueda, categoria y orden en la tienda publica', async () => {
  assert.deepEqual((await cat('?categoria=Cafe')).map((x) => x.id).sort(), [A.id, combo.id].sort());
  assert.deepEqual((await cat('?q=filtro')).map((x) => x.id), [B.id]);
  const porPrecio = await cat('?orden=precio');
  assert.deepEqual(porPrecio.map((x) => x.precio), [...porPrecio.map((x) => x.precio)].sort((a, b) => a - b));
  assert.equal((await api('GET', '/tienda/cafe-catalogo/catalogo')).status, 200);
  assert.equal((await api('GET', '/tienda/otra/catalogo')).status, 404);
});
