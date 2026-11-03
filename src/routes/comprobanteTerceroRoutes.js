const { Router } = require('express');
const Claves = require('../servicios/comprobanteTerceroService');
const { requierePermiso, permisosDe } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Identificación de comprobantes de terceros (Usuarios RF27). Servicio de plataforma, siempre vigente: lo usan los módulos al registrar un
// comprobante; estas rutas sirven para consultarlo, probar una clave y administrar vínculos y anulaciones.
const router = Router();

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Claves.ClaveInvalida) return res.status(err.status ?? 400).json({ error: err.message, campo: err.campo, codigo: err.codigo });
    next(err);
  }
};

router.post('/normalizar', manejar(async (req, res) => res.json(Claves.normalizar(req.body))));
router.get('/', requierePermiso('usuarios.gestionar'), manejar(async (req, res) => res.json(await Claves.listar(req.query))));
router.get('/:id', requierePermiso('usuarios.gestionar'), manejar(async (req, res) => res.json(await Claves.obtener(req.params.id))));

// Reservar a mano (sirve para cargar un comprobante antes de que el módulo exista; la reserva vence sola a los 15 minutos).
router.post('/reservar', manejar(async (req, res) => {
  const { confirmar, id_clave: idClave, ...datos } = req.body;
  if (confirmar) {
    const p = await permisosDe(req);
    if (!p.esAdmin && p.niveles['usuarios.comprobantes.confirmar_casi_duplicado'] !== 'permitido') return res.status(403).json({ error: 'No tenés permiso para confirmar un casi duplicado.', codigo: 'PERMISO' });
    await auditar(req, { modulo: 'comprobantes', accion: 'confirmar_casi_duplicado', entidad: 'comprobante', entidad_id: '-', detalle: String(confirmar.motivo ?? '').slice(0, 200) });
  }
  const r = await Claves.reservar(datos, { modulo: req.body.modulo ?? 'usuarios', userId: req.usuario?.sub, terminal: req.usuario?.terminal_id ? String(req.usuario.terminal_id) : null,
    idSolicitud: req.get('X-ID-Solicitud') || null, idClave, confirmar });
  res.status(['reservada', 'vinculable'].includes(r.estado) ? 201 : 409).json(r);
}));

router.post('/vincular-remito', requierePermiso('usuarios.gestionar'), manejar(async (req, res) => res.json(await Claves.vincularRemito(req.body))));
router.post('/:id/vincular', requierePermiso('usuarios.gestionar'), manejar(async (req, res) => res.json(await Claves.vincular({ ...req.body, id_clave: Number(req.params.id), userId: req.usuario?.sub }))));
router.post('/anular', requierePermiso('usuarios.gestionar'), manejar(async (req, res) => res.json(await Claves.anular(req.body))));
router.post('/:id/cuit', requierePermiso('usuarios.gestionar'), manejar(async (req, res) => res.json(await Claves.informarCuit(Number(req.params.id), req.body.cuit))));

module.exports = router;
