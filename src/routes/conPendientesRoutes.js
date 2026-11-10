const express = require('express');
const { Router } = express;
const Pend = require('../contable/pendienteService');
const Manual = require('../contable/manualService');
const Asientos = require('../contable/asientoService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const { manejar } = require('../contable/comun');
const Adjuntos = require('../contable/adjuntoService');

// Pendientes de imputar, asientos manuales, modelos y recurrentes (Contable RF05, RF15).
const router = Router();
router.use(requiereModulo('contable'));
const VER = requierePermiso('contable.ver'), RESOLVER = requierePermiso('contable.pendientes.resolver'), CREAR = requierePermiso('contable.asientos.crear'), ANULAR = requierePermiso('contable.asientos.anular');
const aud = (req, accion, entidad, id, detalle) => auditar(req, { modulo: 'contable', accion, entidad, entidad_id: id, detalle });

router.get('/pendientes', VER, manejar(async (req, res) => res.json(await Pend.listar(req.query))));
router.post('/pendientes/:id/reintentar', RESOLVER, manejar(async (req, res) => { const r = await Pend.reintentar(Number(req.params.id), req.usuario.sub); await aud(req, 'reintentar_pendiente', 'pendiente', req.params.id, ''); res.json(r); }));
router.post('/pendientes/:id/imputar', RESOLVER, manejar(async (req, res) => {
  const r = await Pend.imputar(Number(req.params.id), req.body ?? {}, req.usuario.sub, req.get('x-id-solicitud') ?? null);
  await aud(req, 'imputar_a_mano', 'pendiente', req.params.id, `asiento ${r.numero}`);
  res.json(r);
}));
router.put('/pendientes/:id', RESOLVER, manejar(async (req, res) => { const r = await Pend.asignar(Number(req.params.id), req.body ?? {}); await aud(req, 'asignar_pendiente', 'pendiente', req.params.id, JSON.stringify(req.body ?? {})); res.json(r); }));

router.post('/asientos-manuales', CREAR, manejar(async (req, res) => {
  const a = await Manual.crear(req.body ?? {}, req.usuario.sub, req.get('x-id-solicitud') ?? null);
  await aud(req, 'asiento_manual', 'asiento', a.id, `n.º ${a.numero}`);
  res.status(201).json(a);
}));
router.post('/asientos/:id/anular', ANULAR, manejar(async (req, res) => {
  const r = await Asientos.anular(Number(req.params.id), { usuarioId: req.usuario.sub, motivo: req.body?.motivo, idSolicitud: req.get('x-id-solicitud') ?? null, confirmarResumen: !!req.body?.confirmar_resumen });
  await aud(req, 'anular_asiento', 'asiento', req.params.id, req.body.motivo);
  res.json(r);
}));

router.get('/asientos/:id/adjuntos', VER, manejar(async (req, res) => res.json(await Adjuntos.listar(Number(req.params.id)))));
// El archivo va como cuerpo (Content-Type image/jpeg, image/png o application/pdf) y el nombre en ?nombre=.
const archivo = express.raw({ type: ['image/jpeg', 'image/png', 'application/pdf'], limit: '6mb' });
router.post('/asientos/:id/adjuntos', CREAR, archivo, manejar(async (req, res) => { const r = await Adjuntos.agregar(Number(req.params.id), { nombre: req.query.nombre, tipo: req.get('content-type')?.split(';')[0], contenido: req.body }, req.usuario.sub); await aud(req, 'adjuntar_a_asiento', 'asiento', req.params.id, r.nombre); res.status(201).json(r); }));
router.get('/asientos/:id/adjuntos/:adjunto', VER, manejar(async (req, res) => { const x = await Adjuntos.obtener(Number(req.params.id), Number(req.params.adjunto)); res.type(x.tipo).attachment(x.nombre).send(x.contenido); }));

router.get('/modelos', VER, manejar(async (req, res) => res.json(await Manual.modelos())));
router.post('/modelos', CREAR, manejar(async (req, res) => { const r = await Manual.crearModelo(req.body ?? {}); await aud(req, 'crear_modelo', 'modelo', r.id, r.nombre); res.status(201).json(r); }));
router.put('/modelos/:id', CREAR, manejar(async (req, res) => { const r = await Manual.editarModelo(Number(req.params.id), req.body ?? {}); await aud(req, 'editar_modelo', 'modelo', r.id, r.nombre); res.json(r); }));
router.delete('/modelos/:id', CREAR, manejar(async (req, res) => { const r = await Manual.eliminarModelo(Number(req.params.id)); await aud(req, 'eliminar_modelo', 'modelo', req.params.id, ''); res.json(r); }));
router.post('/modelos/recurrentes/generar', CREAR, manejar(async (req, res) => { const r = await Manual.generarRecurrentes(req.body ?? {}, req.usuario.sub); await aud(req, 'generar_recurrentes', 'modelo', 'todos', `${r.generados.length} asientos`); res.json(r); }));
router.post('/modelos/:id/generar', CREAR, manejar(async (req, res) => {
  const a = await Manual.generar(Number(req.params.id), req.body?.fecha, req.usuario.sub, req.get('x-id-solicitud') ?? null);
  await aud(req, 'asiento_desde_modelo', 'asiento', a.id, `n.º ${a.numero}`);
  res.status(201).json(a);
}));

module.exports = router;
