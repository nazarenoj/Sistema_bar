// Límites de la parte pública de la tienda (Ventas Online RF01, RN56): por IP, en memoria. Hostinger corre una sola app, así que alcanza; con más de un proceso
// cada uno cuenta por su lado.
// shortcut: contadores en memoria de este proceso (se pierden al reiniciar); pasar a una tabla si algún día hay varios procesos.
const crear = ({ ventanaMs, maximo, mensaje = 'Demasiadas solicitudes. Probá de nuevo en unos minutos.' }) => {
  const cuentas = new Map(); // clave -> { n, vence }
  const limpiar = () => { const ahora = Date.now(); for (const [k, v] of cuentas) if (v.vence <= ahora) cuentas.delete(k); };
  const timer = setInterval(limpiar, Math.max(ventanaMs, 60000)); timer.unref?.();
  const permitir = (clave, tope = maximo) => {
    const ahora = Date.now(), c = cuentas.get(clave);
    if (!c || c.vence <= ahora) { cuentas.set(clave, { n: 1, vence: ahora + ventanaMs }); return { ok: true }; }
    if (c.n >= tope) return { ok: false, reintentarEnSeg: Math.ceil((c.vence - ahora) / 1000) };
    c.n += 1;
    return { ok: true };
  };
  const middleware = (obtenerTope) => async (req, res, next) => {
    try {
      const tope = typeof obtenerTope === 'function' ? await obtenerTope(req) : maximo;
      const r = permitir(`${req.params?.codigo ?? ''}|${req.ip}`, tope);
      if (r.ok) return next();
      res.set('Retry-After', String(r.reintentarEnSeg)).status(429).json({ error: mensaje, codigo: 'DEMASIADAS_SOLICITUDES' });
    } catch (err) { next(err); }
  };
  return { permitir, middleware, reiniciar: () => cuentas.clear() };
};

module.exports = { crear };
