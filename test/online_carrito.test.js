const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');

let api, pool, cerrar, adm, gerente, administrativo, A, B, S;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  await api('POST', '/api/modulos/ventas_online/instalar', { token: adm.token });
  await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { codigo: 'cafe-carro', nombre: 'Cafe', razon_social: 'Cafe SA', cuit: '30711111111', domicilio: 'Mitre 1', activa: true } });
  const estricto = async (nombre, stock, precio) => {
    const p = (await api('POST', '/api/productos', { token: adm.token, body: { nombre, precio, stock } })).json;
    await api('PUT', `/api/stock/configuracion/producto/${p.id}`, { token: adm.token, body: { permite_negativo: false } });
    return p;
  };
  A = await estricto('Cafe 250 g', 5, 1000);
  B = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Medialuna', precio: 300, stock: 0 } })).json;
  S = await estricto('Budin', 0, 800);
  for (const p of [A, B, S]) await api('PUT', `/api/ventas-online/catalogo/${p.id}`, { token: gerente.token, body: { categoria_online: 'Menu' } });
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
});
after(async () => { await cerrar(); });

const T = '/tienda/cafe-carro';
const post = (r, body, token) => api('POST', `${T}${r}`, { body, ...(token && { token }) });
const get = (r, token) => api('GET', `${T}${r}`, token ? { token } : {});
const put = (r, body, token) => api('PUT', `${T}${r}`, { body, ...(token && { token }) });
const nuevo = async (items = [{ producto_id: B.id, cantidad: 2 }]) => {
  let c;
  for (const [i, it] of items.entries()) c = i === 0 ? (await post('/carrito', it)).json : (await post(`/carrito/${c.token}/items`, it)).json;
  return c;
};

test('Ventas Online.RF06: un invitado arma el carrito, agrega, modifica y quita lineas', async () => {
  const c = await nuevo([{ producto_id: B.id, cantidad: 2 }, { producto_id: A.id, cantidad: 1 }]);
  assert.equal(c.token.length, 48);
  assert.equal(c.lineas.length, 2); assert.equal(c.subtotal, 1600); assert.equal(c.total, 1600);
  // La misma seleccion se acumula en la misma linea.
  const mas = (await post(`/carrito/${c.token}/items`, { producto_id: B.id, cantidad: 1 })).json;
  assert.equal(mas.lineas.length, 2); assert.equal(mas.lineas.find((l) => l.producto_id === B.id).cantidad, 3);
  const linB = mas.lineas.find((l) => l.producto_id === B.id).linea;
  assert.equal((await put(`/carrito/${c.token}/items/${linB}`, { cantidad: 5 })).json.subtotal, 2500);
  assert.equal((await put(`/carrito/${c.token}/items/${linB}`, { cantidad: 1.5 })).status, 400);
  assert.equal((await put(`/carrito/${c.token}/items/999`, { cantidad: 1 })).status, 404);
  const sin = await api('DELETE', `${T}/carrito/${c.token}/items/${linB}`);
  assert.equal(sin.json.lineas.length, 1);
  assert.equal((await get('/carrito/no-existe')).status, 404);
  for (const mal of [{ producto_id: B.id, cantidad: 0 }, { producto_id: B.id, cantidad: 1000 }, { producto_id: 99999, cantidad: 1 }, { cantidad: 1 }]) assert.ok((await post('/carrito', mal)).status >= 400, JSON.stringify(mal));
});

test('Ventas Online.RN03: no se agrega mas de lo disponible ni un articulo agotado', async () => {
  const c = await nuevo([{ producto_id: A.id, cantidad: 4 }]);
  const r = await post(`/carrito/${c.token}/items`, { producto_id: A.id, cantidad: 2 });
  assert.equal(r.status, 409); assert.equal(r.json.codigo, 'CANTIDAD_EXCEDIDA'); assert.equal(r.json.disponible, 5);
  assert.equal((await post('/carrito', { producto_id: S.id, cantidad: 1 })).json.codigo, 'SIN_STOCK');
});

test('Ventas Online.RN05/EX09: al mostrar el carrito se recalculan los precios y se informa el cambio con el precio anterior', async () => {
  const c = await nuevo([{ producto_id: B.id, cantidad: 2 }]);
  await pool.query('UPDATE productos SET precio = 350 WHERE id = ?', [B.id]);
  const v = (await get(`/carrito/${c.token}`)).json;
  assert.equal(v.lineas[0].precio_unitario, 350); assert.equal(v.lineas[0].precio_anterior, 300);
  assert.equal(v.avisos[0].tipo, 'cambio_precio'); assert.equal(v.subtotal, 700);
  assert.equal((await get(`/carrito/${c.token}`)).json.avisos.length, 0); // ya se mostro: no se repite el aviso
  await pool.query('UPDATE productos SET precio = 300 WHERE id = ?', [B.id]);
});

test('Ventas Online.EX12: un articulo despublicado desaparece del carrito con un aviso', async () => {
  const c = await nuevo([{ producto_id: B.id, cantidad: 1 }, { producto_id: A.id, cantidad: 1 }]);
  await api('DELETE', `/api/ventas-online/catalogo/${A.id}`, { token: gerente.token });
  const v = (await get(`/carrito/${c.token}`)).json;
  assert.equal(v.lineas.length, 1); assert.equal(v.avisos[0].tipo, 'articulo_quitado');
  await api('PUT', `/api/ventas-online/catalogo/${A.id}`, { token: gerente.token, body: { categoria_online: 'Menu' } });
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
});

test('Ventas Online.RF06: el carrito se guarda N dias y despues vence', async () => {
  const c = await nuevo();
  const [[t]] = await pool.query('SELECT carrito_dias FROM onl_tienda');
  const dentro = (await get(`/carrito/${c.token}`)).json.vence_ms - Date.now();
  assert.ok(Math.abs(dentro - t.carrito_dias * 86400000) < 60000);
  await pool.query('UPDATE onl_carritos SET vence_ms = ? WHERE token = ?', [Date.now() - 1000, c.token]);
  assert.equal((await get(`/carrito/${c.token}`)).status, 404);
  const Carrito = require('../src/ventas_online/carritoService');
  assert.ok((await Carrito.limpiarVencidos()) >= 1);
});

const cupon = (b, t = gerente) => api('POST', '/api/ventas-online/cupones', { token: t.token, body: b });
test('Ventas Online.RF07: se crean cupones por porcentaje o monto con validaciones y permiso', async () => {
  assert.equal((await cupon({ codigo: 'X', tipo: 'monto', valor: 10 })).status, 400);
  assert.equal((await cupon({ codigo: 'DESC10', tipo: 'porcentaje', valor: 150 })).status, 400);
  assert.equal((await cupon({ codigo: 'DESC10', tipo: 'monto', valor: 0 })).status, 400);
  assert.equal((await cupon({ codigo: 'DESC10', tipo: 'monto', valor: 10, vigente_desde: '2030-02-01', vigente_hasta: '2030-01-01' })).status, 400);
  assert.equal((await cupon({ codigo: 'DESC10', tipo: 'porcentaje', valor: 10 }, administrativo)).status, 403);
  const ok = await cupon({ codigo: 'desc10', tipo: 'porcentaje', valor: 10 });
  assert.equal(ok.status, 201, JSON.stringify(ok.json)); assert.equal(ok.json.codigo, 'DESC10');
  assert.equal((await cupon({ codigo: 'DESC10', tipo: 'monto', valor: 5 })).json.codigo, 'CUPON_DUPLICADO');
  await cupon({ codigo: 'MIL', tipo: 'monto', valor: 1000, minimo_compra: 1500 });
  await cupon({ codigo: 'SOLOCAFE', tipo: 'porcentaje', valor: 50, alcance_tipo: 'articulos', alcance: [A.id] });
  await cupon({ codigo: 'VENCIDO', tipo: 'monto', valor: 50, vigente_hasta: '2020-01-01' });
  await cupon({ codigo: 'UNICO', tipo: 'monto', valor: 50, usos_max: 1, usos_por_cliente: 1 });
  assert.equal((await api('GET', '/api/ventas-online/cupones', { token: administrativo.token })).json.length, 5);
});

test('Ventas Online.RN23/EX10: el cupon se aplica sobre los articulos alcanzados y uno invalido muestra el motivo sin descuento', async () => {
  const c = await nuevo([{ producto_id: B.id, cantidad: 2 }, { producto_id: A.id, cantidad: 1 }]); // 600 + 1000
  const ok = (await put(`/carrito/${c.token}/cupon`, { codigo: 'desc10' })).json;
  assert.equal(ok.descuento, 160); assert.equal(ok.total, 1440); assert.equal(ok.cupon.codigo, 'DESC10');
  assert.equal((await put(`/carrito/${c.token}/cupon`, { codigo: 'SOLOCAFE' })).json.descuento, 500); // solo sobre el articulo alcanzado
  const mil = (await put(`/carrito/${c.token}/cupon`, { codigo: 'MIL' })).json;
  assert.equal(mil.descuento, 1000); assert.equal(mil.total, 600);
  for (const [codigo, cod] of [['VENCIDO', 'CUPON_INVALIDO'], ['NOEXISTE', 'CUPON_INVALIDO']]) {
    const r = await put(`/carrito/${c.token}/cupon`, { codigo });
    assert.equal(r.status, 400); assert.equal(r.json.codigo, cod);
  }
  assert.equal((await get(`/carrito/${c.token}`)).json.cupon.codigo, 'MIL'); // el invalido no pisa al vigente
  const chico = await nuevo([{ producto_id: B.id, cantidad: 1 }]);
  assert.match((await put(`/carrito/${chico.token}/cupon`, { codigo: 'MIL' })).json.error, /compra mínima/);
  assert.equal((await api('DELETE', `${T}/carrito/${c.token}/cupon`)).json.descuento, 0);
});

test('Ventas Online.RF07: un cupon agotado se rechaza y el cupon vencido despues de ponerlo se quita al mostrar el carrito', async () => {
  const c = await nuevo([{ producto_id: A.id, cantidad: 1 }]);
  const Cupones = require('../src/ventas_online/cuponService');
  const unico = await Cupones.porCodigo('UNICO');
  assert.equal((await put(`/carrito/${c.token}/cupon`, { codigo: 'UNICO' })).status, 200);
  const conn = await pool.getConnection();
  assert.equal(await Cupones.consumir(conn, unico.id, { quien: 'x@y.test', pedidoId: 'P1', importe: 50 }), true);
  assert.equal(await Cupones.consumir(conn, unico.id, { quien: 'x@y.test', pedidoId: 'P1', importe: 50 }), false); // idempotente
  conn.release();
  assert.equal((await put(`/carrito/${c.token}/cupon`, { codigo: 'UNICO' })).json.codigo, 'CUPON_INVALIDO');
  const v = (await get(`/carrito/${c.token}`)).json;
  assert.equal(v.cupon.valido, false); assert.equal(v.descuento, 0);
  assert.equal((await get(`/carrito/${c.token}`)).json.cupon, null); // ya se quito
  const conn2 = await pool.getConnection();
  await Cupones.reponer(conn2, unico.id, 'P1'); conn2.release();
  assert.equal((await put(`/carrito/${c.token}/cupon`, { codigo: 'UNICO' })).status, 200); // la cancelacion repone el uso
});

test('Ventas Online.RF07: la regla de envio gratis aparece en el carrito', async () => {
  assert.equal((await api('PUT', '/api/ventas-online/envio-gratis', { token: gerente.token, body: { minimo: -5 } })).status, 400);
  await api('PUT', '/api/ventas-online/envio-gratis', { token: gerente.token, body: { minimo: 1500 } });
  const c = await nuevo([{ producto_id: B.id, cantidad: 2 }]);
  assert.deepEqual([(await get(`/carrito/${c.token}`)).json.envio_gratis.gratis, (await get(`/carrito/${c.token}`)).json.envio_gratis.minimo], [false, 1500]);
  assert.equal((await post(`/carrito/${c.token}/items`, { producto_id: A.id, cantidad: 1 })).json.envio_gratis.gratis, true);
});

test('Ventas Online.RF08: la cuenta se registra, ingresa, guarda direcciones y datos fiscales y recupera su contrasena', async () => {
  const reg = await post('/cuenta/registro', { email: 'Ana@Mail.Test', password: 'clave-larga-1', nombre: 'Ana', telefono: '341-1' });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  assert.equal(reg.json.cuenta.email, 'ana@mail.test');
  assert.equal((await post('/cuenta/registro', { email: 'ana@mail.test', password: 'clave-larga-1', nombre: 'Ana' })).json.codigo, 'EMAIL_EN_USO');
  for (const mal of [{ email: 'no', password: 'clave-larga-1', nombre: 'x' }, { email: 'b@mail.test', password: 'corta', nombre: 'x' }, { email: 'b@mail.test', password: 'clave-larga-1' }]) assert.equal((await post('/cuenta/registro', mal)).status, 400);
  assert.equal((await post('/cuenta/ingresar', { email: 'ana@mail.test', password: 'mala' })).status, 401);
  assert.equal((await post('/cuenta/ingresar', { email: 'nadie@mail.test', password: 'clave-larga-1' })).status, 401);
  const tok = (await post('/cuenta/ingresar', { email: 'ana@mail.test', password: 'clave-larga-1' })).json.token;
  assert.equal((await get('/cuenta')).status, 401);
  assert.equal((await get('/cuenta', adm.token)).status, 401); // el token del personal no abre la cuenta
  const cuenta = await put('/cuenta', { direcciones: [{ etiqueta: 'Casa', calle: 'Mitre 123', localidad: 'Rosario' }], datos_fiscales: { tipo_documento: 'cuit', documento: '30-71111111-1', razon_social: 'Ana SRL', condicion_iva: 'Responsable Inscripto' } }, tok);
  assert.equal(cuenta.status, 200, JSON.stringify(cuenta.json));
  assert.equal(cuenta.json.direcciones.length, 1); assert.equal(cuenta.json.datos_fiscales.documento, '30711111111');
  const mal = await put('/cuenta', { datos_fiscales: { tipo_documento: 'cuit', documento: '30711111112' } }, tok);
  assert.equal(mal.status, 400); assert.equal(mal.json.codigo, 'CUIT_INVALIDO'); // EX14
  // Recuperar la contrasena: la respuesta no revela si el correo existe y el codigo sale por correo.
  assert.equal((await post('/cuenta/recuperar', { email: 'nadie@mail.test' })).json.mensaje, (await post('/cuenta/recuperar', { email: 'ana@mail.test' })).json.mensaje);
  const [[mail]] = await pool.query("SELECT cuerpo FROM correo_cola WHERE para = 'ana@mail.test' ORDER BY id DESC LIMIT 1");
  const codigo = mail.cuerpo.match(/: ([0-9a-f]{48})/)[1];
  assert.equal((await post('/cuenta/restablecer', { token: 'x'.repeat(48), password: 'otra-clave-123' })).json.codigo, 'RESET_INVALIDO');
  assert.equal((await post('/cuenta/restablecer', { token: codigo, password: 'otra-clave-123' })).status, 200);
  assert.equal((await post('/cuenta/restablecer', { token: codigo, password: 'otra-clave-123' })).status, 400); // un solo uso
  assert.equal((await post('/cuenta/ingresar', { email: 'ana@mail.test', password: 'otra-clave-123' })).status, 200);
});

test('Ventas Online.RF08/RN47: al iniciar sesion se recalcula el carrito con la lista del cliente y se muestra el cambio', async () => {
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['VEN-LISTAS'], motivo: 'prueba' } });
  const [l] = await pool.query("INSERT INTO listas_precio (nombre, tipo) VALUES ('Socios', 'otra')");
  await pool.query('INSERT INTO lista_precio_items (lista_id, producto_id, precio) VALUES (?, ?, 250)', [l.insertId, B.id]);
  const [cl] = await pool.query("INSERT INTO clientes (id_global, tipo_documento, nro_documento, razon_social) VALUES ('TST01-CLI-ANA', 'DNI', '30111222', 'Ana')");
  await pool.query('INSERT INTO ventas_clientes_copia (cliente_id, razon_social, lista_precio_id, socio, actualizado_ms) VALUES (?, ?, ?, 0, ?)', [cl.insertId, 'Ana', l.insertId, Date.now()]);
  const tok = (await post('/cuenta/ingresar', { email: 'ana@mail.test', password: 'otra-clave-123' })).json.token;
  const [[cta]] = await pool.query("SELECT id FROM onl_clientes WHERE email = 'ana@mail.test'");
  assert.equal((await api('PUT', `/api/ventas-online/clientes/${cta.id}/vinculo`, { token: gerente.token, body: { cliente_id: cl.insertId } })).status, 200);
  await api('PUT', '/api/ventas-online/precios/ajustes', { token: gerente.token, body: { global: 0 } });
  await pool.query("UPDATE onl_tienda SET prioridad_lista = 'cliente'");
  const c = await nuevo([{ producto_id: B.id, cantidad: 2 }]);
  const v = await post(`/carrito/${c.token}/asociar`, {}, tok);
  assert.equal(v.status, 200, JSON.stringify(v.json));
  assert.equal(v.json.lineas[0].precio_unitario, 250); assert.equal(v.json.lineas[0].precio_anterior, 300);
  assert.equal(v.json.avisos[0].tipo, 'cambio_precio');
  assert.equal((await post(`/carrito/${c.token}/asociar`, {})).status, 401);
});

test('Ventas Online.RF08: con ONL-CUENTA-CLIENTE apagada solo se compra como invitado', async () => {
  const r = await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { desactivar: ['ONL-CUENTA-CLIENTE'], motivo: 'prueba' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await post('/cuenta/registro', { email: 'c@mail.test', password: 'clave-larga-1', nombre: 'C' })).json.codigo, 'FUNCION_INACTIVA');
  assert.equal((await post('/cuenta/ingresar', { email: 'ana@mail.test', password: 'otra-clave-123' })).json.codigo, 'FUNCION_INACTIVA');
  assert.equal((await post('/carrito', { producto_id: B.id, cantidad: 1 })).status, 201); // el invitado compra igual
});
