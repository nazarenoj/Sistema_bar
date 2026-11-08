const { Router } = require('express');
const Conectores = require('../ventas_online/conectorService');
const { TiendaInvalida } = require('../ventas_online/tiendaService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Conectores de marketplaces y plataformas de delivery (Ventas Online RF18, RF19). Dos routers: el administrativo y la entrada pública de pedidos, autenticada con el secreto de cada conector.
const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof TiendaInvalida) { const { status, ...extra } = err; return res.status(status ?? 400).json({ error: err.message, ...extra }); }
    next(err);
  }
};

const admin = Router();
admin.use(requiereModulo('ventas_online'));
const GESTIONAR = requierePermiso('ventas_online.plataformas.gestionar');
const aud = (req, accion, id, detalle) => auditar(req, { modulo: 'ventas_online', accion, entidad: 'onl_conectores', entidad_id: String(id), detalle });

admin.get('/plataformas', GESTIONAR, manejar(async (req, res) => res.json(await Conectores.listar())));
admin.post('/plataformas', GESTIONAR, manejar(async (req, res) => { const c = await Conectores.crear(req.body ?? {}); await aud(req, 'crear_conector', c.id, c.codigo); res.status(201).json(c); }));
admin.put('/plataformas/:id', GESTIONAR, manejar(async (req, res) => { const c = await Conectores.editar(Number(req.params.id), req.body ?? {}); await aud(req, 'editar_conector', c.id, c.codigo); res.json(c); }));
admin.post('/plataformas/:id/pausa', GESTIONAR, manejar(async (req, res) => { const c = await Conectores.pausar(Number(req.params.id), req.body?.pausado !== false, req.body?.motivo); await aud(req, c.pausado ? 'pausar_conector' : 'reanudar_conector', c.id, c.pausa_motivo ?? ''); res.json(c); }));
admin.get('/plataformas/:id/articulos', GESTIONAR, manejar(async (req, res) => res.json(await Conectores.articulos(Number(req.params.id)))));
admin.post('/plataformas/:id/articulos', GESTIONAR, manejar(async (req, res) => res.status(201).json(await Conectores.vincularArticulo(Number(req.params.id), req.body ?? {}))));
admin.get('/plataformas/:id/menu', GESTIONAR, manejar(async (req, res) => res.json(await Conectores.menu(Number(req.params.id)))));
admin.post('/plataformas/:id/publicar', GESTIONAR, manejar(async (req, res) => res.json(await Conectores.publicar(Number(req.params.id)))));
admin.post('/plataformas/eventos/reintentar', GESTIONAR, manejar(async (req, res) => res.json(await Conectores.reintentarEventos())));
admin.post('/pedidos/:id/aceptar-plataforma', GESTIONAR, manejar(async (req, res) => { const p = await Conectores.aceptar(Number(req.params.id)); await aud(req, 'aceptar_pedido_plataforma', p.id, p.estado); res.json(p); }));
admin.post('/pedidos/:id/rechazar-plataforma', GESTIONAR, manejar(async (req, res) => { const p = await Conectores.rechazar(Number(req.params.id), req.body ?? {}); await aud(req, 'rechazar_pedido_plataforma', p.id, req.body?.motivo); res.json(p); }));
admin.post('/pedidos/:id/vincular-articulos', GESTIONAR, manejar(async (req, res) => res.json(await Conectores.vincularPedido(Number(req.params.id), req.body?.vinculos))));
admin.get('/plataformas-comisiones-estimadas', GESTIONAR, manejar(async (req, res) => res.json(await Conectores.comisionesEstimadas({ desde: req.query.desde, hasta: req.query.hasta }))));
admin.post('/plataformas/:codigo/liquidaciones', GESTIONAR, manejar(async (req, res) => { const r = await Conectores.enviarLiquidacion(req.params.codigo, req.body ?? {}); await aud(req, 'liquidacion_plataforma', req.params.codigo, String(req.body?.id_liquidacion)); res.status(202).json(r); }));

// La plataforma entrega sus pedidos con el secreto de su conector.
const publico = Router({ mergeParams: true });
publico.post('/plataformas/:conector/pedidos', manejar(async (req, res) => {
  const p = await Conectores.recibirPedido(req.params.conector, req.get('X-Conector-Token'), req.body ?? {});
  res.status(p.repetido ? 200 : 201).json(p);
}));

module.exports = { admin, publico };
