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

const insumo = async (nombre) => (await api('POST', '/api/insumos', { token, body: { nombre: `${nombre} ${++n}`, unidad: 'kg' } })).json;
const stockDe = async (id) => Number((await pool.query('SELECT stock FROM insumos WHERE id = ?', [id]))[0][0].stock);
const ingreso = async (i, cantidad, costo) => (await api('POST', '/api/stock/ingresos', { token, body: { motivo: 'compra', lineas: [{ item: { tipo: 'insumo', id: i.id }, cantidad, costo_unitario: costo }] } })).json.movimientos[0].id;
const subir = (contenido = 'imagen', tipo = 'image/png') => api('POST', '/api/stock-ingresos/fotos', { token, headers: { 'Content-Type': tipo, 'X-Nombre-Archivo': 'factura.png' }, body: contenido });
const enc = (numero) => ({ proveedor: 'Molinos SA', cuit: '30712345678', clase: 'FA', tipo: 'A', punto_venta: 5, numero });

test('Stock.RF05/EX03: la foto queda como borrador sin tocar el stock hasta que un usuario lo confirma, y lo asociado se recuerda', async () => {
  const harina = await insumo('Harina');
  const bolsa = (await api('POST', '/api/presentaciones', { token, body: { insumo_id: harina.id, nombre: 'bolsa 25 kg', factor: 25, usos: ['compra'] } })).json;
  assert.equal((await subir('x', 'text/plain')).status, 400);
  // Sin servicio de lectura: pendiente de lectura, con la imagen guardada y la carga manual disponible (EX03).
  const b = await subir();
  assert.equal(b.status, 201, JSON.stringify(b.json));
  assert.equal(b.json.estado, 'pendiente_lectura');
  assert.equal((await api('POST', `/api/stock-ingresos/fotos/${b.json.id}/confirmar`, { token, body: {} })).status, 409);
  const lectura = await api('PUT', `/api/stock-ingresos/fotos/${b.json.id}/lectura`, { token, body: { encabezado: enc('0001'), lineas: [{ descripcion: 'HARINA 000 X 25KG', cantidad: 2, costo: 1000 }] } });
  assert.equal(lectura.status, 200, JSON.stringify(lectura.json));
  assert.equal(lectura.json.estado, 'borrador');
  assert.equal((await api('POST', `/api/stock-ingresos/fotos/${b.json.id}/confirmar`, { token, body: {} })).status, 400); // falta asociar la línea
  assert.equal(await stockDe(harina.id), 0); // el borrador no impacta el stock
  const asoc = await api('PUT', `/api/stock-ingresos/fotos/${b.json.id}/lineas/0`, { token, body: { item: { tipo: 'insumo', id: harina.id }, presentacion_id: bolsa.id } });
  assert.equal(asoc.status, 200, JSON.stringify(asoc.json));
  const c = await api('POST', `/api/stock-ingresos/fotos/${b.json.id}/confirmar`, { token, body: {} });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(await stockDe(harina.id), 50); // 2 bolsas de 25 kg
  assert.equal(Number((await pool.query('SELECT costo_unitario FROM stock_movimientos WHERE insumo_id = ?', [harina.id]))[0][0].costo_unitario), 40); // 1000 por bolsa ÷ 25
  const [[ing]] = await pool.query('SELECT imagen_borrador_id, proveedor FROM stock_ingresos WHERE id_global = ?', [c.json.ingreso.id_global]);
  assert.deepEqual([ing.imagen_borrador_id, ing.proveedor], [b.json.id, 'Molinos SA']); // la imagen queda adjunta al ingreso
  assert.equal((await api('POST', `/api/stock-ingresos/fotos/${b.json.id}/confirmar`, { token, body: {} })).status, 409); // una sola vez
  assert.equal((await api('POST', `/api/stock-ingresos/fotos/${b.json.id}/descartar`, { token })).status, 409);

  // La próxima lectura del mismo proveedor reconoce la línea sola (diccionario de equivalencias).
  const Fotos = require('../src/stock/ingresoFotoService');
  Fotos.usarLector(async () => ({ encabezado: enc('0002'), lineas: [{ descripcion: 'Harina 000 x 25kg', cantidad: 1, costo: 1000 }] }));
  const b2 = await subir();
  Fotos.usarLector(async () => null);
  assert.equal(b2.json.estado, 'borrador');
  assert.deepEqual([b2.json.lineas[0].reconocida, b2.json.lineas[0].item.id, b2.json.lineas[0].presentacion_id], [true, harina.id, bolsa.id]);
  assert.equal((await api('POST', `/api/stock-ingresos/fotos/${b2.json.id}/confirmar`, { token, body: {} })).status, 200);
  assert.equal(await stockDe(harina.id), 75);

  // Un comprobante ya ingresado no se carga dos veces (RN09) y el borrador se puede descartar.
  const b3 = await subir();
  await api('PUT', `/api/stock-ingresos/fotos/${b3.json.id}/lectura`, { token, body: { encabezado: enc('0002'), lineas: [{ descripcion: 'HARINA 000 X 25KG', cantidad: 1, costo: 1000 }] } });
  assert.equal((await api('POST', `/api/stock-ingresos/fotos/${b3.json.id}/confirmar`, { token, body: {} })).status, 409);
  assert.equal((await api('POST', `/api/stock-ingresos/fotos/${b3.json.id}/descartar`, { token })).json.estado, 'descartado');
  assert.equal(await stockDe(harina.id), 75);
  assert.equal((await api('GET', '/api/stock-ingresos/fotos?estado=confirmado', { token })).json.length, 2);
});

test('Stock.RF40/RN80/EX58: la devolución sale al costo del ingreso, solo de lo que sigue en stock, y queda pendiente de nota de crédito', async () => {
  const cafe = await insumo('Café');
  const a = await ingreso(cafe, 10, 100);
  const b = await ingreso(cafe, 10, 120);
  const dev = (movimiento_id, cantidad, motivo = 'Mal estado') => api('POST', '/api/stock-ingresos/devoluciones-proveedor', { token, body: { movimiento_id, cantidad, motivo } });
  assert.equal((await dev(a, 4, '')).status, 400); // motivo obligatorio
  assert.equal((await dev(999999, 1)).status, 404); // sin ingreso referenciado
  const d = await dev(a, 4);
  assert.equal(d.status, 201, JSON.stringify(d.json));
  assert.deepEqual([d.json.estado, Number(d.json.costo_unitario), Number(d.json.cantidad)], ['pendiente_nc', 100, 4]);
  assert.equal(await stockDe(cafe.id), 16);
  const [[eg]] = await pool.query('SELECT motivo, costo_unitario FROM stock_movimientos WHERE id = ?', [d.json.egreso_id]);
  assert.deepEqual([eg.motivo, Number(eg.costo_unitario), Number(d.json.movimiento_id)], ['devolucion_proveedor', 100, a]);
  const [[c]] = await pool.query("SELECT costo_promedio, ultimo_costo FROM stock_costos WHERE item_tipo = 'insumo' AND item_id = ?", [cafe.id]);
  assert.deepEqual([Number(c.costo_promedio), Number(c.ultimo_costo)], [112.5, 120]); // (20 × 110 − 4 × 100) ÷ 16
  // Solo lo que queda de ese ingreso: 10 − 4 = 6 (EX58).
  const de = await dev(a, 7);
  assert.equal(de.status, 409);
  assert.equal(de.json.devolvible, 6);
  // Lo consumido ya no se devuelve físicamente.
  await api('POST', '/api/stock/egresos', { token, body: { motivo: 'consumo_interno', lineas: [{ item: { tipo: 'insumo', id: cafe.id }, cantidad: 15 }] } });
  assert.equal((await dev(b, 3)).json.devolvible, 1);
  // Sin Compras, la nota de crédito se carga a mano; cada una vale una sola vez (RN09).
  const nc = { comprobante: { cuit: '30712345678', clase: 'NC', tipo: 'A', punto_venta: 5, numero: '77' }, importe: 380 };
  assert.equal((await api('POST', `/api/stock-ingresos/devoluciones-proveedor/${d.json.id}/nota-credito`, { token, body: { importe: 1 } })).status, 400);
  const ok = await api('POST', `/api/stock-ingresos/devoluciones-proveedor/${d.json.id}/nota-credito`, { token, body: nc });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.estado, ok.json.diferencia_valuacion], ['con_nc', -20]);
  assert.equal((await api('POST', `/api/stock-ingresos/devoluciones-proveedor/${d.json.id}/nota-credito`, { token, body: nc })).status, 409);
  const d2 = await dev(b, 1);
  assert.equal((await api('POST', `/api/stock-ingresos/devoluciones-proveedor/${d2.json.id}/nota-credito`, { token, body: nc })).status, 409);
  assert.equal((await api('GET', '/api/stock-ingresos/devoluciones-proveedor?estado=pendiente_nc', { token })).json.length, 1);
});

test('Stock.RN80: con PEPS sale la capa del ingreso devuelto, y devolver el último ingreso restituye el último costo', async () => {
  assert.equal((await api('PUT', '/api/stock/valuacion', { token, body: { metodo: 'peps' } })).status, 200);
  const i = await insumo('Azúcar');
  const a = await ingreso(i, 10, 100);
  const b = await ingreso(i, 10, 120);
  const r = await api('POST', '/api/stock-ingresos/devoluciones-proveedor', { token, body: { movimiento_id: b, cantidad: 4, motivo: 'Vencido' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(Number(r.json.costo_unitario), 120); // PEPS habría tomado 100 de la capa más vieja
  const capas = (await pool.query("SELECT movimiento_id, cantidad_restante FROM stock_capas WHERE item_tipo = 'insumo' AND item_id = ? ORDER BY id", [i.id]))[0];
  assert.deepEqual(capas.map((c) => [Number(c.movimiento_id), Number(c.cantidad_restante)]), [[a, 10], [b, 6]]);
  const ultimo = async () => Number((await pool.query("SELECT ultimo_costo FROM stock_costos WHERE item_tipo = 'insumo' AND item_id = ?", [i.id]))[0][0].ultimo_costo);
  assert.equal(await ultimo(), 120); // devolución parcial: el último costo sigue siendo el de ese ingreso
  await api('POST', '/api/stock-ingresos/devoluciones-proveedor', { token, body: { movimiento_id: b, cantidad: 6, motivo: 'Vencido' } });
  assert.equal(await ultimo(), 100); // se devolvió todo el último ingreso: vuelve el costo del anterior
  assert.equal(await stockDe(i.id), 10);
});
