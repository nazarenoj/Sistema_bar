const { Router } = require('express');
const Promos = require('../services/promocionService');
const Pedido = require('../models/pedidoModel');
const { requierePermiso, permisosDe } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');
const { auditar } = require('../utils/auditar');

// Promociones automáticas (Ventas RF36, RF37), con la función VEN-PROMOS. Crear, editar y pausar exige el permiso específico (RN18).
const router = Router();
const FUNCION = requiereFuncion('VEN-PROMOS');
const VER = [FUNCION, requierePermiso('ventas.catalogo.ver')];
const GESTIONAR = [FUNCION, requierePermiso('ventas.promociones.gestionar')];

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Promos.PromocionInvalida) return res.status(err.status ?? 400).json({ error: err.message, ...(err.codigo && { codigo: err.codigo }) });
    next(err);
  }
};

// Si la promoción deja un artículo por debajo del costo, advierte y exige la confirmación de quien tenga el permiso de Gerente (RF37, RN08).
const guardar = (id) => manejar(async (req, res) => {
  const avisos = await Promos.bajoCosto(req.body);
  if (avisos.length) {
    if (!req.body.confirmar_bajo_costo) return res.status(409).json({ error: 'La promoción deja artículos por debajo del costo. Confirmala para guardarla.', codigo: 'BAJO_COSTO', avisos });
    const { niveles } = await permisosDe(req);
    if (niveles['ventas.promociones.bajo_costo'] !== 'permitido') return res.status(403).json({ error: 'Confirmar una promoción bajo costo necesita el permiso de Gerente.', codigo: 'SIN_PERMISO', permiso: 'ventas.promociones.bajo_costo' });
  }
  const p = await Promos.guardar(id ? Number(req.params.id) : null, req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'ventas', accion: id ? 'promocion_editar' : 'promocion_crear', entidad: 'promocion', entidad_id: String(p.id), detalle: avisos.length ? `${p.nombre} (bajo costo confirmado)` : p.nombre });
  res.status(id ? 200 : 201).json({ ...p, ...(avisos.length && { avisos }) });
});

router.get('/', ...VER, manejar(async (req, res) => res.json(await Promos.listar())));
router.get('/informe', ...VER, manejar(async (req, res) => res.json(await Promos.informe(req.query))));
// Vista previa del cobro de una mesa: lo que descontarían las promociones vigentes ahora (EX24).
router.get('/simular', FUNCION, requierePermiso('ventas.cuenta.cobrar'), manejar(async (req, res) => {
  const ids = (await Pedido.getActivosByMesa(Number(req.query.mesa_id))).map((p) => p.id);
  res.json(await Promos.simular(ids, { formaPago: req.query.forma_pago ?? null }));
}));
router.get('/:id', ...VER, manejar(async (req, res) => {
  const p = await Promos.obtener(Number(req.params.id));
  return p ? res.json(p) : res.status(404).json({ error: 'Promoción no encontrada.' });
}));
router.post('/', ...GESTIONAR, guardar(false));
router.put('/:id', ...GESTIONAR, guardar(true));
router.put('/:id/pausa', ...GESTIONAR, manejar(async (req, res) => {
  const p = await Promos.pausar(Number(req.params.id), req.body.pausada !== false);
  await auditar(req, { modulo: 'ventas', accion: 'promocion_pausa', entidad: 'promocion', entidad_id: String(p.id), detalle: p.estado });
  res.json(p);
}));

router.put('/:id/solo-socios', ...GESTIONAR, manejar(async (req, res) => res.json(await Promos.soloSocios(Number(req.params.id), !!req.body.solo_socios))));

module.exports = router;
