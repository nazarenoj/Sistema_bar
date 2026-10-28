const Mensajeria = require('../mensajeria/servicio');
const logger = require('../utils/logger');

const falla500 = (req, res, err) => {
  logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
};

const actorDe = (req) => ({ id: req.usuario.sub, username: req.usuario.username, rol: req.usuario.rol, terminal_id: req.usuario.terminal_id, ip: req.ip });
const responder = (res, r, ok = {}) => (r.ok === false ? res.status(r.status).json({ error: r.error }) : res.json({ ...ok }));

const pendientes = async (req, res) => {
  try {
    res.json(await Mensajeria.pendientes({ estado: req.query.estado || 'abierto' }));
  } catch (err) {
    falla500(req, res, err);
  }
};

const documento = async (req, res) => {
  try {
    res.json(await Mensajeria.estadoIntegracion(req.params.idGlobal));
  } catch (err) {
    falla500(req, res, err);
  }
};

const reintentar = async (req, res) => {
  try {
    responder(res, await Mensajeria.reintentar(Number(req.params.id), actorDe(req)), { message: 'Reintento en marcha.' });
  } catch (err) {
    falla500(req, res, err);
  }
};

// El descarte pasa por el permiso "requiere autorización": llega acá con el supervisor ya validado (req.autorizadoPor).
const descartar = async (req, res) => {
  try {
    responder(res, await Mensajeria.descartar(Number(req.params.id), req.body.motivo, actorDe(req), req.autorizadoPor), { message: 'Pendiente descartado.' });
  } catch (err) {
    falla500(req, res, err);
  }
};

const reenviar = async (req, res) => {
  const desde = Date.parse(req.body.desde);
  if (Number.isNaN(desde)) return res.status(400).json({ error: '"desde" debe ser una fecha válida.' });
  try {
    res.json({ reenviados: await Mensajeria.reenviarDesde(desde, actorDe(req)) });
  } catch (err) {
    falla500(req, res, err);
  }
};

const conciliar = async (req, res) => {
  try {
    res.json(await Mensajeria.conciliar('bajo_demanda', actorDe(req)));
  } catch (err) {
    falla500(req, res, err);
  }
};

module.exports = { pendientes, documento, reintentar, descartar, reenviar, conciliar };
