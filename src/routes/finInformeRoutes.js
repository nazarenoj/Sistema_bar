const { Router } = require('express');
const Proyeccion = require('../financiero/proyeccionService');
const Informes = require('../financiero/informeService');
const Divisas = require('../financiero/divisaService');
const Cuentas = require('../financiero/cuentaService');
const Movimientos = require('../financiero/movimientoService');
const { manejar } = require('../financiero/comun');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso, validarAutorizacion } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const { enviarReporte, FORMATOS_VALIDOS, FORMATO_POR_DEFECTO } = require('../servicios/reporteService');

// Informes y consultas de Financiero (RF13 a RF16): flujo de fondos, balance de actividad, historial de turnos, valuación de divisas, con exportación a CSV, Excel o PDF; y las
// operaciones de divisas (RF05, RF15) y la ratificación de una devolución que dejó la caja en negativo (RN42, EX31).
const router = Router();
router.use(requiereModulo('financiero'));
const INFORMES = requierePermiso('financiero.informes.ver');
const col = (key, label, tipo = 'texto', ancho = 16) => ({ key, label, tipo, ancho });
const exportar = async (req, res, datos, { titulo, subtitulo = '', resumen = [], hojas }) => {
  const formato = req.query.formato || 'json';
  if (formato === 'json') return res.json(datos);
  if (!FORMATOS_VALIDOS.includes(formato)) return res.status(400).json({ error: `"formato" debe ser uno de: json, ${FORMATOS_VALIDOS.join(', ')}.` });
  await enviarReporte(res, { titulo, subtitulo, filtros: Object.entries(req.query).filter(([k, v]) => v !== '' && k !== 'formato').map(([label, valor]) => ({ label, valor: String(valor) })), resumen, hojas }, formato || FORMATO_POR_DEFECTO);
};

router.get('/informes/flujo', INFORMES, manejar(async (req, res) => {
  const f = await Proyeccion.flujo({ periodo: req.query.periodo, dias: req.query.dias });
  if (req.query.real === '1') {
    const hoy = new Date().toISOString().slice(0, 10);
    for (const fila of f.filas) if (fila.periodo <= hoy && /^\d{4}-\d{2}-\d{2}$/.test(fila.periodo)) fila.real = await Proyeccion.real({ desde: fila.periodo, hasta: fila.periodo });
  }
  await exportar(req, res, f, { titulo: 'Flujo de fondos proyectado', subtitulo: `Por ${f.periodo}`, resumen: [{ label: 'Saldo actual', valor: f.saldo_actual, tipo: 'moneda' }],
    hojas: [{ nombre: 'Flujo', columnas: [col('periodo', 'Período', 'texto'), col('saldo_inicial', 'Saldo inicial', 'moneda'), col('ingresos', 'Ingresos', 'moneda'), col('egresos', 'Egresos', 'moneda'), col('saldo_final', 'Saldo final', 'moneda')], filas: f.filas }] });
}));
router.get('/informes/real-vs-proyectado', INFORMES, manejar(async (req, res) => res.json(await Proyeccion.real({ desde: req.query.desde, hasta: req.query.hasta }))));

router.get('/informes/balance', INFORMES, manejar(async (req, res) => {
  const b = await Informes.balance({ desde: req.query.desde, hasta: req.query.hasta, agrupar: req.query.agrupar, comparar: req.query.comparar === '1' });
  await exportar(req, res, b, { titulo: 'Balance de actividad', subtitulo: `${b.desde} a ${b.hasta} (lo percibido)`, resumen: [{ label: 'Ingresos', valor: b.ingresos, tipo: 'moneda' }, { label: 'Egresos', valor: b.egresos, tipo: 'moneda' }, { label: 'Resultado', valor: b.neto, tipo: 'moneda' }],
    hojas: [{ nombre: 'Balance', columnas: [col('grupo', b.agrupar === 'cuenta' ? 'Caja o cuenta' : 'Categoría', 'texto', 34), col('ingresos', 'Ingresos', 'moneda'), col('egresos', 'Egresos', 'moneda'), col('neto', 'Neto', 'moneda')], filas: b.filas }] });
}));
router.get('/informes/turnos', INFORMES, manejar(async (req, res) => {
  const t = await Informes.turnos({ desde: req.query.desde, hasta: req.query.hasta, cuentaId: req.query.cuenta_id, userId: req.query.user_id });
  await exportar(req, res, t, { titulo: 'Historial de turnos de caja', hojas: [
    { nombre: 'Turnos', columnas: [col('turno_id', 'Turno'), col('caja', 'Caja', 'texto', 22), col('cajero', 'Cajero'), col('estado', 'Estado'), col('reaperturas', 'Reaperturas'), col('diferencia', 'Diferencia', 'moneda')], filas: t.filas },
    { nombre: 'Por cajero', columnas: [col('cajero', 'Cajero'), col('turnos', 'Turnos'), col('faltantes', 'Faltantes', 'moneda'), col('sobrantes', 'Sobrantes', 'moneda'), col('neto', 'Neto', 'moneda')], filas: t.por_cajero }] });
}));
router.get('/informes/saldos', requierePermiso('financiero.saldos.ver'), manejar(async (req, res) => {
  const filas = await Cuentas.listar({ conSaldo: true, soloActivas: true });
  await exportar(req, res, filas, { titulo: 'Saldos por caja y cuenta', hojas: [{ nombre: 'Saldos', columnas: [col('nombre', 'Caja o cuenta', 'texto', 30), col('tipo', 'Tipo'), col('moneda', 'Moneda'), col('saldo', 'Saldo', 'moneda')], filas }] });
}));
router.get('/informes/movimientos', requierePermiso('financiero.movimientos.ver'), manejar(async (req, res) => {
  const q = req.query;
  const filas = await Movimientos.listar({ cuentaId: q.cuenta_id, tipo: q.tipo, desde: q.desde, hasta: q.hasta, turnoId: q.turno_id, docIdGlobal: q.venta, limite: q.limite ?? 500 });
  await exportar(req, res, filas, { titulo: 'Movimientos de fondos', hojas: [{ nombre: 'Movimientos', columnas: [col('id', 'N.º'), col('cuenta', 'Caja o cuenta', 'texto', 24), col('tipo', 'Tipo', 'texto', 22), col('importe', 'Importe', 'moneda'), col('moneda', 'Moneda'), col('forma_pago', 'Forma de pago', 'texto', 18), col('motivo', 'Motivo', 'texto', 34)], filas }] });
}));
router.get('/informes/valuacion', requierePermiso('financiero.saldos.ver'), manejar(async (req, res) => {
  const v = await Informes.valuacion();
  await exportar(req, res, v, { titulo: 'Valuación de moneda extranjera', resumen: [{ label: 'Total en pesos', valor: v.total_pesos, tipo: 'moneda' }, { label: 'Diferencia de cambio', valor: v.diferencia_cambio, tipo: 'moneda' }],
    hojas: [{ nombre: 'Valuación', columnas: [col('cuenta', 'Caja o cuenta', 'texto', 26), col('moneda', 'Moneda'), col('saldo', 'Saldo', 'moneda'), col('cotizacion', 'Cotización', 'moneda'), col('valor_pesos', 'Valor en pesos', 'moneda'), col('diferencia_cambio', 'Diferencia de cambio', 'moneda')], filas: v.filas }] });
}));

// Compra y venta de divisas (FIN-MONEDA-EXT, RN09): una cotización muy apartada de la vigente pide un supervisor.
router.get('/divisas/operaciones', INFORMES, manejar(async (req, res) => res.json(await Divisas.listar({ desde: req.query.desde, hasta: req.query.hasta }))));
router.post('/divisas/operaciones', requierePermiso('financiero.divisas.operar'), manejar(async (req, res) => {
  const o = await Divisas.operar(req.body, { userId: req.usuario.sub, autorizar: () => validarAutorizacion(req, 'financiero.divisas.operar') });
  await auditar(req, { modulo: 'financiero', accion: `${o.tipo}_divisa`, entidad: 'fin_operacion_divisa', entidad_id: String(o.id), detalle: `${o.importe_divisa} ${o.moneda} a ${o.cotizacion}${o.autorizado ? ' (autorizada)' : ''}` });
  res.status(201).json(o);
}));

// Ratificación de una devolución en efectivo que dejó la caja en negativo sin autorización previa: otro usuario con el permiso, con su credencial (EX31).
router.post('/movimientos/:id/ratificar', requierePermiso('financiero.diferencias.autorizar'), manejar(async (req, res) => {
  const r = await Movimientos.ratificar(Number(req.params.id), { autorizar: () => validarAutorizacion(req, 'financiero.diferencias.autorizar') });
  await auditar(req, { modulo: 'financiero', accion: 'ratificar_saldo_negativo', entidad: 'fin_movimiento', entidad_id: req.params.id, detalle: `autorizó ${r.autorizante}` });
  res.json(r);
}));

module.exports = router;
