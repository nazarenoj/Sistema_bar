const { Router } = require('express');
const Facturacion = require('../ventas_online/facturacionService');
const Pesaje = require('../ventas_online/pesajeService');
const { TiendaInvalida } = require('../ventas_online/tiendaService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const pool = require('../config/db');

// Facturación del pedido, alineación y pesaje real (Ventas Online RF14, RF29).
const router = Router();
router.use(requiereModulo('ventas_online'));
const VER = requierePermiso('ventas_online.pedidos.ver'), FACTURAR = requierePermiso('ventas_online.facturacion.gestionar'), PESAR = requierePermiso('ventas_online.pesaje.registrar');
const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof TiendaInvalida) { const { status, ...extra } = err; return res.status(status ?? 400).json({ error: err.message, ...extra }); }
    next(err);
  }
};
const puede = async (req, permiso) => (await require('../middleware/requierePermiso').permisosDe(req)).niveles[permiso] === 'permitido';
const base = (req) => `${req.protocol}://${req.get('host')}/tienda/${req.body?.codigo_tienda ?? 'tienda'}`;

router.get('/pedidos/:id/comprobantes', VER, manejar(async (req, res) => res.json(await Facturacion.comprobantes(Number(req.params.id)))));
router.post('/pedidos/:id/facturar', FACTURAR, manejar(async (req, res) => {
  const r = await Facturacion.facturar(Number(req.params.id));
  await auditar(req, { modulo: 'ventas_online', accion: 'facturar_pedido', entidad: 'onl_pedidos', entidad_id: req.params.id, detalle: r.estado });
  res.json(r);
}));
router.post('/facturacion/reintentar', FACTURAR, manejar(async (req, res) => res.json(await Facturacion.reintentarPendientes())));
router.post('/pedidos/:id/alineacion', VER, manejar(async (req, res) => res.json(await Facturacion.alinear(Number(req.params.id)))));
router.post('/alineacion/recalcular', FACTURAR, manejar(async (req, res) => res.json(await Facturacion.alinearTodos())));
router.put('/facturacion/configuracion', requierePermiso('ventas_online.tienda.configurar'), manejar(async (req, res) => {
  const d = req.body ?? {}, campos = {};
  if (d.facturar_en !== undefined) { if (!['pago', 'despacho'].includes(d.facturar_en)) throw Object.assign(new TiendaInvalida('Se factura «al confirmarse el pago» (pago) o «al despachar» (despacho).'), { status: 400 }); campos.facturar_en = d.facturar_en; }
  for (const [k, max] of [['tolerancia_peso_pct', 100], ['tolerancia_peso_importe', 1e9]]) if (d[k] !== undefined) { if (d[k] !== null && !(Number(d[k]) >= 0 && Number(d[k]) <= max)) throw Object.assign(new TiendaInvalida(`${k} no es válido.`), { status: 400 }); campos[k] = d[k]; }
  if (d.aceptacion_horas !== undefined) { if (!Number.isInteger(d.aceptacion_horas) || d.aceptacion_horas < 1 || d.aceptacion_horas > 72) throw Object.assign(new TiendaInvalida('aceptacion_horas es un entero entre 1 y 72.'), { status: 400 }); campos.aceptacion_horas = d.aceptacion_horas; }
  const claves = Object.keys(campos);
  if (claves.length) await pool.query(`UPDATE onl_tienda SET ${claves.map((k) => `${k} = ?`).join(', ')} WHERE id = 1`, claves.map((k) => campos[k]));
  const [[t]] = await pool.query('SELECT facturar_en, tolerancia_peso_pct, tolerancia_peso_importe, aceptacion_horas FROM onl_tienda WHERE id = 1');
  await auditar(req, { modulo: 'ventas_online', accion: 'configurar_facturacion', entidad: 'onl_tienda', entidad_id: '1', detalle: JSON.stringify(t) });
  res.json(t);
}));

router.get('/pedidos/:id/pesaje', VER, manejar(async (req, res) => res.json(await Pesaje.estadoPesaje(Number(req.params.id)))));
router.post('/pedidos/:id/pesaje/:linea', PESAR, manejar(async (req, res) => {
  const r = await Pesaje.registrarPeso(Number(req.params.id), Number(req.params.linea), req.body ?? {}, { puedeManual: await puede(req, 'ventas_online.pesaje.manual') });
  await auditar(req, { modulo: 'ventas_online', accion: 'pesar_item', entidad: 'onl_pedidos', entidad_id: req.params.id, detalle: `línea ${req.params.linea}: ${req.body?.peso} (${r.estado})${req.body?.manual ? ' manual' : ''}` });
  res.json(r);
}));
router.post('/pedidos/:id/pesaje/:linea/solicitar-aceptacion', PESAR, manejar(async (req, res) => {
  const r = await Pesaje.solicitarAceptacion(Number(req.params.id), Number(req.params.linea), { baseUrl: `${req.protocol}://${req.get('host')}/tienda/${req.body?.codigo_tienda ?? (await pool.query('SELECT codigo FROM onl_tienda WHERE id = 1'))[0][0].codigo}` });
  const { _token, ...publico } = r;
  void _token;
  res.status(201).json(publico);
}));
void base;

module.exports = router;
