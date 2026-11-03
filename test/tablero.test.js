const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');

const Tablero = require('../src/servicios/tableroService');
let api, pool, cerrar, token, tokenBea, beaId, n = 0, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return { id: r.insertId, token: (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token };
  };
  token = (await usuario('adm', 'administrador')).token;
  const bea = await usuario('bea', 'barista');
  tokenBea = bea.token; beaId = bea.id;
});
after(async () => { await cerrar(); });

const tablero = (t = token, q = '') => api('GET', `/api/tablero${q}`, { token: t });
const item = (r, id) => r.json.indicadores.find((i) => i.id === id);
const vender = async (precio, mozo) => {
  const p = (await api('POST', '/api/productos', { token, body: { nombre: `Café ${++n}`, precio } })).json;
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id, mozo_id: mozo } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: p.id, cantidad: 1 }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-tab-${++k}-abcdef` }, body: { pagos: [{ forma: 'efectivo', importe: precio }] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await esperarMensajes(pool);
  return r.json;
};

test('Usuarios.RF19: el tablero necesita USU-TABLERO y muestra los indicadores de Ventas con los datos de la instancia', async () => {
  assert.equal((await tablero()).status, 409);
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['USU-TABLERO'], motivo: 'prueba' } })).status, 200);
  const vacio = await tablero();
  assert.equal(vacio.status, 200);
  assert.equal(item(vacio, 'ventas.total').valor, 0);
  assert.equal(item(vacio, 'ventas.total').comparacion.mensaje, 'Sin base de comparación'); // RN36
  assert.equal(item(vacio, 'ventas.promociones'), undefined); // función VEN-PROMOS apagada (RN34)

  await vender(1000, undefined);
  await vender(500, beaId);
  Tablero.limpiarCache();
  const t = await tablero(token, '?periodo=dia');
  const total = item(t, 'ventas.total');
  assert.deepEqual([total.valor, total.detalle.ventas, total.unidad], [1500, 2, '$']);
  assert.equal(item(t, 'ventas.ticket_promedio').valor, 750);
  assert.equal(item(t, 'ventas.por_hora').serie.reduce((s, x) => s + x.valor, 0), 1500);
  assert.equal(item(t, 'ventas.mas_vendidos').serie.length, 2);
  assert.deepEqual(item(t, 'ventas.por_mozo').serie.map((x) => x.clave).sort(), ['adm', 'bea']);
  assert.equal(item(t, 'stock.mermas').valor, 0);
  assert.ok(total.calculado_en);
  assert.equal((await tablero(token, '?periodo=siglo')).status, 400);
});

test('Usuarios.RN36: la comparación usa un período anterior de igual duración y da la diferencia absoluta y porcentual', async () => {
  const { rangos } = Tablero;
  const r = rangos('dia', new Date(2026, 10, 4, 15, 30)); // miércoles
  assert.deepEqual(r.anterior, ['2026-10-28 00:00:00', '2026-10-28 15:30:00']);
  assert.deepEqual(rangos('semana', new Date(2026, 10, 4, 15, 30)).actual[0], '2026-11-02 00:00:00'); // lunes
  assert.deepEqual(rangos('mes', new Date(2026, 2, 31, 10, 0)).anterior, ['2026-02-01 00:00:00', '2026-02-28 10:00:00']); // recorta al largo del mes anterior
  // Una venta de hace 7 días da base de comparación.
  const hace7 = new Date(Date.now() - 7 * 86400000 - 60000);
  await pool.query("INSERT INTO ventas (id_global, mesa_id, sesion_apertura, total, detalle, created_at) SELECT CONCAT('ANT-', UUID()), mesa_id, DATE_SUB(sesion_apertura, INTERVAL 7 DAY), 500, detalle, ? FROM ventas LIMIT 1", [hace7]);
  Tablero.limpiarCache();
  const t = await tablero(token, '?periodo=dia');
  const c = item(t, 'ventas.total').comparacion;
  assert.deepEqual([c.anterior, c.diferencia, c.porcentaje], [500, 1000, 200]);
});

test('Usuarios.RN34/RF19: el alcance "propias" limita al mozo a sus ventas y cada usuario arma su tablero', async () => {
    assert.equal(item(await tablero(tokenBea), 'ventas.total'), undefined); // el barista no tiene el permiso
  await pool.query("INSERT INTO usuario_permisos (user_id, permiso, nivel) VALUES (?, 'ventas.historial.ver', 'permitido')", [beaId]);
  await pool.query("INSERT INTO usuario_alcances (user_id, tipo, valor) VALUES (?, 'propias', '')", [beaId]);
  const b = await tablero(tokenBea);
  assert.deepEqual([item(b, 'ventas.total').valor, item(b, 'ventas.total').alcance_propias], [500, true]);
  assert.equal(item(await tablero(), 'ventas.total').valor, 1500);
  // Personalización: elegir y ordenar; no se acepta uno que no puede ver.
  assert.equal((await api('PUT', '/api/tablero', { token: tokenBea, body: { indicadores: ['stock.mermas'] } })).status, 400);
  const p = await api('PUT', '/api/tablero', { token, body: { indicadores: ['ventas.ticket_promedio', 'ventas.total'], periodo: 'semana' } });
  assert.deepEqual([p.json.periodo, p.json.indicadores.map((i) => i.id)], ['semana', ['ventas.ticket_promedio', 'ventas.total']]);
  assert.ok((await api('GET', '/api/tablero/indicadores', { token })).json.length > 5);
});

test('Usuarios.EX19: un indicador que falla muestra "No disponible" y los demás siguen', async () => {
  Tablero.registrar([{ id: 'roto.indicador', nombre: 'Roto', modulo: 'ventas', permiso: 'ventas.historial.ver', unidad: '$', calcular: async () => { throw new Error('el módulo no responde'); } }]);
  await api('PUT', '/api/tablero', { token, body: { indicadores: ['roto.indicador', 'ventas.total'] } });
  const t = await tablero();
  assert.deepEqual([item(t, 'roto.indicador').disponible, item(t, 'roto.indicador').error], [false, 'No disponible']);
  assert.equal(item(t, 'ventas.total').valor, 1500);
});
