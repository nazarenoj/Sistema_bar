const bcrypt = require('bcryptjs');
const Permiso = require('../models/permisoModel');
const User = require('../models/userModel');
const Parametro = require('../models/parametroModel');
const { hashCodigo } = require('../utils/credenciales');
const throttle = require('../utils/throttle');
const { auditar } = require('../utils/auditar');
const logger = require('../utils/logger');

// Permisos efectivos del usuario de la request. Se calculan en cada acción (RN09) y se guardan en
// `req` para no repetir la consulta si la misma request pasa por más de un control.
const permisosDe = async (req) => {
  if (!req.permisos) req.permisos = await Permiso.efectivos(req.usuario.sub, req.usuario.rol);
  return req.permisos;
};

// Identifica al supervisor con PIN/tarjeta (`credencial`) o con usuario + contraseña. Devuelve el
// usuario o null; no dice cuál de las dos cosas falló.
const identificarSupervisor = async ({ usuario, credencial }) => {
  if (typeof credencial !== 'string' || !credencial) return null;
  if (usuario) {
    const u = await User.getByUsername(String(usuario).trim());
    return u && (await bcrypt.compare(credencial, u.password_hash)) ? u : null;
  }
  const hash = hashCodigo(credencial);
  return (await User.getByPin(hash)) || (await User.getByTarjeta(hash));
};

// Valida la autorización de supervisor (RF05, RN08): otro usuario, habilitado, con la acción
// "Permitida". Devuelve { ok, supervisor } o { ok: false, error, status }.
// Con `exigirAdmin` el supervisor tiene que ser Administrador (RN86), en vez de tener el permiso.
const validarAutorizacion = async (req, permiso, { exigirAdmin = false } = {}) => {
  const aut = req.body?.autorizacion;
  if (!aut) return { ok: false, status: 403, codigo: 'REQUIERE_AUTORIZACION', error: 'Esta acción necesita la autorización de un supervisor.' };

  const clave = `${req.instancia.codigo}:aut:${req.usuario.sub}`;
  const espera = throttle.bloqueadoPor(clave);
  if (espera) return { ok: false, status: 429, codigo: 'AUTORIZACION_BLOQUEADA', error: `Demasiados intentos fallidos. Reintentá en ${espera} minuto(s).` };

  const rechazo = async (motivo) => {
    const p = await Parametro.todos();
    throttle.registrarFallo(clave, p.intentos_max ?? 5, p.bloqueo_minutos ?? 15);
    await auditar(req, { modulo: 'permisos', accion: 'autorizacion_rechazada', resultado: 'denegado', entidad: 'permiso', entidad_id: permiso, detalle: motivo });
    return { ok: false, status: 403, codigo: 'AUTORIZACION_INVALIDA', error: 'La autorización no es válida.' };
  };

  const sup = await identificarSupervisor(aut);
  if (!sup || !sup.habilitado || sup.bloqueo_min) return rechazo('credencial inválida');
  if (sup.id === req.usuario.sub) return rechazo('el usuario quiso autorizar su propia acción');
  const { niveles, esAdmin } = await Permiso.efectivos(sup.id, sup.rol);
  if (exigirAdmin ? !esAdmin : niveles[permiso] !== 'permitido') return rechazo(`${sup.username} no ${exigirAdmin ? 'es Administrador' : 'tiene la acción permitida'}`);

  throttle.limpiar(clave);
  return { ok: true, supervisor: { id: sup.id, username: sup.username } };
};

// Middleware: deja pasar según el nivel del permiso para el usuario.
//   permitido             → sigue
//   requiere_autorizacion → pide la credencial de un supervisor en `body.autorizacion` y la valida
//   denegado              → 403 y queda registrado el intento (EX03)
const requierePermiso = (permiso) => async (req, res, next) => {
  try {
    const { niveles } = await permisosDe(req);
    const nivel = niveles[permiso] ?? 'denegado';
    if (nivel === 'permitido') return next();

    if (nivel === 'denegado') {
      await auditar(req, { modulo: 'permisos', accion: 'acceso_denegado', resultado: 'denegado', entidad: 'permiso', entidad_id: permiso, detalle: `${req.method} ${req.originalUrl.split('?')[0]}` });
      return res.status(403).json({ error: 'No tenés permiso para hacer esto.', codigo: 'SIN_PERMISO', permiso });
    }

    const r = await validarAutorizacion(req, permiso);
    if (!r.ok) return res.status(r.status).json({ error: r.error, codigo: r.codigo, permiso });
    req.autorizadoPor = r.supervisor;
    await auditar(req, { modulo: 'permisos', accion: 'autorizacion', entidad: 'permiso', entidad_id: permiso, detalle: `autorizó ${r.supervisor.username}` });
    next();
  } catch (err) {
    logger.error(`permisos ${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = { requierePermiso, permisosDe, validarAutorizacion };
