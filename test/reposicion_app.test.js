const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token, principal, n = 0, g = 0;
const DIA = 86400000;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
  principal = (await api('GET', '/api/depositos', { token })).json.find((d) => d.predeterminado);
});
after(async () => { await cerrar(); });

const insumo = async (nombre) => (await api('POST', '/api/insumos', { token, body: { nombre: `${nombre} ${++n}`, unidad: 'kg' } })).json;
const ingreso = (i, cantidad) => api('POST', '/api/stock/ingresos', { token, body: { motivo: 'compra', lineas: [{ item: { tipo: 'insumo', id: i.id }, cantidad, costo_unitario: 1 }] } });
// Consumo histórico: `porDia` por día durante las últimas 8 semanas (movimientos de venta fechados hacia atrás).
const consumir = async (i, porDia, hoy) => {
  for (let k = 1; k <= 56; k++) {
    await pool.query("INSERT INTO stock_movimientos (id_global, insumo_id, deposito_id, tipo, motivo, cantidad, documento_tipo, created_at) VALUES (?, ?, ?, 'venta', 'venta', ?, 'venta', ?)",
      [`HIST-${i.id}-${k}-${++g}`, i.id, principal.id, -porDia, new Date(hoy.getTime() - k * DIA + 3600000)]);
  }
};

test('Stock.RF29: la sugerencia se calcula por consumo promedio, cobertura, plazo y stock de seguridad', async () => {
  const act = await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['STK-REPO-AUTO', 'STK-APP'], motivo: 'prueba' } });
  assert.equal(act.status, 200, JSON.stringify(act.json));
  const Repo = require('../src/stock/reposicionAutoService');
  const hoy = new Date();
  const harina = await insumo('Harina');
  await ingreso(harina, 120);
  await consumir(harina, 2, hoy); // 2 kg por día → existencias 120 − 112 = 8
  const sinPlazo = await insumo('Azúcar');
  await ingreso(sinPlazo, 120);
  await consumir(sinPlazo, 2, hoy);

  assert.equal((await api('PUT', `/api/reposicion-auto/items/insumo/${harina.id}`, { token, body: { stock_seguridad: -1 } })).status, 400);
  const cfg = await api('PUT', `/api/reposicion-auto/items/insumo/${harina.id}`, { token, body: { stock_seguridad: 10, plazo_entrega_dias: 3 } });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.json));

  const lista = await Repo.sugerir({ hoy });
  const h = lista.find((x) => x.item_id === harina.id);
  assert.equal(h.consumo_diario, 2);
  assert.deepEqual([h.plazo_entrega_dias, h.plazo_origen, h.dias_cobertura, h.disponible], [3, 'item', 7, 8]);
  assert.equal(h.sugerida, 22); // 2 × (7 + 3) + 10 de seguridad − 8 disponibles
  // EX40: sin plazo de entrega no se inventa la sugerencia.
  const a = lista.find((x) => x.item_id === sinPlazo.id);
  assert.deepEqual([a.sin_plazo, a.sugerida], [true, null]);

  // Cobertura propia del ítem; y un ítem bien abastecido no figura.
  await api('PUT', `/api/reposicion-auto/items/insumo/${harina.id}`, { token, body: { dias_cobertura: 14 } });
  assert.equal((await Repo.sugerir({ hoy })).find((x) => x.item_id === harina.id).sugerida, 2 * 17 + 10 - 8);
  await ingreso(harina, 500);
  assert.equal((await Repo.sugerir({ hoy })).find((x) => x.item_id === harina.id), undefined);

  const http = await api('GET', '/api/reposicion-auto/sugerencia', { token });
  assert.equal(http.status, 200);
  assert.equal((await api('GET', '/api/reposicion-auto/sugerencia?formato=csv', { token })).status, 200);
});

test('Stock.RF28: la app busca por código o nombre, consulta el stock y registra una merma rápida con los permisos de Stock', async () => {
  const p = (await api('POST', '/api/productos', { token, body: { nombre: 'Budín app', precio: 10, codigo_barras: '7790000000017' } })).json;
  await api('POST', '/api/stock/ingresos', { token, body: { motivo: 'compra', lineas: [{ item: { tipo: 'producto', id: p.id }, cantidad: 10, costo_unitario: 4 }] } });
  assert.equal((await api('GET', '/api/app/buscar', { token })).status, 400);
  const porCodigo = (await api('GET', '/api/app/buscar?q=7790000000017', { token })).json;
  assert.deepEqual([porCodigo[0].tipo, porCodigo[0].id, porCodigo[0].stock], ['producto', p.id, 10]);
  const st = (await api('GET', `/api/app/stock/producto/${p.id}`, { token })).json;
  assert.deepEqual([st[0].fisico, st[0].disponible], [10, 10]);

  const item = { tipo: 'producto', id: p.id };
  assert.equal((await api('POST', '/api/app/mermas', { token, body: { item, cantidad: 1, motivo: 'consumo_interno' } })).status, 400); // no es de merma
  assert.equal((await api('POST', '/api/app/mermas', { token, body: { item, cantidad: 1, motivo: 'devolucion_merma' } })).status, 400); // reservado
  assert.equal((await api('POST', '/api/app/mermas', { token, body: { item, cantidad: 1, motivo: 'rotura' } })).status, 400); // exige observación
  const m = await api('POST', '/api/app/mermas', { token, body: { item, cantidad: 2, motivo: 'rotura', observacion: 'Se cayó la bandeja' } });
  assert.equal(m.status, 201, JSON.stringify(m.json));
  assert.equal(Number((await pool.query('SELECT stock FROM productos WHERE id = ?', [p.id]))[0][0].stock), 8);
  const [[a]] = await pool.query("SELECT COUNT(*) AS n FROM auditoria WHERE accion = 'merma_app'");
  assert.equal(a.n, 1);

  // Conteo por la app: una línea de una toma en curso.
  const t = (await api('POST', '/api/inventario/tomas', { token, body: { alcance: { deposito_id: principal.id } } })).json;
  const l = await api('POST', `/api/app/tomas/${t.id}/lineas`, { token, body: { item, deposito_id: principal.id, cantidad: 8 } });
  assert.equal(l.status, 201, JSON.stringify(l.json));
});

test('Stock.RF28: con STK-APP apagada la app no responde', async () => {
  await api('POST', '/api/funciones/cambiar', { token, body: { desactivar: ['STK-APP'], motivo: 'prueba' } });
  assert.equal((await api('GET', '/api/app/buscar?q=x', { token })).status, 409);
});
