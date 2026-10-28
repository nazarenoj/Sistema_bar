const { permisosDe } = require('./requierePermiso');
const { auditar } = require('../utils/auditar');

// Acciones exclusivas del rol Administrador que no se pueden asignar a otros (Usuarios RN24):
// activar o desactivar funcionalidades e instalar módulos. Por eso no están en el catálogo de permisos.
module.exports = async (req, res, next) => {
  try {
    if ((await permisosDe(req)).esAdmin) return next();
    await auditar(req, { modulo: 'permisos', accion: 'acceso_denegado', resultado: 'denegado', entidad: 'ruta', entidad_id: req.baseUrl, detalle: `${req.method} ${req.originalUrl.split('?')[0]}` });
    res.status(403).json({ error: 'Solo un Administrador puede hacer esto.', codigo: 'SIN_PERMISO' });
  } catch (err) {
    next(err);
  }
};
