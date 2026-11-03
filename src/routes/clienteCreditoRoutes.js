const { Router } = require('express');
const Credito = require('../clientes/creditoService');
const Cuentas = require('../clientes/cuentaService');
const requiereModulo = require('../middleware/requiereModulo');
const requiereFuncion = require('../middleware/requiereFuncion');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const pool = require('../config/db');

// Control de crédito (Clientes y CC RF12, RF13, RF26, RF27): veredicto, reserva, bloqueo y contingencias. Las terminales de Ventas lo usan por el puerto; estas
// rutas sirven para consultarlo y para administrarlo. Todo exige VEN-CC (Clientes RF12 a RF28).
const router = Router();
const BASE = [requiereModulo('clientes'), requiereFuncion('VEN-CC')]; // por ruta: este router comparte prefijo con el de cuentas y no puede cerrarle el paso
for (const m of ['get', 'post', 'put', 'delete']) { const original = router[m].bind(router); router[m] = (ruta, ...h) => original(ruta, ...BASE, ...h); }
const VER = requierePermiso('clientes.ver');

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Credito.CreditoInvalido || err instanceof Cuentas.CuentaInvalida) { const { status, message, ...resto } = err; return res.status(status ?? 400).json({ error: message, ...resto }); }
    next(err);
  }
};

router.get('/modo-credito', VER, manejar(async (req, res) => res.json({ modo: await Credito.modo(), modos: Credito.MODOS })));
router.put('/modo-credito', requierePermiso('clientes.credito.configurar'), manejar(async (req, res) => {
  const r = await Credito.configurarModo(req.body.modo);
  await auditar(req, { modulo: 'clientes', accion: 'modo_credito', entidad: 'parametro', entidad_id: 'cc_modo_credito', detalle: r.modo });
  res.json(r);
}));
router.get('/contingencias', VER, manejar(async (req, res) => res.json(await Credito.contingencias())));
router.post('/veredicto', VER, manejar(async (req, res) => res.json(await Credito.veredicto(req.body))));
router.post('/reservas', VER, manejar(async (req, res) => res.status(201).json(await Credito.reservar({ ...req.body, idSolicitud: req.get('X-ID-Solicitud') || req.body.idSolicitud }))));
router.delete('/reservas/:id', VER, manejar(async (req, res) => res.json({ liberadas: await Credito.liberar(req.params.id) })));
router.post('/reservas/:id/renovar', VER, manejar(async (req, res) => res.json(await Credito.renovar(req.params.id))));
// "Preguntar antes de reenviar" (RN39): el estado de procesamiento de una operación por su clave (Recibido / Retenido / Confirmado / Rechazado).
router.get('/operaciones/:idOperacion/estado', VER, manejar(async (req, res) => {
  const [[m]] = await pool.query('SELECT estado, retenido_por_orden, motivo_rechazo FROM mensajes_integracion WHERE id_operacion = ?', [req.params.idOperacion]);
  if (!m) return res.json({ estado: 'desconocida' });
  const estado = m.estado === 'confirmado' ? 'confirmado' : m.estado === 'rechazado' ? 'rechazado' : m.retenido_por_orden ? 'retenido' : 'recibido';
  res.json({ estado, ...(m.motivo_rechazo && { motivo: m.motivo_rechazo }) });
}));
router.get('/:id/reservas', VER, manejar(async (req, res) => res.json(await Credito.reservasDeCuenta(Number(req.params.id)))));
router.post('/:id/bloquear', requierePermiso('clientes.cuentas.bloquear'), manejar(async (req, res) => {
  const c = await Credito.bloquear(Number(req.params.id), { motivo: 'manual', detalle: req.body.motivo, userId: req.usuario?.sub });
  await auditar(req, { modulo: 'clientes', accion: 'bloquear_cuenta', entidad: 'cuenta', entidad_id: String(c.id), detalle: req.body.motivo });
  res.json(c);
}));
router.post('/:id/desbloquear', requierePermiso('clientes.cuentas.bloquear'), manejar(async (req, res) => {
  const c = await Credito.desbloquear(Number(req.params.id), { motivo: req.body.motivo, userId: req.usuario?.sub });
  await auditar(req, { modulo: 'clientes', accion: 'desbloquear_cuenta', entidad: 'cuenta', entidad_id: String(c.id), detalle: req.body.motivo });
  res.json(c);
}));
router.post('/revisar', requierePermiso('clientes.cuentas.bloquear'), manejar(async (req, res) => res.json(await Credito.revisarDiario())));

module.exports = router;
