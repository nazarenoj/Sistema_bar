const { Router } = require('express');
const Reglas = require('../contable/reglaService');
const Periodos = require('../contable/periodoService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const { manejar } = require('../contable/comun');

// Ejercicios, períodos y reglas de imputación (Contable RF02, RF03).
const router = Router();
router.use(requiereModulo('contable'));
const VER = requierePermiso('contable.ver'), REGLAS = requierePermiso('contable.reglas.editar');
const CERRAR = requierePermiso('contable.periodos.cerrar'), REABRIR = requierePermiso('contable.periodos.reabrir');
const aud = (req, accion, entidad, id, detalle) => auditar(req, { modulo: 'contable', accion, entidad, entidad_id: id, detalle });

router.get('/ejercicios', VER, manejar(async (req, res) => res.json(await Periodos.ejercicios())));
router.post('/ejercicios', REGLAS, manejar(async (req, res) => { const r = await Periodos.crearEjercicio(req.body ?? {}); await aud(req, 'crear_ejercicio', 'ejercicio', r.id, `${r.desde} a ${r.hasta}`); res.status(201).json(r); }));
router.get('/periodos', VER, manejar(async (req, res) => res.json(await Periodos.periodos(req.query))));
router.get('/periodos/:id/historial', VER, manejar(async (req, res) => res.json(await Periodos.historial(Number(req.params.id)))));
router.post('/periodos/:id/cerrar', CERRAR, manejar(async (req, res) => { const r = await Periodos.cerrar(Number(req.params.id), req.usuario.sub); await aud(req, 'cerrar_periodo', 'periodo', r.id, `${r.anio}-${r.mes}`); res.json(r); }));
router.post('/periodos/:id/reabrir', REABRIR, manejar(async (req, res) => {
  const r = await Periodos.reabrir(Number(req.params.id), req.body?.motivo, req.usuario.sub);
  await aud(req, 'reabrir_periodo', 'periodo', r.id, `${r.anio}-${r.mes}: ${req.body.motivo}`);
  res.json(r);
}));

router.get('/formularios', VER, manejar(async (req, res) => res.json(await Reglas.formularios())));
router.get('/reglas', VER, manejar(async (req, res) => res.json(await Reglas.listar(req.query))));
router.post('/reglas/predeterminadas', REGLAS, manejar(async (req, res) => { const r = await Reglas.sembrar(); await aud(req, 'reglas_predeterminadas', 'regla', 'todas', `${r.nuevas} nuevas`); res.json(r); }));
router.post('/reglas', REGLAS, manejar(async (req, res) => { const r = await Reglas.crear(req.body ?? {}); await aud(req, 'crear_regla', 'regla', r.id, `${r.formulario}/${r.componente}/${r.criterio}`); res.status(201).json(r); }));
router.put('/reglas/:id', REGLAS, manejar(async (req, res) => { const r = await Reglas.editar(Number(req.params.id), req.body ?? {}); await aud(req, 'editar_regla', 'regla', r.id, `${r.formulario}/${r.componente}/${r.criterio}`); res.json(r); }));
router.post('/reglas/:id/estado', REGLAS, manejar(async (req, res) => { const r = await Reglas.cambiarEstado(Number(req.params.id), !!req.body?.activa, !!req.body?.confirmar); await aud(req, 'estado_regla', 'regla', r.id, String(r.activa)); res.json(r); }));
router.delete('/reglas/:id', REGLAS, manejar(async (req, res) => { const r = await Reglas.eliminar(Number(req.params.id)); await aud(req, 'eliminar_regla', 'regla', req.params.id, ''); res.json(r); }));

module.exports = router;
