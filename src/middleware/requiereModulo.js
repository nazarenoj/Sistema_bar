const Modulos = require('../modulos/registro');

// Las rutas de un módulo opcional responden 409 si el módulo no está instalado en la instancia.
module.exports = (codigo) => async (req, res, next) => {
  try {
    if (await Modulos.estaInstalado(codigo)) return next();
    res.status(409).json({ error: `El módulo ${codigo} no está instalado.`, codigo: 'MODULO_NO_INSTALADO', modulo: codigo });
  } catch (err) { next(err); }
};
