const express = require('express');
const Fotos = require('../stock/ingresoFotoService');
const Devoluciones = require('../stock/devolucionProveedorService');
const Mov = require('../stock/movimientoService');
const { LoteInvalido } = require('../stock/loteService');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Ingreso por foto (Stock RF05) y devolución a proveedor (RF40). Con los permisos de los demás ingresos y egresos de Stock.
const router = express.Router();
const VER = requierePermiso('stock.movimientos.ver');
const REGISTRAR = requierePermiso('stock.movimientos.registrar');
const usuario = (req) => req.usuario?.sub;

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Devoluciones.DevolucionInvalida) return res.status(err.status ?? 400).json({ error: err.message, ...(err.devolvible !== undefined && { devolvible: err.devolvible }) });
    if (err instanceof Fotos.BorradorInvalido || err instanceof Mov.MovimientoInvalido || err instanceof LoteInvalido) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

// ---- Ingreso por foto: la imagen o el PDF viajan tal cual en el cuerpo (Content-Type image/jpeg, image/png o application/pdf) ----
const cuerpoArchivo = express.raw({ type: ['image/jpeg', 'image/png', 'application/pdf'], limit: '12mb' });
router.post('/fotos', REGISTRAR, cuerpoArchivo, manejar(async (req, res) => {
  const b = await Fotos.crear({ imagen: req.body, tipo: String(req.get('content-type') ?? '').split(';')[0], nombre: req.get('x-nombre-archivo'), deposito_id: req.query.deposito_id ? Number(req.query.deposito_id) : undefined }, { userId: usuario(req) });
  res.status(201).json(b);
}));
router.get('/fotos', VER, manejar(async (req, res) => res.json(await Fotos.listar(req.query))));
router.get('/fotos/:id', VER, manejar(async (req, res) => res.json(await Fotos.obtener(Number(req.params.id)))));
router.get('/fotos/:id/imagen', VER, manejar(async (req, res) => {
  const f = await Fotos.imagen(Number(req.params.id));
  res.type(f.tipo).send(f.imagen);
}));
router.put('/fotos/:id/lectura', REGISTRAR, manejar(async (req, res) => res.json(await Fotos.cargarLectura(Number(req.params.id), req.body))));
router.put('/fotos/:id/lineas/:n', REGISTRAR, manejar(async (req, res) => res.json(await Fotos.asociar(Number(req.params.id), Number(req.params.n), req.body))));
router.post('/fotos/:id/confirmar', REGISTRAR, manejar(async (req, res) => {
  const r = await Fotos.confirmar(Number(req.params.id), req.body, { userId: usuario(req) });
  await auditar(req, { modulo: 'stock', accion: 'ingreso_foto', entidad: 'ingreso', entidad_id: r.ingreso.id_global, detalle: `borrador ${req.params.id} confirmado` });
  res.json(r);
}));
router.post('/fotos/:id/descartar', REGISTRAR, manejar(async (req, res) => res.json(await Fotos.descartar(Number(req.params.id)))));

// ---- Devolución a proveedor ----
router.post('/devoluciones-proveedor', REGISTRAR, manejar(async (req, res) => {
  const d = await Devoluciones.devolver(req.body, { userId: usuario(req) });
  await auditar(req, { modulo: 'stock', accion: 'devolucion_proveedor', entidad: d.item_tipo, entidad_id: String(d.item_id), detalle: `${d.cantidad} devueltos (${d.motivo})` });
  res.status(201).json(d);
}));
router.get('/devoluciones-proveedor', VER, manejar(async (req, res) => res.json(await Devoluciones.listar(req.query))));
router.get('/devoluciones-proveedor/:id', VER, manejar(async (req, res) => res.json(await Devoluciones.obtener(Number(req.params.id)))));
router.post('/devoluciones-proveedor/:id/nota-credito', REGISTRAR, manejar(async (req, res) => res.json(await Devoluciones.cargarNotaCredito(Number(req.params.id), req.body))));

module.exports = router;
