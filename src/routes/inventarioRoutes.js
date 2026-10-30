const { Router } = require('express');
const Toma = require('../stock/tomaService');
const { TomaBloqueada } = require('../stock/tomaAlcance');
const Diferencias = require('../stock/diferenciasService');
const Alertas = require('../stock/alertasService');
const { requierePermiso, validarAutorizacion } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const { enviarReporte, FORMATOS_VALIDOS } = require('../services/reporteService');

// Toma de inventario, diferencias de integración y alertas de Stock (RF14, RF16, RF35).
const router = Router();
const VER = requierePermiso('stock.movimientos.ver');
const CONTAR = requierePermiso('stock.movimientos.registrar');
const APROBAR = requierePermiso('stock.inventario.aprobar');

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof TomaBloqueada) return res.status(err.status).json({ error: err.message, codigo: err.detalle?.codigo ?? 'TOMA_BLOQUEADA', detalle: err.detalle });
    next(err);
  }
};
const noEncontrada = (res) => res.status(404).json({ error: 'Toma no encontrada.' });
const id = (req) => Number(req.params.id);

// ---- Tomas ----
router.post('/tomas', CONTAR, manejar(async (req, res) => {
  const t = await Toma.crear({ alcance: req.body.alcance ?? {}, congelar_manual: req.body.congelar_manual === true }, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'stock', accion: 'toma_creada', entidad: 'toma', entidad_id: t.id_global });
  res.status(201).json(t);
}));
router.get('/tomas', VER, manejar(async (req, res) => res.json(await Toma.listar(req.query.estado))));
router.get('/tomas/:id', VER, manejar(async (req, res) => { const t = await Toma.obtener(id(req)); return t ? res.json(t) : noEncontrada(res); }));

// Carga o recarga (recontar) lo contado de un ítem en un depósito: { item: { tipo, id }, deposito_id, cantidad }.
router.post('/tomas/:id/lineas', CONTAR, manejar(async (req, res) => res.status(201).json(await Toma.cargarLinea(id(req), req.body))));
router.post('/tomas/:id/cancelar', CONTAR, manejar(async (req, res) => (await Toma.cancelar(id(req))) ? res.json({ message: 'Toma cancelada.' }) : res.status(409).json({ error: 'Solo se cancela una toma en curso.' })));

// Aprueba la toma, una sola vez, y genera los ajustes. Cuerpo: confirmaciones { [linea_id]: motivo }, aceptar_pendientes (motivo).
router.post('/tomas/:id/aprobar', APROBAR, manejar(async (req, res) => {
  const r = await Toma.aprobar(id(req), {
    confirmaciones: req.body.confirmaciones ?? {}, aceptarPendientes: typeof req.body.aceptar_pendientes === 'string' ? req.body.aceptar_pendientes.trim() || null : null,
    autorizar: () => validarAutorizacion(req, 'stock.inventario.aprobar'), userId: req.usuario?.sub,
  });
  if (!r.repetida) await auditar(req, { modulo: 'stock', accion: 'toma_aprobada', entidad: 'toma', entidad_id: r.toma, detalle: `${r.ajustes.length} ajuste(s)` });
  res.json(r);
}));

// ---- Diferencias de integración (vendido contra descontado) ----
router.get('/diferencias', VER, manejar(async (req, res) => res.json(await Diferencias.listar(req.query))));
router.post('/diferencias/ejecutar', CONTAR, manejar(async (req, res) => res.json(await Diferencias.ejecutar({ desde: req.body.desde, hasta: req.body.hasta }))));

// ---- Alertas y reposición sugerida ----
router.post('/alertas/evaluar', CONTAR, manejar(async (req, res) => res.json({ abiertas: await Alertas.evaluar() })));
router.get('/reposicion', VER, manejar(async (req, res) => {
  const filas = await Alertas.reposicionSugerida({ deposito_id: req.query.deposito_id });
  if (!req.query.formato) return res.json(filas);
  if (!FORMATOS_VALIDOS.includes(req.query.formato)) return res.status(400).json({ error: `"formato" debe ser uno de: ${FORMATOS_VALIDOS.join(', ')}.` });
  await enviarReporte(res, {
    titulo: 'Reposición sugerida', subtitulo: '', filtros: [], resumen: [{ label: 'Ítems a reponer', valor: filas.length, tipo: 'numero' }],
    hojas: [{ nombre: 'Reposición', columnas: [
      { key: 'nombre', label: 'Ítem', tipo: 'texto', ancho: 26 }, { key: 'deposito', label: 'Depósito', tipo: 'texto', ancho: 18 }, { key: 'disponible', label: 'Disponible', tipo: 'numero', ancho: 11 },
      { key: 'punto_reposicion', label: 'Punto reposición', tipo: 'numero', ancho: 14 }, { key: 'sugerida', label: 'Sugerida', tipo: 'numero', ancho: 11 },
    ], filas }],
  }, req.query.formato, 'reposicion-sugerida');
}));

module.exports = router;
