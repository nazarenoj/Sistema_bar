const { Router } = require('express');
const Clientes = require('../clientes/clienteService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Maestro de clientes (Clientes y CC RF01, RF18, RF21). Los datos personales solo los ve quien tiene permiso (RN17).
const router = Router();
router.use(requiereModulo('clientes'));
const VER = requierePermiso('clientes.ver');
const EDITAR = requierePermiso('clientes.editar');

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Clientes.ClienteInvalido) return res.status(err.status ?? 400).json({ error: err.message, codigo: err.codigo, ...(err.cliente && { cliente: err.cliente }), ...(err.resultante && { resultante: err.resultante }) });
    next(err);
  }
};

router.get('/', VER, manejar(async (req, res) => res.json(await Clientes.buscar(req.query.q, { limite: req.query.limite }))));
router.get('/:id', VER, manejar(async (req, res) => res.json(await Clientes.obtener(Number(req.params.id)))));
router.post('/', EDITAR, manejar(async (req, res) => {
  const c = await Clientes.crear(req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'clientes', accion: 'alta', entidad: 'cliente', entidad_id: String(c.id), detalle: `${c.tipo_documento} ${c.nro_documento}` });
  res.status(201).json(c);
}));
router.put('/:id', EDITAR, manejar(async (req, res) => {
  const c = await Clientes.actualizar(Number(req.params.id), req.body);
  await auditar(req, { modulo: 'clientes', accion: 'modificacion', entidad: 'cliente', entidad_id: String(c.id) });
  res.json(c);
}));
router.post('/:id/activar', EDITAR, manejar(async (req, res) => res.json(await Clientes.cambiarEstado(Number(req.params.id), true))));
router.post('/:id/desactivar', EDITAR, manejar(async (req, res) => {
  const c = await Clientes.cambiarEstado(Number(req.params.id), false);
  await auditar(req, { modulo: 'clientes', accion: 'desactivar', entidad: 'cliente', entidad_id: String(c.id) });
  res.json(c);
}));
router.post('/:id/verificar-arca', EDITAR, manejar(async (req, res) => res.json(await Clientes.verificarArca(Number(req.params.id)))));
router.post('/:id/domicilios', EDITAR, manejar(async (req, res) => res.status(201).json(await Clientes.domicilio(Number(req.params.id), req.body))));
router.delete('/:id/domicilios/:domId', EDITAR, manejar(async (req, res) => res.json(await Clientes.quitarDomicilio(Number(req.params.id), Number(req.params.domId)))));
router.post('/unificar', requierePermiso('clientes.unificar'), manejar(async (req, res) => {
  const c = await Clientes.unificar(req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'clientes', accion: 'unificar', entidad: 'cliente', entidad_id: String(c.id), detalle: `absorbe ${req.body.absorbido_id}: ${req.body.motivo}` });
  res.json(c);
}));

module.exports = router;
