const { Router } = require('express');
const Repo = require('../stock/reposicionAutoService');
const { requierePermiso } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');
const { enviarReporte, FORMATOS_VALIDOS } = require('../services/reporteService');

// Reposición automática sugerida (Stock RF29), con la función STK-REPO-AUTO. Solo arma la lista: nunca compra.
const router = Router();
const FUNCION = requiereFuncion('STK-REPO-AUTO');

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Repo.ReposicionInvalida) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

// Stock de seguridad, plazo de entrega y días de cobertura de un ítem.
router.put('/items/:tipo/:id', FUNCION, requierePermiso('stock.insumos.editar'), manejar(async (req, res) => res.json(await Repo.configurar({ tipo: req.params.tipo, id: Number(req.params.id) }, req.body))));

router.get('/sugerencia', FUNCION, requierePermiso('stock.movimientos.ver'), manejar(async (req, res) => {
  const filas = await Repo.sugerir({ deposito_id: req.query.deposito_id ? Number(req.query.deposito_id) : undefined });
  if (!req.query.formato) return res.json(filas);
  if (!FORMATOS_VALIDOS.includes(req.query.formato)) return res.status(400).json({ error: `"formato" debe ser uno de: ${FORMATOS_VALIDOS.join(', ')}.` });
  await enviarReporte(res, {
    titulo: 'Reposición sugerida por consumo', subtitulo: '', filtros: [], resumen: [{ label: 'Ítems a reponer', valor: filas.length, tipo: 'numero' }],
    hojas: [{ nombre: 'Sugerencia', columnas: [
      { key: 'nombre', label: 'Ítem', tipo: 'texto', ancho: 26 }, { key: 'consumo_diario', label: 'Consumo diario', tipo: 'numero', ancho: 14 }, { key: 'plazo_entrega_dias', label: 'Plazo (días)', tipo: 'numero', ancho: 12 },
      { key: 'disponible', label: 'Disponible', tipo: 'numero', ancho: 11 }, { key: 'sugerida', label: 'Sugerida', tipo: 'numero', ancho: 11 },
    ], filas }],
  }, req.query.formato, 'reposicion-por-consumo');
}));

module.exports = router;
