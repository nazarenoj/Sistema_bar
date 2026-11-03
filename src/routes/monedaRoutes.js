const { Router } = require('express');
const Monedas = require('../servicios/monedaService');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Monedas y cotizaciones (Usuarios RF14). Consultar la lista y la cotización vigente está al alcance de cualquier usuario con sesión
// (el cobro la necesita); cargar cotizaciones y administrar monedas exige permiso (RN17).
const router = Router();

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Monedas.MonedaInvalida) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

router.get('/', manejar(async (req, res) => res.json(await Monedas.listar())));
router.post('/', requierePermiso('usuarios.gestionar'), manejar(async (req, res) => {
  const m = await Monedas.crear(req.body);
  await auditar(req, { modulo: 'monedas', accion: 'moneda_crear', entidad: 'moneda', entidad_id: m.codigo, detalle: m.nombre });
  res.status(201).json(m);
}));
router.put('/:codigo/activa', requierePermiso('usuarios.gestionar'), manejar(async (req, res) => res.json(await Monedas.activar(req.params.codigo, !!req.body.activa))));

router.get('/cotizaciones/vigente', manejar(async (req, res) => {
  const c = await Monedas.vigente(req.query.moneda, req.query.fecha);
  return c ? res.json(c) : res.status(404).json({ error: 'No hay cotización cargada para esa moneda.', codigo: 'SIN_COTIZACION' });
}));
router.get('/cotizaciones', manejar(async (req, res) => res.json(await Monedas.historial(req.query.moneda, req.query.limite))));
router.post('/cotizaciones', requierePermiso('usuarios.cotizaciones.cargar'), manejar(async (req, res) => {
  const c = await Monedas.cargar(req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'monedas', accion: 'cotizacion_cargar', entidad: 'cotizacion', entidad_id: String(c.id), detalle: `${c.moneda} ${c.comprador}/${c.vendedor}` });
  res.status(201).json(c);
}));

module.exports = router;
