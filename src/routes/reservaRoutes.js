const { Router } = require('express');
const Reservas = require('../services/reservaService');
const { requierePermiso } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');
const { auditar } = require('../utils/auditar');

// Reservas de mesa, lista de espera, turnos con cupo y pedidos especiales (Ventas RF43, RF44), con la función VEN-RESERVAS.
const router = Router();
const FUNCION = requiereFuncion('VEN-RESERVAS');
const OPERAR = [FUNCION, requierePermiso('ventas.pedidos.operar')];
const n = (req, p = 'id') => Number(req.params[p]);

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Reservas.ReservaInvalida) {
      const { alternativas, lista_espera, codigo, disponible } = err;
      return res.status(err.status ?? 400).json({ error: err.message, ...(codigo && { codigo }), ...(alternativas && { alternativas }), ...(lista_espera && { lista_espera }), ...(disponible !== undefined && { disponible }) });
    }
    next(err);
  }
};

// ---- Reservas ----
router.get('/', ...OPERAR, manejar(async (req, res) => res.json(await Reservas.listar(req.query))));
router.get('/plano', ...OPERAR, manejar(async (req, res) => res.json(await Reservas.plano({ salon_id: req.query.salon_id ? Number(req.query.salon_id) : undefined, desde: req.query.desde, hasta: req.query.hasta }))));
router.get('/recordatorios', ...OPERAR, manejar(async (req, res) => res.json(await Reservas.recordatoriosDebidos())));
router.post('/', ...OPERAR, manejar(async (req, res) => {
  const r = await Reservas.crear(req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'ventas', accion: 'reserva_crear', entidad: 'reserva', entidad_id: r.id_global, detalle: `${r.cliente_nombre} (${r.personas})` });
  res.status(201).json(r);
}));

// ---- Turnos con cupo y pedidos especiales (RF44) ----
router.get('/turnos', ...OPERAR, manejar(async (req, res) => res.json(await Reservas.listarTurnos(req.query))));
router.post('/turnos', ...OPERAR, manejar(async (req, res) => res.status(201).json(await Reservas.crearTurno(req.body))));
router.get('/turnos/:id', ...OPERAR, manejar(async (req, res) => { const t = await Reservas.obtenerTurno(n(req)); return t ? res.json(t) : res.status(404).json({ error: 'Turno no encontrado.' }); }));
router.post('/turnos/:id/inscripciones', ...OPERAR, manejar(async (req, res) => res.status(201).json(await Reservas.inscribir(n(req), req.body))));
router.delete('/turnos/:id/inscripciones/:inscripto', ...OPERAR, manejar(async (req, res) => res.json(await Reservas.bajaInscripcion(n(req), n(req, 'inscripto')))));
router.post('/turnos/:id/cancelar', ...OPERAR, manejar(async (req, res) => res.json(await Reservas.cancelarTurno(n(req)))));
router.get('/especiales', ...OPERAR, manejar(async (req, res) => res.json(await Reservas.listarEspeciales(req.query))));
router.post('/especiales', ...OPERAR, manejar(async (req, res) => res.status(201).json(await Reservas.crearEspecial(req.body))));
router.get('/especiales/:id', ...OPERAR, manejar(async (req, res) => { const e = await Reservas.obtenerEspecial(n(req)); return e ? res.json(e) : res.status(404).json({ error: 'Pedido especial no encontrado.' }); }));
router.post('/especiales/:id/comanda', ...OPERAR, manejar(async (req, res) => res.json(await Reservas.generarComanda(n(req), { userId: req.usuario?.sub }))));
router.post('/especiales/:id/entregar', ...OPERAR, manejar(async (req, res) => res.json(await Reservas.entregarEspecial(n(req)))));
router.post('/especiales/:id/cancelar', ...OPERAR, manejar(async (req, res) => res.json(await Reservas.cancelarEspecial(n(req)))));

router.get('/:id', ...OPERAR, manejar(async (req, res) => { const r = await Reservas.obtener(n(req)); return r ? res.json(r) : res.status(404).json({ error: 'Reserva no encontrada.' }); }));
router.put('/:id', ...OPERAR, manejar(async (req, res) => res.json(await Reservas.actualizar(n(req), req.body))));
router.post('/:id/confirmar', ...OPERAR, manejar(async (req, res) => res.json(await Reservas.confirmar(n(req)))));
router.post('/:id/cumplir', ...OPERAR, manejar(async (req, res) => res.json(await Reservas.cumplir(n(req)))));
router.post('/:id/no-presento', ...OPERAR, manejar(async (req, res) => res.json(await Reservas.noPresento(n(req)))));
router.post('/:id/cancelar', ...OPERAR, manejar(async (req, res) => {
  const r = await Reservas.cancelar(n(req), req.body.motivo);
  await auditar(req, { modulo: 'ventas', accion: 'reserva_cancelar', entidad: 'reserva', entidad_id: r.id_global, detalle: r.motivo_cancelacion });
  res.json(r);
}));
router.post('/:id/asignar', ...OPERAR, manejar(async (req, res) => res.json(await Reservas.asignarMesa(n(req), req.body))));

module.exports = router;
