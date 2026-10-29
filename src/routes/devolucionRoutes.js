const { Router } = require('express');
const Devolucion = require('../services/devolucionService');
const Venta = require('../services/ventaService');
const { requierePermiso, validarAutorizacion } = require('../middleware/requierePermiso');

const router = Router();

// Anula o devuelve una venta, total o parcialmente (Ventas RF15, RF49).
// Cuerpo: venta_id_global, motivo, items [{ linea, cantidad }] o todo: true (anulación), reingreso ('reingreso' | 'merma'),
// reintegro [{ forma, importe }] (opcional: por defecto, el reparto original). Un reintegro con una forma distinta de las
// originales exige la autorización de un supervisor (RN76).
router.post('/', requierePermiso('ventas.devoluciones.crear'), async (req, res, next) => {
  const { venta_id_global: id, items, todo, motivo, reingreso, reintegro } = req.body;
  if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'Falta "venta_id_global".' });
  try {
    const venta = await Venta.obtener(id);
    if (!venta) return res.status(404).json({ error: 'Venta no encontrada.' });
    let autorizadoPor = req.autorizadoPor?.id ?? null;
    if (await Devolucion.necesitaAutorizacion(venta, reintegro)) {
      const a = await validarAutorizacion(req, 'ventas.devoluciones.crear');
      if (!a.ok) return res.status(a.status).json({ error: 'Devolver con otra forma de pago exige la autorización de un supervisor.', codigo: a.codigo });
      autorizadoPor = a.supervisor.id;
    }
    const r = await Devolucion.devolver(id, { items, todo: todo === true, motivo, reingreso, reintegro },
      { idSolicitud: req.get('X-ID-Solicitud'), userId: req.usuario?.sub, autorizadoPor });
    res.status(201).json(r);
  } catch (err) {
    if (err instanceof Devolucion.DevolucionInvalida) return res.status(err.status || 400).json({ error: err.message, codigo: 'DEVOLUCION_INVALIDA' });
    next(err);
  }
});

router.get('/', requierePermiso('ventas.historial.ver'), async (req, res, next) => {
  if (typeof req.query.venta !== 'string') return res.status(400).json({ error: 'Falta "venta" (ID_Global de la venta).' });
  try { res.json(await Devolucion.listar(req.query.venta)); } catch (err) { next(err); }
});

module.exports = router;
