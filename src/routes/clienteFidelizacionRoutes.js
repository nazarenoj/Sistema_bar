const { Router } = require('express');
const F = require('../clientes/fidelizacionService');
const requiereModulo = require('../middleware/requiereModulo');
const requiereFuncion = require('../middleware/requiereFuncion');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Fidelización, gift cards, saldo a favor y vales (Clientes y CC RF22 a RF24, RF31). Configurar el programa, ajustar saldos, anular y reactivar instrumentos requieren
// permiso y quedan auditados con usuario, fecha y motivo (RN28). Los saldos pertenecen a esta instancia (RN26).
const router = Router();
router.use(requiereModulo('clientes'), requiereFuncion('CLI-FIDEL'));
const VER = requierePermiso('clientes.ver');
const CONFIGURAR = requierePermiso('clientes.fidelizacion.configurar');
const GESTIONAR = requierePermiso('clientes.fidelizacion.gestionar');

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof F.FidelizacionInvalida) { const { status, message, ...resto } = err; return res.status(status ?? 400).json({ error: message, ...resto }); }
    next(err);
  }
};

router.get('/programa', VER, manejar(async (req, res) => res.json({ ...(await F.programa()), vigente: await F.vigente(), reglas: await F.reglas() })));
router.put('/programa', CONFIGURAR, manejar(async (req, res) => {
  const p = await F.configurarPrograma(req.body);
  await auditar(req, { modulo: 'clientes', accion: 'programa_fidelizacion', entidad: 'programa', entidad_id: '1', detalle: `estado ${p.estado}` });
  res.json(p);
}));
router.post('/reglas', CONFIGURAR, manejar(async (req, res) => {
  const r = await F.crearRegla(req.body);
  await auditar(req, { modulo: 'clientes', accion: 'regla_sellos', entidad: 'regla', entidad_id: String(r.id), detalle: r.nombre });
  res.status(201).json(r);
}));
router.put('/reglas/:id/activa', CONFIGURAR, manejar(async (req, res) => res.json(await F.activarRegla(Number(req.params.id), !!req.body.activa))));

router.get('/identificar', requierePermiso('ventas.cuenta.cobrar'), manejar(async (req, res) => res.json(await F.identificar(req.query.q))));
router.post('/socios', requierePermiso('clientes.editar'), manejar(async (req, res) => {
  const s = await F.adherir(Number(req.body.cliente_id), req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'clientes', accion: 'adhesion_socio', entidad: 'cliente', entidad_id: String(s.cliente_id), detalle: 'con consentimiento' });
  res.status(201).json(s);
}));
router.post('/socios/alta-rapida', requierePermiso('ventas.cuenta.cobrar'), manejar(async (req, res) => {
  const s = await F.altaRapida(req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'clientes', accion: 'alta_rapida_socio', entidad: 'cliente', entidad_id: String(s.cliente_id) });
  res.status(201).json(s);
}));
router.get('/socios/:clienteId', requierePermiso('ventas.cuenta.cobrar'), manejar(async (req, res) => res.json(await F.socio(Number(req.params.clienteId)))));
router.delete('/socios/:clienteId', requierePermiso('clientes.editar'), manejar(async (req, res) => {
  const s = await F.baja(Number(req.params.clienteId));
  await auditar(req, { modulo: 'clientes', accion: 'baja_socio', entidad: 'cliente', entidad_id: String(s.cliente_id) });
  res.json(s);
}));
router.post('/socios/:clienteId/ajustes', GESTIONAR, manejar(async (req, res) => {
  const s = await F.ajustar(Number(req.params.clienteId), req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'clientes', accion: 'ajuste_fidelizacion', entidad: 'cliente', entidad_id: String(s.cliente_id), detalle: `${req.body.tipo} ${req.body.cantidad}: ${req.body.motivo}` });
  res.json(s);
}));
router.get('/premio', requierePermiso('ventas.cuenta.cobrar'), manejar(async (req, res) => res.json(await F.premio(Number(req.query.cliente_id), Number(req.query.regla_id)))));

router.get('/consulta', requierePermiso('ventas.cuenta.cobrar'), manejar(async (req, res) => res.json(await F.consultar({ codigo: req.query.codigo, q: req.query.q }))));
router.get('/instrumentos', VER, manejar(async (req, res) => res.json(await F.instrumentos(req.query))));
router.post('/saldo-favor', GESTIONAR, manejar(async (req, res) => {
  const r = await F.recargarSaldo(req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'clientes', accion: 'saldo_a_favor', entidad: 'instrumento', entidad_id: r[0].codigo, detalle: `${req.body.importe}: ${req.body.motivo}` });
  res.status(201).json(r[0]);
}));
router.post('/instrumentos/:id/anular', GESTIONAR, manejar(async (req, res) => {
  const i = await F.anular(Number(req.params.id), req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'clientes', accion: 'anular_instrumento', entidad: 'instrumento', entidad_id: i.codigo, detalle: req.body.motivo });
  res.json(i);
}));
router.post('/instrumentos/:id/reactivar', GESTIONAR, manejar(async (req, res) => {
  const i = await F.reactivar(Number(req.params.id), req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'clientes', accion: 'reactivar_instrumento', entidad: 'instrumento', entidad_id: i.codigo, detalle: req.body.motivo });
  res.json(i);
}));

// Retención del saldo para un canje (reservar, confirmar y vencer): con clave de solicitud por intento.
router.post('/retenciones', requierePermiso('ventas.cuenta.cobrar'), manejar(async (req, res) => res.json(await F.retener({ ...req.body, idSolicitud: req.get('X-ID-Solicitud') || req.body.idSolicitud }))));
router.delete('/retenciones/:id', requierePermiso('ventas.cuenta.cobrar'), manejar(async (req, res) => res.json({ liberadas: await F.liberar(req.params.id) })));
router.post('/retenciones/:id/renovar', requierePermiso('ventas.cuenta.cobrar'), manejar(async (req, res) => res.json(await F.renovar(req.params.id))));

router.get('/informes', VER, manejar(async (req, res) => res.json(await F.informes(req.query))));
router.post('/vencimientos', GESTIONAR, manejar(async (req, res) => res.json(await F.vencer())));

module.exports = router;
