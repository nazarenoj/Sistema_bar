const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const Tienda = require('../src/ventas_online/tiendaService');
const Limitador = require('../src/ventas_online/limitador');
const { limitadores } = require('../src/routes/onlPublicaRoutes');

let api, pool, cerrar, adm, gerente, administrativo, cajero;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  cajero = await usuario(api, pool, 'cami', 'cajero');
});
after(async () => { await cerrar(); });

const cfg = (b, t = gerente) => api('PUT', '/api/ventas-online/tienda', { token: t.token, body: b });
const LEGAL = { razon_social: 'Cafe del Sur SA', cuit: '30-71111111-1', domicilio: 'Mitre 123, Rosario' };

test('Ventas Online.RN01: el modulo se instala y todo lo administrativo exige permiso', async () => {
  assert.equal((await api('GET', '/api/ventas-online/tienda', { token: gerente.token })).status, 409); // sin instalar
  const inst = await api('POST', '/api/modulos/ventas_online/instalar', { token: adm.token });
  assert.equal(inst.status, 200, JSON.stringify(inst.json));
  const t = (await api('GET', '/api/ventas-online/tienda', { token: gerente.token })).json;
  assert.equal(t.activa, false); assert.equal(t.codigo, null);
  assert.equal((await api('GET', '/api/ventas-online/tienda', { token: cajero.token })).status, 403);
  assert.equal((await api('GET', '/api/ventas-online/tienda', { token: administrativo.token })).status, 200);
  assert.equal((await cfg({ nombre: 'x' }, administrativo)).status, 403); // ve pero no configura
});

test('Ventas Online.RF01: la configuracion valida codigo, colores, CUIT, horarios y limites', async () => {
  for (const mal of [{ codigo: 'AB' }, { codigo: 'Mi Tienda' }, { codigo: 'api' }, { color_primario: 'rojo' }, { cuit: '30711111112' }, { email: 'no' }, { dominio: 'sin punto' }, { logo_url: 'javascript:x' },
    { horarios: { lun: [{ desde: '10:00', hasta: '09:00' }] } }, { horarios: { xxx: [] } }, { limite_pedidos_ip_hora: 0 }, { prioridad_lista: 'otra' }]) {
    const r = await cfg(mal);
    assert.equal(r.status, 400, JSON.stringify(mal) + ' ' + JSON.stringify(r.json));
  }
  const ok = await cfg({ codigo: 'Cafe-Sur', nombre: 'Cafe del Sur', ...LEGAL, color_primario: '#6b4226', color_acento: '#d9822b', telefono: '341-555', email: 'hola@cafedelsur.test', dominio: 'cafedelsur.test',
    logo_url: 'https://cafedelsur.test/logo.png', horarios: { lun: [{ desde: '00:00', hasta: '23:59' }], mar: [{ desde: '00:00', hasta: '23:59' }], mie: [{ desde: '00:00', hasta: '23:59' }], jue: [{ desde: '00:00', hasta: '23:59' }],
      vie: [{ desde: '00:00', hasta: '23:59' }], sab: [{ desde: '00:00', hasta: '23:59' }], dom: [{ desde: '00:00', hasta: '23:59' }] }, limite_pedidos_ip_hora: 3 });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.codigo, 'cafe-sur'); assert.equal(ok.json.cuit, '30711111111'); assert.equal(ok.json.url_publica, '/tienda/cafe-sur'); assert.equal(ok.json.activa, false);
});

test('Ventas Online.RN01: sin la tienda activa la subruta responde 404 y no se activa incompleta', async () => {
  assert.equal((await api('GET', '/tienda/cafe-sur')).status, 404); // configurada pero inactiva
  assert.equal((await api('GET', '/tienda/no-existe')).status, 404);
  // Una tienda sin datos legales no se puede activar.
  await pool.query("UPDATE onl_tienda SET razon_social = NULL WHERE id = 1");
  const r = await cfg({ activa: true });
  assert.equal(r.status, 409); assert.equal(r.json.codigo, 'TIENDA_INCOMPLETA');
  assert.equal((await cfg({ activa: true, ...LEGAL })).json.activa, true);
});

test('Ventas Online.RF01: la parte publica no necesita sesion y solo muestra lo publicable', async () => {
  const r = await api('GET', '/tienda/cafe-sur');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.nombre, 'Cafe del Sur'); assert.equal(r.json.abierta, true);
  assert.deepEqual(r.json.colores, { primario: '#6b4226', acento: '#d9822b' });
  assert.equal(r.json.comercio.cuit, '30711111111');
  for (const interno of ['limite_pedidos_ip_hora', 'vigencia_reserva_min', 'timeout_reserva_segundos', 'activa', 'id', 'prioridad_lista', 'impagos_horas']) assert.ok(!(interno in r.json), `expone ${interno}`);
  assert.equal((await api('GET', '/tienda/CAFE-SUR')).status, 200); // el codigo no distingue mayusculas
  assert.equal((await api('GET', '/tienda/cafe-sur/paginas/envios')).status, 404);
});

test('Ventas Online.RF01: las paginas informativas se editan con permiso y se leen sin sesion', async () => {
  const put = (slug, body, t = gerente) => api('PUT', `/api/ventas-online/paginas/${slug}`, { token: t.token, body });
  assert.equal((await put('otra', { contenido: 'x' })).status, 404);
  assert.equal((await put('envios', { contenido: '' })).status, 400);
  assert.equal((await put('envios', { contenido: 'x' }, administrativo)).status, 403);
  const p = await put('envios', { contenido: 'Enviamos en el dia dentro de Rosario.' });
  assert.equal(p.status, 200); assert.equal(p.json.titulo, 'Envíos');
  await put('terminos', { titulo: 'Condiciones', contenido: 'Al comprar aceptas.' });
  assert.equal((await api('GET', '/api/ventas-online/paginas', { token: gerente.token })).json.length, 2);
  const pub = await api('GET', '/tienda/cafe-sur/paginas/envios');
  assert.equal(pub.json.contenido, 'Enviamos en el dia dentro de Rosario.');
  assert.deepEqual((await api('GET', '/tienda/cafe-sur')).json.paginas.map((x) => x.slug), ['envios', 'terminos']);
});

test('Ventas Online.RF01: el codigo cambia y el viejo deja de existir; los horarios cierran la tienda', async () => {
  assert.equal((await cfg({ codigo: 'cafe-centro' })).json.url_publica, '/tienda/cafe-centro');
  assert.equal((await api('GET', '/tienda/cafe-sur')).status, 404);
  assert.equal((await api('GET', '/tienda/cafe-centro')).status, 200);
  const dia = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'][(new Date().getDay() + 6) % 7];
  await cfg({ horarios: { [dia]: [{ desde: '00:00', hasta: '00:01' }] } });
  assert.equal((await api('GET', '/tienda/cafe-centro')).json.abierta, false);
  assert.equal(Tienda.abiertaAhora({ lun: [{ desde: '08:00', hasta: '12:00' }] }, new Date('2026-11-09T09:30:00')), true); // un lunes
  assert.equal(Tienda.abiertaAhora({ lun: [{ desde: '08:00', hasta: '12:00' }] }, new Date('2026-11-09T12:00:00')), false);
  assert.equal(Tienda.abiertaAhora(null), true);
  await cfg({ activa: false });
  assert.equal((await api('GET', '/tienda/cafe-centro')).status, 404);
  await cfg({ activa: true });
});

test('Ventas Online.RN56: los limites por IP frenan el exceso con 429 y el de pedidos sale de la tienda', async () => {
  const l = Limitador.crear({ ventanaMs: 60000, maximo: 2 });
  assert.equal(l.permitir('ip').ok, true); assert.equal(l.permitir('ip').ok, true);
  const tercero = l.permitir('ip');
  assert.equal(tercero.ok, false); assert.ok(tercero.reintentarEnSeg > 0);
  assert.equal(l.permitir('otra-ip').ok, true);
  // El tope de pedidos se lee de la configuracion de la tienda (3 por hora).
  limitadores.pedidos.reiniciar();
  const { limitePedidos } = require('../src/routes/onlPublicaRoutes');
  const corre = async () => { let st = 200; await limitePedidos({ params: { codigo: 'cafe-centro' }, ip: '1.2.3.4' }, { set() { return this; }, status(s) { st = s; return this; }, json() {} }, () => {}); return st; };
  assert.deepEqual([await corre(), await corre(), await corre(), await corre()], [200, 200, 200, 429]);
});

test('Ventas Online: una ruta publica no sale del contexto de su instancia', async () => {
  // Si el codigo no esta en ninguna instancia no hay forma de leer datos de otra: 404 sin pistas.
  const r = await api('GET', '/tienda/otra-tienda');
  assert.equal(r.status, 404); assert.deepEqual(Object.keys(r.json).sort(), ['codigo', 'error']);
  // Y no admite el encabezado de instancia para saltar a otra.
  assert.equal((await api('GET', '/tienda/otra-tienda', { headers: { 'X-Instancia': 'TST01' } })).status, 404);
});
