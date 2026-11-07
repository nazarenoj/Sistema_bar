const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const Notificacion = require('../models/notificacionModel');
const Cuentas = require('./cuentaService');
const Gastos = require('./gastoService');
const { invalida, r2 } = require('./comun');

// Gastos recurrentes (Financiero RF12, FIN-GASTOS-REC): alquiler, abonos y servicios con importe estimado, periodicidad y próxima fecha. Generan recordatorios en el
// Centro de Notificaciones y alimentan el flujo de fondos (RF13). Cada período se genera una sola vez. Sin la función no hay gastos recurrentes ni recordatorios (RN27).
const PERIODOS = { semanal: { dias: 7 }, mensual: { meses: 1 }, bimestral: { meses: 2 }, trimestral: { meses: 3 }, semestral: { meses: 6 }, anual: { meses: 12 } };

const exigirFuncion = async () => {
  if (!(await Funciones.estaActiva('FIN-GASTOS-REC'))) throw invalida('Los gastos recurrentes necesitan la función FIN-GASTOS-REC.', 409, { codigo: 'FUNCION_INACTIVA' });
};

// La fecha siguiente a una periodicidad, conservando el día del mes cuando existe (31 de enero + 1 mes = 28 o 29 de febrero).
const siguiente = (iso, periodicidad, diaMes = null) => {
  const [a, m, dActual] = iso.split('-').map(Number);
  const d = diaMes ?? dActual;
  const p = PERIODOS[periodicidad];
  if (p.dias) { const f = new Date(Date.UTC(a, m - 1, dActual + p.dias)); return f.toISOString().slice(0, 10); }
  const total = (m - 1) + p.meses;
  const anio = a + Math.floor(total / 12), mes = total % 12;
  const ultimo = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate();
  return new Date(Date.UTC(anio, mes, Math.min(d, ultimo))).toISOString().slice(0, 10);
};

const vista = (r) => ({
  id: r.id, nombre: r.nombre, categoria_id: r.categoria_id, cuenta_id: r.cuenta_id, importe_estimado: Number(r.importe_estimado), periodicidad: r.periodicidad,
  proxima_fecha: r.proxima_fecha instanceof Date ? r.proxima_fecha.toISOString().slice(0, 10) : r.proxima_fecha, aviso_dias: r.aviso_dias, activo: !!r.activo,
});
const fila = async (id) => {
  const [[r]] = await pool.query('SELECT * FROM fin_gastos_recurrentes WHERE id = ?', [id]);
  if (!r) throw invalida('Gasto recurrente no encontrado.', 404);
  return r;
};

const validar = async (d, actual = {}) => {
  const nombre = String(d.nombre ?? actual.nombre ?? '').trim();
  if (!nombre || nombre.length > 80) throw invalida('Indicá el nombre (hasta 80 caracteres).');
  const importe = Number(d.importe_estimado ?? actual.importe_estimado);
  if (!(importe > 0)) throw invalida('El importe estimado debe ser mayor a cero.');
  const periodicidad = d.periodicidad ?? actual.periodicidad ?? 'mensual';
  if (!PERIODOS[periodicidad]) throw invalida(`La periodicidad debe ser una de: ${Object.keys(PERIODOS).join(', ')}.`);
  const proxima = Gastos.fechaISO(d.proxima_fecha ?? (actual.proxima_fecha instanceof Date ? actual.proxima_fecha.toISOString().slice(0, 10) : actual.proxima_fecha), 'La próxima fecha');
  const aviso = d.aviso_dias !== undefined ? Number(d.aviso_dias) : actual.aviso_dias ?? 3;
  if (!Number.isInteger(aviso) || aviso < 0 || aviso > 60) throw invalida('Los días de aviso son un entero entre 0 y 60.');
  const categoriaId = Number(d.categoria_id ?? actual.categoria_id), cuentaId = Number(d.cuenta_id ?? actual.cuenta_id);
  const [[cat]] = await pool.query('SELECT id FROM fin_categorias WHERE id = ? AND activa = 1', [categoriaId]);
  if (!cat) throw invalida('Elegí una categoría activa.');
  await Cuentas.obtenerFila(cuentaId);
  return { nombre, importe, periodicidad, proxima, aviso, categoriaId, cuentaId };
};

const crear = async (d) => {
  await exigirFuncion();
  const v = await validar(d);
  try {
    const [r] = await pool.query('INSERT INTO fin_gastos_recurrentes (nombre, categoria_id, cuenta_id, importe_estimado, periodicidad, proxima_fecha, dia_mes, aviso_dias) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [v.nombre, v.categoriaId, v.cuentaId, v.importe, v.periodicidad, v.proxima, Number(v.proxima.slice(8)), v.aviso]);
    return vista(await fila(r.insertId));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida(`Ya existe el gasto recurrente "${v.nombre}".`, 409);
    throw err;
  }
};
const actualizar = async (id, d) => {
  await exigirFuncion();
  const actual = await fila(id);
  const v = await validar(d, actual);
  try {
    await pool.query('UPDATE fin_gastos_recurrentes SET nombre = ?, categoria_id = ?, cuenta_id = ?, importe_estimado = ?, periodicidad = ?, proxima_fecha = ?, dia_mes = ?, aviso_dias = ?, activo = ? WHERE id = ?',
      [v.nombre, v.categoriaId, v.cuentaId, v.importe, v.periodicidad, v.proxima, Number(v.proxima.slice(8)), v.aviso, d.activo === undefined ? actual.activo : d.activo ? 1 : 0, id]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida(`Ya existe el gasto recurrente "${v.nombre}".`, 409);
    throw err;
  }
  return vista(await fila(id));
};
// Sin la función los datos se conservan para los informes históricos, pero no se muestran como activos (RN27).
const listar = async () => (await pool.query('SELECT * FROM fin_gastos_recurrentes ORDER BY proxima_fecha, nombre'))[0].map(vista);

// Paga la ocurrencia de la próxima fecha (con el importe real) y pasa a la siguiente: un período no se genera dos veces.
const pagar = async (id, d, ctx) => {
  await exigirFuncion();
  const r = await fila(id);
  if (!r.activo) throw invalida('El gasto recurrente está desactivado.', 409);
  const fecha = r.proxima_fecha instanceof Date ? r.proxima_fecha.toISOString().slice(0, 10) : r.proxima_fecha;
  const gasto = await Gastos.registrar({ fecha: d.fecha ?? fecha, categoria_id: r.categoria_id, cuenta_id: d.cuenta_id ?? r.cuenta_id, importe: d.importe ?? Number(r.importe_estimado), descripcion: r.nombre,
    comprobante: d.comprobante, proveedor: d.proveedor, origen: 'recurrente', recurrente_id: r.id, recurrente_fecha: fecha }, ctx);
  const proxima = siguiente(fecha, r.periodicidad, r.dia_mes);
  await pool.query('UPDATE fin_gastos_recurrentes SET proxima_fecha = ? WHERE id = ? AND proxima_fecha = ?', [proxima, id, fecha]);
  await Notificacion.resolverPorClave(`gasto-rec:${id}:${fecha}`, 'Se pagó el gasto');
  return { gasto, proxima_fecha: proxima };
};

// Recordatorios en el Centro de Notificaciones: uno por gasto y fecha, que se resuelve solo al pagarse (RF12).
const recordatorios = async (hoy = new Date().toISOString().slice(0, 10)) => {
  if (!(await Funciones.estaActiva('FIN-GASTOS-REC'))) return { emitidos: 0 };
  const [filas] = await pool.query('SELECT * FROM fin_gastos_recurrentes WHERE activo = 1');
  let emitidos = 0;
  for (const r of filas) {
    const fecha = r.proxima_fecha instanceof Date ? r.proxima_fecha.toISOString().slice(0, 10) : r.proxima_fecha;
    const limite = new Date(`${fecha}T00:00:00Z`).getTime() - r.aviso_dias * 86400000;
    if (new Date(`${hoy}T00:00:00Z`).getTime() < limite) continue;
    const vencido = fecha < hoy;
    await Notificacion.crear({ modulo: 'financiero', tipo: 'gasto_recurrente', severidad: vencido ? 'alta' : 'media', roles: ['gerente', 'administrativo'], clave: `gasto-rec:${r.id}:${fecha}`,
      mensaje: `${vencido ? 'Vencido' : 'Por vencer'}: ${r.nombre} (${r2(r.importe_estimado)}) el ${fecha}.` });
    emitidos++;
  }
  return { emitidos };
};

module.exports = { siguiente, crear, actualizar, listar, pagar, recordatorios };
