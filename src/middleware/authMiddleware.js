const jwt = require('jsonwebtoken');
const Sesion = require('../models/sesionModel');
const Parametro = require('../models/parametroModel');
const logger = require('../utils/logger');
const { auditar } = require('../utils/auditar');

// Rutas que un usuario con "debe cambiar la contraseña" sí puede usar.
const RUTAS_CAMBIO_PASSWORD = ['/api/auth/cambiar-password', '/api/auth/logout', '/api/auth/sesion'];

const respuesta401 = (res, mensaje) => res.status(401).json({ error: mensaje });

// El token solo identifica la sesión; el estado real (cerrada, vencida por inactividad, usuario
// desactivado o con la contraseña por cambiar) se consulta en el servidor en cada request. Los
// permisos por rol llegan con la Fase A5: hasta entonces todo usuario logueado puede todo.
// `refrescar` renueva la marca de actividad: los latidos de la pantalla no la renuevan, si no una
// terminal olvidada nunca vencería.
const crear = (refrescar) => async (req, res, next) => {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return respuesta401(res, 'No autenticado. Iniciá sesión.');

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return respuesta401(res, 'Sesión inválida o expirada. Iniciá sesión de nuevo.');
  }
  // Un token de otra instancia no sirve aquí aunque la firma sea válida.
  if (!payload.sid || payload.inst !== req.instancia?.codigo) return respuesta401(res, 'Sesión inválida o expirada. Iniciá sesión de nuevo.');

  try {
    const sesion = await Sesion.getConUsuario(payload.sid);
    if (!sesion || sesion.fin) return respuesta401(res, 'La sesión se cerró. Iniciá sesión de nuevo.');

    if (!sesion.habilitado) {
      await Sesion.cerrar(sesion.id, 'forzado');
      return respuesta401(res, 'Tu usuario fue desactivado.');
    }

    const minutos = Sesion.minutosInactividad(sesion, await Parametro.todos());
    if (sesion.inactivo_seg > minutos * 60) {
      await Sesion.cerrar(sesion.id, 'inactividad');
      await auditar(req, { modulo: 'sesiones', accion: 'vencida_inactividad', entidad: 'sesion', entidad_id: sesion.id },
        { id: sesion.user_id, username: sesion.username, rol: sesion.rol, terminal_id: sesion.terminal_id, ip: req.ip });
      return respuesta401(res, 'Sesión cerrada por inactividad. Iniciá sesión de nuevo.');
    }

    if (sesion.debe_cambiar_password && !RUTAS_CAMBIO_PASSWORD.includes(req.originalUrl.split('?')[0]))
      return res.status(403).json({ error: 'Tenés que cambiar tu contraseña antes de continuar.', codigo: 'CAMBIO_PASSWORD' });

    if (refrescar) await Sesion.tocar(sesion.id);

    req.usuario = {
      sub: sesion.user_id, username: sesion.username, rol: sesion.rol,
      sid: sesion.id, terminal_id: sesion.terminal_id,
    };
    next();
  } catch (err) {
    logger.error(`auth ${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const requireAuth = crear(true);
requireAuth.pasivo = crear(false);

module.exports = requireAuth;
