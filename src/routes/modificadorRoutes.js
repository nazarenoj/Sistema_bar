const { Router } = require('express');
const Modificadores = require('../services/modificadorService');
const { requierePermiso } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');
const { auditar } = require('../utils/auditar');

// Grupos de modificadores y sus opciones (Ventas RF30), con la función VEN-MODIF. Los ve quien ve el catálogo; los edita quien lo edita.
const router = Router();
const FUNCION = requiereFuncion('VEN-MODIF');
const VER = [FUNCION, requierePermiso('ventas.catalogo.ver')];
const EDITAR = [FUNCION, requierePermiso('ventas.catalogo.editar')];

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Modificadores.ModificadorInvalido) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

router.get('/', ...VER, manejar(async (req, res) => res.json(await Modificadores.listar())));
// Los grupos que se aplican a un artículo: lo que la pantalla de pedido ofrece al elegirlo.
router.get('/producto/:productoId', ...VER, manejar(async (req, res) => res.json(await Modificadores.paraProducto(Number(req.params.productoId)))));
// Completa o cambia las opciones de un ítem del pedido que todavía no salió a comanda (Ventas EX31).
router.put('/items/:itemId', FUNCION, requierePermiso('ventas.pedidos.operar'), manejar(async (req, res) => {
  if (!Array.isArray(req.body.opciones)) return res.status(400).json({ error: 'Falta "opciones" (lista de ids).' });
  res.json(await Modificadores.asignarAItem(Number(req.params.itemId), req.body.opciones));
}));
router.get('/:id', ...VER, manejar(async (req, res) => {
  const g = await Modificadores.obtener(Number(req.params.id));
  return g ? res.json(g) : res.status(404).json({ error: 'Grupo no encontrado.' });
}));
router.post('/', ...EDITAR, manejar(async (req, res) => {
  const g = await Modificadores.guardar(null, req.body);
  await auditar(req, { modulo: 'ventas', accion: 'modificador_crear', entidad: 'grupo_modificador', entidad_id: String(g.id), detalle: g.nombre });
  res.status(201).json(g);
}));
router.put('/:id', ...EDITAR, manejar(async (req, res) => {
  const g = await Modificadores.guardar(Number(req.params.id), req.body);
  await auditar(req, { modulo: 'ventas', accion: 'modificador_editar', entidad: 'grupo_modificador', entidad_id: String(g.id), detalle: g.nombre });
  res.json(g);
}));
router.put('/:id/activo', ...EDITAR, manejar(async (req, res) => res.json(await Modificadores.activar(Number(req.params.id), !!req.body.activo))));

module.exports = router;
