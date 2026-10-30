const { Router } = require('express');
const pool = require('../config/db');
const Mov = require('../stock/movimientoService');
const Toma = require('../stock/tomaService');
const { TomaBloqueada } = require('../stock/tomaAlcance');
const { LoteInvalido } = require('../stock/loteService');
const { requierePermiso } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');
const { auditar } = require('../utils/auditar');

// App móvil de inventario (Stock RF28), con la función STK-APP: lo que el celular necesita sobre los servicios de Stock, con sus mismos
// permisos y auditoría. Requiere conexión: el servidor no guarda nada por el dispositivo (Usuarios RN80). Conteo, recepción y registro
// de temperaturas usan las rutas de siempre (`/api/inventario`, `/api/stock/ingresos`, `/api/temperaturas`) con `origen: app`.
const router = Router();
const FUNCION = requiereFuncion('STK-APP');
const VER = [FUNCION, requierePermiso('stock.movimientos.ver')];
const REGISTRAR = [FUNCION, requierePermiso('stock.movimientos.registrar')];

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof TomaBloqueada) return res.status(err.status).json({ error: err.message, codigo: err.detalle?.codigo ?? 'TOMA_BLOQUEADA', detalle: err.detalle });
    if (err instanceof Mov.MovimientoInvalido || err instanceof LoteInvalido) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

// Escaneo o búsqueda: un código de barras, el código interno de la etiqueta o parte del nombre. Devuelve los ítems con su stock.
router.get('/buscar', ...VER, manejar(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.status(400).json({ error: 'Indicá el código o el nombre a buscar.' });
  const [productos] = await pool.query(
    "SELECT 'producto' AS tipo, id, nombre, stock FROM productos WHERE (codigo_barras = ? OR nombre LIKE ?) ORDER BY nombre LIMIT 20", [q, `%${q}%`]);
  const [insumos] = await pool.query("SELECT 'insumo' AS tipo, id, nombre, stock FROM insumos WHERE nombre LIKE ? ORDER BY nombre LIMIT 20", [`%${q}%`]);
  res.json([...productos, ...insumos].map((i) => ({ ...i, stock: Number(i.stock) })));
}));

// Consulta de stock de un ítem por depósito, con lo comprometido y lo disponible.
router.get('/stock/:tipo/:id', ...VER, manejar(async (req, res) => {
  if (!['insumo', 'producto'].includes(req.params.tipo)) return res.status(400).json({ error: 'El tipo debe ser insumo o producto.' });
  const filas = (await Mov.existencias({ tipo: req.params.tipo })).filter((f) => f.item_id === Number(req.params.id));
  res.json(filas);
}));

// Registro rápido de merma: solo con motivos de clase "merma" del sistema o de la instancia (no los reservados).
router.post('/mermas', ...REGISTRAR, manejar(async (req, res) => {
  const { item, cantidad, motivo, deposito_id, lote, observacion } = req.body;
  const [[m]] = await pool.query("SELECT codigo FROM motivos_stock WHERE codigo = ? AND tipo = 'egreso' AND clase_contable = 'merma' AND reservado = 0 AND activo = 1", [motivo]);
  if (!m) return res.status(400).json({ error: 'El motivo debe ser un motivo de merma.' });
  const r = await Mov.egresar({ deposito_id, motivo, observacion, lineas: [{ item, cantidad, lote }] }, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'stock', accion: 'merma_app', entidad: item?.tipo, entidad_id: String(item?.id), detalle: `${cantidad} (${motivo}), desde la app` });
  res.status(201).json(r);
}));

// Conteo por cámara o lector: carga una línea de una toma en curso.
router.post('/tomas/:id/lineas', ...REGISTRAR, manejar(async (req, res) => {
  const l = await Toma.cargarLinea(Number(req.params.id), req.body);
  await auditar(req, { modulo: 'stock', accion: 'conteo_app', entidad: 'toma', entidad_id: String(req.params.id), detalle: 'línea cargada desde la app' });
  res.status(201).json(l);
}));

module.exports = router;
