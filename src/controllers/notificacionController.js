const Notificacion = require('../models/notificacionModel');
const { permisosDe } = require('../middleware/requierePermiso');
const logger = require('../utils/logger');

const falla500 = (req, res, err) => {
  logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
};

// Cada persona ve las alertas dirigidas a alguno de sus roles; el Administrador ve todas.
const destinoDe = async (req) => {
  const p = await permisosDe(req);
  return { roles: p.roles, esAdmin: p.esAdmin };
};

const listar = async (req, res) => {
  try {
    const destino = await destinoDe(req);
    res.json({ nuevas: await Notificacion.contarNuevas(destino), notificaciones: await Notificacion.listarPara(destino, { estado: req.query.estado }) });
  } catch (err) {
    falla500(req, res, err);
  }
};

const marcar = (estado) => async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un entero válido.' });
  try {
    const destino = await destinoDe(req);
    // Solo se puede tocar lo que a la persona le corresponde ver.
    const visibles = await Notificacion.listarPara(destino, { limite: 200 });
    if (!visibles.some((n) => n.id === id)) return res.status(404).json({ error: 'La notificación no existe.' });
    await Notificacion.marcar(id, estado);
    res.json({ message: 'Listo.' });
  } catch (err) {
    falla500(req, res, err);
  }
};

module.exports = { listar, leida: marcar('leida'), resuelta: marcar('resuelta') };
