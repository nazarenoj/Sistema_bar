const Terminal = require('../models/terminalModel');
const Sesion = require('../models/sesionModel');
const Parametro = require('../models/parametroModel');
const logger = require('../utils/logger');
const { auditar } = require('../utils/auditar');

const TIPOS = ['venta', 'pantalla_cocina', 'dispositivo_movil', 'inventario', 'otro'];

const falla500 = (req, res, err) => {
  logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
};

const validar = (body, { alta }) => {
  const errores = [];
  const datos = {};
  const dado = (k) => body[k] !== undefined;

  if (alta || dado('nombre')) {
    if (typeof body.nombre !== 'string' || !body.nombre.trim() || body.nombre.trim().length > 60)
      errores.push('"nombre" es obligatorio (hasta 60 caracteres).');
    else datos.nombre = body.nombre.trim();
  }
  if (dado('tipo')) {
    if (!TIPOS.includes(body.tipo)) errores.push(`"tipo" debe ser uno de: ${TIPOS.join(', ')}.`);
    else datos.tipo = body.tipo;
  } else if (alta) datos.tipo = 'venta';
  if (dado('activa')) {
    if (typeof body.activa !== 'boolean') errores.push('"activa" debe ser true o false.');
    else datos.activa = body.activa ? 1 : 0;
  }
  if (dado('inactividad_min')) {
    if (body.inactividad_min !== null && (!Number.isInteger(body.inactividad_min) || body.inactividad_min < 1 || body.inactividad_min > 1440))
      errores.push('"inactividad_min" debe ser un entero entre 1 y 1440, o null para usar el del rol.');
    else datos.inactividad_min = body.inactividad_min;
  }
  return { errores, datos };
};

const mensajeDuplicado = (err) => (err.code === 'ER_DUP_ENTRY' ? 'Ya existe una terminal con ese nombre.' : null);

// Estado de conexión según el último contacto: la pantalla manda un latido cada pocos segundos.
const listar = async (req, res) => {
  try {
    const { terminal_sin_contacto_seg: limite = 90 } = await Parametro.todos();
    const filas = await Terminal.listar();
    res.json(filas.map((t) => ({
      ...t,
      estado_conexion: t.segundos_sin_contacto !== null && t.segundos_sin_contacto <= limite ? 'en_linea' : 'sin_conexion',
    })));
  } catch (err) {
    falla500(req, res, err);
  }
};

const crear = async (req, res) => {
  try {
    const { errores, datos } = validar(req.body, { alta: true });
    if (errores.length) return res.status(400).json({ errores });
    const { id, codigo } = await Terminal.crear(datos);
    await auditar(req, { modulo: 'terminales', accion: 'crear', entidad: 'terminal', entidad_id: id, valor_nuevo: datos });
    res.status(201).json({ id, codigo, message: 'Terminal creada. Cargá el código en el equipo desde la pantalla de ingreso.' });
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
    const antes = await Terminal.getById(id);
    if (!antes) return res.status(404).json({ error: `Terminal con id ${id} no encontrada.` });
    const { errores, datos } = validar(req.body, { alta: false });
    if (errores.length) return res.status(400).json({ errores });
    await Terminal.actualizar(id, datos);
    await auditar(req, { modulo: 'terminales', accion: 'actualizar', entidad: 'terminal', entidad_id: id,
      valor_anterior: Object.fromEntries(Object.keys(datos).map((k) => [k, antes[k]])), valor_nuevo: datos });
    res.json({ message: 'Terminal actualizada.' });
  } catch (err) {
    const msg = mensajeDuplicado(err);
    if (msg) return res.status(400).json({ error: msg });
    falla500(req, res, err);
  }
};

// Latido de la pantalla: marca el contacto de la terminal de la sesión. Va por requireAuth.pasivo,
// o sea que no cuenta como actividad del usuario.
const ping = async (req, res) => {
  try {
    if (req.usuario.terminal_id) await Terminal.tocar(req.usuario.terminal_id);
    res.json({ ok: true });
  } catch (err) {
    falla500(req, res, err);
  }
};

// Sesiones abiertas (Usuarios RF06): el Administrador las ve y puede cerrarlas.
const sesiones = async (req, res) => {
  try {
    res.json(await Sesion.listarActivas());
  } catch (err) {
    falla500(req, res, err);
  }
};

const cerrarSesion = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });
  try {
    const cerradas = await Sesion.cerrar(id, 'forzado');
    if (!cerradas) return res.status(404).json({ error: 'La sesión no existe o ya estaba cerrada.' });
    await auditar(req, { modulo: 'sesiones', accion: 'cierre_forzado', entidad: 'sesion', entidad_id: id });
    res.json({ message: 'Sesión cerrada.' });
  } catch (err) {
    falla500(req, res, err);
  }
};

module.exports = { listar, crear, actualizar, ping, sesiones, cerrarSesion };
