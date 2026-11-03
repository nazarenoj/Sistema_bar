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

const serializado = async (extra = {}) => (await api('POST', '/api/productos', { token, body: { nombre: `Molinillo ${++n}`, precio: 1000, tipo: 'serializado', plazo_garantia_dias: 365, ...extra } })).json;
const nuevoPedido = async () => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  return { mesa, pedido: (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json };
};
const agregar = (pedido, p, serie, cantidad = 1) => api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: p.id, cantidad, ...(serie !== undefined && { serie }) }] } });
const cobrar = async (mesa) => {
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-ser-${++k}-abcdef` }, body: { metodo_pago: 'efectivo' } });
  await esperarMensajes(pool);
  await esperarMensajes(pool);
  return r;
};
const vender = async (p, serie) => { const { mesa, pedido } = await nuevoPedido(); const a = await agregar(pedido, p, serie); assert.equal(a.status, 201, JSON.stringify(a.json)); const r = await cobrar(mesa); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.venta_id_global; };
const devolver = (id, body) => api('POST', '/api/devoluciones', { token, headers: { 'X-ID-Solicitud': `devol-ser-${++k}-abcdef` }, body: { venta_id_global: id, motivo: 'prueba', ...body } });
const hoyMas = (dias) => { const d = new Date(Date.now() + dias * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('Ventas.RN05: el tipo serializado solo existe con VEN-SERIE y exige la serie en cada venta', async () => {
  assert.equal((await api('POST', '/api/productos', { token, body: { nombre: 'Sin función', precio: 10, tipo: 'serializado' } })).status, 409);
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['VEN-SERIE'], motivo: 'prueba' } })).status, 200);
  const p = await serializado();
  assert.deepEqual([p.tipo, p.plazo_garantia_dias], ['serializado', 365]);
  const { pedido } = await nuevoPedido();
  const sin = await agregar(pedido, p);
  assert.equal(sin.status, 400);
  assert.equal(sin.json.codigo, 'FALTA_SERIE');
  assert.equal((await agregar(pedido, p, 'SN1', 2)).status, 400); // una unidad por línea
  assert.equal((await agregar(pedido, { id: (await api('POST', '/api/productos', { token, body: { nombre: `Común ${++n}`, precio: 10 } })).json.id }, 'SN1')).status, 400); // un común no lleva serie
  assert.equal((await agregar(pedido, p, 'SN1')).status, 201);
  const otro = (await nuevoPedido()).pedido;
  const dup = await agregar(otro, p, 'SN1'); // la misma serie en otro pedido abierto
  assert.equal(dup.status, 409);
  assert.equal(dup.json.codigo, 'SERIE_NO_DISPONIBLE');
});

test('Ventas.RN05/RN79: sin Stock la serie se captura, se guarda con su garantía y no se vende dos veces sin devolución', async () => {
  const p = await serializado({ plazo_garantia_dias: 30 });
  const v = await vender(p, 'AB-100');
  const [[venta]] = await pool.query('SELECT detalle FROM ventas WHERE id_global = ?', [v]);
  const linea = JSON.parse(venta.detalle)[0];
  assert.deepEqual([linea.serie, linea.fecha_fin_garantia], ['AB-100', hoyMas(30)]);
  // El plazo cambia después y la garantía de lo vendido no se recalcula (RN79).
  await api('PUT', `/api/productos/${p.id}`, { token, body: { nombre: p.nombre, precio: 1000, tipo: 'serializado', plazo_garantia_dias: 999 } });
  assert.equal((await pool.query('SELECT DATE_FORMAT(fecha_fin_garantia, "%Y-%m-%d") AS f FROM ventas_series WHERE numero_serie = "AB-100"'))[0][0].f, hoyMas(30));
  // La serie vendida no vuelve a venderse (EX33).
  const rep = await agregar((await nuevoPedido()).pedido, p, 'AB-100');
  assert.equal(rep.status, 409);
  assert.equal(rep.json.estado, 'vendida');
  // Registro de ventas: por serie y por estado de la garantía.
  assert.equal((await api('GET', '/api/ventas?serie=AB-100', { token })).json.ventas.length, 1);
  assert.equal((await api('GET', '/api/ventas?serie=NO-EXISTE', { token })).json.ventas.length, 0);
  assert.equal((await api('GET', '/api/ventas?garantia=vigente&serie=AB-100', { token })).json.ventas.length, 1);
  assert.equal((await api('GET', '/api/ventas?garantia=vencida&serie=AB-100', { token })).json.ventas.length, 0);
  // La devolución pide si tiene falla; con garantía vencida advierte y no bloquea.
  assert.equal((await devolver(v, { todo: true })).status, 400);
  assert.equal((await devolver(v, { todo: true, series: [{ linea: 0, falla: true }] })).status, 400); // con falla, el motivo
  await pool.query("UPDATE ventas_series SET fecha_fin_garantia = '2020-01-01' WHERE numero_serie = 'AB-100'");
  const d = await devolver(v, { todo: true, series: [{ linea: 0, falla: false }] });
  assert.equal(d.status, 201, JSON.stringify(d.json));
  assert.match(d.json.advertencias[0], /garantía/);
  assert.equal((await api('GET', '/api/ventas?garantia=vencida&serie=AB-100&incluir_anuladas=1', { token })).json.ventas.length, 1);
  // Devuelta, la serie se puede vender de nuevo.
  const otra = await agregar((await nuevoPedido()).pedido, p, 'AB-100');
  assert.equal(otra.status, 201, JSON.stringify(otra.json));
});

test('Ventas.RN05/EX33: con Stock y STK-SERIE la serie tiene que estar Disponible y pasa Comprometida → Vendida con el cierre', async () => {
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['STK-SERIE'], motivo: 'prueba' } })).status, 200);
  const p = await serializado({ plazo_garantia_dias: 90 });
  assert.equal((await api('PUT', `/api/series/${p.id}/activar`, { token })).status, 200);
  assert.equal((await api('POST', `/api/series/${p.id}/ingresos`, { token, body: { series: ['SN1', 'SN2', 'SN3'], costo_unitario: 500 } })).status, 201);
  const estado = async (num) => (await api('GET', `/api/series/${p.id}`, { token })).json.find((s) => s.numero_serie === num)?.estado;
  const ine = await agregar((await nuevoPedido()).pedido, p, 'NO-HAY');
  assert.deepEqual([ine.status, ine.json.estado], [409, 'inexistente']);
  const { mesa, pedido } = await nuevoPedido();
  assert.equal((await agregar(pedido, p, 'SN1')).status, 201);
  assert.equal(await estado('SN1'), 'disponible'); // cargar en el pedido no la compromete
  const r = await cobrar(mesa);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(await estado('SN1'), 'vendida');
  assert.equal(Number((await pool.query('SELECT stock FROM productos WHERE id = ?', [p.id]))[0][0].stock), 2);
  const [[lc]] = await pool.query('SELECT costo_unitario, origen_costo FROM lineas_costo WHERE doc_id_global = ?', [r.json.venta_id_global]);
  assert.deepEqual([Number(lc.costo_unitario), lc.origen_costo], [500, 'movimiento_stock']); // el costo de esa unidad
  const hist = (await api('GET', `/api/series/${p.id}/SN1/historial`, { token })).json.eventos.map((e) => e.evento);
  assert.ok(hist.includes('venta'));
  const vendida = await agregar((await nuevoPedido()).pedido, p, 'SN1');
  assert.deepEqual([vendida.status, vendida.json.estado], [409, 'vendida']);
  // Devolución sin falla: vuelve Disponible. Con falla: se da de baja con el motivo (RN79).
  const sinFalla = await devolver(r.json.venta_id_global, { todo: true, series: [{ linea: 0, falla: false }] });
  assert.equal(sinFalla.status, 201, JSON.stringify(sinFalla.json));
  await esperarMensajes(pool);
  assert.equal(await estado('SN1'), 'disponible');
  assert.equal(Number((await pool.query('SELECT stock FROM productos WHERE id = ?', [p.id]))[0][0].stock), 3);
  const v2 = await vender(p, 'SN2');
  const conFalla = await devolver(v2, { todo: true, series: [{ linea: 0, falla: true, motivo: 'no muele' }] });
  assert.equal(conFalla.status, 201, JSON.stringify(conFalla.json));
  await esperarMensajes(pool);
  assert.equal(await estado('SN2'), 'baja');
  assert.equal(Number((await pool.query('SELECT stock FROM productos WHERE id = ?', [p.id]))[0][0].stock), 2); // SN1 y SN3
});

test('Ventas.EX33/EX34: un serializado con VEN-SERIE inactiva no es vendible y alerta; la función no se desactiva con datos vigentes', async () => {
  const p = await serializado();
  const des = await api('POST', '/api/funciones/cambiar', { token, body: { desactivar: ['VEN-SERIE'], motivo: 'prueba' } });
  assert.equal(des.status, 409); // STK-SERIE sigue activa y hay serializados
  await pool.query("UPDATE estado_funcionalidades SET activa = 0 WHERE funcion_id IN ('STK-SERIE', 'VEN-SERIE')");
  const r = await agregar((await nuevoPedido()).pedido, p, 'ZZ-1');
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'SERIALIZADO_NO_VENDIBLE');
  const [[a]] = await pool.query("SELECT mensaje FROM notificaciones WHERE tipo = 'serializado_sin_funcion' LIMIT 1");
  assert.match(a.mensaje, /VEN-SERIE/);
  // Y el tipo no se ofrece: no se puede crear uno nuevo.
  assert.equal((await api('POST', '/api/productos', { token, body: { nombre: 'Otro', precio: 5, tipo: 'serializado' } })).status, 409);
});
