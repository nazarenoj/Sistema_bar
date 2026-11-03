const { Router } = require('express');
const Remitos = require('../services/remitoService');
const { requierePermiso, validarAutorizacion } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Remitos de entrega y su facturación (Ventas RF12, RF27). Un remito asignado a la cuenta pide veredicto y reserva de crédito como una venta a cuenta (RN73).
const router = Router();
const EMITIR = requierePermiso('ventas.remitos.emitir');
const FACTURAR = requierePermiso('ventas.remitos.facturar');

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Remitos.RemitoInvalido) return res.status(err.status ?? 400).json({ error: err.message, codigo: err.codigo });
    if (['CREDITO_BLOQUEADO', 'CREDITO_REQUIERE_AUTORIZACION', 'CREDITO_NO_RESPONDE', 'CLIENTE_NO_IDENTIFICADO', 'CUENTA_CORRIENTE_NO_DISPONIBLE', 'STOCK_NO_RESPONDE', 'SIN_DISPONIBLE', 'LOTE_NO_DISPONIBLE', 'SERIE_NO_DISPONIBLE'].includes(err.codigo))
      return res.status(err.status ?? 409).json({ error: err.message, codigo: err.codigo, detalle: err.detalle });
    if (err.constructor?.name === 'PagoInvalido') return res.status(400).json({ error: err.message });
    next(err);
  }
};

router.get('/', requierePermiso('ventas.historial.ver'), manejar(async (req, res) => res.json(await Remitos.listar({ cliente_id: req.query.cliente_id ? Number(req.query.cliente_id) : undefined, facturacion: req.query.facturacion, estado: req.query.estado }))));
router.post('/', EMITIR, manejar(async (req, res) => {
  const r = await Remitos.emitir(req.body, { userId: req.usuario?.sub, idSolicitud: req.get('X-ID-Solicitud') || null, autorizar: () => validarAutorizacion(req, 'ventas.credito.autorizar') });
  if (!r.ya_procesado) await auditar(req, { modulo: 'ventas', accion: 'remito', entidad: 'remito', entidad_id: r.id_global, detalle: `N° ${r.numero} por ${r.total}${r.cuenta_asignada ? ' a cuenta' : ''}` });
  res.status(r.ya_procesado ? 200 : 201).json(r);
}));
// Facturar remitos pendientes de un cliente: uno solo (factura individual) o varios con CLI-FACT-AGRUPADA. `previa: true` muestra las diferencias sin emitir.
router.post('/facturar', FACTURAR, manejar(async (req, res) => {
  const r = await Remitos.facturar(req.body, { userId: req.usuario?.sub, idSolicitud: req.get('X-ID-Solicitud') || null });
  if (r.ok && !r.previa) await auditar(req, { modulo: 'ventas', accion: 'facturar_remitos', entidad: 'factura', entidad_id: r.factura.id_global, detalle: `${r.remitos.length} remito(s) por ${r.total}` });
  const { status, ...cuerpo } = r;
  res.status(r.ok ? 200 : status ?? 400).json(cuerpo);
}));
router.get('/:id', requierePermiso('ventas.historial.ver'), manejar(async (req, res) => {
  const r = await Remitos.obtener(req.params.id);
  return r ? res.json(r) : res.status(404).json({ error: 'Remito no encontrado.' });
}));
router.post('/:id/anular', EMITIR, manejar(async (req, res) => {
  const r = await Remitos.anular(req.params.id, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'ventas', accion: 'anular_remito', entidad: 'remito', entidad_id: r.id_global });
  res.json(r);
}));

module.exports = router;
