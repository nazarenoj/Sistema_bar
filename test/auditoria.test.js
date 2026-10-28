const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp({ alta: false }));
  await pool.query("INSERT INTO configuracion_instancia (id, codigo_instancia, razon_social, sucursal) VALUES (1, 'AUD01', 'X', 'Y')");
  await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('jefe', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'jefe', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

const eventos = async (q = '') => (await api('GET', `/api/auditoria${q}`, { token })).json;

test('Usuarios.RF08: ingresos, ingresos fallidos y cambios de usuarios quedan auditados con valor anterior y nuevo', async () => {
  await api('POST', '/api/auth/login', { body: { username: 'jefe', password: 'mala' } });
  const alta = await api('POST', '/api/usuarios', { token, body: { username: 'ana', password: 'clave-larga-2', rol: 'empleado', pin: '4321' } });
  assert.equal(alta.status, 201);
  await api('PUT', `/api/usuarios/${alta.json.id}`, { token, body: { rol: 'admin', nombre: 'Ana' } });

  const todos = await eventos();
  const por = (accion) => todos.find((e) => e.accion === accion);
  assert.ok(por('ingreso'));
  assert.equal(por('ingreso_fallido').resultado, 'denegado');
  const upd = por('actualizar');
  assert.equal(JSON.parse(upd.valor_anterior).rol, 'empleado');
  assert.equal(JSON.parse(upd.valor_nuevo).rol, 'admin');
  assert.equal(upd.username, 'jefe');
  assert.match(upd.id_global, /^AUD01-/);
});

test('Usuarios.RN12: la auditoría nunca guarda contraseñas ni PIN', async () => {
  const [filas] = await pool.query('SELECT * FROM auditoria');
  const texto = JSON.stringify(filas);
  for (const secreto of ['clave-larga-1', 'clave-larga-2', '4321', 'mala']) assert.ok(!texto.includes(`"${secreto}"`) && !texto.includes(`${secreto}\\"`), secreto);
  assert.ok(!/password|pin_hash/.test(filas.map((f) => f.valor_nuevo || '').join('')));
});

test('Usuarios.RN11: ningún SQL modifica ni borra eventos', async () => {
  await assert.rejects(() => pool.query("UPDATE auditoria SET accion = 'x'"), /solo agregar/);
  await assert.rejects(() => pool.query('DELETE FROM auditoria'), /solo agregar/);
});

test('Usuarios.RN11: la cadena cierra, aguanta eventos simultáneos y alterar una fila la rompe', async () => {
  const Auditoria = require('../src/models/auditoriaModel');
  await Promise.all(Array.from({ length: 25 }, (_, i) => Auditoria.registrar({ modulo: 'prueba', accion: 'simultaneo', detalle: String(i) })));
  const ok = (await api('GET', '/api/auditoria/verificar', { token })).json;
  assert.equal(ok.ok, true);
  assert.ok(ok.total >= 25);

  // Quien tenga acceso directo a la base y saque el trigger puede tocar una fila, pero el control lo detecta.
  const [[fila]] = await pool.query("SELECT id FROM auditoria WHERE accion = 'simultaneo' ORDER BY id LIMIT 1 OFFSET 3");
  await pool.query('DROP TRIGGER auditoria_no_update');
  await pool.query("UPDATE auditoria SET detalle = 'alterado' WHERE id = ?", [fila.id]);
  const roto = (await api('GET', '/api/auditoria/verificar', { token })).json;
  assert.equal(roto.ok, false);
  assert.equal(roto.primer_roto, fila.id);
});

test('Usuarios.RF09: la consulta filtra, pagina por cursor y exporta', async () => {
  const pagina1 = await eventos('?modulo=prueba&limite=10');
  assert.equal(pagina1.length, 10);
  const pagina2 = await eventos(`?modulo=prueba&limite=100&antes_de=${pagina1[9].id}`);
  assert.equal(pagina2.length, 15);
  const ficha = await eventos('?entidad=usuario&entidad_id=2');
  assert.ok(ficha.length >= 2 && ficha.every((e) => e.entidad === 'usuario'));
  const exp = await api('GET', '/api/auditoria/exportar', { token });
  assert.equal(exp.status, 200);
});
