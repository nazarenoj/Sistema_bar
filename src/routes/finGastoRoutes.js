const express = require('express');
const Gastos = require('../financiero/gastoService');
const Recurrentes = require('../financiero/gastoRecurrenteService');
const { manejar } = require('../financiero/comun');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Gastos (Financiero RF10), carga por foto (FIN-FOTO-GASTOS) y gastos recurrentes (RF12).
const router = express.Router();
router.use(requiereModulo('financiero'));
const VER = requierePermiso('financiero.gastos.ver');
const REGISTRAR = requierePermiso('financiero.gastos.registrar');
const archivo = express.raw({ type: ['image/jpeg', 'image/png', 'application/pdf'], limit: '6mb' });

// El contexto de una carga: quién es, la clave de la solicitud, el supervisor que autorizó (si hizo falta) y cómo auditar los bloqueos de duplicados (EX26).
const contexto = (req) => ({
  userId: req.usuario.sub, idSolicitud: req.get('X-ID-Solicitud') ?? null, autorizanteId: req.autorizadoPor?.id ?? null,
  auditar: (accion, detalle) => auditar(req, { modulo: 'financiero', accion, resultado: /duplicado|repetido|proceso/.test(accion) ? 'denegado' : 'ok', entidad: 'fin_gasto', detalle }),
});

router.get('/gastos', VER, manejar(async (req, res) => {
  const q = req.query;
  res.json(await Gastos.listar({ desde: q.desde, hasta: q.hasta, categoriaId: q.categoria_id, cuentaId: q.cuenta_id, estado: q.estado, limite: q.limite }));
}));
router.get('/gastos/:id', VER, manejar(async (req, res) => res.json(await Gastos.obtener(Number(req.params.id)))));
router.get('/gastos/:id/adjunto', VER, manejar(async (req, res) => {
  const a = await Gastos.adjuntoDe(Number(req.params.id));
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(a.adjunto_nombre ?? 'comprobante')}"`).type(a.adjunto_tipo).send(a.adjunto);
}));
router.post('/gastos', REGISTRAR, manejar(async (req, res) => {
  const g = await Gastos.registrar(req.body, contexto(req));
  await auditar(req, { modulo: 'financiero', accion: 'registrar_gasto', entidad: 'fin_gasto', entidad_id: String(g.id), detalle: `${g.importe} ${g.estado}${g.clave ? ` (${g.clave})` : ''}` });
  res.status(201).json(g);
}));
router.post('/gastos/foto', REGISTRAR, archivo, manejar(async (req, res) => {
  res.json(await Gastos.leerFoto({ imagen: req.body, tipo: req.get('Content-Type'), nombre: req.query.nombre }));
}));
router.post('/gastos/:id/adjunto', REGISTRAR, archivo, manejar(async (req, res) => res.json(await Gastos.adjuntar(Number(req.params.id), { imagen: req.body, tipo: req.get('Content-Type'), nombre: req.query.nombre }))));
router.post('/gastos/:id/confirmar', REGISTRAR, manejar(async (req, res) => {
  const g = await Gastos.confirmarBorrador(Number(req.params.id), { ...contexto(req), confirmar_casi_duplicado: req.body?.confirmar_casi_duplicado });
  await auditar(req, { modulo: 'financiero', accion: 'confirmar_gasto_borrador', entidad: 'fin_gasto', entidad_id: String(g.id) });
  res.json(g);
}));
router.post('/gastos/:id/anular', requierePermiso('financiero.gastos.anular'), manejar(async (req, res) => {
  const g = await Gastos.anular(Number(req.params.id), req.body, req.usuario.sub);
  await auditar(req, { modulo: 'financiero', accion: 'anular_gasto', entidad: 'fin_gasto', entidad_id: String(g.id), detalle: req.body.motivo });
  res.json(g);
}));

router.get('/gastos-recurrentes', VER, manejar(async (req, res) => res.json(await Recurrentes.listar())));
router.post('/gastos-recurrentes', REGISTRAR, manejar(async (req, res) => res.status(201).json(await Recurrentes.crear(req.body))));
router.put('/gastos-recurrentes/:id', REGISTRAR, manejar(async (req, res) => res.json(await Recurrentes.actualizar(Number(req.params.id), req.body))));
router.post('/gastos-recurrentes/recordatorios', REGISTRAR, manejar(async (req, res) => res.json(await Recurrentes.recordatorios(req.body?.hoy))));
router.post('/gastos-recurrentes/:id/pagar', REGISTRAR, manejar(async (req, res) => {
  const r = await Recurrentes.pagar(Number(req.params.id), req.body ?? {}, contexto(req));
  await auditar(req, { modulo: 'financiero', accion: 'pagar_gasto_recurrente', entidad: 'fin_gasto', entidad_id: String(r.gasto.id) });
  res.status(201).json(r);
}));

module.exports = router;
