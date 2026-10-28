const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/userModel');
const Sesion = require('../models/sesionModel');
const Terminal = require('../models/terminalModel');
const Parametro = require('../models/parametroModel');
const Permiso = require('../models/permisoModel');
const { hashCodigo } = require('../utils/credenciales');
const throttle = require('../utils/throttle');
const logger = require('../utils/logger');
const { auditar } = require('../utils/auditar');

// Tope absoluto de vida del token; el vencimiento real por inactividad lo decide el servidor.
const JWT_EXPIRES_IN = '12h';

// Se compara contra este hash cuando el usuario no existe, para que responder "no existe" no tarde
// menos que responder "contraseña incorrecta" (no filtrar qué usuarios existen por el tiempo).
const HASH_DUMMY = bcrypt.hashSync('contraseña-que-nadie-usa', 10);

const falla500 = (req, res, err) => {
  logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
};

// Quien intenta ingresar todavía no tiene sesión: el actor se arma con lo que se sabe.
const actorIngreso = (req, user, terminal) => ({
  id: user?.id, username: user?.username, rol: user?.rol, terminal_id: terminal?.id, ip: req.ip,
});

const datosUsuario = (u, terminal, permisos) => ({
  id: u.id, username: u.username, rol: u.rol, nombre: u.nombre,
  roles: permisos?.roles, permisos: permisos?.niveles,
  debe_cambiar_password: !!u.debe_cambiar_password,
  terminal: terminal ? { id: terminal.id, nombre: terminal.nombre } : null,
});

// Abre una sesión nueva y devuelve el token. `terminal` puede ser null (equipo sin registrar).
const abrirSesion = async (req, res, user, terminal) => {
  const sid = await Sesion.crear({ user_id: user.id, terminal_id: terminal?.id, ip: req.ip });
  if (terminal) await Terminal.tocar(terminal.id);
  await User.registrarLoginOk(user.id);
  await auditar(req, { modulo: 'sesiones', accion: 'ingreso', entidad: 'sesion', entidad_id: sid }, actorIngreso(req, user, terminal));
  const token = jwt.sign(
    { sub: user.id, username: user.username, rol: user.rol, sid, inst: req.instancia.codigo },
    process.env.JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  const params = await Parametro.todos();
  const minutos = terminal?.inactividad_min ?? params[`inactividad_min_${user.rol}`] ?? 10;
  res.json({ token, usuario: datosUsuario(user, terminal, await Permiso.efectivos(user.id, user.rol)), inactividad_min: minutos });
};

// Rechazo de un usuario que ya se identificó bien (contraseña, PIN o tarjeta correctos): ahí sí se
// puede decir el motivo sin regalarle información a quien adivina.
const motivoRechazo = (user) => {
  if (!user.habilitado) return { status: 403, error: 'Usuario desactivado.' };
  if (user.bloqueo_min)
    return { status: 423, error: `Usuario bloqueado por intentos fallidos. Reintentá en ${user.bloqueo_min} minuto(s) o pedí a un Administrador que lo desbloquee.` };
  return null;
};

const login = async (req, res) => {
  const { username, password, terminal } = req.body;

  if (!username || typeof username !== 'string')
    return res.status(400).json({ error: 'El campo "username" es obligatorio.' });
  if (!password || typeof password !== 'string')
    return res.status(400).json({ error: 'El campo "password" es obligatorio.' });

  try {
    let terminalRow = null;
    if (terminal) {
      terminalRow = await Terminal.getByCodigo(String(terminal).trim().toUpperCase());
      if (!terminalRow || !terminalRow.activa)
        return res.status(400).json({ error: 'El código de terminal no está registrado o la terminal está desactivada.' });
    }

    const user = await User.getByUsername(username.trim());
    const valido = await bcrypt.compare(password, user ? user.password_hash : HASH_DUMMY);

    if (!user || !valido) {
      // Un usuario ya bloqueado no suma fallos: el bloqueo no se alarga probando contraseñas.
      if (user && !user.bloqueo_min) {
        const p = await Parametro.todos();
        await User.registrarFallo(user.id, p.intentos_max ?? 5, p.bloqueo_minutos ?? 15);
      }
      await auditar(req, { modulo: 'sesiones', accion: 'ingreso_fallido', resultado: 'denegado', detalle: `usuario "${username.trim().slice(0, 50)}"` }, actorIngreso(req, user, terminalRow));
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }

    const rechazo = motivoRechazo(user);
    if (rechazo) {
      await auditar(req, { modulo: 'sesiones', accion: 'ingreso_rechazado', resultado: 'denegado', detalle: rechazo.error }, actorIngreso(req, user, terminalRow));
      return res.status(rechazo.status).json({ error: rechazo.error });
    }

    await abrirSesion(req, res, user, terminalRow);
  } catch (err) {
    falla500(req, res, err);
  }
};

const logout = async (req, res) => {
  try {
    await Sesion.cerrar(req.usuario.sid, 'cierre');
    await auditar(req, { modulo: 'sesiones', accion: 'cierre', entidad: 'sesion', entidad_id: req.usuario.sid });
    res.json({ message: 'Sesión cerrada.' });
  } catch (err) {
    falla500(req, res, err);
  }
};

// Datos de la sesión actual: la pantalla los usa al cargar para validar el token guardado.
const sesionActual = async (req, res) => {
  try {
    const user = await User.getById(req.usuario.sub);
    const sesion = await Sesion.getConUsuario(req.usuario.sid);
    const terminal = sesion.terminal_id ? await Terminal.getById(sesion.terminal_id) : null;
    const params = await Parametro.todos();
    res.json({
      usuario: datosUsuario(user, terminal, await Permiso.efectivos(user.id, user.rol)),
      inactividad_min: Sesion.minutosInactividad(sesion, params),
    });
  } catch (err) {
    falla500(req, res, err);
  }
};

const cambiarPassword = async (req, res) => {
  const { actual, nueva } = req.body;
  if (typeof actual !== 'string' || typeof nueva !== 'string' || !actual || !nueva)
    return res.status(400).json({ error: 'Se necesitan la contraseña actual y la nueva.' });

  try {
    const { password_min_largo: min = 8 } = await Parametro.todos();
    if (nueva.length < min)
      return res.status(400).json({ error: `La contraseña nueva debe tener al menos ${min} caracteres.` });
    if (nueva === actual)
      return res.status(400).json({ error: 'La contraseña nueva tiene que ser distinta de la actual.' });

    const user = await User.getById(req.usuario.sub);
    if (!(await bcrypt.compare(actual, user.password_hash)))
      return res.status(400).json({ error: 'La contraseña actual no es correcta.' });

    await User.setPassword(user.id, await bcrypt.hash(nueva, 10), false);
    // Si alguien más tenía la contraseña vieja, sus sesiones dejan de servir.
    await Sesion.cerrarDeUsuario(user.id, 'forzado', req.usuario.sid);
    await auditar(req, { modulo: 'usuarios', accion: 'cambio_password', entidad: 'usuario', entidad_id: user.id });
    res.json({ message: 'Contraseña actualizada.' });
  } catch (err) {
    falla500(req, res, err);
  }
};

// Cambio rápido de usuario en la terminal con PIN o código de tarjeta/llave: cierra la sesión actual
// y abre la del nuevo usuario en la misma terminal, sin pasar por la pantalla de ingreso.
const cambiarUsuario = async (req, res) => {
  const { codigo } = req.body;
  if (typeof codigo !== 'string' || !codigo.trim())
    return res.status(400).json({ error: 'Ingresá el PIN o pasá la tarjeta.' });

  const clave = `${req.instancia.codigo}:cambio:${req.usuario.terminal_id ?? req.ip}`;
  try {
    const p = await Parametro.todos();

    const espera = throttle.bloqueadoPor(clave);
    if (espera)
      return res.status(429).json({ error: `Demasiados intentos fallidos en esta terminal. Reintentá en ${espera} minuto(s).` });

    const hash = hashCodigo(codigo);
    const user = (await User.getByPin(hash)) || (await User.getByTarjeta(hash));
    if (!user) {
      throttle.registrarFallo(clave, p.intentos_max ?? 5, p.bloqueo_minutos ?? 15);
      await auditar(req, { modulo: 'sesiones', accion: 'cambio_usuario_fallido', resultado: 'denegado' });
      return res.status(401).json({ error: 'PIN o tarjeta incorrectos.' });
    }

    const rechazo = motivoRechazo(user);
    if (rechazo) return res.status(rechazo.status).json({ error: rechazo.error });

    throttle.limpiar(clave);
    await Sesion.cerrar(req.usuario.sid, 'cambio_usuario');
    await auditar(req, { modulo: 'sesiones', accion: 'cambio_usuario', entidad: 'usuario', entidad_id: user.id, detalle: `de ${req.usuario.username} a ${user.username}` });
    const terminal = req.usuario.terminal_id ? await Terminal.getById(req.usuario.terminal_id) : null;
    await abrirSesion(req, res, user, terminal);
  } catch (err) {
    falla500(req, res, err);
  }
};

module.exports = { login, logout, sesionActual, cambiarPassword, cambiarUsuario };
