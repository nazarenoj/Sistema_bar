const { Router } = require('express');
const Copias = require('../servicios/copiaService');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const requiereFuncion = require('../middleware/requiereFuncion');

// Copias de seguridad y restauración (Usuarios RF11, RF12). Todo exige el permiso de gestionar copias (Administrador).
const router = Router();
router.use(requierePermiso('usuarios.copias.gestionar'));

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Copias.CopiaInvalida) return res.status(err.status ?? 400).json({ error: err.message, codigo: err.codigo });
    next(err);
  }
};

router.get('/', manejar(async (req, res) => res.json({ clave_configurada: await Copias.claveConfigurada(), copias: await Copias.listar() })));
router.post('/configuracion', manejar(async (req, res) => {
  const r = await Copias.configurarClave(req.body.clave);
  await auditar(req, { modulo: 'copias', accion: 'configurar_clave', entidad: 'copias', entidad_id: '1' });
  res.json(r);
}));
router.post('/', manejar(async (req, res) => {
  const c = await Copias.generar({ tipo: 'manual', clave: req.body.clave, userId: req.usuario?.sub });
  await auditar(req, { modulo: 'copias', accion: 'generar', entidad: 'copia', entidad_id: String(c.id), detalle: c.nombre });
  res.status(201).json(c);
}));
// Destino externo (USU-NUBE, RF23): la configuración y el reenvío de lo que quedó en cola.
router.get('/destino', requiereFuncion('USU-NUBE'), manejar(async (req, res) => res.json(await Copias.destinoExterno())));
router.put('/destino', requiereFuncion('USU-NUBE'), manejar(async (req, res) => {
  const d = await Copias.configurarDestino(req.body);
  await auditar(req, { modulo: 'copias', accion: 'destino_externo', entidad: 'copias', entidad_id: '1', detalle: `${d.tipo}: ${d.ruta}` });
  res.json(d);
}));
router.post('/destino/enviar', requiereFuncion('USU-NUBE'), manejar(async (req, res) => res.json(await Copias.enviarExternas())));
router.get('/:id/detalle', manejar(async (req, res) => res.json(await Copias.detalle(req.params.id))));
router.post('/:id/verificar', manejar(async (req, res) => res.json(await Copias.verificar(req.params.id, req.body.clave))));
router.put('/:id/retener', manejar(async (req, res) => res.json(await Copias.retener(req.params.id, !!req.body.retenida))));
router.get('/:id/descargar', manejar(async (req, res) => {
  const a = await Copias.archivo(req.params.id);
  await auditar(req, { modulo: 'copias', accion: 'descargar', entidad: 'copia', entidad_id: req.params.id, detalle: a.nombre });
  res.download(a.ruta, a.nombre);
}));
router.post('/:id/restaurar', manejar(async (req, res) => {
  const r = await Copias.restaurar({ id: req.params.id, clave: req.body.clave, confirmacion: req.body.confirmacion, actor: { id: req.usuario?.sub } });
  await auditar(req, { modulo: 'copias', accion: 'restaurar', entidad: 'copia', entidad_id: req.params.id, detalle: `${r.restaurada} (previa ${r.copia_previa})` });
  res.json(r);
}));

module.exports = router;
