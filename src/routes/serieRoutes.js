const { Router } = require('express');
const Series = require('../stock/serieService');
const { requierePermiso } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');
const { auditar } = require('../utils/auditar');

// Series (Stock RF26, RF37, RF41). Operar series exige STK-SERIE; la baja, la conversión y la consulta de vigentes rigen mientras haya series.
const router = Router();
const FUNCION = requiereFuncion('STK-SERIE');
const VER = requierePermiso('stock.movimientos.ver');
const GESTIONAR = [FUNCION, requierePermiso('stock.series.gestionar')];
const BAJA = requierePermiso('stock.series.baja');
const pid = (req) => Number(req.params.productoId);

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Series.SerieInvalida) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

router.put('/:productoId/activar', ...GESTIONAR, manejar(async (req, res) => res.json(await Series.activar(pid(req)))));
router.post('/:productoId/ingresos', ...GESTIONAR, manejar(async (req, res) => res.status(201).json(await Series.ingresar({ ...req.body, producto_id: pid(req) }, { userId: req.usuario?.sub }))));
router.post('/:productoId/conteo', ...GESTIONAR, manejar(async (req, res) => res.json(await Series.contar(pid(req), Number(req.body.deposito_id), req.body.series, { userId: req.usuario?.sub }))));

// Compromiso y venta de una serie (los llama Ventas para un artículo serializado).
router.post('/:productoId/:numero/comprometer', ...GESTIONAR, manejar(async (req, res) => res.json(await Series.comprometer(pid(req), req.params.numero, req.body.id_compromiso, { userId: req.usuario?.sub }))));
router.post('/:productoId/:numero/liberar', ...GESTIONAR, manejar(async (req, res) => res.json(await Series.liberar(pid(req), req.params.numero, { userId: req.usuario?.sub }))));
router.post('/:productoId/:numero/vender', ...GESTIONAR, manejar(async (req, res) => res.json(await Series.vender(pid(req), req.params.numero, req.body, { userId: req.usuario?.sub }))));
router.post('/:productoId/:numero/devolver', ...GESTIONAR, manejar(async (req, res) => res.json(await Series.devolver(pid(req), req.params.numero, req.body, { userId: req.usuario?.sub }))));

router.get('/vigentes', VER, manejar(async (req, res) => res.json(await Series.vigentes())));
router.get('/:productoId', VER, manejar(async (req, res) => res.json(await Series.listar(pid(req), req.query.estado))));
router.get('/:productoId/:numero/historial', VER, manejar(async (req, res) => res.json(await Series.historial(pid(req), req.params.numero))));

// RF37: disponibles mientras existan series, aun con STK-SERIE inactiva.
router.post('/:productoId/baja', BAJA, manejar(async (req, res) => {
  const r = await Series.baja(pid(req), req.body.series, req.body.motivo, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'stock', accion: 'baja_series', entidad: 'producto', entidad_id: String(pid(req)), detalle: `${r.series.length} serie(s): ${req.body.motivo}` });
  res.json(r);
}));
router.post('/:productoId/convertir', BAJA, manejar(async (req, res) => {
  const r = await Series.convertir(pid(req), { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'stock', accion: 'conversion_series', entidad: 'producto', entidad_id: String(pid(req)), detalle: `${r.convertidas} serie(s) a saldo por cantidad` });
  res.json(r);
}));

module.exports = router;
