const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');
const Lectura = require('../src/servicios/lecturaComprobanteService');

let api, pool, cerrar, token, tokenBarista;
const CUIT = '30711111111';

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

const leer = (contenido = 'imagen') => api('POST', '/api/lectura-comprobantes/leer', { token, headers: { 'Content-Type': 'image/png' }, body: contenido });
const propuesta = { encabezado: { cuit: CUIT, clase: 'FACTURA', tipo: 'A', punto_venta: 3, numero: 4521, fecha: '2026-10-05', importe: 12100, proveedor: 'Molinos SA' }, lineas: [{ descripcion: 'HARINA 000 X 25KG', cantidad: 2, costo: 1000 }], confianza: { cuit: 0.99, numero: 0.7, importe: 0.95 } };

test('Usuarios.RF15/RN18/RN19: la lectura necesita USU-FOTO, exige https y solo devuelve una propuesta con confianza y verificación de la clave', async () => {
  assert.equal((await leer()).status, 409); // función apagada
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['USU-FOTO'], motivo: 'prueba' } })).status, 200);
  assert.equal((await leer()).json.estado, 'pendiente'); // sin servicio configurado
  assert.equal((await api('PUT', '/api/lectura-comprobantes/configuracion', { token, body: { url: 'http://lector.ejemplo.com/leer' } })).status, 400); // RN19
  assert.equal((await api('PUT', '/api/lectura-comprobantes/configuracion', { token: tokenBarista, body: { url: 'https://lector.ejemplo.com/leer' } })).status, 403);
  assert.equal((await api('PUT', '/api/lectura-comprobantes/configuracion', { token, body: { url: 'https://lector.ejemplo.com/leer' } })).status, 200);
  Lectura.usarProveedor(async ({ imagen, tipo }) => { assert.equal(tipo, 'image/png'); assert.ok(imagen.length); return propuesta; });
  const r = (await leer()).json;
  assert.deepEqual([r.estado, r.propuesta, r.origen], ['ok', true, 'servicio']);
  assert.deepEqual([r.confianza.cuit, r.confianza.numero], [0.99, 0.7]);
  assert.deepEqual(r.faltan, ['cae']); // el servicio no leyó el CAE: queda para completar
  assert.deepEqual([r.verificacion.clave_valida, r.verificacion.clave], [true, `${CUIT}-FACTURA-A-00003-00004521`]);
  // Un dato mal leído se detecta con las reglas de la clave y se dice qué corregir.
  Lectura.usarProveedor(async () => ({ ...propuesta, encabezado: { ...propuesta.encabezado, cuit: '30711111112', numero: undefined } }));
  const mala = (await leer()).json;
  assert.deepEqual([mala.verificacion.clave_valida, mala.verificacion.corregir], [false, 'cuit']);
  assert.ok(mala.faltan.includes('numero'));
});

test('Usuarios.EX11: si el servicio no responde, la respuesta es "pendiente" y el ingreso de Stock guarda la imagen y la vuelve a leer después', async () => {
  Lectura.usarProveedor(async () => { throw new Error('timeout'); });
  assert.equal((await leer()).json.estado, 'pendiente');
  const b = await api('POST', '/api/stock-ingresos/fotos', { token, headers: { 'Content-Type': 'image/png', 'X-Nombre-Archivo': 'f.png' }, body: 'imagen' });
  assert.equal(b.json.estado, 'pendiente_lectura');
  assert.equal((await api('POST', `/api/stock-ingresos/fotos/${b.json.id}/releer`, { token })).json.lectura, 'pendiente'); // sigue caído
  Lectura.usarProveedor(async () => propuesta);
  const ok = await api('POST', `/api/stock-ingresos/fotos/${b.json.id}/releer`, { token });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.estado, ok.json.encabezado.numero, ok.json.lineas.length], ['borrador', 4521, 1]); // el servicio solo propuso: no hay ingreso ni stock
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM stock_ingresos'))[0][0].n, 0);
});

test('Usuarios.RF15: el QR fiscal de ARCA se lee sin conexión', async () => {
  const qr = (d) => `https://www.afip.gob.ar/fe/qr/?p=${Buffer.from(JSON.stringify(d)).toString('base64')}`;
  const r = (await api('POST', '/api/lectura-comprobantes/qr', { token, body: { texto: qr({ ver: 1, fecha: '2026-10-05', cuit: 30711111111, ptoVta: 3, tipoCmp: 1, nroCmp: 4521, importe: 12100, moneda: 'PES', ctz: 1, tipoCodAut: 'E', codAut: 70123456789012 }) } })).json;
  assert.deepEqual([r.origen, r.encabezado.clase, r.encabezado.tipo, r.encabezado.numero, r.encabezado.cae, r.confianza.cuit], ['qr', 'FACTURA', 'A', 4521, '70123456789012', 1]);
  assert.equal(r.verificacion.clave_valida, true);
  assert.equal((await api('POST', '/api/lectura-comprobantes/qr', { token, body: { texto: 'https://ejemplo.com/otra-cosa' } })).status, 400);
});

test('Usuarios.RF16/RN20: el diccionario lleva el texto del tercero a un único destino y, para un ítem de stock, a una presentación de Stock sin factor propio', async () => {
  const harina = (await api('POST', '/api/insumos', { token, body: { nombre: 'Harina 000', unidad: 'kg' } })).json;
  const otro = (await api('POST', '/api/insumos', { token, body: { nombre: 'Azúcar', unidad: 'kg' } })).json;
  const bolsa = (await api('POST', '/api/presentaciones', { token, body: { insumo_id: harina.id, nombre: 'bolsa 25 kg', factor: 25, usos: ['compra'] } })).json;
  const ajena = (await api('POST', '/api/presentaciones', { token, body: { insumo_id: otro.id, nombre: 'bolsa 50 kg', factor: 50, usos: ['compra'] } })).json;
  const guardar = (b, t = token) => api('POST', '/api/equivalencias-terceros', { token: t, body: b });
  const base = { cuit: CUIT, descripcion: 'HARINA 000 x 25kg', tipo_destino: 'item_stock', id_destino: harina.id, presentacion_id: bolsa.id };
  assert.equal((await guardar(base, tokenBarista)).status, 403);
  assert.equal((await guardar({ ...base, cuit: '123' })).status, 400);
  assert.equal((await guardar({ ...base, presentacion_id: ajena.id })).status, 400); // la presentación tiene que ser del ítem
  assert.equal((await guardar({ ...base, presentacion_id: undefined })).status, 400); // un ítem de stock lleva presentación
  assert.equal((await guardar({ ...base, id_destino: 99999 })).status, 404);
  assert.equal((await guardar({ ...base, tipo_destino: 'categoria_gasto', presentacion_id: undefined })).status, 409); // sin Financiero
  const ok = await guardar(base);
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(Object.keys(ok.json).some((k) => /factor|unidad/.test(k)), false); // el diccionario no guarda factor ni unidad
  // Un texto de un emisor lleva a un solo destino: guardar de nuevo lo reemplaza.
  const prod = (await api('POST', '/api/productos', { token, body: { nombre: 'Pan', precio: 100 } })).json;
  const art = await guardar({ cuit: CUIT, descripcion: 'harina 000 X 25KG', tipo_destino: 'articulo', id_destino: prod.id });
  assert.equal(art.status, 201);
  assert.equal((await api('GET', `/api/equivalencias-terceros?cuit=${CUIT}`, { token })).json.length, 1);
  assert.equal((await guardar(base)).status, 201);
  const r = await api('POST', '/api/equivalencias-terceros/resolver', { token, body: { cuit: CUIT, descripcion: '  Harina 000 x 25KG ' } });
  assert.deepEqual([r.json.estado, r.json.id_destino, r.json.presentacion_id], ['vigente', harina.id, bolsa.id]);
  assert.equal((await api('POST', '/api/equivalencias-terceros/resolver', { token, body: { cuit: CUIT, descripcion: 'otra cosa' } })).status, 404);

  // Stock crea una versión nueva de la presentación (como ya tuvo uso): rige la vigente. Si queda sin vigencia, pasa a "revisar".
  await api('POST', '/api/stock/ingresos', { token, body: { motivo: 'compra', lineas: [{ item: { tipo: 'insumo', id: harina.id }, cantidad: 1, presentacion_id: bolsa.id, costo_unitario: 10 }] } });
  const nueva = await api('PUT', `/api/presentaciones/${bolsa.id}`, { token, body: { factor: 26 } });
  assert.equal(nueva.status, 200, JSON.stringify(nueva.json));
  const nuevoId = nueva.json.id;
  assert.notEqual(nuevoId, bolsa.id);
  const actual = (await api('POST', '/api/equivalencias-terceros/resolver', { token, body: { cuit: CUIT, descripcion: 'harina 000 x 25kg' } })).json;
  assert.deepEqual([actual.estado, actual.presentacion_id], ['vigente', nuevoId]);
  await pool.query('UPDATE presentaciones SET vigente_hasta = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE insumo_id = ? AND nombre = ?', [harina.id, 'bolsa 25 kg']);
  const rev = (await api('POST', '/api/equivalencias-terceros/resolver', { token, body: { cuit: CUIT, descripcion: 'harina 000 x 25kg' } })).json;
  assert.deepEqual([rev.estado, /elegí otra/.test(rev.motivo)], ['revisar', true]);
  assert.equal((await api('GET', '/api/equivalencias-terceros?estado=revisar', { token })).json.length, 1);
  const volver = await guardar({ ...base, presentacion_id: nuevoId });
  assert.equal(volver.status, 409); // sigue sin vigencia: hay que elegir una vigente
  const nueva2 = (await api('POST', '/api/presentaciones', { token, body: { insumo_id: harina.id, nombre: 'bolsa 20 kg', factor: 20, usos: ['compra'] } })).json;
  assert.equal((await guardar({ ...base, presentacion_id: nueva2.id })).json.estado, 'vigente');
  assert.equal((await api('DELETE', `/api/equivalencias-terceros/${ok.json.id}`, { token })).status, 200);
});

test('Stock RF05 + Usuarios RF16: la lectura reconoce sola a un proveedor ya asociado, desde el diccionario de la plataforma', async () => {
  const sal = (await api('POST', '/api/insumos', { token, body: { nombre: 'Sal', unidad: 'kg' } })).json;
  const paquete = (await api('POST', '/api/presentaciones', { token, body: { insumo_id: sal.id, nombre: 'paquete 1 kg', factor: 1, usos: ['compra'] } })).json;
  await api('POST', '/api/equivalencias-terceros', { token, body: { cuit: CUIT, descripcion: 'SAL FINA 1KG', tipo_destino: 'item_stock', id_destino: sal.id, presentacion_id: paquete.id } });
  Lectura.usarProveedor(async () => ({ encabezado: { ...propuesta.encabezado, numero: 9001 }, lineas: [{ descripcion: 'Sal fina 1kg', cantidad: 3, costo: 500 }], confianza: {} }));
  const b = await api('POST', '/api/stock-ingresos/fotos', { token, headers: { 'Content-Type': 'image/png' }, body: 'imagen' });
  assert.equal(b.json.estado, 'borrador');
  assert.deepEqual([b.json.lineas[0].item, b.json.lineas[0].presentacion_id, b.json.lineas[0].reconocida], [{ tipo: 'insumo', id: sal.id }, paquete.id, true]);
});
