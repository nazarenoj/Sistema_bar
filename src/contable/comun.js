// Piezas comunes de Contable: el error de negocio, el redondeo y el manejador de rutas.
class ContableInvalido extends Error {}
const invalida = (mensaje, status = 400, extra = {}) => Object.assign(new ContableInvalido(mensaje), { status, ...extra });
const r2 = (x) => Math.round(Number(x ?? 0) * 100) / 100;
const cts = (x) => Math.round(Number(x ?? 0) * 100);
const pad = (n) => String(n).padStart(2, '0');
// Fecha local como AAAA-MM-DD (los períodos y las fechas de inicio son del día del comercio).
const fechaLocal = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const iso = (f) => (f instanceof Date ? fechaLocal(f) : f ? String(f).slice(0, 10) : null);
const esFecha = (f) => /^\d{4}-\d{2}-\d{2}$/.test(String(f)) && !Number.isNaN(new Date(`${f}T12:00:00`).getTime());

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof ContableInvalido) { const { status, ...extra } = err; return res.status(status ?? 400).json({ error: err.message, ...extra }); }
    next(err);
  }
};

module.exports = { ContableInvalido, invalida, r2, cts, fechaLocal, iso, esFecha, manejar };
