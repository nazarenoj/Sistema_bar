const Modulos = require('../modulos/registro');
const { LLAMADAS } = require('../modulos/llamadas');
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

module.exports = { listar, instalar: cambiar('instalar'), desinstalar: cambiar('desinstalar') };
