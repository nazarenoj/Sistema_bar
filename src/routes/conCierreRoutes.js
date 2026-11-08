const { Router } = require('express');
const Ejercicios = require('../contable/ejercicioService');
const Reval = require('../contable/revaluacionService');
const Plantillas = require('../contable/plantillaService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const { manejar } = require('../contable/comun');

// Cierre de ejercicio, revaluación y exportación con plantillas (Contable RF09, RF10, RF12).
const router = Router();
router.use(requiereModulo('contable'));
const VER = requierePermiso('contable.ver'), CERRAR = requierePermiso('contable.ejercicio.cerrar'), REVAL = requierePermiso('contable.revaluacion.registrar');
const PLANTILLAS = requierePermiso('contable.plantillas.editar'), EXPORTAR = requierePermiso('contable.exportar');
const aud = (req, accion, entidad, id, detalle) => auditar(req, { modulo: 'contable', accion, entidad, entidad_id: id, detalle });

router.get('/ejercicios/:id/cierre', VER, manejar(async (req, res) => { const v = await Ejercicios.validar(Number(req.params.id)); res.json({ ejercicio_id: v.ejercicio.id, puede_cerrar: !Object.keys(v.faltan).length, faltan: v.faltan }); }));
router.post('/ejercicios/:id/cerrar', CERRAR, manejar(async (req, res) => {
  const r = await Ejercicios.cerrar(Number(req.params.id), req.usuario.sub, req.get('x-id-solicitud') ?? null);
  await aud(req, 'cerrar_ejercicio', 'ejercicio', req.params.id, `resultado ${r.resultado}`);
  res.json(r);
}));

router.get('/revaluacion', VER, manejar(async (req, res) => res.json(await Reval.propuesta({ periodo: req.query.periodo }))));
router.post('/revaluacion', REVAL, manejar(async (req, res) => {
  const r = await Reval.registrar(req.body ?? {}, req.usuario.sub, req.get('x-id-solicitud') ?? null);
  await aud(req, 'revaluacion', 'asiento', r.asiento_id, req.body.periodo);
  res.status(201).json(r);
}));

router.get('/plantillas', VER, manejar(async (req, res) => res.json(await Plantillas.listar())));
router.post('/plantillas', PLANTILLAS, manejar(async (req, res) => { const r = await Plantillas.crear(req.body ?? {}); await aud(req, 'crear_plantilla', 'plantilla', r.id, r.nombre); res.status(201).json(r); }));
router.put('/plantillas/:id', PLANTILLAS, manejar(async (req, res) => { const r = await Plantillas.editar(Number(req.params.id), req.body ?? {}); await aud(req, 'editar_plantilla', 'plantilla', r.id, r.nombre); res.json(r); }));
router.delete('/plantillas/:id', PLANTILLAS, manejar(async (req, res) => { const r = await Plantillas.eliminar(Number(req.params.id)); await aud(req, 'eliminar_plantilla', 'plantilla', req.params.id, ''); res.json(r); }));
router.get('/exportar/diario', EXPORTAR, manejar(async (req, res) => {
  const r = await Plantillas.exportarDiario(Number(req.query.plantilla), req.query);
  await aud(req, 'exportar_plantilla', 'libro', 'diario', `${r.lineas} línea(s)`);
  res.type('text/csv').attachment(r.nombre).send(r.texto);
}));

module.exports = router;
