const { Router } = require('express');
const Comisiones = require('../services/comisionService');
const { requierePermiso } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');
const { enviarReporte, FORMATOS_VALIDOS } = require('../servicios/reporteService');
const { auditar } = require('../utils/auditar');

// Comisiones de vendedores y su liquidación (Ventas RF40, RF41), con la función VEN-COMISIONES. Liquidar exige el permiso (RN18).
const router = Router();
const FUNCION = requiereFuncion('VEN-COMISIONES');
const GESTIONAR = [FUNCION, requierePermiso('ventas.comisiones.gestionar')];

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Comisiones.ComisionInvalida) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

router.get('/reglas', ...GESTIONAR, manejar(async (req, res) => res.json(await Comisiones.reglas())));
router.post('/reglas', ...GESTIONAR, manejar(async (req, res) => {
  const r = await Comisiones.guardarRegla(null, req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'ventas', accion: 'comision_regla_crear', entidad: 'comision_regla', entidad_id: String(r.id), detalle: r.nombre });
  res.status(201).json(r);
}));
router.put('/reglas/:id', ...GESTIONAR, manejar(async (req, res) => res.json(await Comisiones.guardarRegla(Number(req.params.id), req.body))));
router.put('/reglas/:id/activa', ...GESTIONAR, manejar(async (req, res) => res.json(await Comisiones.activarRegla(Number(req.params.id), !!req.body.activa))));

// Lo que se liquidaría en un período, sin guardar; y lo que lleva acumulado quien está logueado.
router.get('/previa', ...GESTIONAR, manejar(async (req, res) => res.json(await Comisiones.previa(req.query.desde, req.query.hasta))));
router.get('/mias', FUNCION, requierePermiso('ventas.pedidos.operar'), manejar(async (req, res) => res.json(await Comisiones.deUsuario(req.usuario.sub, req.query.desde, req.query.hasta))));

router.get('/liquidaciones', ...GESTIONAR, manejar(async (req, res) => res.json(await Comisiones.listar())));
router.post('/liquidaciones', ...GESTIONAR, manejar(async (req, res) => {
  const l = await Comisiones.liquidar(req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'ventas', accion: 'comision_liquidar', entidad: 'comision_liquidacion', entidad_id: l.id_global, detalle: `${l.tipo} ${l.desde} a ${l.hasta}: ${l.total}` });
  res.status(201).json(l);
}));
router.get('/liquidaciones/:id', ...GESTIONAR, manejar(async (req, res) => {
  const l = await Comisiones.obtener(Number(req.params.id));
  if (!l) return res.status(404).json({ error: 'Liquidación no encontrada.' });
  if (!req.query.formato) return res.json(l);
  if (!FORMATOS_VALIDOS.includes(req.query.formato)) return res.status(400).json({ error: `"formato" debe ser uno de: ${FORMATOS_VALIDOS.join(', ')}.` });
  await enviarReporte(res, {
    titulo: `Liquidación de comisiones ${l.tipo}`, subtitulo: `${l.desde} a ${l.hasta} — ${l.estado.replace(/_/g, ' ')}`, filtros: [],
    resumen: [{ label: 'Vendedores', valor: l.vendedores.length, tipo: 'numero' }, { label: 'Total a pagar', valor: l.total, tipo: 'moneda' }],
    hojas: [{ nombre: 'Por vendedor', columnas: [
      { key: 'vendedor', label: 'Vendedor', tipo: 'texto', ancho: 22 }, { key: 'ventas', label: 'Ventas', tipo: 'numero', ancho: 9 }, { key: 'base', label: 'Neto', tipo: 'moneda', ancho: 14 },
      { key: 'comisiones', label: 'Comisiones', tipo: 'moneda', ancho: 14 }, { key: 'ajustes', label: 'Ajustes', tipo: 'moneda', ancho: 14 }, { key: 'total', label: 'Total', tipo: 'moneda', ancho: 14 },
    ], filas: l.vendedores }],
  }, req.query.formato, `comisiones-${l.desde}-${l.hasta}`);
}));
router.post('/liquidaciones/:id/pagar', ...GESTIONAR, manejar(async (req, res) => {
  const l = await Comisiones.pagar(Number(req.params.id), req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'ventas', accion: 'comision_pagar', entidad: 'comision_liquidacion', entidad_id: l.id_global, detalle: `${l.total} (${l.estado})` });
  res.json(l);
}));

module.exports = router;
