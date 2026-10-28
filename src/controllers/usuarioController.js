const bcrypt = require('bcryptjs');
const User = require('../models/userModel');
const Sesion = require('../models/sesionModel');
const Parametro = require('../models/parametroModel');
const Permiso = require('../models/permisoModel');
const { permisosDe } = require('../middleware/requierePermiso');
const { hashCodigo } = require('../utils/credenciales');
const { esFechaISO } = require('../utils/validaciones');
const logger = require('../utils/logger');
const { auditar } = require('../utils/auditar');


const ROLES = ['admin', 'empleado'];
const USERNAME_REGEX = /^[A-Za-z0-9._-]{3,50}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const falla500 = (req, res, err) => {
  logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
};

// Valida los campos que vengan en el body (en el alta, además, los obligatorios) y devuelve los
// errores y las columnas ya listas para guardar (PIN y tarjeta como hash). `null` borra el PIN, la
// tarjeta, el correo o la baja programada.
const validar = async (body, { alta }) => {
  const errores = [];
  const datos = {};
  const p = await Parametro.todos();
  const dado = (k) => body[k] !== undefined;

  if (alta || dado('username')) {
    if (typeof body.username !== 'string' || !USERNAME_REGEX.test(body.username.trim()))
      errores.push('"username" debe tener entre 3 y 50 caracteres: letras, números, punto, guion o guion bajo.');
    else datos.username = body.username.trim();
  }
  if (dado('rol') || (alta && !dado('rolIds'))) {
    if (!ROLES.includes(body.rol)) errores.push(`"rol" debe ser uno de: ${ROLES.join(', ')}.`);
    else datos.rol = body.rol;
  }
  if (alta) {
    const min = p.password_min_largo ?? 8;
    if (typeof body.password !== 'string' || body.password.length < min)
      errores.push(`"password" debe tener al menos ${min} caracteres.`);
    else datos.password = body.password;
  }
  if (dado('nombre')) {
    if (body.nombre !== null && (typeof body.nombre !== 'string' || body.nombre.length > 100))
      errores.push('"nombre" debe ser texto de hasta 100 caracteres.');
    else datos.nombre = body.nombre ? body.nombre.trim() : null;
  }
  if (dado('email')) {
    if (body.email !== null && (typeof body.email !== 'string' || body.email.length > 150 || !EMAIL_REGEX.test(body.email)))
      errores.push('"email" no es un correo válido.');
    else datos.email = body.email;
  }
  if (dado('pin')) {
    const min = p.pin_min_digitos ?? 4;
    if (body.pin === null) datos.pin_hash = null;
    else if (typeof body.pin !== 'string' || !/^\d+$/.test(body.pin) || body.pin.length < min || body.pin.length > 12)
      errores.push(`"pin" debe tener entre ${min} y 12 dígitos.`);
    else datos.pin_hash = hashCodigo(body.pin);
  }
  if (dado('codigo_tarjeta')) {
    if (body.codigo_tarjeta === null) datos.tarjeta_hash = null;
    else if (typeof body.codigo_tarjeta !== 'string' || body.codigo_tarjeta.trim().length < 4 || body.codigo_tarjeta.length > 64)
      errores.push('"codigo_tarjeta" debe tener entre 4 y 64 caracteres.');
    else datos.tarjeta_hash = hashCodigo(body.codigo_tarjeta);
  }
  if (dado('fecha_baja')) {
    if (body.fecha_baja !== null && !esFechaISO(body.fecha_baja))
      errores.push('"fecha_baja" debe ser una fecha válida (AAAA-MM-DD) o null.');
    else datos.fecha_baja = body.fecha_baja;
  }
  return { errores, datos };
};

// Roles con los que nace un usuario: los `rolIds` pedidos, o el que corresponde al campo `rol`
// de siempre (admin → Administrador, empleado → Encargado de turno).
const rolesParaAlta = async (body, datos, actor) => {
  const roles = await Permiso.listarRoles();
  const ids = body.rolIds ?? [roles.find((r) => r.codigo === (datos.rol === 'admin' ? 'administrador' : 'encargado')).id];
  const elegidos = Array.isArray(ids) ? roles.filter((r) => ids.includes(r.id)) : [];
  if (!elegidos.length || elegidos.length !== new Set(ids).size) return { status: 400, error: '"rolIds" debe ser una lista de roles existentes.' };
  if (!actor.esAdmin) {
    if (elegidos.some((r) => r.codigo === 'administrador')) return { status: 403, error: 'Solo un Administrador crea Administradores.' };
    for (const r of elegidos)
      if (Object.entries(r.permisos).some(([p, n]) => n !== 'denegado' && actor.niveles[p] !== 'permitido'))
        return { status: 403, error: `No podés otorgar el rol "${r.nombre}": tiene permisos que vos no tenés.` };
  }
  return { ids: elegidos.map((r) => r.id), rol: elegidos.some((r) => r.codigo === 'administrador') ? 'admin' : 'empleado' };
};

// El PIN y la tarjeta son únicos en la instancia (Usuarios RN02, EX05); el índice UNIQUE lo
// garantiza aunque dos altas lleguen a la vez, y acá se traduce el error a un mensaje.
const mensajeDuplicado = (err) => {
  if (err.code !== 'ER_DUP_ENTRY') return null;
  if (err.message.includes('uq_users_pin')) return 'Ese PIN ya lo usa otro usuario. Elegí otro.';
  if (err.message.includes('uq_users_tarjeta')) return 'Esa tarjeta ya está asignada a otro usuario.';
  return 'Ya existe un usuario con ese nombre de acceso.';
};

// Siempre tiene que quedar al menos un Administrador activo y sin baja programada (Usuarios RN06).
// `despues` es cómo quedaría el usuario tras el cambio.
const dejaSinAdmin = async (antes, despues) => {
  const eraAdmin = antes.rol === 'admin' && antes.activo && !antes.fecha_baja;
  const sigue = despues.rol === 'admin' && despues.activo && !despues.fecha_baja;
  return eraAdmin && !sigue && (await User.contarAdminsPermanentes(antes.id)) === 0;
};

const listar = async (req, res) => {
  try {
    res.json(await User.listar());
  } catch (err) {
    falla500(req, res, err);
  }
};

const crear = async (req, res) => {
  try {
    const { errores, datos } = await validar(req.body, { alta: true });
    if (errores.length) return res.status(400).json({ errores });

    // RN07: quien no es Administrador no puede crear Administradores ni darles permisos que no tiene.
    const actor = await permisosDe(req);
    const rolIds = await rolesParaAlta(req.body, datos, actor);
    if (rolIds.error) return res.status(rolIds.status).json({ error: rolIds.error });
    datos.rol = rolIds.rol;

    const id = await User.crear({ ...datos, password_hash: await bcrypt.hash(datos.password, 10) });
    await Permiso.guardarAccesos(id, { rolIds: rolIds.ids });
    await auditar(req, { modulo: 'usuarios', accion: 'crear', entidad: 'usuario', entidad_id: id, valor_nuevo: { ...datos, password: undefined } });
    res.status(201).json({ id, message: 'Usuario creado. Va a tener que cambiar la contraseña en su primer ingreso.' });
  } catch (err) {
    const msg = mensajeDuplicado(err);
    if (msg) return res.status(400).json({ error: msg });
    falla500(req, res, err);
  }
};

const actualizar = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });

  try {
    const antes = await User.getById(id);
    if (!antes) return res.status(404).json({ error: `Usuario con id ${id} no encontrado.` });

    const { errores, datos } = await validar(req.body, { alta: false });
    if (errores.length) return res.status(400).json({ errores });
    delete datos.username; // el usuario de acceso no se cambia: es lo que identifica al usuario en la auditoría
    const despues = { ...antes, ...datos };
    if (await dejaSinAdmin(antes, despues))
      return res.status(400).json({ error: 'Tiene que quedar al menos un Administrador activo y sin baja programada.' });

    // Cambiar los roles es asignar accesos (RN07): se hace en /api/roles/usuarios/:id, con sus controles.
    if (datos.rol && datos.rol !== antes.rol) {
      const actor = await permisosDe(req);
      if (!actor.esAdmin) return res.status(403).json({ error: 'Solo un Administrador cambia el rol de un usuario.' });
      await Permiso.guardarAccesos(id, { rolIds: [(await Permiso.listarRoles()).find((r) => r.codigo === (datos.rol === 'admin' ? 'administrador' : 'encargado')).id] });
    }

    await User.actualizar(id, datos);
    const cambios = Object.keys(datos).filter((k) => !/pin|tarjeta/.test(k));
    await auditar(req, { modulo: 'usuarios', accion: 'actualizar', entidad: 'usuario', entidad_id: id,
      valor_anterior: Object.fromEntries(cambios.map((k) => [k, antes[k]])), valor_nuevo: Object.fromEntries(cambios.map((k) => [k, datos[k]])),
      detalle: Object.keys(datos).some((k) => /pin|tarjeta/.test(k)) ? 'cambió PIN o tarjeta' : undefined });
    // Un cambio de rol rige desde la acción siguiente: el rol sale de la sesión, no del token.
    res.json({ message: 'Usuario actualizado.' });
  } catch (err) {
    const msg = mensajeDuplicado(err);
    if (msg) return res.status(400).json({ error: msg });
    falla500(req, res, err);
  }
};

// Los usuarios no se borran: se desactivan para conservar la trazabilidad (Usuarios RN05).
const cambiarActivo = (activo) => async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });

  try {
    const antes = await User.getById(id);
    if (!antes) return res.status(404).json({ error: `Usuario con id ${id} no encontrado.` });

    if (!activo && (await dejaSinAdmin(antes, { ...antes, activo: 0 })))
      return res.status(400).json({ error: 'Tiene que quedar al menos un Administrador activo y sin baja programada.' });

    await User.actualizar(id, { activo: activo ? 1 : 0 });
    if (!activo) await Sesion.cerrarDeUsuario(id, 'forzado');
    await auditar(req, { modulo: 'usuarios', accion: activo ? 'activar' : 'desactivar', entidad: 'usuario', entidad_id: id, valor_anterior: { activo: antes.activo }, valor_nuevo: { activo: activo ? 1 : 0 } });
    res.json({ message: activo ? 'Usuario activado.' : 'Usuario desactivado.' });
  } catch (err) {
    falla500(req, res, err);
  }
};

const desbloquear = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });
  try {
    if (!(await User.getById(id))) return res.status(404).json({ error: `Usuario con id ${id} no encontrado.` });
    await User.desbloquear(id);
    await auditar(req, { modulo: 'usuarios', accion: 'desbloquear', entidad: 'usuario', entidad_id: id });
    res.json({ message: 'Usuario desbloqueado.' });
  } catch (err) {
    falla500(req, res, err);
  }
};

// Contraseña nueva puesta por un Administrador: el usuario la cambia en su próximo ingreso y sus
// sesiones abiertas se cierran.
const resetPassword = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });

  try {
    const { password_min_largo: min = 8 } = await Parametro.todos();
    if (typeof req.body.password !== 'string' || req.body.password.length < min)
      return res.status(400).json({ error: `"password" debe tener al menos ${min} caracteres.` });
    if (!(await User.getById(id))) return res.status(404).json({ error: `Usuario con id ${id} no encontrado.` });

    await User.setPassword(id, await bcrypt.hash(req.body.password, 10), true);
    await Sesion.cerrarDeUsuario(id, 'forzado');
    await auditar(req, { modulo: 'usuarios', accion: 'restablecer_password', entidad: 'usuario', entidad_id: id });
    res.json({ message: 'Contraseña restablecida. El usuario tendrá que cambiarla al ingresar.' });
  } catch (err) {
    falla500(req, res, err);
  }
};

module.exports = {
  listar, crear, actualizar,
  desactivar: cambiarActivo(false), activar: cambiarActivo(true),
  desbloquear, resetPassword,
};
