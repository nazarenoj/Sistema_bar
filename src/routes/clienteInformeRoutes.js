const { Router } = require('express');
const Informes = require('../clientes/informesService');
const Retiros = require('../clientes/retiroService');
const Cuentas = require('../clientes/cuentaService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const { enviarReporte, FORMATOS_VALIDOS, FORMATO_POR_DEFECTO } = require('../servicios/reporteService');

// Estado de cuenta e informes de cuentas corrientes (Clientes y CC RF14, RF15, RF16). Filtros combinables y exportación a CSV, Excel o PDF.
const router = Router();
router.use(requiereModulo('clientes'));
const VER = requierePermiso('clientes.ver');

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Informes.InformeInvalido || err instanceof Cuentas.CuentaInvalida || err instanceof Retiros.RetiroInvalido) { const { status, message, ...resto } = err; return res.status(status ?? 400).json({ error: message, ...resto }); }
    next(err);
  }
};
const col = (key, label, tipo = 'texto', ancho = 16) => ({ key, label, tipo, ancho });
// Responde en JSON o exporta: `formato` = csv, xlsx o pdf.
const exportar = async (req, res, datos, { titulo, subtitulo = '', resumen = [], hojas }) => {
  const formato = req.query.formato || 'json';
  if (formato === 'json') return res.json(datos);
  if (!FORMATOS_VALIDOS.includes(formato)) return res.status(400).json({ error: `"formato" debe ser uno de: json, ${FORMATOS_VALIDOS.join(', ')}.` });
  await enviarReporte(res, { titulo, subtitulo, filtros: Object.entries(req.query).filter(([k, v]) => v !== '' && k !== 'formato').map(([label, valor]) => ({ label, valor: String(valor) })), resumen, hojas }, formato || FORMATO_POR_DEFECTO, titulo.toLowerCase().replace(/\s+/g, '-'));
};

router.get('/estado-cuenta/:cuentaId', VER, manejar(async (req, res) => {
  const e = await Informes.estadoDeCuenta(Number(req.params.cuentaId), req.query);
  await exportar(req, res, e, { titulo: 'Estado de cuenta', subtitulo: `${e.cliente.razon_social} — ${e.moneda}`,
    resumen: [{ label: 'Saldo inicial', valor: e.saldo_inicial, tipo: 'moneda' }, { label: 'Saldo final', valor: e.saldo_final, tipo: 'moneda' }],
    hojas: [{ nombre: 'Movimientos', columnas: [col('fecha', 'Fecha', 'fecha'), col('tipo', 'Tipo'), col('comprobante_ref', 'Comprobante', 'texto', 22), col('debe', 'Debe', 'moneda'), col('haber', 'Haber', 'moneda'), col('saldo', 'Saldo', 'moneda')], filas: e.movimientos },
      { nombre: 'Pendientes', columnas: [col('comprobante_ref', 'Comprobante', 'texto', 22), col('fecha', 'Fecha', 'fecha'), col('fecha_vencimiento', 'Vence', 'fecha'), col('saldo_pendiente', 'Saldo', 'moneda')], filas: e.composicion }] });
}));
router.post('/estado-cuenta/:cuentaId/enviar', requierePermiso('clientes.cuentas.gestionar'), manejar(async (req, res) => {
  const e = await Informes.enviarEstado(Number(req.params.cuentaId), req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'clientes', accion: 'enviar_estado_cuenta', entidad: 'cuenta', entidad_id: req.params.cuentaId, detalle: e.destino });
  res.status(201).json(e);
}));
router.get('/envios', VER, manejar(async (req, res) => res.json(await Informes.envios({ cliente_id: req.query.cliente_id ? Number(req.query.cliente_id) : undefined }))));
router.post('/recordatorios', requierePermiso('clientes.cuentas.gestionar'), manejar(async (req, res) => res.json(await Informes.recordatorios())));

router.get('/tramos', VER, manejar(async (req, res) => res.json(await Informes.tramos())));
router.put('/tramos', requierePermiso('clientes.cuentas.gestionar'), manejar(async (req, res) => res.json(await Informes.configurarTramos(req.body.tramos))));
router.get('/antiguedad', VER, manejar(async (req, res) => {
  const a = await Informes.antiguedad(req.query);
  await exportar(req, res, a, { titulo: 'Antigüedad de saldos', resumen: [{ label: 'Deuda total', valor: a.total, tipo: 'moneda' }],
    hojas: [{ nombre: 'Antigüedad', columnas: [col('cliente', 'Cliente', 'texto', 30), col('moneda', 'Moneda', 'texto', 8), ...a.tramos.map((t, i) => col(`t${i}`, `${t} días`, 'moneda')), col('total', 'Total', 'moneda'), col('saldo_a_favor', 'Saldo a favor', 'moneda')], filas: a.clientes }] });
}));
router.get('/deudores', VER, manejar(async (req, res) => {
  const d = await Informes.deudores(req.query);
  await exportar(req, res, d, { titulo: 'Deudores', resumen: [{ label: 'Total vencido', valor: d.total_vencido, tipo: 'moneda' }],
    hojas: [{ nombre: 'Deudores', columnas: [col('cliente', 'Cliente', 'texto', 30), col('telefono', 'Teléfono'), col('comprobantes_vencidos', 'Vencidos', 'numero'), col('importe_vencido', 'Importe vencido', 'moneda'), col('dias_mora', 'Días de mora', 'numero'), col('saldo', 'Saldo', 'moneda')], filas: d.deudores }] });
}));
router.get('/cobranzas', VER, manejar(async (req, res) => {
  const c = await Informes.cobranzas(req.query);
  await exportar(req, res, c, { titulo: 'Cobranzas', resumen: [{ label: 'Total cobrado', valor: c.total, tipo: 'moneda' }],
    hojas: [{ nombre: 'Por forma de pago', columnas: [col('forma', 'Forma de pago'), col('recibos', 'Recibos', 'numero'), col('importe', 'Importe', 'moneda')], filas: c.por_forma }, { nombre: 'Por día', columnas: [col('fecha', 'Fecha', 'fecha'), col('importe', 'Importe', 'moneda')], filas: c.por_dia }] });
}));
router.get('/retenciones', VER, manejar(async (req, res) => {
  const r = await Informes.retenciones(req.query);
  await exportar(req, res, r, { titulo: 'Retenciones sufridas', resumen: [{ label: 'Total retenido', valor: r.total, tipo: 'moneda' }],
    hojas: [{ nombre: 'Retenciones', columnas: [col('fecha', 'Fecha', 'fecha'), col('cliente', 'Cliente', 'texto', 28), col('impuesto', 'Impuesto'), col('regimen', 'Régimen'), col('jurisdiccion', 'Jurisdicción'), col('nro_certificado', 'Certificado', 'texto', 20), col('recibo', 'Recibo', 'texto', 18), col('importe', 'Importe', 'moneda')], filas: r.retenciones }] });
}));
// Clientes alcanzados por un retiro de lote (RF30; requiere Stock con STK-TRAZA): el alcance que informa Stock con el contacto de cada cliente, y el aviso por línea.
router.get('/retiros/:retiroId/alcance', VER, manejar(async (req, res) => {
  const a = await Retiros.alcance(Number(req.params.retiroId));
  await exportar(req, res, a, { titulo: 'Clientes alcanzados por un retiro de lote', subtitulo: `${a.lote}: ${a.motivo}`, resumen: [{ label: 'Clientes alcanzados', valor: a.clientes_alcanzados, tipo: 'numero' }, { label: 'Líneas sin cliente identificado', valor: a.sin_cliente, tipo: 'numero' }],
    hojas: [{ nombre: 'Alcance', columnas: [col('comprobante', 'Comprobante', 'texto', 30), col('fecha', 'Fecha', 'fecha'), col('articulo', 'Artículo', 'texto', 24), col('lote', 'Lote'), col('cantidad', 'Cantidad', 'numero'), col('estado_aviso', 'Aviso'), col('cliente', 'Cliente', 'texto', 28), col('telefono', 'Teléfono'), col('email', 'Correo', 'texto', 26), col('domicilio', 'Domicilio', 'texto', 30)],
      filas: a.lineas.map((l) => ({ ...l, cliente: l.contacto?.cliente ?? 'Sin cliente identificado', telefono: l.contacto?.telefono ?? '', email: l.contacto?.email ?? '', domicilio: l.contacto?.domicilio ?? '' })) }] });
}));
router.post('/retiros/lineas/:lineaId/avisado', requierePermiso('clientes.retiros.avisar'), manejar(async (req, res) => {
  const r = await Retiros.marcarAvisado(Number(req.params.lineaId), req.body, { userId: req.usuario?.sub });
  await auditar(req, { modulo: 'clientes', accion: 'aviso_retiro', entidad: 'retiro_linea', entidad_id: req.params.lineaId, detalle: req.body.medio });
  res.json(r);
}));
router.get('/proyeccion', VER, manejar(async (req, res) => {
  const p = await Informes.proyeccion(req.query);
  await exportar(req, res, p, { titulo: 'Proyección de cobros', resumen: [{ label: 'Total a cobrar', valor: p.total, tipo: 'moneda' }],
    hojas: [{ nombre: 'Por vencimiento', columnas: [col('fecha', 'Vencimiento', 'fecha'), col('comprobantes', 'Comprobantes', 'numero'), col('importe', 'Importe', 'moneda'), col('acumulado', 'Acumulado', 'moneda')], filas: p.dias }] });
}));

module.exports = router;
