const net = require('net');
const tls = require('tls');
const pool = require('../config/db');
const Funciones = require('../funciones/servicio');

// Notificaciones por correo (Usuarios RF24; función USU-CORREO): las alertas del Centro de Notificaciones también se mandan por correo a los
// roles configurados, desde cierta severidad. Sin conexión el mensaje queda en cola y se reintenta; sin la función las alertas se ven solo en
// el Centro. Cliente SMTP propio (sin dependencias): TLS implícito (puerto 465) o STARTTLS, y autenticación PLAIN.
class CorreoInvalido extends Error {}
const invalida = (m, status = 400) => Object.assign(new CorreoInvalido(m), { status });
const SEVERIDADES = ['baja', 'media', 'alta', 'critica'];
const REINTENTOS_MIN = [1, 5, 15, 60, 180, 360, 720, 1440]; // después del octavo intento queda "fallido"

// ---- SMTP ----
const hablar = (socketInicial) => {
  let socket = socketInicial, buffer = '', espera = null;
  const lineas = [];
  const alDato = (d) => {
    buffer += d.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\r\n')) >= 0) { lineas.push(buffer.slice(0, i)); buffer = buffer.slice(i + 2); }
    if (espera) espera();
  };
  socket.on('data', alDato);
  // Una respuesta termina en la línea "NNN texto" (con espacio, no guion).
  const leer = () => new Promise((resolve, reject) => {
    const mirar = () => {
      const fin = lineas.findIndex((l) => /^\d{3} /.test(l) || /^\d{3}$/.test(l));
      if (fin >= 0) { espera = null; resolve(lineas.splice(0, fin + 1)); }
    };
    espera = mirar;
    socket.once('error', reject); socket.once('close', () => reject(new Error('el servidor cortó la conexión')));
    mirar();
  });
  const decir = (linea) => socket.write(`${linea}\r\n`);
  const cambiar = (nuevo) => { socket.removeListener('data', alDato); socket = nuevo; socket.on('data', alDato); };
  return { leer, decir, cambiar, cerrar: () => socket.destroy(), get socket() { return socket; } };
};
const codigo = (r) => Number(r[r.length - 1].slice(0, 3));
const esperar = async (c, ok) => { const r = await c.leer(); if (!ok.includes(codigo(r))) throw new Error(`SMTP: ${r.join(' | ')}`); return r; };

const smtpEnviar = async ({ host, puerto, seguro, usuario, remitente }, { para, asunto, cuerpo }) => {
  const clave = process.env.CORREO_PASSWORD;
  const socket = await new Promise((resolve, reject) => {
    const s = seguro ? tls.connect({ host, port: puerto, servername: host }, () => resolve(s)) : net.connect({ host, port: puerto }, () => resolve(s));
    s.setTimeout(20000, () => s.destroy(new Error('SMTP: tiempo agotado')));
    s.once('error', reject);
  });
  const c = hablar(socket);
  try {
    await esperar(c, [220]);
    c.decir('EHLO chepola'); let ext = await esperar(c, [250]);
    if (!seguro && ext.some((l) => /STARTTLS/i.test(l))) {
      c.decir('STARTTLS'); await esperar(c, [220]);
      c.cambiar(await new Promise((resolve, reject) => { const t = tls.connect({ socket: c.socket, servername: host }, () => resolve(t)); t.once('error', reject); }));
      c.decir('EHLO chepola'); ext = await esperar(c, [250]);
    }
    if (usuario && clave) { c.decir(`AUTH PLAIN ${Buffer.from(`\0${usuario}\0${clave}`).toString('base64')}`); await esperar(c, [235]); }
    c.decir(`MAIL FROM:<${remitente}>`); await esperar(c, [250]);
    c.decir(`RCPT TO:<${para}>`); await esperar(c, [250, 251]);
    c.decir('DATA'); await esperar(c, [354]);
    const mensaje = [`From: ${remitente}`, `To: ${para}`, `Subject: =?UTF-8?B?${Buffer.from(asunto).toString('base64')}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64', '', Buffer.from(cuerpo).toString('base64').replace(/(.{76})/g, '$1\r\n')].join('\r\n');
    c.decir(`${mensaje}\r\n.`); await esperar(c, [250]);
    c.decir('QUIT');
  } finally { c.cerrar(); }
};
let transporte = smtpEnviar;
const usarTransporte = (fn) => { transporte = fn; };

// ---- Configuración ----
const config = async () => (await pool.query('SELECT * FROM correo_config WHERE id = 1'))[0][0];
const roles = async () => (await pool.query('SELECT rol_codigo FROM correo_roles ORDER BY rol_codigo'))[0].map((r) => r.rol_codigo);
const estado = async () => { const c = await config(); return { ...c, activo: !!c.activo, seguro: !!c.seguro, roles: await roles(), clave_en_entorno: !!process.env.CORREO_PASSWORD }; };

const configurar = async ({ host, puerto = 587, seguro = false, usuario = null, remitente, severidad_minima: sev = 'alta', activo = true, roles: rs }) => {
  if (typeof host !== 'string' || !host.trim()) throw invalida('Falta el servidor de correo.');
  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) throw invalida('El puerto es un número de 1 a 65535.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(remitente ?? '')) throw invalida('El remitente tiene que ser una dirección de correo.');
  if (!SEVERIDADES.includes(sev)) throw invalida(`La severidad mínima es una de: ${SEVERIDADES.join(', ')}.`);
  await pool.query('UPDATE correo_config SET host = ?, puerto = ?, seguro = ?, usuario = ?, remitente = ?, severidad_minima = ?, activo = ? WHERE id = 1', [host.trim(), puerto, seguro ? 1 : 0, usuario, remitente, sev, activo ? 1 : 0]);
  if (rs !== undefined) {
    if (!Array.isArray(rs)) throw invalida('"roles" es una lista de códigos de rol.');
    const ok = new Set((await pool.query('SELECT codigo FROM roles'))[0].map((r) => r.codigo));
    const mala = rs.find((r) => !ok.has(r));
    if (mala) throw invalida(`El rol "${mala}" no existe.`);
    await pool.query('DELETE FROM correo_roles');
    if (rs.length) await pool.query('INSERT INTO correo_roles (rol_codigo) VALUES ?', [rs.map((r) => [r])]);
  }
  return estado();
};

// ---- Cola ----
const listo = async () => (await Funciones.estaActiva('USU-CORREO')) && !!(await config()).activo;
const encolar = async ({ para, asunto, cuerpo, notificacionId = null }) => {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(para ?? '')) throw invalida('La dirección de destino no es válida.');
  const [r] = await pool.query('INSERT INTO correo_cola (para, asunto, cuerpo, notificacion_id) VALUES (?, ?, ?, ?)', [para, String(asunto).slice(0, 200), cuerpo, notificacionId]);
  return r.insertId;
};

// Una alerta nueva del Centro de Notificaciones: se manda a los usuarios habilitados de los roles configurados que figuran como destinatarios
// (el Administrador ve todas), si la severidad alcanza el mínimo. Nunca frena a quien emitió la alerta.
const alEmitir = async ({ id, modulo, severidad, mensaje, roles: destinatarios }) => {
  try {
    if (!(await listo())) return 0;
    const c = await config();
    if (SEVERIDADES.indexOf(severidad) < SEVERIDADES.indexOf(c.severidad_minima)) return 0;
    const configurados = await roles();
    const alcanzan = configurados.filter((r) => r === 'administrador' || destinatarios.includes(r));
    if (!alcanzan.length) return 0;
    const [usuarios] = await pool.query(
      `SELECT DISTINCT u.email FROM users u JOIN usuario_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.rol_id
       WHERE u.activo = 1 AND (u.fecha_baja IS NULL OR u.fecha_baja > CURDATE()) AND u.email IS NOT NULL AND u.email <> '' AND r.codigo IN (?)`, [alcanzan]);
    for (const u of usuarios) await encolar({ para: u.email, asunto: `[${severidad.toUpperCase()}] ${modulo}: alerta del sistema`, cuerpo: mensaje, notificacionId: id });
    return usuarios.length;
  } catch { return 0; }
};

// Envía lo pendiente: un fallo reprograma con espera creciente y, agotados los intentos, queda "fallido" a la vista del Administrador.
const enviarCola = async () => {
  if (!(await listo())) return { enviados: 0, fallidos: 0, pendientes: 0 };
  const c = await config();
  const [pend] = await pool.query("SELECT * FROM correo_cola WHERE estado = 'pendiente' AND proximo_intento <= NOW() ORDER BY id LIMIT 50");
  let enviados = 0, fallidos = 0;
  for (const m of pend) {
    try {
      await transporte({ host: c.host, puerto: c.puerto, seguro: !!c.seguro, usuario: c.usuario, remitente: c.remitente }, { para: m.para, asunto: m.asunto, cuerpo: m.cuerpo });
      await pool.query("UPDATE correo_cola SET estado = 'enviado', intentos = intentos + 1, enviado_en = NOW(), error = NULL WHERE id = ?", [m.id]);
      enviados++;
    } catch (err) {
      const n = m.intentos + 1;
      if (n >= REINTENTOS_MIN.length) { await pool.query("UPDATE correo_cola SET estado = 'fallido', intentos = ?, error = ? WHERE id = ?", [n, String(err.message).slice(0, 255), m.id]); fallidos++; } else
        await pool.query('UPDATE correo_cola SET intentos = ?, error = ?, proximo_intento = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?', [n, String(err.message).slice(0, 255), REINTENTOS_MIN[n - 1], m.id]);
    }
  }
  return { enviados, fallidos, pendientes: Number((await pool.query("SELECT COUNT(*) AS n FROM correo_cola WHERE estado = 'pendiente'"))[0][0].n) };
};

// Envío directo para quien necesita el resultado ya (por ejemplo el recordatorio de una reserva): falla si no se pudo.
const enviarDirecto = async ({ para, asunto, cuerpo }) => {
  if (!(await listo())) throw new Error('El correo no está activado.');
  const c = await config();
  await transporte({ host: c.host, puerto: c.puerto, seguro: !!c.seguro, usuario: c.usuario, remitente: c.remitente }, { para, asunto, cuerpo });
};

const cola = async ({ estado: e } = {}) => (await pool.query(`SELECT id, para, asunto, estado, intentos, proximo_intento, error, creado_en, enviado_en FROM correo_cola ${e ? 'WHERE estado = ?' : ''} ORDER BY id DESC LIMIT 200`, e ? [e] : []))[0];
const reintentar = async (id) => {
  const [r] = await pool.query("UPDATE correo_cola SET estado = 'pendiente', intentos = 0, proximo_intento = NOW() WHERE id = ? AND estado = 'fallido'", [id]);
  if (!r.affectedRows) throw invalida('Solo se reintentan los envíos fallidos.', 409);
};

module.exports = { CorreoInvalido, smtpEnviar, usarTransporte, config, estado, configurar, encolar, alEmitir, enviarCola, enviarDirecto, cola, reintentar };
