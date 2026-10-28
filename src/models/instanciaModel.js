const pool = require('../config/db');
const registro = require('../instancias/registro');

// Datos de la instancia (tabla configuracion_instancia, una sola fila). Se leen seguido (cada
// ID_Global), así que se guardan en memoria; cambian solo en el alta.
const cache = new Map(); // codigo de registro -> fila

const get = async () => {
  const { codigo } = registro.actual();
  if (!cache.has(codigo)) {
    const [rows] = await pool.query('SELECT * FROM configuracion_instancia WHERE id = 1');
    if (!rows[0]) return null; // sin alta todavía: no se guarda para volver a mirar
    cache.set(codigo, rows[0]);
  }
  return cache.get(codigo);
};

// Código que prefija los ID_Global. Una instancia sin dar de alta no puede crear documentos.
const codigo = async () => {
  const fila = await get();
  if (!fila) throw new Error('La instancia no está dada de alta (falta configuracion_instancia). Correr npm run alta.');
  return fila.codigo_instancia;
};

module.exports = { get, codigo };
