const Modulos = require('../modulos/registro');
const { LLAMADAS } = require('../modulos/llamadas');
const Desinstalacion = require('../modulos/desinstalacion');
const { auditar } = require('../utils/auditar');
const logger = require('../utils/logger');

const falla500 = (req, res, err) => {
  logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
};

const listar = async (req, res) => {
  try {
    res.json({ modulos: await Modulos.listar(), llamadas: LLAMADAS });
  } catch (err) {
    falla500(req, res, err);
  }
};

// Instalar o desinstalar un módulo es exclusivo del Administrador (se controla en la ruta).
const cambiar = (accion) => async (req, res) => {
  try {
    const r = await Modulos[accion](req.params.codigo, undefined, { id: req.usuario.sub, username: req.usuario.username });
    await auditar(req, {
      modulo: 'modulos', accion, resultado: r.ok ? 'ok' : 'denegado', entidad: 'modulo', entidad_id: req.params.codigo,
      detalle: r.problemas.join(' '),
    });
    if (!r.ok) return res.status(400).json({ error: r.problemas.join(' '), problemas: r.problemas });
    res.json({ message: accion === 'instalar' ? 'Módulo instalado.' : 'Módulo desinstalado. Sus datos y permisos se conservan.' });
  } catch (err) {
    falla500(req, res, err);
  }
};

// Desinstalación por etapas (RN87): inicia, intenta completar y, si quedan operaciones sin resolver, el módulo queda "En desinstalación" (EX59).
const actorDe = (req) => ({ id: req.usuario.sub, username: req.usuario.username });
const manejar = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Desinstalacion.DesinstalacionInvalida) return res.status(err.status ?? 400).json({ error: err.message, problemas: err.problemas });
    falla500(req, res, err);
  }
};
const desinstalar = manejar(async (req, res) => {
  const codigo = req.params.codigo;
  try {
    await Desinstalacion.iniciar(codigo, actorDe(req));
  } catch (err) {
    if (err instanceof Desinstalacion.DesinstalacionInvalida) await auditar(req, { modulo: 'modulos', accion: 'desinstalar', resultado: 'denegado', entidad: 'modulo', entidad_id: codigo, detalle: err.message });
    throw err;
  }
  try {
    await Desinstalacion.completar(codigo, actorDe(req));
  } catch (err) {
    if (err instanceof Desinstalacion.DesinstalacionInvalida && err.status === 409 && err.problemas) {
      await auditar(req, { modulo: 'modulos', accion: 'desinstalar_iniciar', entidad: 'modulo', entidad_id: codigo });
      return res.status(202).json({ message: 'El módulo quedó en desinstalación: faltan operaciones por resolver.', estado: 'en_desinstalacion', pendientes: err.problemas });
    }
    throw err;
  }
  await auditar(req, { modulo: 'modulos', accion: 'desinstalar', entidad: 'modulo', entidad_id: codigo });
  res.json({ message: 'Módulo desinstalado. Sus datos y permisos se conservan.' });
});
const estadoDesinstalacion = manejar(async (req, res) => res.json(await Desinstalacion.estado(req.params.codigo)));
const completarDesinstalacion = manejar(async (req, res) => {
  const r = await Desinstalacion.completar(req.params.codigo, actorDe(req));
  await auditar(req, { modulo: 'modulos', accion: 'desinstalar', entidad: 'modulo', entidad_id: req.params.codigo });
  res.json(r);
});
const cancelarDesinstalacion = manejar(async (req, res) => {
  const r = await Desinstalacion.cancelar(req.params.codigo);
  await auditar(req, { modulo: 'modulos', accion: 'desinstalar_cancelar', entidad: 'modulo', entidad_id: req.params.codigo });
  res.json(r);
});

module.exports = { listar, instalar: cambiar('instalar'), desinstalar, estadoDesinstalacion, completarDesinstalacion, cancelarDesinstalacion };
