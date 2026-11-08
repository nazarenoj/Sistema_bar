const { Router } = require('express');
const Informes = require('../ventas_online/informeService');
const { TiendaInvalida } = require('../ventas_online/tiendaService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const { enviarReporte, FORMATOS_VALIDOS } = require('../servicios/reporteService');

// Informes de la tienda con exportación (Ventas Online RF17).
const router = Router();
router.use(requiereModulo('ventas_online'));
const VER = requierePermiso('ventas_online.informes.ver');
const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof TiendaInvalida) { const { status, ...extra } = err; return res.status(status ?? 400).json({ error: err.message, ...extra }); }
    next(err);
  }
};

router.get('/informes', VER, manejar(async (req, res) => res.json(Informes.tipos())));
router.get('/informes/:tipo', VER, manejar(async (req, res) => {
  const r = await Informes.ejecutar(req.params.tipo, req.query);
  if (!req.query.formato) return res.json(r);
  if (!FORMATOS_VALIDOS.includes(req.query.formato)) return res.status(400).json({ error: `"formato" debe ser uno de: ${FORMATOS_VALIDOS.join(', ')}.` });
  await auditar(req, { modulo: 'ventas_online', accion: 'exportar_informe', entidad: 'informe_online', entidad_id: r.tipo, detalle: req.query.formato });
  await enviarReporte(res, { titulo: r.titulo, subtitulo: '', filtros: [], resumen: [{ label: 'Filas', valor: r.filas.length, tipo: 'numero' }], hojas: [{ nombre: r.titulo.slice(0, 28), columnas: r.columnas, filas: r.filas }] }, req.query.formato, `tienda-${r.tipo}`);
}));

module.exports = router;
