const Auditoria = require('../models/auditoriaModel');
const logger = require('./logger');

// Datos de quién hizo la acción, sacados de la request.
const actorDe = (req) => ({
  id: req.usuario?.sub, username: req.usuario?.username, rol: req.usuario?.rol,
  terminal_id: req.usuario?.terminal_id, ip: req.ip,
});

// Registra un evento de auditoría. Una falla al auditar se informa en el log y no frena la
// operación del usuario.
// shortcut: la operación sigue aunque el evento no se grabe; cuando exista la bandeja de salida
// (A10), el evento pendiente debería quedar ahí para reintentarlo.
const auditar = async (req, evento, actor) => {
  try {
    await Auditoria.registrar({ ...evento, actor: actor || actorDe(req) });
  } catch (err) {
    logger.error(`[auditoria] no se pudo registrar ${evento.modulo}.${evento.accion}: ${err.message}`);
  }
};

module.exports = { auditar, actorDe };
