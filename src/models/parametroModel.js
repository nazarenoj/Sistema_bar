const pool = require('../config/db');
const registro = require('../instancias/registro');

// Los parámetros se leen en cada request autenticado (vencimiento por inactividad), así que se
// guardan en memoria unos segundos.
// shortcut: un cambio en la tabla `parametros` tarda hasta TTL_MS en notarse; subir a un
// invalidador explícito si algún día se edita desde pantalla.
const TTL_MS = 10000;
const cachePorInstancia = new Map(); // codigo -> { valores, hasta }

const todos = async () => {
  const { codigo } = registro.actual();
  const c = cachePorInstancia.get(codigo);
  if (c && Date.now() < c.hasta) return c.valores;
  const [rows] = await pool.query('SELECT clave, valor FROM parametros');
  const valores = Object.fromEntries(rows.map((r) => [r.clave, Number(r.valor)]));
  cachePorInstancia.set(codigo, { valores, hasta: Date.now() + TTL_MS });
  return valores;
};

const invalidar = () => { cachePorInstancia.delete(registro.actual().codigo); };

module.exports = { todos, invalidar };
