const { Router } = require('express');
const Cuentas = require('../clientes/cuentaService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const requiereFuncion = require('../middleware/requiereFuncion');

// Cuentas corrientes de clientes (Clientes y CC RF03, RF09). Cambiar el límite, emitir notas y cerrar cuentas requieren permiso y quedan auditados (RN16).
const router = Router();
router.use(requiereModulo('clientes'));
const VER = requierePermiso('clientes.ver');
const GESTIONAR = requierePermiso('clientes.cuentas.gestionar');

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Cuentas.CuentaInvalida) { const { status, message, ...resto } = err; return res.status(status ?? 400).json({ error: message, ...resto }); }
    next(err);
  }
};

// Facturación agrupada de remitos (RF05, RF21; función CLI-FACT-AGRUPADA): la lista de trabajo de un cliente y el pedido a Ventas de UN comprobante fiscal que los agrupa
// (llamada n.º 12). La respuesta de Ventas se devuelve tal cual: diferencias a aceptar, remitos inválidos (EX36) o el comprobante emitido.
router.get('/remitos-pendientes', VER, manejar(async (req, res) => res.json(await Cuentas.remitosPendientes(Number(req.query.cliente_id)))));
router.post('/facturacion-agrupada', requierePermiso('ventas.remitos.facturar'), requiereFuncion('CLI-FACT-AGRUPADA'), manejar(async (req, res) => {
  const r = await Cuentas.facturarAgrupado(req.body, { userId: req.usuario?.sub, idSolicitud: req.get('X-ID-Solicitud') || null });
  if (r.ok && !r.previa) await auditar(req, { modulo: 'clientes', accion: 'facturacion_agrupada', entidad: 'cliente', entidad_id: String(req.body.cliente_id), detalle: `${r.remitos.length} remito(s) por ${r.total}` });
  const { status, ...cuerpo } = r;
  res.status(r.ok ? 200 : status ?? 400).json(cuerpo);
}));

router.get('/', VER, manejar(async (req, res) => res.json(await Cuentas.deCliente(Number(req.query.cliente_id)))));
router.post('/', GESTIONAR, manejar(async (req, res) => {
  const c = await Cuentas.abrir(Number(req.body.cliente_id), req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'clientes', accion: 'abrir_cuenta', entidad: 'cuenta', entidad_id: String(c.id), detalle: `límite ${c.limite_credito} ${c.moneda}` });
  res.status(201).json(c);
}));
router.get('/:id', VER, manejar(async (req, res) => res.json(await Cuentas.obtener(Number(req.params.id)))));
router.put('/:id', GESTIONAR, manejar(async (req, res) => {
  const c = await Cuentas.actualizar(Number(req.params.id), req.body);
  await auditar(req, { modulo: 'clientes', accion: 'modificar_cuenta', entidad: 'cuenta', entidad_id: String(c.id), detalle: JSON.stringify(req.body).slice(0, 200) });
  res.json(c);
}));
router.post('/:id/cerrar', GESTIONAR, manejar(async (req, res) => {
  const c = await Cuentas.cerrar(Number(req.params.id));
  await auditar(req, { modulo: 'clientes', accion: 'cerrar_cuenta', entidad: 'cuenta', entidad_id: String(c.id) });
  res.json(c);
}));
router.get('/:id/movimientos', VER, manejar(async (req, res) => res.json(await Cuentas.movimientos(Number(req.params.id), req.query))));
router.get('/:id/pendientes', VER, manejar(async (req, res) => res.json(await Cuentas.pendientes(Number(req.params.id)))));

// Notas de débito y de crédito, fiscales (por el servicio de emisión de Ventas) o internas; llevan clave de solicitud (RN39).
router.post('/:id/notas', requierePermiso('clientes.notas.emitir'), manejar(async (req, res) => {
  const n = await Cuentas.nota(Number(req.params.id), req.body, { userId: req.usuario?.sub, idSolicitud: req.get('X-ID-Solicitud') || null });
  await auditar(req, { modulo: 'clientes', accion: n.tipo === 'nd' ? 'nota_debito' : 'nota_credito', entidad: 'movimiento', entidad_id: String(n.id), detalle: `${n.importe} ${n.motivo}` });
  res.status(201).json(n);
}));
router.post('/notas/:movId/emitir', requierePermiso('clientes.notas.emitir'), manejar(async (req, res) => {
  const n = await Cuentas.emitirFiscal(Number(req.params.movId));
  res.status(n ? 200 : 502).json(n ?? { error: 'La nota sigue pendiente de emisión.' });
}));

module.exports = router;
