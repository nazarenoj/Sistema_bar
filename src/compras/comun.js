// Piezas comunes de Compras: el error de negocio, el redondeo, el manejador de rutas y los permisos de lectura.
class CompraInvalida extends Error {}
const invalida = (mensaje, status = 400, extra = {}) => Object.assign(new CompraInvalida(mensaje), { status, ...extra });

const r2 = (x) => Math.round(Number(x) * 100) / 100;
const r4 = (x) => Math.round(Number(x) * 10000) / 10000;
const cts = (x) => Math.round(Number(x) * 100);
const hoy = () => new Date().toISOString().slice(0, 10);
const iso = (f) => (f instanceof Date ? f.toISOString().slice(0, 10) : f);

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof CompraInvalida) return res.status(err.status ?? 400).json({ error: err.message, ...(err.codigo && { codigo: err.codigo }), ...(err.detalle && { detalle: err.detalle }) });
    next(err);
  }
};

// ¿La persona de la request tiene la acción permitida? (para decidir qué datos mostrar, sin cortar la request).
const puede = async (req, permiso) => {
  const { permisosDe } = require('../middleware/requierePermiso');
  return (await permisosDe(req)).niveles[permiso] === 'permitido';
};

module.exports = { CompraInvalida, invalida, r2, r4, cts, hoy, iso, manejar, puede };
