const { Router } = require('express');
const C = require('../servicios/consolidacionService');
const Funciones = require('../funciones/servicio');
const requiereFuncion = require('../middleware/requiereFuncion');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const { enviarReporte, FORMATOS_VALIDOS, FORMATO_POR_DEFECTO } = require('../servicios/reporteService');

// Consolidación de sucursales (Usuarios RF20). Gestionar: Administrador. Ver el control y los informes: permiso aparte.
const router = Router();
const gestiona = requierePermiso('usuarios.consolidacion.gestionar');
const ve = requierePermiso('usuarios.consolidacion.ver');
router.use(requiereFuncion('USU-CONSOL'));

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof C.ConsolidacionInvalida) return res.status(err.status ?? 400).json({ error: err.message, codigo: err.codigo });
    next(err);
  }
};

router.get('/configuracion', gestiona, manejar(async (req, res) => res.json(await C.estado())));
router.put('/configuracion', gestiona, manejar(async (req, res) => {
  const e = await C.configurar(req.body);
  await auditar(req, { modulo: 'consolidacion', accion: 'marcar_instancia', entidad: 'instancia', entidad_id: '1', detalle: `sucursal=${e.sucursal} casa_central=${e.casa_central}` });
  res.json(e);
}));

router.post('/publicar', gestiona, manejar(async (req, res) => res.status(201).json(await C.publicar(req.body))));
router.get('/publicados', gestiona, manejar(async (req, res) => res.json(await C.publicados())));
router.get('/publicados/:id/archivo', gestiona, manejar(async (req, res) => {
  const s = await C.sobreDe(req.params.id);
  res.set('Content-Disposition', `attachment; filename="${s.id_paquete}.json"`).json(s);
}));
router.post('/enviar', gestiona, manejar(async (req, res) => res.json(await C.enviarPendientes())));

router.get('/sucursales', ve, manejar(async (req, res) => res.json(await C.sucursales())));
router.post('/sucursales', gestiona, manejar(async (req, res) => {
  const s = await C.registrarSucursal(req.body);
  await auditar(req, { modulo: 'consolidacion', accion: 'alta_sucursal', entidad: 'sucursal', entidad_id: s.codigo, detalle: s.nombre });
  res.status(201).json(s);
}));
router.put('/sucursales/:codigo/activa', gestiona, manejar(async (req, res) => res.json(await C.activarSucursal(req.params.codigo, !!req.body.activa))));

// Importar el archivo (descarga o medio extraíble) y reintentar los que esperaban una versión compatible.
router.post('/importar', gestiona, manejar(async (req, res) => {
  const r = await C.importar(req.body);
  await auditar(req, { modulo: 'consolidacion', accion: 'importar', entidad: 'paquete', entidad_id: r.id_paquete ?? '-', detalle: r.importado ? 'importado' : (r.mensaje ?? r.motivo ?? 'no importado') });
  res.status(r.rechazado ? 422 : 200).json(r);
}));
router.post('/reintentar-pendientes', gestiona, manejar(async (req, res) => res.json(await C.reintentarPendientes())));
router.get('/paquetes', ve, manejar(async (req, res) => res.json(await C.recibidos())));
router.get('/control', ve, manejar(async (req, res) => res.json(await C.control())));

const informe = (fn, titulo, hojas) => manejar(async (req, res) => {
  const formato = req.query.formato || FORMATO_POR_DEFECTO;
  if (!FORMATOS_VALIDOS.includes(formato)) return res.status(400).json({ error: `"formato" debe ser uno de: ${FORMATOS_VALIDOS.join(', ')}.` });
  const data = await fn(req.query);
  if (formato === 'json') return res.json(data);
  await enviarReporte(res, {
    titulo, subtitulo: `${data.desde} a ${data.hasta}${data.incompleto.length ? ' — INCOMPLETO: faltan paquetes' : ''}`, filtros: [], resumen: [],
    hojas: hojas.map((h) => ({ nombre: h.nombre, columnas: h.columnas, filas: data[h.clave] })),
  }, formato, titulo.toLowerCase().replace(/\s+/g, '-'));
});
const col = (key, label, tipo = 'texto', ancho = 16) => ({ key, label, tipo, ancho });
router.get('/informes/ventas', ve, informe(C.informeVentas, 'Ventas consolidadas', [
  { nombre: 'Totales', clave: 'totales', columnas: [col('sucursal', 'Sucursal'), col('ventas', 'Ventas', 'numero'), col('importe', 'Importe', 'moneda'), col('anulaciones', 'Anulaciones', 'numero'), col('devoluciones', 'Devoluciones', 'moneda')] },
  { nombre: 'Por producto', clave: 'por_producto', columnas: [col('sucursal', 'Sucursal'), col('producto', 'Producto', 'texto', 30), col('cantidad', 'Cantidad', 'numero'), col('importe', 'Importe', 'moneda')] },
  { nombre: 'Por forma de pago', clave: 'por_forma_pago', columnas: [col('sucursal', 'Sucursal'), col('forma', 'Forma de pago'), col('importe', 'Importe', 'moneda')] },
]));
router.get('/informes/stock', ve, informe(C.informeStock, 'Stock consolidado', [
  { nombre: 'Existencias', clave: 'existencias', columnas: [col('sucursal', 'Sucursal'), col('al', 'Al'), col('item', 'Ítem', 'texto', 30), col('cantidad', 'Cantidad', 'numero'), col('valor', 'Valor', 'moneda')] },
  { nombre: 'Mermas', clave: 'mermas', columnas: [col('sucursal', 'Sucursal'), col('motivo', 'Motivo', 'texto', 24), col('cantidad', 'Cantidad', 'numero'), col('valor', 'Valor', 'moneda')] },
]));

// Envío automático desde otra sucursal: sin sesión, pero el paquete se acepta solo con firma válida de una sucursal registrada (EX20).
router.recibir = async (req, res, next) => {
  try {
    if (!(await Funciones.estaActiva('USU-CONSOL'))) return res.status(409).json({ error: 'La función USU-CONSOL está desactivada.' });
    const r = await C.importar(req.body);
    res.status(r.rechazado ? 422 : 200).json(r);
  } catch (err) {
    if (err instanceof C.ConsolidacionInvalida) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

module.exports = router;
