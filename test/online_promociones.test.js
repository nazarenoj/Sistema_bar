process.env.AFIP_CONDICION_IVA_EMISOR = 'responsable_inscripto';
process.env.AFIP_PUNTO_VENTA = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const { simularArca } = require('./ayudas_online');

// Ventas Online RF21/RN24: las promociones automáticas de Ventas (VEN-PROMOS) se aplican solas en el carrito y el checkout, se muestran junto al ítem y se registran en la venta.
let api, pool, cerrar, adm, gerente, A, B, k = 0;
const T = '/tienda/cafe-promo';

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  simularArca();
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  await api('POST', '/api/modulos/ventas_online/instalar', { token: adm.token });
  await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { codigo: 'cafe-promo', nombre: 'Cafe', razon_social: 'Cafe SA', cuit: '30711111111', domicilio: 'Mitre 1', activa: true } });
  A = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Medialuna', precio: 300, stock: 0 } })).json;
  B = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Cafe', precio: 500, stock: 0 } })).json;
  for (const p of [A, B]) await api('PUT', `/api/ventas-online/catalogo/${p.id}`, { token: gerente.token, body: { categoria_online: 'Menu' } });
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
});
after(async () => { await cerrar(); });

const carrito = async (items, cupon = null) => {
  let c;
  for (const [i, it] of items.entries()) c = i === 0 ? (await api('POST', `${T}/carrito`, { body: it })).json : (await api('POST', `${T}/carrito/${c.token}/items`, { body: it })).json;
  if (cupon) c = (await api('PUT', `${T}/carrito/${c.token}/cupon`, { body: { codigo: cupon } })).json;
  return c;
};

test('Ventas Online.RF21: sin VEN-PROMOS la tienda opera solo con precios y cupones', async () => {
  const c = await carrito([{ producto_id: A.id, cantidad: 2 }]);
  assert.equal(c.total, 600);
  assert.equal(c.descuento_promos ?? 0, 0);
});

test('Ventas Online.RF21/RN23: una promoción 2x1 se aplica sola, se muestra junto al ítem y baja el total', async () => {
  assert.equal((await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['VEN-PROMOS', 'ONL-CUPONES'], motivo: 'prueba' } })).status, 200);
  const p = await api('POST', '/api/promociones', { token: adm.token, body: { nombre: 'Medialunas 2x1', tipo: '2x1', items: [{ producto_id: A.id }] } });
  assert.equal(p.status, 201, JSON.stringify(p.json));
  const c = await carrito([{ producto_id: A.id, cantidad: 2 }, { producto_id: B.id, cantidad: 1 }]);
  assert.equal(c.subtotal, 1100);
  assert.equal(c.descuento_promos, 300); // una medialuna gratis
  assert.equal(c.total, 800);
  const l = c.lineas.find((x) => x.producto_id === A.id);
  assert.equal(l.descuento_promo, 300);
  assert.equal(l.promociones[0].nombre, 'Medialunas 2x1');
  assert.ok(c.avisos.some((a) => a.tipo === 'promocion_aplicada'));
  assert.equal(c.lineas.find((x) => x.producto_id === B.id).descuento_promo, 0);
  // Con una sola medialuna no hay promoción.
  assert.equal((await carrito([{ producto_id: A.id, cantidad: 1 }])).total, 300);
});

test('Ventas Online.RN24: un cupón no acumulable no se suma al ítem con promoción; uno acumulable sí, sobre el precio ya promocionado', async () => {
  const cupon = (b) => api('POST', '/api/ventas-online/cupones', { token: gerente.token, body: b });
  assert.equal((await cupon({ codigo: 'DIEZ', tipo: 'porcentaje', valor: 10 })).status, 201);
  assert.equal((await cupon({ codigo: 'DIEZACUM', tipo: 'porcentaje', valor: 10, acumulable: true })).status, 201);
  const items = [{ producto_id: A.id, cantidad: 2 }, { producto_id: B.id, cantidad: 1 }];
  // No acumulable: el 10 % es solo sobre el café (50), la medialuna conserva su promoción.
  const no = await carrito(items, 'DIEZ');
  assert.equal(no.descuento, 50);
  assert.equal(no.total, 1100 - 300 - 50);
  // Acumulable: el 10 % es sobre lo que queda después de la promoción: (300 + 500) x 10 % = 80.
  const si = await carrito(items, 'DIEZACUM');
  assert.equal(si.descuento, 80);
  assert.equal(si.total, 1100 - 300 - 80);
});

test('Ventas Online.RF21: el pedido guarda el descuento por línea y Ventas registra la venta con las promociones aplicadas', async () => {
  const c = await carrito([{ producto_id: A.id, cantidad: 2 }, { producto_id: B.id, cantidad: 1 }], 'DIEZ');
  require('../src/ventas_online/limites').pedidos.reiniciar();
  const r = await api('POST', `${T}/checkout`, { headers: { 'X-ID-Solicitud': `sol-promo-${++k}-abcdef` }, body: { carrito: c.token, contacto: { nombre: 'Ana', email: 'ana@mail.test' }, medio_pago: 'pago_al_retirar', acepta_terminos: true,
    total_confirmado: c.total, entrega: { tipo: 'retiro' } } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.descuento, 350); // 300 de la promoción y 50 del cupón
  assert.equal(r.json.total, 750);
  const [lineas] = await pool.query('SELECT producto_id, descuento_linea, promociones FROM onl_pedido_lineas WHERE pedido_id = ? ORDER BY linea', [r.json.id]);
  assert.deepEqual(lineas.map((l) => Number(l.descuento_linea)), [300, 50]);
  assert.equal(JSON.parse(lineas[0].promociones)[0].nombre, 'Medialunas 2x1');
  // El comercio acepta el pedido: Ventas registra la venta por el total neto y deja la promoción aplicada.
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${r.json.id}/aceptar`, { token: gerente.token })).status, 200);
  await esperarMensajes(pool);
  const [[v]] = await pool.query('SELECT id, id_global, total FROM ventas ORDER BY id DESC LIMIT 1');
  assert.equal(Number(v.total), 750);
  const [aplicadas] = await pool.query('SELECT nombre, importe FROM promociones_aplicadas WHERE clave = ?', [r.json.id_global]);
  assert.deepEqual(aplicadas.map((x) => [x.nombre, Number(x.importe)]), [['Medialunas 2x1', 300]]);
  const venta = (await api('GET', `/api/ventas/${v.id_global}`, { token: adm.token })).json;
  assert.equal(venta.detalle.find((l) => l.producto_id === A.id).importe_descuento, 300);
});
