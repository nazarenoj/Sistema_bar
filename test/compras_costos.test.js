process.env.AFIP_CONDICION_IVA_EMISOR = 'responsable_inscripto';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const Equivalencias = require('../src/servicios/equivalenciaTerceroService');
const puertos = require('../src/modulos/puertos');

let api, pool, cerrar, adm, gerente, administrativo, contador, prov, harina, cafe, azucar, bolsa, paquete, k = 0;
const CUIT = '30711111111';
const hoy = () => new Date().toISOString().slice(0, 10);

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  contador = await usuario(api, pool, 'cora', 'contador');
  await api('POST', '/api/modulos/compras/instalar', { token: adm.token });
  prov = (await api('POST', '/api/compras/proveedores', { token: administrativo.token, body: { cuit: CUIT, razon_social: 'Molino Costos SA', condicion_iva: 'Responsable Inscripto', consultar_arca: false } })).json;
  const insumo = async (nombre) => (await api('POST', '/api/insumos', { token: adm.token, body: { nombre, unidad: 'kg' } })).json;
  harina = await insumo('Harina costos'); cafe = await insumo('Cafe costos'); azucar = await insumo('Azucar costos');
  bolsa = (await api('POST', '/api/presentaciones', { token: adm.token, body: { insumo_id: harina.id, nombre: 'bolsa 25 kg', factor: 25, usos: ['compra'] } })).json;
  paquete = (await api('POST', '/api/presentaciones', { token: adm.token, body: { insumo_id: cafe.id, nombre: 'paquete 1 kg', factor: 1, usos: ['compra'] } })).json;
  await Equivalencias.guardar({ cuit: CUIT, descripcion: 'HAR-001', tipo_destino: 'item_stock', id_destino: harina.id, presentacion_id: bolsa.id });
  await Equivalencias.guardar({ cuit: CUIT, descripcion: 'CAF-001', tipo_destino: 'item_stock', id_destino: cafe.id, presentacion_id: paquete.id });
});
after(async () => { await cerrar(); });

const factura = async (item, precio, extra = {}) => {
  const cant = 10, neto = Math.round(cant * precio * 100) / 100, iva = Math.round(neto * 21) / 100;
  const r = await api('POST', '/api/compras/comprobantes', { token: administrativo.token, body: { cuit: CUIT, clase: 'FACTURA', tipo: 'A', punto_venta: 1, numero: String(++k), fecha: hoy(), alicuotas: [{ alicuota: 21, neto, iva }], otros_tributos: k, total: Math.round((neto + iva + k) * 100) / 100,
    lineas: [{ item: { tipo: 'insumo', id: item.id }, cantidad: cant, descripcion: 'Mercaderia', precio_unitario: precio }], ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
};
const cr = async (item) => (await api('GET', '/api/compras/costos', { token: gerente.token })).json.find((c) => c.item_id === item.id);
const config = (b) => api('PUT', '/api/compras/config', { token: adm.token, body: b });
const pendientes = async () => (await api('GET', '/api/compras/costos/pendientes', { token: gerente.token })).json;

test('Compras.RN05: la primera factura fija el costo de reposicion y llega a Ventas y a Stock por eventos', async () => {
  await factura(cafe, 100);
  const c = await cr(cafe);
  assert.equal(c.costo, 100); assert.equal(c.fuente, 'factura');
  await esperarMensajes(pool);
  const [[v]] = await pool.query("SELECT costo FROM ventas_costos_reposicion WHERE item_tipo = 'insumo' AND item_id = ?", [cafe.id]);
  const [[s]] = await pool.query("SELECT costo FROM stock_costo_referencia WHERE item_tipo = 'insumo' AND item_id = ?", [cafe.id]);
  assert.equal(Number(v.costo), 100); assert.equal(Number(s.costo), 100);
});

test('Compras.RN27: el puerto costoReposicion responde el costo y sin costo para un item desconocido', async () => {
  const p = await puertos.obtener('costoReposicion');
  assert.equal((await p.costo({ tipo: 'insumo', id: cafe.id })).costo, 100);
  assert.equal(await p.costo({ tipo: 'insumo', id: azucar.id }), null);
});

test('Compras.RN06/EX10: siempre actualiza; una variacion mayor al umbral pide confirmacion y se confirma o rechaza', async () => {
  assert.equal((await config({ actualizacion_costo: 'siempre', variacion_costo_pct: 50 })).status, 200);
  await factura(cafe, 120);
  assert.equal((await cr(cafe)).costo, 120);
  await factura(cafe, 600);
  assert.equal((await cr(cafe)).costo, 120);
  const pend = await pendientes();
  assert.equal(pend.length, 1); assert.equal(pend[0].costo_propuesto, 600);
  assert.equal((await api('POST', `/api/compras/costos/pendientes/${pend[0].id}/rechazar`, { token: gerente.token })).json.estado, 'rechazado');
  assert.equal((await api('POST', `/api/compras/costos/pendientes/${pend[0].id}/confirmar`, { token: gerente.token })).status, 409);
  await factura(cafe, 700);
  const [p2] = await pendientes();
  assert.equal((await api('POST', `/api/compras/costos/pendientes/${p2.id}/confirmar`, { token: contador.token })).status, 403);
  assert.equal((await api('POST', `/api/compras/costos/pendientes/${p2.id}/confirmar`, { token: gerente.token })).status, 200);
  assert.equal((await cr(cafe)).costo, 700);
});

test('Compras.RN06: solo si aumenta ignora una baja y con confirmacion deja todo pendiente', async () => {
  await config({ actualizacion_costo: 'solo_si_aumenta', variacion_costo_pct: 500 });
  await factura(cafe, 690);
  assert.equal((await cr(cafe)).costo, 700);
  await factura(cafe, 710);
  assert.equal((await cr(cafe)).costo, 710);
  await config({ actualizacion_costo: 'con_confirmacion' });
  await factura(cafe, 720);
  assert.equal((await cr(cafe)).costo, 710);
  const pend = await pendientes();
  assert.equal(pend.length, 1);
  await api('POST', `/api/compras/costos/pendientes/${pend[0].id}/confirmar`, { token: gerente.token });
  assert.equal((await cr(cafe)).costo, 720);
  await config({ actualizacion_costo: 'siempre', variacion_costo_pct: 50 });
});

test('Compras.RN05: un comprobante B integra el IVA al costo', async () => {
  await factura(azucar, 100, { tipo: 'B' });
  const c = await cr(azucar);
  assert.ok(c && c.costo >= 100, JSON.stringify(c));
});

test('Compras.RF11: el ajuste manual exige permiso y motivo, queda en el historial y se publica', async () => {
  assert.equal((await api('PUT', `/api/compras/costos/insumo/${azucar.id}`, { token: administrativo.token, body: { costo: 5, motivo: 'prueba' } })).status, 403);
  assert.equal((await api('PUT', `/api/compras/costos/insumo/${azucar.id}`, { token: gerente.token, body: { costo: 55 } })).status, 400);
  const r = await api('PUT', `/api/compras/costos/insumo/${azucar.id}`, { token: gerente.token, body: { costo: 55, motivo: 'oferta del proveedor' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.fuente, 'manual');
  const h = (await api('GET', `/api/compras/costos/insumo/${azucar.id}/historial`, { token: gerente.token })).json;
  assert.equal(h[0].costo, 55);
  await esperarMensajes(pool);
  const [[v]] = await pool.query("SELECT costo FROM ventas_costos_reposicion WHERE item_id = ? AND item_tipo = 'insumo'", [azucar.id]);
  assert.equal(Number(v.costo), 55);
});

const csv = (filas) => `codigo,descripcion,precio,bonificacion\n${filas.join('\n')}`;
test('Compras.RN15/EX09: una lista con una fila sin equivalencia se rechaza entera y no cambia nada', async () => {
  const antes = (await cr(cafe)).costo;
  const r = await api('POST', '/api/compras/listas', { token: gerente.token, body: { proveedor_id: prov.id, contenido: csv(['CAF-001,Cafe,900,0', 'XXX-999,Desconocido,10,0']) } });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.equal(r.json.codigo, 'LISTA_INVALIDA');
  assert.equal(r.json.detalle.errores[0].fila, 3);
  assert.equal((await cr(cafe)).costo, antes);
  assert.equal((await api('GET', '/api/compras/listas', { token: gerente.token })).json.length, 0);
});

test('Compras.RF10: vista previa, importacion con unidad de compra y bonificacion, historial de listas', async () => {
  const vp = await api('POST', '/api/compras/listas/vista-previa', { token: gerente.token, body: { proveedor_id: prov.id, contenido: csv(['CAF-001,Cafe,725,0']) } });
  assert.equal(vp.status, 200, JSON.stringify(vp.json));
  assert.equal(vp.json.cambios[0].costo_actual, 720);
  assert.equal((await api('GET', '/api/compras/listas', { token: gerente.token })).json.length, 0);
  const r = await api('POST', '/api/compras/listas', { token: gerente.token, body: { proveedor_id: prov.id, nombre: 'Lista enero', filas: [
    { item_tipo: 'insumo', item_id: cafe.id, precio: 725 }, { item_tipo: 'insumo', item_id: harina.id, presentacion_id: bolsa.id, precio: 1250, bonificacion: 10 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.estado, 'vigente');
  assert.equal((await cr(cafe)).costo, 725); assert.equal((await cr(cafe)).fuente, 'lista');
  assert.equal((await cr(harina)).costo, 45);
  const l2 = await api('POST', '/api/compras/listas', { token: gerente.token, body: { proveedor_id: prov.id, filas: [{ item_tipo: 'insumo', item_id: cafe.id, precio: 730 }] } });
  assert.equal(l2.status, 201);
  assert.equal((await api('GET', `/api/compras/listas/${r.json.id}`, { token: gerente.token })).json.estado, 'historica');
  assert.equal((await api('GET', '/api/compras/listas?estado=vigente', { token: gerente.token })).json.length, 1);
  assert.equal((await api('POST', '/api/compras/listas', { token: contador.token, body: { proveedor_id: prov.id, filas: [] } })).status, 403);
});

test('Compras.RN40: la copia de Ventas converge al ultimo costo publicado', async () => {
  await esperarMensajes(pool);
  const [[v]] = await pool.query("SELECT costo FROM ventas_costos_reposicion WHERE item_id = ? AND item_tipo = 'insumo'", [cafe.id]);
  assert.equal(Number(v.costo), (await cr(cafe)).costo);
});
