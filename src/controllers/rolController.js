const Permiso = require('../models/permisoModel');
const User = require('../models/userModel');
const { PERMISOS, NIVELES, TIPOS_ALCANCE, existe } = require('../permisos/catalogo');
const { permisosDe } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const logger = require('../utils/logger');

const falla500 = (req, res, err) => {
  logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
};

const catalogo = (req, res) => res.json({ permisos: PERMISOS, niveles: NIVELES, tipos_alcance: TIPOS_ALCANCE });

const listar = async (req, res) => {
  try {
    res.json(await Permiso.listarRoles());
  } catch (err) {
    falla500(req, res, err);
  }
};

// { permiso: nivel } válido, o el mensaje de error.
const validarMapa = (mapa, { admiteNull = false } = {}) => {
  if (typeof mapa !== 'object' || mapa === null || Array.isArray(mapa)) return { error: 'Los permisos deben ser un objeto { permiso: nivel }.' };
  const limpio = {};
  for (const [p, n] of Object.entries(mapa)) {
    if (!existe(p)) return { error: `El permiso "${p}" no existe.` };
    if (n === null && admiteNull) continue; // null = quitar la excepción
    if (!NIVELES.includes(n)) return { error: `El nivel de "${p}" debe ser: ${NIVELES.join(', ')}.` };
    limpio[p] = n;
  }
  return { mapa: limpio };
};

// RN07: quien no es Administrador no puede otorgar permisos que él no tiene.
const excedeLoPropio = (actor, mapa) =>
  !actor.esAdmin && Object.entries(mapa).some(([p, n]) => n !== 'denegado' && actor.niveles[p] !== 'permitido');

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

const crear = async (req, res) => {
  const { nombre, descripcion, permisos = {} } = req.body;
  if (typeof nombre !== 'string' || !nombre.trim() || nombre.trim().length > 60)
    return res.status(400).json({ error: '"nombre" es obligatorio (hasta 60 caracteres).' });
  const v = validarMapa(permisos);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const actor = await permisosDe(req);
    if (excedeLoPropio(actor, v.mapa)) return res.status(403).json({ error: 'No podés otorgar permisos que vos no tenés.' });
    const codigo = slug(nombre);
    if (!codigo) return res.status(400).json({ error: '"nombre" necesita letras o números.' });
    const id = await Permiso.crearRol({ codigo, nombre: nombre.trim(), descripcion: descripcion || null, permisos: v.mapa });
    await auditar(req, { modulo: 'permisos', accion: 'crear_rol', entidad: 'rol', entidad_id: id, valor_nuevo: { nombre: nombre.trim(), permisos: v.mapa } });
    res.status(201).json({ id, message: 'Rol creado.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Ya existe un rol con ese nombre.' });
    falla500(req, res, err);
  }
};

const actualizar = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });
  try {
    const antes = await Permiso.getRol(id);
    if (!antes) return res.status(404).json({ error: `Rol con id ${id} no encontrado.` });
    if (antes.codigo === 'administrador') return res.status(400).json({ error: 'El rol Administrador no se modifica: puede todo.' });

    const datos = {};
    if (req.body.nombre !== undefined) {
      if (typeof req.body.nombre !== 'string' || !req.body.nombre.trim() || req.body.nombre.trim().length > 60)
        return res.status(400).json({ error: '"nombre" debe tener hasta 60 caracteres.' });
      datos.nombre = req.body.nombre.trim();
    }
    if (req.body.descripcion !== undefined) datos.descripcion = req.body.descripcion;
    if (req.body.permisos !== undefined) {
      const v = validarMapa(req.body.permisos);
      if (v.error) return res.status(400).json({ error: v.error });
      datos.permisos = v.mapa;
    }
    const actor = await permisosDe(req);
    if (datos.permisos && excedeLoPropio(actor, datos.permisos)) return res.status(403).json({ error: 'No podés otorgar permisos que vos no tenés.' });
    // Tampoco puede tocar un rol que él mismo tiene: sería modificar sus propios permisos (RN07).
    if (!actor.esAdmin && actor.roles.includes(antes.codigo)) return res.status(403).json({ error: 'No podés modificar un rol que vos tenés.' });

    await Permiso.actualizarRol(id, datos);
    await auditar(req, { modulo: 'permisos', accion: 'editar_rol', entidad: 'rol', entidad_id: id,
      valor_anterior: { nombre: antes.nombre, permisos: antes.permisos }, valor_nuevo: { nombre: datos.nombre ?? antes.nombre, permisos: datos.permisos ?? antes.permisos } });
    res.json({ message: 'Rol actualizado. Rige desde la próxima acción de cada usuario.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Ya existe un rol con ese nombre.' });
    falla500(req, res, err);
  }
};

const borrar = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });
  try {
    const rol = await Permiso.getRol(id);
    if (!rol) return res.status(404).json({ error: `Rol con id ${id} no encontrado.` });
    if (rol.predefinido) return res.status(400).json({ error: 'Los roles de referencia no se borran; se pueden editar.' });
    if (rol.usuarios) return res.status(400).json({ error: `El rol lo tienen ${rol.usuarios} usuario(s). Sacáselo antes de borrarlo.` });
    await Permiso.borrarRol(id);
    await auditar(req, { modulo: 'permisos', accion: 'borrar_rol', entidad: 'rol', entidad_id: id, valor_anterior: { nombre: rol.nombre, permisos: rol.permisos } });
    res.json({ message: 'Rol borrado.' });
  } catch (err) {
    falla500(req, res, err);
  }
};

const accesos = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });
  try {
    if (!(await User.getById(id))) return res.status(404).json({ error: `Usuario con id ${id} no encontrado.` });
    res.json(await Permiso.accesosDe(id));
  } catch (err) {
    falla500(req, res, err);
  }
};

// Roles, excepciones y alcances de un usuario. Reglas de RN07: nadie modifica los suyos (salvo un
// Administrador), ni otorga lo que no tiene; todo queda auditado con valor anterior y nuevo.
const guardarAccesos = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });
  const { rolIds, excepciones, alcances } = req.body;
  try {
    const objetivo = await User.getById(id);
    if (!objetivo) return res.status(404).json({ error: `Usuario con id ${id} no encontrado.` });
    const actor = await permisosDe(req);
    if (!actor.esAdmin && id === req.usuario.sub) return res.status(403).json({ error: 'No podés modificar tus propios roles ni permisos.' });

    const roles = await Permiso.listarRoles();
    const nuevo = {};
    if (rolIds !== undefined) {
      if (!Array.isArray(rolIds) || !rolIds.length || rolIds.some((r) => !roles.some((x) => x.id === r)))
        return res.status(400).json({ error: '"rolIds" debe ser una lista con al menos un rol existente.' });
      const elegidos = roles.filter((r) => rolIds.includes(r.id));
      if (!actor.esAdmin && elegidos.some((r) => r.codigo === 'administrador')) return res.status(403).json({ error: 'Solo un Administrador asigna el rol Administrador.' });
      for (const r of elegidos) if (excedeLoPropio(actor, r.permisos)) return res.status(403).json({ error: `No podés otorgar el rol "${r.nombre}": tiene permisos que vos no tenés.` });
      // RN06: no se puede dejar al sistema sin Administrador.
      const eraAdmin = objetivo.rol === 'admin' && objetivo.activo && !objetivo.fecha_baja;
      if (eraAdmin && !elegidos.some((r) => r.codigo === 'administrador') && (await User.contarAdminsPermanentes(id)) === 0)
        return res.status(400).json({ error: 'Tiene que quedar al menos un Administrador activo y sin baja programada.' });
      nuevo.rolIds = rolIds;
    }
    if (excepciones !== undefined) {
      const v = validarMapa(excepciones, { admiteNull: true });
      if (v.error) return res.status(400).json({ error: v.error });
      if (excedeLoPropio(actor, v.mapa)) return res.status(403).json({ error: 'No podés otorgar permisos que vos no tenés.' });
      nuevo.excepciones = v.mapa;
    }
    if (alcances !== undefined) {
      if (!Array.isArray(alcances) || alcances.some((a) => !TIPOS_ALCANCE.includes(a?.tipo) || (a.valor != null && String(a.valor).length > 60)))
        return res.status(400).json({ error: `"alcances" debe ser una lista de { tipo, valor } con tipo: ${TIPOS_ALCANCE.join(', ')}.` });
      nuevo.alcances = alcances;
    }

    const antes = await Permiso.accesosDe(id);
    await Permiso.guardarAccesos(id, nuevo);
    // El rol cambia desde la acción siguiente (RN09); las sesiones abiertas siguen, con los permisos nuevos.
    await auditar(req, { modulo: 'permisos', accion: 'asignar_accesos', entidad: 'usuario', entidad_id: id,
      valor_anterior: antes, valor_nuevo: { ...antes, ...nuevo }, detalle: `sobre ${objetivo.username}` });
    res.json({ message: 'Accesos actualizados.' });
  } catch (err) {
    falla500(req, res, err);
  }
};

module.exports = { catalogo, listar, crear, actualizar, borrar, accesos, guardarAccesos };
