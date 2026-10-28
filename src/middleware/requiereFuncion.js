const Funciones = require('../funciones/servicio');

// Bloquea las operaciones nuevas de una función desactivada (RN26). Los documentos que ya estaban
// abiertos se terminan con su instantánea, no con este control.
module.exports = (id) => async (req, res, next) => {
  try {
    if (await Funciones.estaActiva(id)) return next();
    res.status(409).json({ error: `La función ${id} está desactivada.`, codigo: 'FUNCION_DESACTIVADA', funcion: id });
  } catch (err) {
    next(err);
  }
};
