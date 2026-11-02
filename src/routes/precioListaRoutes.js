const { Router } = require('express');
const Listas = require('../services/listaPrecioService');
const { requierePermiso, permisosDe } = require('../middleware/requierePermiso');
const requiereFuncion = require('../middleware/requiereFuncion');
const { auditar } = require('../utils/auditar');

// Listas de precios múltiples (Ventas RF34, RF35), con la función VEN-LISTAS.
const router = Router();
const FUNCION = requiereFuncion('VEN-LISTAS');
const VER = [FUNCION, requierePermiso('ventas.catalogo.ver')];
const EDITAR = [FUNCION, requierePermiso('ventas.catalogo.editar')];

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Listas.ListaInvalida) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

router.get('/', ...VER, manejar(async (req, res) => res.json(await Listas.listar())));
router.post('/', ...EDITAR, manejar(async (req, res) => {
  const l = await Listas.guardar(null, req.body);
  await auditar(req, { modulo: 'ventas', accion: 'lista_precio_crear', entidad: 'lista_precio', entidad_id: String(l.id), detalle: l.nombre });
  res.status(201).json(l);
}));
router.put('/:id', ...EDITAR, manejar(async (req, res) => res.json(await Listas.guardar(Number(req.params.id), req.body))));
router.put('/:id/activa', ...EDITAR, manejar(async (req, res) => res.json(await Listas.activar(Number(req.params.id), !!req.body.activa))));
router.get('/:id/precios', ...VER, manejar(async (req, res) => res.json(await Listas.preciosDe(Number(req.params.id)))));
router.put('/:id/precios', ...EDITAR, manejar(async (req, res) => {
  const r = await Listas.fijarPrecios(Number(req.params.id), req.body.precios);
  await auditar(req, { modulo: 'ventas', accion: 'lista_precio_precios', entidad: 'lista_precio', entidad_id: req.params.id, detalle: `${req.body.precios.length} precio(s)` });
  res.json(r);
}));

// La lista de una terminal (RN32: la del cliente, después la de la terminal, después la Minorista).
router.put('/terminales/:terminalId', ...EDITAR, manejar(async (req, res) => res.json(await Listas.asignarATerminal(Number(req.params.terminalId), req.body.lista_precio_id ?? null))));

// Elegir a mano la lista de un pedido. Con ítems ya cargados exige el permiso de precios; no cambia el precio de lo agregado (RN17).
router.put('/pedidos/:pedidoId', FUNCION, requierePermiso('ventas.pedidos.operar'), manejar(async (req, res) => {
  const id = Number(req.params.pedidoId);
  if (!Number.isInteger(req.body.lista_precio_id)) return res.status(400).json({ error: 'Falta "lista_precio_id".' });
  if (await Listas.itemsDe(id)) {
    const { niveles } = await permisosDe(req);
    if (niveles['ventas.precios.actualizar'] !== 'permitido') return res.status(403).json({ error: 'Cambiar la lista de un pedido con ítems necesita el permiso de precios.', codigo: 'SIN_PERMISO', permiso: 'ventas.precios.actualizar' });
  }
  const r = await Listas.asignarAPedido(id, req.body.lista_precio_id);
  await auditar(req, { modulo: 'ventas', accion: 'lista_precio_pedido', entidad: 'pedido', entidad_id: String(id), detalle: r.lista });
  res.json(r);
}));

module.exports = router;
