const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token, n = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

const producto = async (nombre, extra = {}) => (await api('POST', '/api/productos', { token, body: { nombre: `${nombre} ${++n}`, precio: 100, ...extra } })).json;

test('Stock.RF27: STK-ETIQUETAS viene apagada y sus rutas se bloquean', async () => {
  assert.equal((await api('GET', '/api/etiquetas/plantillas', { token })).status, 409);
  const act = await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['STK-ETIQUETAS'], motivo: 'prueba' } });
  assert.equal(act.status, 200, JSON.stringify(act.json));
});

test('Stock.RN82: el verificador es EAN-13 módulo 10 y la etiqueta de peso se genera y se valida con prefijo, artículo y peso', async () => {
  const { verificador } = require('../src/stock/etiquetaService');
  assert.equal(verificador('400638133393'), 1); // EAN-13 de referencia 4006381333931
  assert.equal(verificador('590123412345'), 7); // 5901234123457
  const p = await producto('Queso');
  const c = await api('PUT', `/api/etiquetas/articulos/${p.id}/codigo`, { token, body: {} });
  assert.equal(c.json.codigo_etiqueta, '00001');
  assert.equal((await api('PUT', `/api/etiquetas/articulos/${p.id}/codigo`, { token, body: {} })).json.codigo_etiqueta, '00001'); // ya tiene
  const q = await producto('Jamón');
  assert.equal((await api('PUT', `/api/etiquetas/articulos/${q.id}/codigo`, { token, body: { codigo: 1 } })).status, 409); // lo tiene otro

  assert.equal((await api('POST', `/api/etiquetas/articulos/${p.id}/peso`, { token, body: { peso: 100000 } })).status, 400);
  const g = await api('POST', `/api/etiquetas/articulos/${p.id}/peso`, { token, body: { peso: 1250 } });
  assert.equal(g.status, 201, JSON.stringify(g.json));
  const codigo = g.json.codigo;
  assert.equal(codigo.slice(0, 12), '290000101250');
  const v = (await api('GET', `/api/etiquetas/validar/${codigo}`, { token })).json;
  assert.deepEqual([v.valida, v.producto_id, v.peso], [true, p.id, 1250]);

  // EX59: prefijo ajeno, verificador inválido, artículo inexistente, largo incorrecto.
  const malVerif = `${codigo.slice(0, 12)}${(Number(codigo[12]) + 1) % 10}`;
  assert.match((await api('GET', `/api/etiquetas/validar/${malVerif}`, { token })).json.motivo, /verificador/);
  const ajeno = `20${codigo.slice(2, 12)}`;
  const ajenoOk = `${ajeno}${require('../src/stock/etiquetaService').verificador(ajeno)}`;
  assert.match((await api('GET', `/api/etiquetas/validar/${ajenoOk}`, { token })).json.motivo, /prefijo/);
  const sinArt = `29099990100`.padEnd(12, '0');
  const sinArtOk = `${sinArt}${require('../src/stock/etiquetaService').verificador(sinArt)}`;
  assert.match((await api('GET', `/api/etiquetas/validar/${sinArtOk}`, { token })).json.motivo, /no existe/);
  assert.equal((await api('GET', '/api/etiquetas/validar/123', { token })).json.valida, false);

  // El puerto de Stock entrega la validación a Ventas.
  const puerto = await require('../src/modulos/puertos').obtener('stock');
  assert.equal((await puerto.validarEtiqueta(codigo)).peso, 1250);

  // El prefijo propio es de la instancia: 2 dígitos, sin chocar con el catálogo, y no cambia con etiquetas ya impresas.
  assert.equal((await api('PUT', '/api/etiquetas/prefijo', { token, body: { prefijo: '7' } })).status, 400);
  assert.equal((await api('PUT', '/api/etiquetas/prefijo', { token, body: { prefijo: '31' } })).status, 409); // ya hay etiquetas de peso
});

test('Stock.RF27/RN40: la etiqueta de góndola se imprime con la plantilla de la impresora y queda desactualizada si cambia el precio', async () => {
  const p = await producto('Alfajor', { codigo_barras: '7791234567890' });
  assert.equal((await api('POST', `/api/etiquetas/articulos/${p.id}/gondola`, { token, body: { impresora: 'Zebra' } })).status, 404); // sin plantilla
  const pl = await api('PUT', '/api/etiquetas/plantillas', { token, body: { tipo: 'gondola', impresora: 'Zebra', contenido: '{{nombre}} ${{precio}} [{{codigo_barras}}]' } });
  assert.equal(pl.status, 200, JSON.stringify(pl.json));
  const e = await api('POST', `/api/etiquetas/articulos/${p.id}/gondola`, { token, body: { impresora: 'Zebra' } });
  assert.equal(e.status, 201, JSON.stringify(e.json));
  assert.equal(e.json.texto, `${p.nombre} $100.00 [7791234567890]`);
  assert.equal((await api('GET', '/api/etiquetas/desactualizadas', { token })).json.length, 0);
  await pool.query('UPDATE productos SET precio = 150 WHERE id = ?', [p.id]);
  const d = (await api('GET', '/api/etiquetas/desactualizadas', { token })).json;
  assert.deepEqual(d.map((x) => [x.producto_id, x.precio_impreso, x.precio_vigente]), [[p.id, 100, 150]]);
  await api('POST', `/api/etiquetas/articulos/${p.id}/gondola`, { token, body: {} }); // reimpresión al precio nuevo
  assert.equal((await api('GET', '/api/etiquetas/desactualizadas', { token })).json.length, 0);
});

test('Stock.RF27: la etiqueta de elaborado lleva lote, vencimiento, alérgenos, conservación y un QR con artículo y lote', async () => {
  const harina = (await api('POST', '/api/insumos', { token, body: { nombre: 'Harina E', unidad: 'kg' } })).json;
  const gluten = (await api('GET', '/api/alergenos', { token })).json.find((a) => a.codigo === 'gluten');
  await api('PUT', `/api/alergenos/item/insumo/${harina.id}`, { token, body: { alergenos: [{ alergeno_id: gluten.id, tipo: 'contiene' }] } });
  const pan = await producto('Pan', { tipo: 'elaborado' });
  await api('PUT', `/api/recetas/${pan.id}`, { token, body: { lineas: [{ insumo_id: harina.id, cantidad_consumida: 0.5 }] } });
  await api('PUT', `/api/produccion/ficha/${pan.id}`, { token, body: { conservacion: 'Ambiente seco', peso_porcion: 0.4 } });
  await api('PUT', `/api/lotes/configuracion/producto/${pan.id}`, { token, body: { controla_lote: true, vida_util_dias: 3 } });
  await api('PUT', '/api/etiquetas/plantillas', { token, body: { tipo: 'elaborado', impresora: 'Zebra', contenido: '{{nombre}} L{{lote}} vto {{vencimiento}} | {{alergenos}} | {{conservacion}} | {{peso_neto}} | {{qr}}' } });
  await api('POST', '/api/stock/ingresos', { token, body: { motivo: 'compra', lineas: [{ item: { tipo: 'insumo', id: harina.id }, cantidad: 20, costo_unitario: 5 }] } });
  const o = (await api('POST', '/api/produccion/ordenes', { token, body: { producto_id: pan.id, cantidad: 5 } })).json;
  assert.equal((await api('POST', `/api/produccion/ordenes/${o.id}/confirmar`, { token, body: { lote_codigo: 'PAN1' } })).status, 200);
  assert.equal((await api('POST', `/api/etiquetas/articulos/${pan.id}/elaborado`, { token, body: { impresora: 'Zebra' } })).status, 400); // falta el lote
  const e = await api('POST', `/api/etiquetas/articulos/${pan.id}/elaborado`, { token, body: { impresora: 'Zebra', lote: 'PAN1' } });
  assert.equal(e.status, 201, JSON.stringify(e.json));
  assert.equal(e.json.datos.lote, 'PAN1');
  assert.equal(e.json.datos.alergenos, 'Gluten / TACC');
  assert.equal(e.json.datos.qr, `P:${pan.id}|L:PAN1`);
  assert.match(e.json.texto, /Ambiente seco \| 0.4 \| P:/);
  assert.ok(e.json.datos.vencimiento);
});
