require('dotenv').config();
const registro = require('../instancias/registro');

// Fachada del pool: cada llamada va a la base de la instancia de la request en curso (A1), así
// los modelos siguen haciendo `pool.query(...)` sin saber de instancias. Fuera de una request
// (scripts, arranque) usa la única instancia si hay una sola.
const enActual = () => {
  const inst = registro.actual();
  if (!inst) throw new Error('No hay instancia en contexto: la request no identificó el cliente.');
  return registro.poolDe(inst);
};

module.exports = {
  query: (...a) => enActual().query(...a),
  execute: (...a) => enActual().execute(...a),
  getConnection: () => enActual().getConnection(),
  // Crea las bases que falten y aplica las migraciones pendientes a todas las instancias.
  ensureDatabase: () => registro.migrarTodas(),
  end: () => registro.cerrarTodas(),
};
