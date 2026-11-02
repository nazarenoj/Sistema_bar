const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');

let api, pool, cerrar, token, tokenBarista, n = 0, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
  };
  token = await usuario('adm', 'administrador');
  tokenBarista = await usuario('bea', 'barista');
});
after(async () => { await cerrar(); });

const producto = async (nombre, precio = 100, extra = {}) => (await api('POST', '/api/productos', { token, body: { nombre: `${nombre} ${++n}`, precio, ...extra } })).json;
const promo = (body, t = token) => api('POST', '/api/promociones', { token: t, body });
const TODOS = '0,1,2,3,4,5,6';
// Una cuenta con las líneas indicadas [producto, cantidad]; devuelve { mesa, pedido }.
const cuenta = async (lineas) => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  const r = await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: lineas.map(([p, c]) => ({ producto_id: p.id, cantidad: c })) } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { mesa, pedido };
};
const simular = async (mesa, forma = 'efectivo') => (await api('GET', `/api/promociones/simular?mesa_id=${mesa.id}&forma_pago=${forma}`, { token })).json;
const cobrar = async (mesa, extra = {}) => {
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-pro-${++k}-abcdef` }, body: { metodo_pago: 'efectivo', ...extra } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await esperarMensajes(pool);
  return r.json;
};
const ventaDe = async (id) => (await pool.query('SELECT total, detalle FROM ventas WHERE id_global = ?', [id]))[0][0];
// Deja una sola promoción activa para que cada prueba mire lo suyo.
const solo = async (id) => pool.query("UPDATE promociones SET estado = IF(id = ?, 'activa', 'pausada')", [id]);

test('Ventas.RF36: sin VEN-PROMOS no hay promociones; al activarla se validan y exigen el permiso específico', async () => {
  assert.equal((await api('GET', '/api/promociones', { token })).status, 409);
  const a = await producto('Medialuna');
  const { mesa } = await cuenta([[a, 2]]);
  assert.equal((await cobrar(mesa)).total ?? 200, 200);
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['VEN-PROMOS'], motivo: 'prueba' } })).status, 200);
  assert.equal((await promo({ nombre: 'x', tipo: 'rara' })).status, 400);
  assert.equal((await promo({ nombre: 'Sin alcance', tipo: '2x1', items: [] })).status, 400);
  assert.equal((await promo({ nombre: 'Combo corto', tipo: 'combo_precio', precio_cerrado: 10, items: [{ producto_id: a.id }] })).status, 400);
  assert.equal((await promo({ nombre: 'Pct', tipo: 'cantidad', porcentaje: 150, cantidad_minima: 3, items: [{ producto_id: a.id }] })).status, 400);
  assert.equal((await promo({ nombre: 'Horario vacío', tipo: 'horario', porcentaje: 10 })).status, 400);
  assert.equal((await promo({ nombre: 'Vigencia', tipo: '2x1', items: [{ producto_id: a.id }], vigente_desde: '2026-02-01', vigente_hasta: '2026-01-01' })).status, 400);
  const ok = await promo({ nombre: 'Dos por uno', tipo: '2x1', items: [{ producto_id: a.id }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal((await promo({ nombre: 'Dos por uno', tipo: '2x1', items: [{ producto_id: a.id }] })).status, 409);
  assert.equal((await promo({ nombre: 'Del barista', tipo: '2x1', items: [{ producto_id: a.id }] }, tokenBarista)).status, 403);
  const pausada = await api('PUT', `/api/promociones/${ok.json.id}/pausa`, { token, body: { pausada: true } });
  assert.equal(pausada.json.estado, 'pausada');
});

test('Ventas.RN33: 2x1, combo a precio cerrado, cantidad y categoría descuentan por línea y el cobro usa el total neto', async () => {
  const cafe = await producto('Café', 500);
  const medialuna = await producto('Medialuna', 300);
  const galle = await producto('Galletita', 100);
  const dos = (await promo({ nombre: `2x1 galletas ${n}`, tipo: '2x1', items: [{ producto_id: galle.id }] })).json;
  await solo(dos.id);
  let c = await cuenta([[galle, 3], [cafe, 1]]);
  let s = await simular(c.mesa);
  assert.deepEqual([s.bruto, s.descuento, s.total], [800, 100, 700]); // una de tres sale gratis
  let r = await cobrar(c.mesa);
  let v = await ventaDe(r.venta_id_global);
  assert.equal(Number(v.total), 700);
  const det = JSON.parse(v.detalle);
  assert.deepEqual([det[0].importe_descuento, det[0].promociones[0].nombre.startsWith('2x1')], [100, true]);
  assert.equal(det[1].importe_descuento, undefined);

  const combo = (await promo({ nombre: `Desayuno ${n}`, tipo: 'combo_precio', precio_cerrado: 700, items: [{ producto_id: cafe.id, cantidad: 1 }, { producto_id: medialuna.id, cantidad: 1 }] })).json;
  await solo(combo.id);
  c = await cuenta([[cafe, 2], [medialuna, 1]]);
  s = await simular(c.mesa);
  assert.deepEqual([s.bruto, s.descuento, s.total], [1300, 100, 1200]); // un solo combo completo: 800 → 700
  r = await cobrar(c.mesa);
  const dc = JSON.parse((await ventaDe(r.venta_id_global)).detalle);
  assert.equal(dc.reduce((a, l) => a + (l.importe_descuento ?? 0), 0), 100); // prorrateado entre las líneas, suma exacta

  const cant = (await promo({ nombre: `Docena ${n}`, tipo: 'cantidad', porcentaje: 10, cantidad_minima: 3, items: [{ producto_id: galle.id }] })).json;
  await solo(cant.id);
  assert.equal((await simular((await cuenta([[galle, 2]])).mesa)).descuento, 0); // no llega a la cantidad mínima
  assert.equal((await simular((await cuenta([[galle, 3]])).mesa)).descuento, 30);

  const cat = (await api('POST', '/api/categorias', { token, body: { nombre: `Pastelería ${++n}` } })).json;
  if (cat?.id) {
    const torta = await producto('Torta', 1000, { categoria_id: cat.id });
    const porCat = (await promo({ nombre: `Pastelería -20 ${n}`, tipo: 'categoria', porcentaje: 20, items: [{ categoria_id: cat.id }] })).json;
    await solo(porCat.id);
    assert.equal((await simular((await cuenta([[torta, 1], [cafe, 1]])).mesa)).descuento, 200);
  }
});

test('Ventas.RN33/EX24: forma de pago, franja y vigencia se evalúan al cobrar; vencida o pausada no se aplica', async () => {
  const a = await producto('Jugo', 200);
  const fp = (await promo({ nombre: `Efectivo -10 ${n}`, tipo: 'forma_pago', forma_pago: 'efectivo', porcentaje: 10 })).json;
  await solo(fp.id);
  const c = await cuenta([[a, 2]]);
  assert.equal((await simular(c.mesa, 'efectivo')).descuento, 40);
  assert.equal((await simular(c.mesa, 'tarjeta_debito')).descuento, 0);
  // Con pago mixto no rige la promoción de forma de pago.
  const mixto = await cobrar(c.mesa, { metodo_pago: undefined, pagos: [{ forma: 'efectivo', importe: 200 }, { forma: 'tarjeta_debito', importe: 200 }] });
  assert.equal(Number((await ventaDe(mixto.venta_id_global)).total), 400);

  const feliz = (await promo({ nombre: `Happy ${n}`, tipo: 'horario', porcentaje: 50, dias_semana: TODOS, hora_desde: '00:00', hora_hasta: '23:59' })).json;
  await solo(feliz.id);
  assert.equal((await simular((await cuenta([[a, 1]])).mesa)).descuento, 100);
  // Fuera de la franja, vencida o pausada: no se aplica y la venta sigue (EX24).
  await pool.query("UPDATE promociones SET hora_desde = '03:00', hora_hasta = '03:01' WHERE id = ?", [feliz.id]);
  const fueraDeHora = new Date().getHours() === 3 && new Date().getMinutes() === 0;
  if (!fueraDeHora) assert.equal((await simular((await cuenta([[a, 1]])).mesa)).descuento, 0);
  await pool.query("UPDATE promociones SET hora_desde = '00:00', hora_hasta = '23:59', vigente_hasta = '2020-01-01' WHERE id = ?", [feliz.id]);
  assert.equal((await simular((await cuenta([[a, 1]])).mesa)).descuento, 0);
  await pool.query("UPDATE promociones SET vigente_hasta = NULL WHERE id = ?", [feliz.id]);
  assert.equal((await simular((await cuenta([[a, 1]])).mesa)).descuento, 100);
  await api('PUT', `/api/promociones/${feliz.id}/pausa`, { token, body: { pausada: true } });
  assert.equal((await simular((await cuenta([[a, 1]])).mesa)).descuento, 0);
});

test('Ventas.RN33: gana la de mayor prioridad salvo que ambas sean acumulables; el tope limita y nada queda en negativo', async () => {
  const a = await producto('Alfajor', 1000);
  const A = (await promo({ nombre: `Pri 1 ${n}`, tipo: 'horario', porcentaje: 10, dias_semana: TODOS, prioridad: 1 })).json;
  const B = (await promo({ nombre: `Pri 2 ${n}`, tipo: 'horario', porcentaje: 20, dias_semana: TODOS, prioridad: 2 })).json;
  await pool.query("UPDATE promociones SET estado = IF(id IN (?, ?), 'activa', 'pausada')", [A.id, B.id]);
  let c = await cuenta([[a, 1]]);
  assert.equal((await simular(c.mesa)).descuento, 100); // solo la de prioridad 1
  await pool.query('UPDATE promociones SET acumulable = 1 WHERE id IN (?, ?)', [A.id, B.id]);
  assert.equal((await simular(c.mesa)).descuento, 280); // 10 % de 1000 y 20 % de los 900 que quedan
  await pool.query('UPDATE promociones SET tope = 150 WHERE id = ?', [B.id]);
  assert.equal((await simular(c.mesa)).descuento, 250); // la segunda queda en su tope de 150
  await pool.query('UPDATE promociones SET porcentaje = 100, tope = NULL WHERE id IN (?, ?)', [A.id, B.id]);
  const s = await simular(c.mesa);
  assert.deepEqual([s.descuento, s.total], [1000, 0]); // nunca más que el importe de la línea
});

test('Ventas.RN34: una devolución parcial reintegra el precio efectivamente cobrado y el informe cuenta cada uso', async () => {
  const a = await producto('Budín', 100);
  const dos = (await promo({ nombre: `2x1 budín ${n}`, tipo: '2x1', items: [{ producto_id: a.id }] })).json;
  await solo(dos.id);
  const c = await cuenta([[a, 3]]);
  const r = await cobrar(c.mesa);
  assert.equal(Number((await ventaDe(r.venta_id_global)).total), 200);
  const dev = async (body) => api('POST', '/api/devoluciones', { token, headers: { 'X-ID-Solicitud': `devol-pro-${++k}-abcdef` }, body: { venta_id_global: r.venta_id_global, motivo: 'prueba', ...body } });
  const d1 = await dev({ items: [{ linea: 0, cantidad: 1 }] });
  assert.equal(d1.status, 201, JSON.stringify(d1.json));
  assert.equal(d1.json.devolucion.total, 66.67); // 100 − 100 de descuento ÷ 3
  const d2 = await dev({ todo: true });
  assert.equal(d2.status, 201, JSON.stringify(d2.json));
  assert.equal(Math.round((d1.json.devolucion.total + d2.json.devolucion.total) * 100) / 100, 200); // entre las dos, lo cobrado
  const inf = (await api('GET', '/api/promociones/informe', { token })).json.find((x) => x.promocion_id === dos.id);
  assert.deepEqual([inf.veces, inf.importe_descontado], [1, 100]);
});

test('Ventas.RF37: una promoción bajo costo advierte y se guarda solo confirmada', async () => {
  const p = await producto('Cápsula', 100);
  await api('POST', '/api/stock/ingresos', { token, body: { motivo: 'compra', lineas: [{ item: { tipo: 'producto', id: p.id }, cantidad: 10, costo_unitario: 80 }] } });
  const base = { nombre: `Liquidación ${n}`, tipo: 'cantidad', porcentaje: 30, cantidad_minima: 2, items: [{ producto_id: p.id }] };
  const r = await promo(base);
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'BAJO_COSTO');
  assert.deepEqual([r.json.avisos[0].precio, r.json.avisos[0].costo], [70, 80]);
  const ok = await promo({ ...base, confirmar_bajo_costo: true });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.avisos.length, 1);
  assert.equal((await promo({ ...base, nombre: `Otra ${n}`, porcentaje: 5 })).status, 201); // 95 sigue sobre el costo: sin aviso
});
