const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const Pasarela = require('../src/ventas_online/pasarelaMP');
const Pagos = require('../src/ventas_online/pagoService');

let api, pool, cerrar, adm, gerente, administrativo, cajero, E, V, k = 0;
const T = '/tienda/cafe-env';
const TODO_EL_DIA = Object.fromEntries(['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'].map((d) => [d, [{ desde: '00:00', hasta: '23:59' }]]));
const FRANJA = 15 * 60000;
const proxima = (min) => Math.ceil((Date.now() + min * 60000) / FRANJA) * FRANJA; // una franja de 15 minutos que arranca dentro de `min` minutos

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  cajero = await usuario(api, pool, 'cami', 'cajero');
  await api('POST', '/api/modulos/ventas_online/instalar', { token: adm.token });
  await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { codigo: 'cafe-env', nombre: 'Cafe', razon_social: 'Cafe SA', cuit: '30711111111', domicilio: 'Mitre 1', activa: true, horarios: TODO_EL_DIA } });
  E = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Torta por encargo', precio: 5000, stock: 0 } })).json;
  V = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Medialuna de vitrina', precio: 300, stock: 0 } })).json;
  for (const p of [E, V]) await api('PUT', `/api/ventas-online/catalogo/${p.id}`, { token: gerente.token, body: { categoria_online: 'Menu' } });
  await api('PUT', `/api/ventas-online/catalogo/${E.id}/preparacion`, { token: gerente.token, body: { prep_min: 20 } });
  Pasarela.usarProveedor({ nombre: 'mercadopago', crearCobro: async () => ({ preferencia_id: 'P', url: 'https://x' }), obtenerPago: async () => ({}), buscarPagos: async () => [], reintegrar: async () => ({ id: 'R', estado: 'approved' }), verificarFirma: async () => true });
});
after(async () => { Pasarela.usarProveedor(null); await cerrar(); });

const carrito = async (items) => {
  let c;
  for (const [i, it] of items.entries()) c = i === 0 ? (await api('POST', `${T}/carrito`, { body: it })).json : (await api('POST', `${T}/carrito/${c.token}/items`, { body: it })).json;
  return c;
};
const cotizar = (c, entrega) => api('POST', `${T}/entrega/cotizar`, { body: { carrito: c.token, entrega } });
const pedir = async (c, entrega, extra = {}) => {
  require('../src/ventas_online/limites').pedidos.reiniciar();
  return api('POST', `${T}/checkout`, { headers: { 'X-ID-Solicitud': `sol-env-${++k}-abcdef` }, body: { carrito: c.token, contacto: { nombre: 'Ana', email: 'ana@mail.test' }, entrega, medio_pago: 'pago_al_retirar', acepta_terminos: true, total_confirmado: c.total + (extra.envio ?? 0), ...extra.body } });
};

test('Ventas Online.RF11: las zonas de delivery se configuran con permiso, por codigo postal sin repetirse', async () => {
  const z = (b, t = gerente) => api('POST', '/api/ventas-online/zonas', { token: t.token, body: b });
  assert.equal((await z({ nombre: 'Centro', codigos_postales: ['2000'], costo: 500 }, administrativo)).status, 403);
  assert.equal((await z({ nombre: '', codigos_postales: ['2000'] })).status, 400);
  assert.equal((await z({ nombre: 'Centro', codigos_postales: [] })).status, 400);
  assert.equal((await z({ nombre: 'Centro', codigos_postales: ['20'] })).status, 400);
  const ok = await z({ nombre: 'Centro', codigos_postales: ['2000', '2001'], costo: 500, plazo_min: 45, minimo_compra: 1000, gratis_desde: 8000 });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal((await z({ nombre: 'Norte', codigos_postales: ['2001'] })).json.codigo, 'CP_EN_OTRA_ZONA');
  await z({ nombre: 'Norte', codigos_postales: ['2002'], costo: 900, plazo_min: 90 });
  assert.equal((await api('GET', '/api/ventas-online/zonas', { token: administrativo.token })).json.length, 2);
  assert.equal((await api('GET', `${T}/entrega/zonas`)).json.length, 2);
  assert.equal((await api('GET', '/api/ventas-online/funciones-no-existe', { token: gerente.token })).status, 404);
});

test('Ventas Online.RF11: el retiro no cuesta y el delivery cobra la tarifa de su zona, con minimo de compra y envio gratis por zona', async () => {
  const c = await carrito([{ producto_id: V.id, cantidad: 4 }]); // 1200
  const retiro = (await cotizar(c, { tipo: 'retiro' })).json;
  assert.deepEqual([retiro.tipo, retiro.costo, retiro.modalidad, retiro.tiempo_estimado_min], ['retiro', 0, 'barra', 0]);
  assert.equal((await cotizar(c, { tipo: 'retiro', modalidad: 'vitrina' })).json.modalidad, 'vitrina');
  const d = (await cotizar(c, { tipo: 'delivery', calle: 'Mitre 123', codigo_postal: '2000' })).json;
  assert.deepEqual([d.costo, d.gratis, d.zona, d.tiempo_estimado_min], [500, false, 'Centro', 45]);
  assert.equal((await cotizar(c, { tipo: 'delivery', calle: 'x', codigo_postal: '9999' })).json.codigo, 'FUERA_DE_ZONA');
  assert.equal((await cotizar(c, { tipo: 'delivery', codigo_postal: '2000' })).status, 400);
  assert.equal((await cotizar(c, { tipo: 'transportista' })).json.codigo, 'ENTREGA_NO_DISPONIBLE');
  const chico = await carrito([{ producto_id: V.id, cantidad: 1 }]);
  const minimo = await cotizar(chico, { tipo: 'delivery', calle: 'x', codigo_postal: '2000' });
  assert.equal(minimo.json.codigo, 'MINIMO_ZONA'); assert.equal(minimo.json.minimo, 1000);
  const grande = await carrito([{ producto_id: V.id, cantidad: 30 }]); // 9000: envio gratis en la zona
  assert.deepEqual([(await cotizar(grande, { tipo: 'delivery', calle: 'x', codigo_postal: '2000' })).json.costo, (await cotizar(grande, { tipo: 'delivery', calle: 'x', codigo_postal: '2000' })).json.gratis], [0, true]);
});

test('Ventas Online.RF11: el checkout suma el envio al total, guarda la zona y el pedido de retiro recibe un numero para retirar', async () => {
  const c = await carrito([{ producto_id: V.id, cantidad: 4 }]);
  const mal = await pedir(c, { tipo: 'delivery', calle: 'Mitre 123', codigo_postal: '2000' }); // total_confirmado sin envio
  assert.equal(mal.json.codigo, 'TOTAL_CAMBIO'); assert.equal(mal.json.resumen.envio, 500);
  const d = await pedir(c, { tipo: 'delivery', calle: 'Mitre 123', codigo_postal: '2000' }, { envio: 500 });
  assert.equal(d.status, 201, JSON.stringify(d.json));
  assert.deepEqual([d.json.envio, d.json.total, d.json.entrega.zona, d.json.entrega.calle], [500, 1700, 'Centro', 'Mitre 123']);
  const c2 = await carrito([{ producto_id: V.id, cantidad: 1 }]);
  const r = await pedir(c2, { tipo: 'retiro' });
  assert.match(r.json.numero_retiro, /^R\d{3}$/);
  const c3 = await carrito([{ producto_id: V.id, cantidad: 1 }]);
  assert.notEqual((await pedir(c3, { tipo: 'retiro' })).json.numero_retiro, r.json.numero_retiro);
});

test('Ventas Online.RN37: el tiempo estimado es el mayor tiempo de preparacion mas la demora de carga; la vitrina no tiene preparacion', async () => {
  assert.equal((await api('PUT', `/api/ventas-online/catalogo/${E.id}/preparacion`, { token: cajero.token, body: { prep_min: 5 } })).status, 403);
  assert.equal((await api('PUT', `/api/ventas-online/catalogo/${E.id}/preparacion`, { token: gerente.token, body: { prep_min: -1 } })).status, 400);
  const mixto = await carrito([{ producto_id: E.id, cantidad: 1 }, { producto_id: V.id, cantidad: 1 }]);
  assert.equal((await cotizar(mixto, { tipo: 'retiro' })).json.tiempo_estimado_min, 30); // 20 de la torta + 10 de demora
  assert.equal((await api('PUT', '/api/ventas-online/envios/configuracion', { token: gerente.token, body: { demora_carga_min: 15 } })).json.demora_carga_min, 15);
  assert.equal((await cotizar(mixto, { tipo: 'retiro' })).json.tiempo_estimado_min, 35);
  const delivery = (await cotizar(mixto, { tipo: 'delivery', calle: 'x', codigo_postal: '2002' })).json;
  assert.equal(delivery.tiempo_estimado_min, 35 + 90); // la preparacion mas el plazo de la zona
});

test('Ventas Online.RF26: se pide para una hora programada en franjas de 15 minutos, dentro del horario y de los dias permitidos', async () => {
  const c = await carrito([{ producto_id: E.id, cantidad: 1 }]);
  const bien = proxima(180);
  const ok = (await cotizar(c, { tipo: 'retiro', programado: new Date(bien).toISOString() })).json;
  assert.deepEqual([ok.programado_ms, ok.lo_antes_posible], [bien, false]);
  assert.equal((await cotizar(c, { tipo: 'retiro', programado: new Date(bien + 60000).toISOString() })).status, 400); // no es una franja
  assert.equal((await cotizar(c, { tipo: 'retiro', programado: new Date(proxima(0) - FRANJA * 8).toISOString() })).json.codigo, 'FRANJA_PASADA');
  assert.equal((await cotizar(c, { tipo: 'retiro', programado: new Date(proxima(0) + 9 * 86400000).toISOString() })).json.codigo, 'FUERA_DE_PLAZO');
  assert.equal((await cotizar(c, { tipo: 'retiro', programado: 'ayer' })).status, 400);
  const f = (await api('GET', `${T}/entrega/franjas?fecha=${new Date(bien).toISOString().slice(0, 10)}&carrito=${c.token}`)).json;
  assert.ok(f.some((x) => x.desde_ms === bien));
  assert.ok(f.every((x) => x.desde_ms >= Date.now() + 35 * 60000 - FRANJA)); // nada antes de ahora mas el tiempo estimado
  assert.equal((await api('GET', `${T}/entrega/franjas?fecha=2020-01-01`)).json.length, 0);
  assert.equal((await api('GET', `${T}/entrega/franjas?fecha=${new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10)}`)).json.codigo, 'FUERA_DE_PLAZO');
});

test('Ventas Online.RN37: una franja que alcanza su capacidad deja de ofrecerse y no admite mas pedidos', async () => {
  await api('PUT', '/api/ventas-online/envios/configuracion', { token: gerente.token, body: { capacidad_franja: 2 } });
  const franja = proxima(240);
  const iso = new Date(franja).toISOString();
  for (let i = 0; i < 2; i++) assert.equal((await pedir(await carrito([{ producto_id: E.id, cantidad: 1 }]), { tipo: 'retiro', programado: iso })).status, 201);
  const tercero = await carrito([{ producto_id: E.id, cantidad: 1 }]);
  assert.equal((await pedir(tercero, { tipo: 'retiro', programado: iso })).json.codigo, 'FRANJA_COMPLETA');
  const f = (await api('GET', `${T}/entrega/franjas?fecha=${iso.slice(0, 10)}&carrito=${tercero.token}`)).json;
  assert.equal(f.some((x) => x.desde_ms === franja), false);
  assert.equal(f.some((x) => x.desde_ms === franja + FRANJA), true);
  // La vitrina no tiene preparacion y no consume cupo.
  assert.equal((await pedir(await carrito([{ producto_id: V.id, cantidad: 1 }]), { tipo: 'retiro', programado: iso })).status, 201);
});

test('Ventas Online.RN37: fuera del horario no se toman pedidos de elaborados, pero si de vitrina', async () => {
  const dias = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'];
  const hoy = dias[(new Date().getDay() + 6) % 7];
  await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { horarios: { [hoy]: [{ desde: '00:00', hasta: '00:01' }] } } });
  const e = await carrito([{ producto_id: E.id, cantidad: 1 }]);
  const r = await cotizar(e, { tipo: 'retiro' });
  assert.equal(r.status, 409); assert.equal(r.json.codigo, 'FUERA_DE_HORARIO');
  assert.equal((await cotizar(await carrito([{ producto_id: V.id, cantidad: 1 }]), { tipo: 'retiro' })).status, 200);
  await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { horarios: TODO_EL_DIA } });
});

test('Ventas Online.RF11: un envio no se despacha sin pago acreditado y el despacho exige permiso; ONL-ENVIOS-TRANSPORTISTA queda apagada', async () => {
  const f = (await api('GET', '/api/funciones', { token: adm.token })).json;
  const lista = Array.isArray(f) ? f : f.funciones;
  assert.equal(lista.find((x) => x.id === 'ONL-ENVIOS-TRANSPORTISTA').activa, false);
  const c = await carrito([{ producto_id: V.id, cantidad: 4 }]);
  const d = await pedir(c, { tipo: 'delivery', calle: 'Mitre 123', codigo_postal: '2000' }, { envio: 500 });
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${d.json.id}/despachar`, { token: cajero.token })).status, 403);
  const sin = await api('POST', `/api/ventas-online/pedidos/${d.json.id}/despachar`, { token: gerente.token });
  assert.equal(sin.status, 409); assert.equal(sin.json.codigo, 'PEDIDO_NO_PAGADO');
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${d.json.id}/aceptar`, { token: gerente.token })).json.estado, 'pagado');
  const estado = (id, e) => api('POST', `/api/ventas-online/pedidos/${id}/estado`, { token: gerente.token, body: { estado: e } });
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${d.json.id}/despachar`, { token: gerente.token })).json.codigo, 'ESTADO_INVALIDO'); // antes hay que prepararlo
  assert.equal((await estado(d.json.id, 'en_preparacion')).status, 200);
  assert.equal((await estado(d.json.id, 'listo')).status, 200);
  const ok = await api('POST', `/api/ventas-online/pedidos/${d.json.id}/despachar`, { token: gerente.token });
  assert.equal(ok.json.estado, 'despachado');
  const retiro = await pedir(await carrito([{ producto_id: V.id, cantidad: 1 }]), { tipo: 'retiro' });
  await api('POST', `/api/ventas-online/pedidos/${retiro.json.id}/aceptar`, { token: gerente.token });
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${retiro.json.id}/despachar`, { token: gerente.token })).status, 409); // el retiro no se despacha
  assert.ok(Pagos);
});
