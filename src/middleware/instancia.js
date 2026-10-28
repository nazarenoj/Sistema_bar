const registro = require('../instancias/registro');

// Identifica el cliente de la request y ejecuta el resto de la cadena dentro de su contexto.
module.exports = (req, res, next) => {
  const inst = registro.resolver(req);
  if (!inst) return res.status(404).json({ error: 'Instancia no identificada.', codigo: 'INSTANCIA' });
  req.instancia = inst;
  registro.dentroDe(inst, next);
};
