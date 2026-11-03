const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');
const Modulos = require('../src/modulos/registro');
const Desinstalacion = require('../src/modulos/desinstalacion');

let api, pool, cerrar, token;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [r] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query("INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = 'administrador'", [r.insertId]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

const modulo = async (codigo) => (await api('GET', '/api/modulos', { token })).json.modulos.find((m) => m.codigo === codigo);
const abrirToma = () => pool.query("INSERT INTO tomas_inventario (id_global, estado, alcance) VALUES (?, 'en_curso', '{}')", [`TOMA-${Date.now()}`]);

test('Usuarios.RN87: sin operaciones pendientes la desinstalación se completa; Usuarios y Ventas no se desinstalan', async () => {
  assert.equal((await api('POST', '/api/modulos/usuarios/desinstalar', { token })).status, 400);
  assert.equal((await api('POST', '/api/modulos/ventas/desinstalar', { token })).status, 400);
  const r = await api('POST', '/api/modulos/stock/desinstalar', { token });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await modulo('stock')).instalado, false);
  assert.equal((await api('POST', '/api/modulos/stock/instalar', { token })).status, 200);
  assert.equal((await modulo('stock')).instalado, true);
});

test('Usuarios.RN87/EX59: con operaciones sin resolver el módulo queda "En desinstalación", ya no cuenta como instalado y no se completa hasta resolverlas', async () => {
  await abrirToma();
  const r = await api('POST', '/api/modulos/stock/desinstalar', { token });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.pendientes[0].tipo, 'tomas_inventario');
  const m = await modulo('stock');
  assert.deepEqual([m.instalado, m.en_desinstalacion], [false, true]);
  assert.equal(await Modulos.estaInstalado('stock'), false); // sin llamadas ni mensajes nuevos hacia él
  const c = await api('POST', '/api/modulos/stock/desinstalacion/completar', { token });
  assert.equal(c.status, 409); // EX59: no se completa mientras haya algo sin resolver
  assert.equal(c.json.problemas[0].cantidad, 1);
  assert.equal((await api('GET', '/api/modulos/stock/desinstalacion', { token })).json.pendientes.length, 1);
  // El Administrador puede cancelarla y el módulo vuelve a su estado anterior.
  assert.equal((await api('POST', '/api/modulos/stock/desinstalacion/cancelar', { token })).json.estado, 'instalado');
  assert.equal(await Modulos.estaInstalado('stock'), true);
  assert.equal((await api('POST', '/api/modulos/stock/desinstalacion/cancelar', { token })).status, 409);
  // Se resuelve lo que faltaba y se completa.
  assert.equal((await api('POST', '/api/modulos/stock/desinstalar', { token })).status, 202);
  await pool.query("UPDATE tomas_inventario SET estado = 'cancelada'");
  const ok = await api('POST', '/api/modulos/stock/desinstalacion/completar', { token });
  assert.deepEqual([ok.status, ok.json.desinstalado], [200, true]);
  assert.equal((await modulo('stock')).en_desinstalacion, false);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM auditoria WHERE accion IN ('desinstalar_iniciar', 'desinstalar_cancelar', 'desinstalar')"))[0][0].n >= 4, true);
  await api('POST', '/api/modulos/stock/instalar', { token });
});

test('Usuarios.RN85/EX59: vencido el plazo, lo que falta pasa a la Bandeja de pendientes con responsable y se avisa, sin duplicarse', async () => {
  await abrirToma();
  assert.equal((await api('POST', '/api/modulos/stock/desinstalar', { token })).status, 202);
  assert.deepEqual((await Desinstalacion.mantenimiento())[0].esperando, 1); // dentro del plazo solo espera
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM bandeja_pendientes WHERE motivo LIKE 'Desinstalación de stock%'"))[0][0].n, 0);
  await pool.query("UPDATE modulos_instalados SET desinstalacion_desde = DATE_SUB(NOW(), INTERVAL 25 HOUR) WHERE codigo = 'stock'");
  assert.equal((await Desinstalacion.mantenimiento())[0].a_bandeja, 1);
  await Desinstalacion.mantenimiento();
  const [filas] = await pool.query("SELECT modulo_responsable, rol_responsable FROM bandeja_pendientes WHERE motivo LIKE 'Desinstalación de stock%'");
  assert.deepEqual(filas, [{ modulo_responsable: 'stock', rol_responsable: 'gerente' }]);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE tipo = 'desinstalacion_pendiente'"))[0][0].n, 1);
  // Al resolverse lo pendiente, la tarea periódica completa sola la desinstalación.
  await pool.query("UPDATE tomas_inventario SET estado = 'cancelada'");
  assert.equal((await Desinstalacion.mantenimiento())[0].completada, true);
  assert.equal((await modulo('stock')).instalado, false);
});
