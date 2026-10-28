const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');
const { existe } = require('../src/permisos/catalogo');
const { hashCodigo } = require('../src/utils/credenciales');

let api, pool, cerrar, roles;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  roles = Object.fromEntries((await pool.query('SELECT id, codigo FROM roles'))[0].map((r) => [r.codigo, r.id]));
});
after(async () => { await cerrar(); });

const CLAVE = 'clave-larga-1';
// Crea un usuario con un rol de referencia (y PIN opcional) y devuelve { id, token }.
const usuario = async (username, rol, pin) => {
  const [r] = await pool.query('INSERT INTO users (username, password_hash, rol, pin_hash) VALUES (?, ?, ?, ?)',
    [username, await bcrypt.hash(CLAVE, 4), rol === 'administrador' ? 'admin' : 'empleado', pin ? hashCodigo(pin) : null]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [r.insertId, roles[rol]]);
  const token = (await api('POST', '/api/auth/login', { body: { username, password: CLAVE } })).json.token;
  return { id: r.insertId, token };
};
const auditados = async (accion) => (await pool.query('SELECT * FROM auditoria WHERE accion = ?', [accion]))[0];

test('el catálogo y los roles de referencia son coherentes: todo permiso sembrado existe', async () => {
  const [filas] = await pool.query('SELECT DISTINCT permiso FROM rol_permisos');
  assert.ok(filas.length > 10);
  for (const { permiso } of filas) assert.ok(existe(permiso), permiso);
});

test('Usuarios.EX03: sin permiso se bloquea la acción y queda registrado el intento', async () => {
  const barista = await usuario('bea', 'barista');
  const r = await api('POST', '/api/mesas/1/cerrar', { token: barista.token, headers: { 'X-ID-Solicitud': 'solicitud-permiso-1' }, body: {} });
  assert.equal(r.status, 403);
  assert.equal(r.json.codigo, 'SIN_PERMISO');
  const eventos = await auditados('acceso_denegado');
  assert.ok(eventos.some((e) => e.username === 'bea' && e.entidad_id === 'ventas.cuenta.cobrar' && e.resultado === 'denegado'));
  assert.equal((await api('GET', '/api/usuarios', { token: barista.token })).status, 403);
});

test('Usuarios.RF05/EX04: "requiere autorización" pide a otro usuario con la acción permitida; nadie se autoriza a sí mismo', async () => {
  const mozo = await usuario('mario', 'mozo', '1111');
  await usuario('encarna', 'encargado', '2222');
  await usuario('caro', 'cajero', '3333'); // cajero tiene anular en "requiere autorización": no puede autorizar
  const anular = (autorizacion) => api('DELETE', '/api/pedidos/999999', { token: mozo.token, body: autorizacion && { autorizacion } });

  const sin = await anular();
  assert.equal(sin.status, 403);
  assert.equal(sin.json.codigo, 'REQUIERE_AUTORIZACION');

  for (const mala of [{ credencial: '9999' }, { credencial: '1111' }, { credencial: '3333' }]) {
    const r = await anular(mala);
    assert.equal(r.status, 403, JSON.stringify(mala));
    assert.equal(r.json.codigo, 'AUTORIZACION_INVALIDA');
  }
  assert.equal((await auditados('autorizacion_rechazada')).length, 3);

  const ok = await anular({ credencial: '2222' });
  assert.equal(ok.status, 404); // pasó el permiso y llegó al controlador (el pedido no existe)
  const [aut] = await auditados('autorizacion');
  assert.match(aut.detalle, /encarna/);
  assert.equal(aut.username, 'mario');

  // También con usuario y contraseña.
  assert.equal((await anular({ usuario: 'encarna', credencial: CLAVE })).status, 404);
});

test('Usuarios.RN09: un cambio de permisos rige desde la acción siguiente, sin volver a ingresar', async () => {
  const admin = await usuario('adm', 'administrador');
  const u = await usuario('lucho', 'cajero');
  const ver = () => api('GET', '/api/insumos', { token: u.token });
  assert.equal((await ver()).status, 403);

  const rol = (await api('GET', '/api/roles', { token: admin.token })).json.find((r) => r.codigo === 'cajero');
  const r = await api('PUT', `/api/roles/${rol.id}`, { token: admin.token, body: { permisos: { ...rol.permisos, 'stock.insumos.ver': 'permitido' } } });
  assert.equal(r.status, 200);
  assert.equal((await ver()).status, 200);
  const cambio = (await auditados('editar_rol'))[0];
  assert.equal(JSON.parse(cambio.valor_anterior).permisos['stock.insumos.ver'], undefined);
  assert.equal(JSON.parse(cambio.valor_nuevo).permisos['stock.insumos.ver'], 'permitido');
});

test('una excepción individual pisa a los roles', async () => {
  const admin = await usuario('adm2', 'administrador');
  const u = await usuario('nico', 'encargado');
  assert.equal((await api('GET', '/api/insumos', { token: u.token })).status, 200);
  const r = await api('PUT', `/api/roles/usuarios/${u.id}`, { token: admin.token, body: { excepciones: { 'stock.insumos.ver': 'denegado' } } });
  assert.equal(r.status, 200);
  assert.equal((await api('GET', '/api/insumos', { token: u.token })).status, 403);
});

test('Usuarios.RN07: nadie se modifica a sí mismo ni otorga lo que no tiene; solo el Administrador asigna Administrador', async () => {
  const admin = await usuario('adm3', 'administrador');
  // Un gerente con permiso para gestionar roles, pero sin ser Administrador.
  const [r] = await pool.query("INSERT INTO roles (codigo, nombre) VALUES ('jefe_rrhh', 'Jefe de RRHH')");
  await pool.query("INSERT INTO rol_permisos VALUES (?, 'usuarios.gestionar', 'permitido'), (?, 'usuarios.roles.gestionar', 'permitido'), (?, 'ventas.pedidos.operar', 'permitido'), (?, 'ventas.catalogo.ver', 'permitido')", [r.insertId, r.insertId, r.insertId, r.insertId]);
  roles.jefe_rrhh = r.insertId;
  const jefe = await usuario('rrhh', 'jefe_rrhh');
  const otro = await usuario('otro', 'barista');
  const asignar = (id, body) => api('PUT', `/api/roles/usuarios/${id}`, { token: jefe.token, body });

  assert.equal((await asignar(jefe.id, { rolIds: [roles.barista] })).status, 403); // los suyos
  assert.equal((await asignar(otro.id, { rolIds: [roles.administrador] })).status, 403); // administrador
  assert.equal((await asignar(otro.id, { rolIds: [roles.gerente] })).status, 403); // permisos que no tiene
  assert.equal((await asignar(otro.id, { excepciones: { 'auditoria.ver': 'permitido' } })).status, 403);
  assert.equal((await asignar(otro.id, { excepciones: { 'ventas.pedidos.operar': 'permitido' } })).status, 200);
  assert.equal((await asignar(otro.id, { rolIds: [roles.barista] })).status, 200); // barista ⊆ lo que él tiene

  // Crear usuarios con más de lo propio tampoco.
  const crear = (body) => api('POST', '/api/usuarios', { token: jefe.token, body: { password: CLAVE, ...body } });
  assert.equal((await crear({ username: 'nuevo1', rol: 'admin' })).status, 403);
  assert.equal((await crear({ username: 'nuevo2', rolIds: [roles.gerente] })).status, 403);
  assert.equal((await crear({ username: 'nuevo3', rolIds: [roles.barista] })).status, 201);

  // El Administrador sí puede asignarse y asignar cualquier cosa, y queda auditado con valores anterior y nuevo.
  assert.equal((await api('PUT', `/api/roles/usuarios/${admin.id}`, { token: admin.token, body: { rolIds: [roles.administrador, roles.gerente] } })).status, 200);
  const ev = (await auditados('asignar_accesos')).filter((e) => e.username === 'adm3');
  assert.equal(ev.length, 1);
  assert.deepEqual(JSON.parse(ev[0].valor_nuevo).rolIds, [roles.administrador, roles.gerente]);
});

test('Usuarios.RN06: no se le puede sacar el rol Administrador al último Administrador', async () => {
  await pool.query("UPDATE users SET activo = 0 WHERE rol = 'admin'");
  const unico = await usuario('unico', 'administrador');
  const r = await api('PUT', `/api/roles/usuarios/${unico.id}`, { token: unico.token, body: { rolIds: [roles.mozo] } });
  assert.equal(r.status, 400);
});

test('el rol Administrador no se edita y los roles de referencia no se borran ni con usuarios', async () => {
  const admin = await usuario('adm4', 'administrador');
  assert.equal((await api('PUT', `/api/roles/${roles.administrador}`, { token: admin.token, body: { nombre: 'X' } })).status, 400);
  assert.equal((await api('DELETE', `/api/roles/${roles.mozo}`, { token: admin.token })).status, 400);
  const nuevo = await api('POST', '/api/roles', { token: admin.token, body: { nombre: 'Barista de tarde', permisos: { 'ventas.pedidos.operar': 'permitido' } } });
  assert.equal(nuevo.status, 201);
  assert.equal((await api('DELETE', `/api/roles/${nuevo.json.id}`, { token: admin.token })).status, 200);
});
