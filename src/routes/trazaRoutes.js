const { Router } = require('express');
const Traza = require('../stock/trazaService');
const { requierePermiso } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');
const { auditar } = require('../utils/auditar');
const { enviarReporte, FORMATOS_VALIDOS } = require('../services/reporteService');

// Trazabilidad y retiro de lote (Stock RF21, RF42, RN83), con la función STK-TRAZA. Clientes y CC llama hacia abajo a
// GET /retiros/:id (el "alcance de un retiro") y marca el aviso por POST /retiros/lineas/:id/avisar.
const router = Router();
const VER = [requiereFuncion('STK-TRAZA'), requierePermiso('stock.trazabilidad.ver')];
const RETIRAR = [requiereFuncion('STK-TRAZA'), requierePermiso('stock.trazabilidad.retirar')];
const REGISTRAR = [requiereFuncion('STK-TRAZA'), requierePermiso('stock.movimientos.registrar')];
const id = (req) => Number(req.params.id);

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Traza.TrazaInvalida) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

router.get('/lotes/:id/ascendente', ...VER, manejar(async (req, res) => res.json(await Traza.ascendente(id(req)))));
router.get('/lotes/:id/descendente', ...VER, manejar(async (req, res) => res.json(await Traza.descendente(id(req)))));

router.post('/lotes/:id/retirar', ...RETIRAR, manejar(async (req, res) => {
  const r = await Traza.retirar(id(req), req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'stock', accion: 'retiro_lote', entidad: 'retiro_lote', entidad_id: r.id_global, detalle: req.body.motivo });
  res.status(201).json(r);
}));
router.get('/retiros', ...VER, manejar(async (req, res) => res.json(await Traza.listar(req.query.estado))));
router.get('/retiros/:id', ...VER, manejar(async (req, res) => {
  const r = await Traza.obtener(id(req));
  if (!r) return res.status(404).json({ error: 'Retiro no encontrado.' });
  if (!req.query.formato) return res.json(r);
  if (!FORMATOS_VALIDOS.includes(req.query.formato)) return res.status(400).json({ error: `"formato" debe ser uno de: ${FORMATOS_VALIDOS.join(', ')}.` });
  await enviarReporte(res, {
    titulo: `Retiro de lote ${r.lote_codigo}`, subtitulo: r.motivo, filtros: [], resumen: [{ label: 'Líneas alcanzadas', valor: r.lineas.length, tipo: 'numero' }],
    hojas: [{ nombre: 'Alcance', columnas: [
      { key: 'documento', label: 'Comprobante', tipo: 'texto', ancho: 30 }, { key: 'fecha', label: 'Fecha', tipo: 'texto', ancho: 20 }, { key: 'deposito', label: 'Sector', tipo: 'texto', ancho: 18 },
      { key: 'lote', label: 'Lote', tipo: 'texto', ancho: 14 }, { key: 'cantidad', label: 'Cantidad', tipo: 'numero', ancho: 11 }, { key: 'lote_confirmado', label: 'Lote', tipo: 'texto', ancho: 16 },
      { key: 'estado_aviso', label: 'Aviso', tipo: 'texto', ancho: 12 },
    ], filas: r.lineas.map((l) => ({ ...l, fecha: new Date(l.fecha).toISOString().slice(0, 16).replace('T', ' '), lote_confirmado: l.no_confirmado ? 'No confirmado' : 'Confirmado' })) }],
  }, req.query.formato, `retiro-${r.lote_codigo}`);
}));
router.post('/retiros/:id/liberar', ...RETIRAR, manejar(async (req, res) => {
  const r = await Traza.liberar(id(req), req.body.motivo, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'stock', accion: 'retiro_lote_liberado', entidad: 'retiro_lote', entidad_id: r.id_global, detalle: req.body.motivo });
  res.json(r);
}));
router.post('/retiros/lineas/:id/avisar', ...REGISTRAR, manejar(async (req, res) => {
  const r = await Traza.avisar(id(req), { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'stock', accion: 'retiro_aviso', entidad: 'retiro_lote', entidad_id: r.id_global, detalle: `línea ${id(req)}` });
  res.json(r);
}));
router.post('/retiros/lineas/:id/recuperar', ...REGISTRAR, manejar(async (req, res) => {
  const r = await Traza.recuperar(id(req), req.body.cantidad, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'stock', accion: 'retiro_recupero', entidad: 'retiro_lote', entidad_id: r.id_global, detalle: `línea ${id(req)}: ${req.body.cantidad}` });
  res.json(r);
}));

module.exports = router;
