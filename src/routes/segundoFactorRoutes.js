const { Router } = require('express');
const SF = require('../servicios/segundoFactorService');
const User = require('../models/userModel');
const requiereFuncion = require('../middleware/requiereFuncion');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Segundo factor (Usuarios RF21). Cada usuario enlaza el suyo; restablecer el de otro y elegir los roles exigidos requiere permiso.
const router = Router();
router.use(requiereFuncion('USU-2FA'));

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof SF.SegundoFactorInvalido) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};
const yo = (req) => User.getById(req.usuario.sub);

router.get('/', manejar(async (req, res) => res.json(await SF.estado(await yo(req)))));
router.post('/iniciar', manejar(async (req, res) => res.json(await SF.iniciar(await yo(req)))));
router.post('/confirmar', manejar(async (req, res) => {
  const r = await SF.confirmar(await yo(req), req.body.codigo);
  await auditar(req, { modulo: 'sesiones', accion: '2fa_enlazar', entidad: 'usuario', entidad_id: String(req.usuario.sub) });
  res.json(r);
}));
router.get('/roles', requierePermiso('usuarios.roles.gestionar'), manejar(async (req, res) => res.json(await SF.rolesExigidos())));
router.put('/roles', requierePermiso('usuarios.roles.gestionar'), manejar(async (req, res) => {
  const r = await SF.configurarRoles(req.body.roles);
  await auditar(req, { modulo: 'sesiones', accion: '2fa_roles', entidad: 'configuracion', entidad_id: '1', detalle: r.join(',') });
  res.json(r);
}));
// EX27: lo hace otro Administrador (no sobre sí mismo); queda auditado.
router.delete('/usuarios/:id', requierePermiso('usuarios.gestionar'), manejar(async (req, res) => {
  if (Number(req.params.id) === req.usuario.sub) return res.status(409).json({ error: 'No podés restablecer tu propio segundo factor: pedíselo a otro Administrador o ingresá con un código de recuperación.' });
  await SF.restablecer(Number(req.params.id));
  await auditar(req, { modulo: 'sesiones', accion: '2fa_restablecer', entidad: 'usuario', entidad_id: req.params.id });
  res.json({ restablecido: true });
}));

module.exports = router;
