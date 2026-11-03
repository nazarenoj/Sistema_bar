const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');
const Monedas = require('../src/servicios/monedaService');

let api, pool, cerrar, token;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [r] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query("INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = 'administrador'", [r.insertId]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

const fuente = (moneda = 'USD') => api('PUT', '/api/monedas/fuentes', { token, body: { moneda, url: 'https://fuente.test/dolar', ruta_comprador: 'compra', ruta_vendedor: 'data.venta' } });
const alertas = async () => (await pool.query("SELECT clave FROM notificaciones WHERE tipo = 'cotizacion_vencida' AND estado <> 'resuelta'"))[0].map((x) => x.clave);

test('Usuarios.RF22: la fuente es configurable y se valida', async () => {
  assert.equal((await fuente()).status, 200);
  assert.equal((await api('PUT', '/api/monedas/fuentes', { token, body: { moneda: 'USD', url: 'ftp://x', ruta_comprador: 'a', ruta_vendedor: 'b' } })).status, 400);
  assert.equal((await api('PUT', '/api/monedas/fuentes', { token, body: { moneda: 'ARS', url: 'https://x', ruta_comprador: 'a', ruta_vendedor: 'b' } })).status, 404);
  assert.equal((await api('GET', '/api/monedas/fuentes', { token })).json.length, 1);
});

test('Usuarios.RF22: sin USU-COTIZ-AUTO no consulta; con la función carga la cotización automática una vez por día hábil', async () => {
  Monedas.usarFuente(async () => ({ compra: 1200, data: { venta: 1250 } }));
  assert.deepEqual(await Monedas.actualizarAutomaticas({ forzar: true }), []); // función apagada
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['USU-COTIZ-AUTO'], motivo: 'prueba' } })).status, 200);
  const sabado = new Date(2026, 10, 7, 10, 0);
  assert.deepEqual(await Monedas.actualizarAutomaticas({ ahora: sabado }), []); // fin de semana
  const r = await Monedas.actualizarAutomaticas();
  assert.deepEqual(r.map((x) => [x.moneda, x.ok, x.comprador, x.vendedor]), [['USD', true, 1200, 1250]]);
  const v = (await api('GET', '/api/monedas/cotizaciones/vigente?moneda=USD', { token })).json;
  assert.deepEqual([v.comprador, v.vendedor, v.origen, v.vencida], [1200, 1250, 'automatica', false]);
  assert.deepEqual(await Monedas.actualizarAutomaticas(), []); // ya se actualizó hoy
});

test('Usuarios.EX12: si la fuente falla se mantiene la última cotización y se alerta cuando supera la antigüedad', async () => {
  Monedas.usarFuente(async () => { throw new Error('sin conexión'); });
  const r = await api('POST', '/api/monedas/fuentes/actualizar', { token });
  assert.equal(r.json[0].ok, false);
  assert.equal(r.json[0].ultima_vigente.comprador, 1200); // se mantiene la última
  assert.deepEqual(await alertas(), []); // todavía dentro de las 24 h
  // EUR no tiene ninguna cotización: la falla alerta.
  await fuente('EUR');
  await api('POST', '/api/monedas/fuentes/actualizar', { token });
  assert.deepEqual(await alertas(), ['cotizacion-auto-EUR']);
  // Vuelve la fuente: carga y resuelve la alerta; una respuesta inválida cuenta como falla.
  Monedas.usarFuente(async () => ({ compra: 0, data: { venta: 1 } }));
  assert.equal((await api('POST', '/api/monedas/fuentes/actualizar', { token })).json.every((x) => !x.ok), true);
  Monedas.usarFuente(async () => ({ compra: 1500, data: { venta: 1560 } }));
  await api('POST', '/api/monedas/fuentes/actualizar', { token });
  assert.deepEqual(await alertas(), []);
  assert.equal((await api('GET', '/api/monedas/fuentes', { token })).json.find((f) => f.moneda === 'EUR').ultimo_error, null);
});
