const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

process.env.COPIAS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'copias-nube-'));
const EXTERNO = fs.mkdtempSync(path.join(os.tmpdir(), 'externo-'));
let api, pool, cerrar, token, srv, puerto, recibidos = [];
const CLAVE = 'clave-de-copias-123';

// Servidor SMTP mínimo de verdad: habla el protocolo y guarda lo que recibe.
const levantarSmtp = (puertoFijo = 0) => new Promise((resolve) => {
  const s = net.createServer((sock) => {
    let modo = 'cmd', msg = { para: [], datos: '' }, buf = '';
    sock.write('220 prueba ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 2);
        if (modo === 'datos') { if (l === '.') { modo = 'cmd'; recibidos.push(msg); msg = { para: [], datos: '' }; sock.write('250 ok\r\n'); } else msg.datos += `${l}\n`; continue; }
        if (/^EHLO/.test(l)) sock.write('250-prueba\r\n250 AUTH PLAIN\r\n');
        else if (/^MAIL FROM:<(.*)>/.test(l)) { msg.de = l.match(/<(.*)>/)[1]; sock.write('250 ok\r\n'); }
        else if (/^RCPT TO:<(.*)>/.test(l)) { msg.para.push(l.match(/<(.*)>/)[1]); sock.write('250 ok\r\n'); }
        else if (l === 'DATA') { modo = 'datos'; sock.write('354 sigue\r\n'); }
        else if (l === 'QUIT') sock.end('221 chau\r\n');
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  s.listen(puertoFijo, '127.0.0.1', () => resolve(s));
});

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol, email) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol, email) VALUES (?, ?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado', email]);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
  };
  await usuario('adm', 'administrador', 'adm@cafe.test');
  await usuario('ger', 'gerente', 'ger@cafe.test');
  await usuario('bea', 'barista', 'bea@cafe.test');
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
  srv = await levantarSmtp();
  puerto = srv.address().port;
});
after(async () => { srv?.close(); await cerrar(); fs.rmSync(process.env.COPIAS_DIR, { recursive: true, force: true }); fs.rmSync(EXTERNO, { recursive: true, force: true }); });

const activar = (f) => api('POST', '/api/funciones/cambiar', { token, body: { activar: [f], motivo: 'prueba' } });

test('Usuarios.RF23/EX06: con USU-NUBE la copia se envía cifrada al destino externo; si no llega queda en cola, alerta y se reintenta', async () => {
  const Copias = require('../src/servicios/copiaService');
  assert.equal((await api('GET', '/api/copias/destino', { token })).status, 409);
  assert.equal((await activar('USU-NUBE')).status, 200);
  assert.equal((await api('PUT', '/api/copias/destino', { token, body: { tipo: 'http', ruta: 'http://nube.ejemplo.com/copias' } })).status, 400);
  assert.equal((await api('PUT', '/api/copias/destino', { token, body: { tipo: 'carpeta', ruta: EXTERNO } })).status, 200);
  assert.equal((await api('POST', '/api/copias/configuracion', { token, body: { clave: CLAVE } })).status, 200);
  const c1 = (await api('POST', '/api/copias', { token, body: { clave: CLAVE } })).json;
  assert.deepEqual(fs.readFileSync(path.join(EXTERNO, c1.nombre)), fs.readFileSync(path.join(process.env.COPIAS_DIR, 'DEFAULT', c1.nombre))); // la misma copia cifrada
  assert.equal((await pool.query('SELECT externa_estado FROM copias_seguridad WHERE id = ?', [c1.id]))[0][0].externa_estado, 'enviada');

  Copias.usarTransporteExterno(async () => { throw new Error('el destino no responde'); });
  const c2 = await api('POST', '/api/copias', { token, body: { clave: CLAVE } });
  assert.equal(c2.status, 201); // la copia se conserva en la plataforma
  const fila = (await pool.query('SELECT externa_estado, externa_error FROM copias_seguridad WHERE id = ?', [c2.json.id]))[0][0];
  assert.deepEqual([fila.externa_estado, fila.externa_error], ['pendiente', 'el destino no responde']);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE clave = 'copia-externa-pendiente' AND estado <> 'resuelta'"))[0][0].n, 1);
  const vistos = [];
  Copias.usarTransporteExterno(async (d, c) => { vistos.push(c.nombre); });
  const r = await api('POST', '/api/copias/destino/enviar', { token });
  assert.deepEqual([r.json.length, r.json[0].enviada, vistos], [1, true, [c2.json.nombre]]);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE clave = 'copia-externa-pendiente' AND estado <> 'resuelta'"))[0][0].n, 0);
});

test('Usuarios.RF24: las alertas nuevas salen por correo a los roles configurados desde la severidad mínima, sin repetirse', async () => {
  const Notificacion = require('../src/models/notificacionModel');
  assert.equal((await api('GET', '/api/correo', { token })).status, 409);
  assert.equal((await activar('USU-CORREO')).status, 200);
  const base = { host: '127.0.0.1', puerto, remitente: 'sistema@cafe.test', severidad_minima: 'alta', roles: ['administrador', 'gerente'] };
  assert.equal((await api('PUT', '/api/correo', { token, body: { ...base, remitente: 'sin-arroba' } })).status, 400);
  assert.equal((await api('PUT', '/api/correo', { token, body: { ...base, severidad_minima: 'enorme' } })).status, 400);
  assert.equal((await api('PUT', '/api/correo', { token, body: { ...base, roles: ['inexistente'] } })).status, 400);
  assert.equal((await api('PUT', '/api/correo', { token, body: base })).status, 200);
  const cola = async () => (await pool.query('SELECT para FROM correo_cola ORDER BY id'))[0].map((x) => x.para);

  await Notificacion.crear({ modulo: 'stock', tipo: 't', severidad: 'media', mensaje: 'poca cosa', roles: ['gerente'], clave: 'a-1' });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(await cola(), []); // por debajo del mínimo
  await Notificacion.crear({ modulo: 'stock', tipo: 't', severidad: 'alta', mensaje: 'Se cayó la balanza', roles: ['gerente'], clave: 'a-2' });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual((await cola()).sort(), ['adm@cafe.test', 'ger@cafe.test']);
  await Notificacion.crear({ modulo: 'stock', tipo: 't', severidad: 'critica', mensaje: 'Se cayó la balanza', roles: ['gerente'], clave: 'a-2' }); // misma alerta abierta: se actualiza, no se reenvía
  await Notificacion.crear({ modulo: 'ventas', tipo: 't', severidad: 'critica', mensaje: 'Solo para barista', roles: ['barista'], clave: 'a-3' });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual((await cola()).sort(), ['adm@cafe.test', 'adm@cafe.test', 'ger@cafe.test']); // barista no es un rol configurado: solo el Administrador

  const env = await api('POST', '/api/correo/enviar', { token });
  assert.deepEqual([env.json.enviados, env.json.pendientes], [3, 0]);
  assert.equal(recibidos.length, 3);
  const m = recibidos.find((x) => x.para.includes('ger@cafe.test'));
  assert.equal(m.de, 'sistema@cafe.test');
  assert.match(m.datos, /Subject: =\?UTF-8\?B\?/);
  assert.equal(Buffer.from(m.datos.split('\n\n')[1].replace(/\n/g, ''), 'base64').toString(), 'Se cayó la balanza');
  assert.equal((await api('POST', '/api/correo/probar', { token, body: { para: 'adm@cafe.test' } })).status, 200);
});

test('Usuarios.RF24: sin conexión el envío queda en cola con espera creciente y, agotados los intentos, queda fallido hasta reintentarlo', async () => {
  const Correo = require('../src/servicios/correoService');
  const Notificacion = require('../src/models/notificacionModel');
  const cerrado = await new Promise((r) => srv.close(r)); void cerrado;
  await pool.query("UPDATE correo_cola SET estado = 'enviado'");
  await Notificacion.crear({ modulo: 'stock', tipo: 't', severidad: 'critica', mensaje: 'Sin internet', roles: [], clave: 'b-1' });
  await new Promise((r) => setTimeout(r, 100));
  const r1 = await api('POST', '/api/correo/enviar', { token });
  assert.deepEqual([r1.json.enviados, r1.json.pendientes], [0, 1]);
  const m = (await pool.query("SELECT * FROM correo_cola WHERE estado = 'pendiente'"))[0][0];
  assert.equal(m.intentos, 1);
  assert.ok(new Date(m.proximo_intento) > new Date()); // espera antes de reintentar
  assert.deepEqual((await api('POST', '/api/correo/enviar', { token })).json.enviados, 0); // todavía no le toca
  assert.equal((await api('POST', '/api/correo/probar', { token, body: { para: 'adm@cafe.test' } })).status, 502);
  await pool.query('UPDATE correo_cola SET intentos = 7, proximo_intento = NOW() WHERE id = ?', [m.id]);
  assert.equal((await api('POST', '/api/correo/enviar', { token })).json.fallidos, 1);
  assert.equal((await api('GET', '/api/correo/cola?estado=fallido', { token })).json.length, 1);
  srv = await levantarSmtp(puerto); // vuelve la conexión
  assert.equal((await api('POST', `/api/correo/cola/${m.id}/reintentar`, { token })).status, 200);
  assert.equal((await api('POST', `/api/correo/cola/${m.id}/reintentar`, { token })).status, 409);
  assert.equal((await Correo.enviarCola()).enviados, 1);
});

test('Usuarios.RF24 + Ventas RF44: los recordatorios de reservas salen por el servicio de correo de la plataforma', async () => {
  const Reservas = require('../src/services/reservaService');
  await pool.query("INSERT INTO reservas_mesa (id_global, fecha_hora, duracion_min, fecha_fin, personas, cliente_nombre, cliente_email) VALUES ('RES-T1', DATE_ADD(NOW(), INTERVAL 2 HOUR), 60, DATE_ADD(NOW(), INTERVAL 3 HOUR), 2, 'Lucía', 'lucia@mail.test')");
  const antes = recibidos.length;
  assert.equal((await Reservas.enviarRecordatorios()).enviados, 1);
  assert.deepEqual(recibidos.slice(antes).map((x) => x.para), [['lucia@mail.test']]);
});
