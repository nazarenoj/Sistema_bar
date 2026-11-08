const { Router } = require('express');
const Reservas = require('../ventas_online/reservaTiendaService');
const { TiendaInvalida } = require('../ventas_online/tiendaService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Reservas de mesa, turnos y encargos desde la tienda (Ventas Online RF20). Un router público (con el enlace del correo) y uno administrativo.
const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof TiendaInvalida) { const { status, ...extra } = err; return res.status(status ?? 400).json({ error: err.message, ...extra }); }
    next(err);
  }
};

const publico = Router({ mergeParams: true });
publico.get('/reservas/cupos', manejar(async (req, res) => res.json(await Reservas.cupos())));
publico.post('/reservas/mesa', manejar(async (req, res) => res.status(201).json(await Reservas.reservarMesa(req.body ?? {}))));
publico.post('/reservas/turnos/:id', manejar(async (req, res) => res.status(201).json(await Reservas.reservarTurno(Number(req.params.id), req.body ?? {}))));
publico.post('/reservas/encargos', manejar(async (req, res) => res.status(201).json(await Reservas.encargar(req.body ?? {}))));
publico.get('/reservas/:token', manejar(async (req, res) => res.json(await Reservas.consultar(req.params.token))));
publico.delete('/reservas/:token', manejar(async (req, res) => res.json(await Reservas.cancelar(req.params.token))));

const admin = Router();
admin.use(requiereModulo('ventas_online'));
const GESTIONAR = requierePermiso('ventas_online.reservas.gestionar');
admin.get('/reservas-tienda', GESTIONAR, manejar(async (req, res) => res.json(await Reservas.listar({ estado: req.query.estado }))));
admin.post('/reservas-tienda/:id/confirmar', GESTIONAR, manejar(async (req, res) => {
  const r = await Reservas.confirmar(Number(req.params.id));
  await auditar(req, { modulo: 'ventas_online', accion: 'confirmar_reserva', entidad: 'onl_reservas', entidad_id: String(r.id), detalle: r.tipo });
  res.json(r);
}));
admin.put('/reservas-tienda/configuracion', GESTIONAR, manejar(async (req, res) => res.json(await Reservas.configurar(req.body ?? {}))));
admin.put('/catalogo/:id/encargo', GESTIONAR, manejar(async (req, res) => res.json(await Reservas.configurarEncargo(Number(req.params.id), req.body ?? {}))));

module.exports = { publico, admin };
