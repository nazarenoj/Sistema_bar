const { Router } = require('express');
const Correo = require('../servicios/correoService');
const requiereFuncion = require('../middleware/requiereFuncion');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Notificaciones por correo (Usuarios RF24). Todo es del Administrador.
const router = Router();
router.use(requiereFuncion('USU-CORREO'), requierePermiso('usuarios.correo.gestionar'));

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Correo.CorreoInvalido) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

router.get('/', manejar(async (req, res) => res.json(await Correo.estado())));
router.put('/', manejar(async (req, res) => {
  const e = await Correo.configurar(req.body);
  await auditar(req, { modulo: 'correo', accion: 'configurar', entidad: 'correo', entidad_id: '1', detalle: `${e.host}:${e.puerto}, desde ${e.severidad_minima}` });
  res.json(e);
}));
router.get('/cola', manejar(async (req, res) => res.json(await Correo.cola(req.query))));
router.post('/enviar', manejar(async (req, res) => res.json(await Correo.enviarCola())));
router.post('/cola/:id/reintentar', manejar(async (req, res) => { await Correo.reintentar(Number(req.params.id)); res.json({ pendiente: true }); }));
// Prueba de envío: lo que falla se informa (a diferencia de la cola, que reintenta).
router.post('/probar', manejar(async (req, res) => {
  try { await Correo.enviarDirecto({ para: req.body.para, asunto: 'Prueba de correo del sistema', cuerpo: 'Si recibís este mensaje, las notificaciones por correo funcionan.' }); } catch (err) {
    return res.status(502).json({ error: `No se pudo enviar: ${err.message}` });
  }
  res.json({ enviado: true });
}));

module.exports = router;
