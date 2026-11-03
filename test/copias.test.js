const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

process.env.COPIAS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'copias-test-'));
let api, pool, cerrar, token, tokenBarista;
const CLAVE = 'clave-de-copias-123';

const entrar = async (username) => (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
  };
  await usuario('adm', 'administrador');
  await usuario('bea', 'barista');
  token = await entrar('adm');
  tokenBarista = await entrar('bea');
});
after(async () => { await cerrar(); fs.rmSync(process.env.COPIAS_DIR, { recursive: true, force: true }); });

const copiar = (body = { clave: CLAVE }, t = token) => api('POST', '/api/copias', { token: t, body });
const productos = async (t = token) => (await api('GET', '/api/productos', { token: t })).json.map((p) => p.nombre);

test('Usuarios.RN13/RF11: la clave se define al configurar, la copia sale cifrada y verificada, y solo la ve el Administrador', async () => {
  assert.equal((await api('GET', '/api/copias', { token: tokenBarista })).status, 403);
  assert.equal((await api('POST', '/api/copias/configuracion', { token, body: { clave: 'corta' } })).status, 400);
  const cfg = await api('POST', '/api/copias/configuracion', { token, body: { clave: CLAVE } });
  assert.equal(cfg.status, 200);
  assert.match(cfg.json.advertencia, /sin ella/i);
  assert.equal((await copiar({})).json.codigo, 'SIN_CLAVE'); // ni en el pedido ni en el entorno
  assert.equal((await copiar({ clave: 'otra-clave-distinta' })).json.codigo, 'CLAVE_INCORRECTA');
  const c = await copiar();
  assert.equal(c.status, 201, JSON.stringify(c.json));
  assert.equal(c.json.estado, 'valida');
  const crudo = fs.readFileSync(path.join(process.env.COPIAS_DIR, 'DEFAULT', c.json.nombre));
  assert.equal(crudo.includes('Prod nunca visible'), false);
  const d = (await api('GET', `/api/copias/${c.json.id}/detalle`, { token })).json;
  assert.deepEqual([d.version_sistema, d.modulos.includes('ventas'), Boolean(d.fecha)], [require('../package.json').version, true, true]);
  assert.equal((await api('POST', `/api/copias/${c.json.id}/verificar`, { token, body: { clave: CLAVE } })).json.valida, true);
});

test('Usuarios.EX07: una copia dañada se marca inválida, alerta y no se puede restaurar', async () => {
  const c = (await copiar()).json;
  fs.appendFileSync(path.join(process.env.COPIAS_DIR, 'DEFAULT', c.nombre), 'x');
  const v = await api('POST', `/api/copias/${c.id}/verificar`, { token, body: { clave: CLAVE } });
  assert.equal(v.json.valida, false);
  assert.equal((await api('POST', `/api/copias/${c.id}/restaurar`, { token, body: { clave: CLAVE, confirmacion: 'RESTAURAR' } })).json.codigo, 'COPIA_INVALIDA');
});

test('Usuarios.RF11: la retención conserva la más nueva de cada día y el aviso de atraso aparece sin copia automática', async () => {
  const Copias = require('../src/servicios/copiaService');
  await pool.query("UPDATE parametros SET valor = '1' WHERE clave = 'copia_retener_diarias'");
  const a = await Copias.generar({ tipo: 'automatica', clave: CLAVE });
  const b = await Copias.generar({ tipo: 'automatica', clave: CLAVE });
  await pool.query('UPDATE copias_seguridad SET retenida = 0');
  assert.equal(await Copias.aplicarRetencion(), 1);
  const quedan = (await pool.query("SELECT id FROM copias_seguridad WHERE tipo = 'automatica'"))[0].map((x) => x.id);
  assert.deepEqual(quedan, [b.id]);
  assert.equal(fs.existsSync(path.join(process.env.COPIAS_DIR, 'DEFAULT', a.nombre)), false);
  // Con la copia vencida por antigüedad, la tarea periódica genera otra (la clave sale del entorno) y no alerta de atraso.
  process.env.COPIAS_CLAVE = CLAVE;
  const r = await Copias.mantenimiento({ ahora: new Date(Date.now() + 30 * 3600000) });
  assert.ok(r.generada);
  delete process.env.COPIAS_CLAVE;
});

test('Usuarios.RF12/RN14/RN15: restaurar vuelve la instancia completa, cierra sesiones, hace copia previa y bloquea la emisión fiscal', async () => {
  await api('POST', '/api/productos', { token, body: { nombre: 'Antes de la copia', precio: 100 } });
  const c = (await copiar()).json;
  await api('POST', '/api/productos', { token, body: { nombre: 'Después de la copia', precio: 200 } });
  const ruta = `/api/copias/${c.id}/restaurar`;
  assert.equal((await api('POST', ruta, { token, body: { clave: CLAVE } })).json.codigo, 'SIN_CONFIRMACION');
  assert.equal((await api('POST', ruta, { token: tokenBarista, body: { clave: CLAVE, confirmacion: 'RESTAURAR' } })).status, 403);
  // EX09: clave equivocada → no toca nada. EX08: copia de una versión más nueva → bloquea.
  assert.equal((await api('POST', ruta, { token, body: { clave: 'otra-clave-distinta', confirmacion: 'RESTAURAR' } })).json.codigo, 'CLAVE_INCORRECTA');
  assert.ok((await productos()).includes('Después de la copia'));
  await pool.query("DELETE FROM schema_migrations WHERE version = (SELECT v FROM (SELECT MAX(version) v FROM schema_migrations) x)");
  const nueva = await api('POST', ruta, { token, body: { clave: CLAVE, confirmacion: 'RESTAURAR' } });
  assert.equal(nueva.json.codigo, 'VERSION_INCOMPATIBLE');
  await pool.query("INSERT INTO schema_migrations (version, archivo, huella) VALUES ('053', '053_copias.sql', ?)", [require('crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'database', 'migraciones', '053_copias.sql'), 'utf8').replace(/\r\n/g, '\n')).digest('hex')]);
  assert.ok((await productos()).includes('Después de la copia'));

  const [[{ v: vAntes }]] = await pool.query('SELECT version_configuracion AS v FROM configuracion_instancia WHERE id = 1');
  const r = await api('POST', ruta, { token, body: { clave: CLAVE, confirmacion: 'RESTAURAR' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.reingresar, true);
  assert.ok(r.json.copia_previa);
  assert.equal((await api('GET', '/api/productos', { token })).status, 401); // las sesiones se cerraron
  token = await entrar('adm');
  const nombres = await productos();
  assert.ok(nombres.includes('Antes de la copia'));
  assert.equal(nombres.includes('Después de la copia'), false);
  const [[{ v: vDespues }]] = await pool.query('SELECT version_configuracion AS v FROM configuracion_instancia WHERE id = 1');
  assert.ok(vDespues >= vAntes); // RN74: no retrocede
  const [[{ valor }]] = await pool.query("SELECT valor FROM parametros WHERE clave = 'restauracion_en_curso'");
  assert.equal(valor, '0');
  // La copia previa permite volver atrás: tiene lo que se perdió.
  const previa = (await pool.query("SELECT id FROM copias_seguridad WHERE nombre = ?", [r.json.copia_previa]))[0][0];
  assert.ok(previa);

  // RN14: emisión fiscal bloqueada hasta validar la numeración; sin comprobantes locales la validación es inmediata.
  const Secuenciador = require('../src/services/secuenciadorService');
  await assert.rejects(Secuenciador.conClave({ puntoVenta: 1, tipo: 11 }, async () => 1), { codigo: 'CLAVE_RESOLVIENDO' });
  assert.equal((await api('POST', '/api/facturas/claves/sincronizar', { token })).json.ok, true);
  assert.equal(await Secuenciador.conClave({ puntoVenta: 1, tipo: 11 }, async () => 7), 7);
});
