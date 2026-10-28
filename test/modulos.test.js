const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token, tokenEmpleado;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const crear = async (u, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [u, await bcrypt.hash('clave-larga-1', 4), rol]);
    return r.insertId;
  };
  await crear('jefe', 'admin'); await crear('emp', 'empleado');
  token = (await api('POST', '/api/auth/login', { body: { username: 'jefe', password: 'clave-larga-1' } })).json.token;
  tokenEmpleado = (await api('POST', '/api/auth/login', { body: { username: 'emp', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

test('Usuarios.RF13: instalar y desinstalar módulos es del Administrador, valida dependencias y deja el estado anterior si no se puede', async () => {
  assert.equal((await api('GET', '/api/modulos', { token: tokenEmpleado })).status, 403);
  const lista = (await api('GET', '/api/modulos', { token })).json.modulos;
  assert.deepEqual(lista.filter((m) => m.instalado).map((m) => m.codigo).sort(), ['stock', 'usuarios', 'ventas']);

  // Ventas no se puede sacar mientras Stock la necesita.
  const r = await api('POST', '/api/modulos/ventas/desinstalar', { token });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /stock necesita que esté instalado ventas/);
  assert.equal((await api('POST', '/api/modulos/usuarios/desinstalar', { token })).status, 400);
  assert.equal((await api('POST', '/api/modulos/contable/instalar', { token })).status, 400); // no disponible
  const despues = (await api('GET', '/api/modulos', { token })).json.modulos.filter((m) => m.instalado).map((m) => m.codigo).sort();
  assert.deepEqual(despues, ['stock', 'usuarios', 'ventas']);

  assert.equal((await api('POST', '/api/modulos/stock/desinstalar', { token })).status, 200);
  assert.equal((await api('POST', '/api/modulos/stock/instalar', { token })).status, 200);
  const [aud] = await pool.query("SELECT resultado FROM auditoria WHERE modulo = 'modulos' ORDER BY id");
  assert.deepEqual(aud.map((a) => a.resultado), ['denegado', 'denegado', 'denegado', 'ok', 'ok']);
});

test('Índice B.5: llamar() aplica el tiempo y la política de falla de cada llamada, y rechaza las que no figuran', async () => {
  const llamar = require('../src/modulos/llamar');
  // Dentro de una instancia (la única por defecto), como en una request.
  const ok = await llamar(3, 'ventas', async () => 42);
  assert.deepEqual(ok, { fallo: false, valor: 42 });

  await assert.rejects(() => llamar(99, 'ventas', async () => 1), /no figura/);
  await assert.rejects(() => llamar(3, 'clientes', async () => 1), /no puede hacer/);

  const colgada = () => new Promise(() => {});
  const abrir = await llamar(3, 'ventas', colgada, { esperaMs: 20 }); // n.º 3: abrir con autorización
  assert.equal(abrir.requiereAutorizacion, true);
  const degradar = await llamar(4, 'ventas', colgada, { esperaMs: 20 }); // n.º 4: degradar
  assert.equal(degradar.degradado, true);
  await assert.rejects(() => llamar(11, 'ventas', colgada, { esperaMs: 20 }), (e) => e.codigo === 'LLAMADA_CERRADA'); // n.º 11: cerrar

  // Destino no instalado: no se llama.
  let llamado = false;
  const sinClientes = await llamar(1, 'ventas', async () => { llamado = true; });
  assert.equal(sinClientes.degradado, true);
  assert.equal(llamado, false);
});

test('Índice B.2: sin el módulo implementador el puerto devuelve su implementación nula', async () => {
  const puertos = require('../src/modulos/puertos');
  require('../src/models/insumoPuerto');
  const conStock = await puertos.obtener('stock');
  assert.notEqual(conStock, puertos.PUERTOS.stock.nula);

  await api('POST', '/api/modulos/stock/desinstalar', { token });
  const sinStock = await puertos.obtener('stock');
  assert.equal(sinStock, puertos.PUERTOS.stock.nula);
  assert.deepEqual(await sinStock.disponibilidad(), { bloqueado: false });
  assert.equal((await puertos.obtener('credito')).disponible, false);
  await api('POST', '/api/modulos/stock/instalar', { token });
});
