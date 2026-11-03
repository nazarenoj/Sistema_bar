const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');
const SF = require('../src/servicios/segundoFactorService');

let api, pool, cerrar, tokenAdm2, ids = {};
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    ids[username] = r.insertId;
  };
  await usuario('adm', 'administrador');
  await usuario('adm2', 'administrador');
  await usuario('bea', 'barista');
});
after(async () => { await cerrar(); });

const entrar = (username, codigo) => api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1', ...(codigo && { codigo }) } });
const secretoDe = async (id) => (await pool.query('SELECT secreto FROM usuario_2fa WHERE user_id = ?', [id]))[0][0].secreto;
const codigoEn = (secreto, desplazamiento = 0) => SF.codigoDe(secreto, SF.pasoActual() + desplazamiento);

test('Usuarios.RN45: el código es TOTP estándar de 6 dígitos y 30 segundos (vector RFC 6238)', () => {
  const secreto = SF.base32(Buffer.from('12345678901234567890'));
  assert.equal(SF.codigoDe(secreto, Math.floor(59 / 30)), '287082');
  assert.equal(SF.codigoDe(secreto, Math.floor(1111111109 / 30)), '081804');
  assert.equal(SF.verificarTotp(secreto, '287082', 59000), Math.floor(59 / 30));
  assert.equal(SF.verificarTotp(secreto, '287082', 59000 + 30000), 1); // tolerancia de un período
  assert.equal(SF.verificarTotp(secreto, '287082', 59000 + 90000), null);
  assert.equal(SF.verificarTotp(secreto, 'abcdef', 59000), null);
});

test('Usuarios.RF21: sin USU-2FA no hay segundo factor; con la función, el Administrador lo enlaza y recibe 10 códigos de recuperación', async () => {
  const t = (await entrar('adm')).json.token;
  assert.equal((await api('GET', '/api/2fa', { token: t })).status, 409);
  assert.equal((await api('POST', '/api/funciones/cambiar', { token: t, body: { activar: ['USU-2FA'], motivo: 'prueba' } })).status, 200);
  const ing = await entrar('adm');
  assert.deepEqual([ing.status, ing.json.debe_enlazar_2fa], [200, true]); // todavía no lo enlazó: entra y se lo lleva a enlazar
  const token = ing.json.token;
  assert.equal((await api('POST', '/api/2fa/confirmar', { token, body: { codigo: '123456' } })).status, 409); // sin pedir el enlace antes
  const ini = (await api('POST', '/api/2fa/iniciar', { token })).json;
  assert.match(ini.uri, /^otpauth:\/\/totp\//);
  assert.equal((await api('POST', '/api/2fa/confirmar', { token, body: { codigo: '000000' === codigoEn(ini.secreto) ? '111111' : '000000' } })).status, 400);
  const ok = await api('POST', '/api/2fa/confirmar', { token, body: { codigo: codigoEn(ini.secreto) } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.codigos_recuperacion.length, 10);
  assert.equal((await api('POST', '/api/2fa/iniciar', { token })).status, 409); // ya enlazado
  assert.deepEqual(await api('GET', '/api/2fa', { token }).then((r) => [r.json.exigido, r.json.enlazado, r.json.codigos_restantes]), [true, true, 10]);
  ids.recuperacion = ok.json.codigos_recuperacion;
});

test('Usuarios.RN45/EX26: el ingreso exige el código; uno inválido o repetido se rechaza con mensaje genérico y cuenta como fallo', async () => {
  const falta = await entrar('adm');
  assert.deepEqual([falta.status, falta.json.requiere_2fa], [401, true]);
  assert.equal((await pool.query('SELECT intentos_fallidos AS n FROM users WHERE id = ?', [ids.adm]))[0][0].n, 0); // no pedir el código no es un fallo
  const mal = await entrar('adm', '000000' === codigoEn(await secretoDe(ids.adm)) ? '111111' : '000000');
  assert.deepEqual([mal.status, mal.json.error], [401, 'El código no es válido.']);
  assert.equal((await pool.query('SELECT intentos_fallidos AS n FROM users WHERE id = ?', [ids.adm]))[0][0].n, 1);
  const secreto = await secretoDe(ids.adm);
  const bueno = await entrar('adm', codigoEn(secreto, 1)); // el paso siguiente, dentro de la tolerancia
  assert.equal(bueno.status, 200);
  assert.equal(bueno.json.debe_enlazar_2fa, undefined);
  assert.equal((await entrar('adm', codigoEn(secreto, 1))).status, 401); // el mismo código no sirve dos veces
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM auditoria WHERE accion = 'ingreso_fallido' AND detalle = 'segundo factor inválido'"))[0][0].n, 2);
  assert.equal((await entrar('bea')).status, 200); // un rol que no lo exige entra solo con la contraseña
});

test('Usuarios.RN45: un código de recuperación sirve una sola vez y su uso se audita', async () => {
  const [c1, c2] = ids.recuperacion;
  const r = await entrar('adm', c1.toLowerCase());
  assert.deepEqual([r.status, r.json.codigos_recuperacion_restantes], [200, 9]);
  assert.equal((await entrar('adm', c1)).status, 401);
  assert.equal((await entrar('adm', c2)).status, 200);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM auditoria WHERE accion = '2fa_recuperacion_usada'"))[0][0].n, 2);
});

test('Usuarios.EX27: otro Administrador restablece el factor perdido; los intentos fallidos bloquean; los roles exigidos se configuran', async () => {
  tokenAdm2 = (await entrar('adm2')).json.token;
  assert.equal((await api('DELETE', `/api/2fa/usuarios/${ids.adm2}`, { token: tokenAdm2 })).status, 409); // no sobre sí mismo
  assert.equal((await api('DELETE', `/api/2fa/usuarios/${ids.bea}`, { token: tokenAdm2 })).status, 404);
  assert.equal((await api('DELETE', `/api/2fa/usuarios/${ids.adm}`, { token: tokenAdm2 })).status, 200);
  assert.equal((await entrar('adm')).json.debe_enlazar_2fa, true); // sin factor otra vez: debe enlazarlo
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM auditoria WHERE accion = '2fa_restablecer'"))[0][0].n, 1);

  // Cinco códigos malos seguidos bloquean al usuario (RN04).
  const t = (await entrar('adm')).json.token;
  const ini = (await api('POST', '/api/2fa/iniciar', { token: t })).json;
  await api('POST', '/api/2fa/confirmar', { token: t, body: { codigo: codigoEn(ini.secreto) } });
  for (let i = 0; i < 5; i++) await entrar('adm', '999999' === codigoEn(ini.secreto) ? '888888' : '999999');
  assert.equal((await entrar('adm', codigoEn(ini.secreto, 1))).status, 423);

  assert.deepEqual((await api('GET', '/api/2fa/roles', { token: tokenAdm2 })).json, ['administrador', 'gerente']);
  assert.equal((await api('PUT', '/api/2fa/roles', { token: tokenAdm2, body: { roles: ['inexistente'] } })).status, 400);
  assert.deepEqual((await api('PUT', '/api/2fa/roles', { token: tokenAdm2, body: { roles: ['gerente'] } })).json, ['gerente']);
  assert.equal((await entrar('adm2')).json.debe_enlazar_2fa, undefined); // el administrador ya no lo necesita
});
