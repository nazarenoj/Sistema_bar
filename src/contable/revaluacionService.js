const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const Monedas = require('../servicios/monedaService');
const Asientos = require('./asientoService');
const Cuentas = require('./cuentaService');
const { invalida, r2, iso } = require('./comun');

// Revaluación de moneda extranjera (Contable RF09, RN10, EX05) [CON-REVALUACION]: al cierre de cada período se propone el asiento de diferencia de cambio de las cuentas en divisa, con la cotización
// de cierre: comprador para los activos y vendedor para los pasivos. Sin cotización no se genera y se pide.
const exigirFuncion = async () => {
  if (!(await Funciones.estaActiva('CON-REVALUACION'))) throw invalida('La función CON-REVALUACION está desactivada.', 409, { codigo: 'FUNCION_DESACTIVADA' });
};

const periodoDe = async (periodo) => {
  if (!/^\d{4}-\d{2}$/.test(String(periodo ?? ''))) throw invalida('El período va como AAAA-MM.');
  const [anio, mes] = periodo.split('-').map(Number);
  const [[p]] = await pool.query('SELECT * FROM con_periodos WHERE anio = ? AND mes = ?', [anio, mes]);
  if (!p) throw invalida('Ese período no existe.', 404);
  const hasta = `${periodo}-${String(new Date(anio, mes, 0).getDate()).padStart(2, '0')}`;
  return { p, hasta };
};

const cotizacionDe = async (moneda, hasta, dadas) => {
  const d = dadas?.[moneda];
  if (d && Number(d.comprador) > 0 && Number(d.vendedor) > 0) return { comprador: Number(d.comprador), vendedor: Number(d.vendedor), origen: 'indicada' };
  const v = await Monedas.vigente(moneda, `${hasta} 23:59:59`).catch(() => null);
  return v ? { comprador: Number(v.comprador), vendedor: Number(v.vendedor), origen: 'registrada' } : null;
};

const propuesta = async ({ periodo, cotizaciones } = {}) => {
  await exigirFuncion();
  const { p, hasta } = await periodoDe(periodo);
  const [cuentas] = await pool.query("SELECT id, codigo, nombre, tipo, moneda FROM con_cuentas WHERE moneda <> 'ARS' AND tipo IN ('activo', 'pasivo') AND imputable = 1");
  const lineas = [], cotiz = {}, faltantes = new Set();
  const ganancia = await Cuentas.porClave('diferencias_cambio_pos'), perdida = await Cuentas.porClave('diferencias_cambio');
  for (const c of cuentas) {
    const [[s]] = await pool.query(`SELECT COALESCE(SUM(l.debe - l.haber), 0) AS libro,
        COALESCE(SUM(CASE WHEN l.importe_divisa IS NULL THEN 0 WHEN l.debe > 0 THEN l.importe_divisa ELSE -l.importe_divisa END), 0) AS divisa
      FROM con_asiento_lineas l JOIN con_asientos a ON a.id = l.asiento_id WHERE l.cuenta_id = ? AND a.fecha <= ?`, [c.id, hasta]);
    const signo = c.tipo === 'activo' ? 1 : -1;
    const libro = r2(Number(s.libro) * signo), divisa = Number(s.divisa) * signo;
    if (divisa === 0 && libro === 0) continue;
    const q = cotiz[c.moneda] ?? (cotiz[c.moneda] = await cotizacionDe(c.moneda, hasta, cotizaciones));
    if (!q) { faltantes.add(c.moneda); continue; }
    const objetivo = r2(divisa * (c.tipo === 'activo' ? q.comprador : q.vendedor));
    const diferencia = r2(objetivo - libro);
    if (diferencia === 0) continue;
    // Activo: sube = ganancia; pasivo: sube = pérdida.
    const esGanancia = c.tipo === 'activo' ? diferencia > 0 : diferencia < 0;
    const cuentaResultado = esGanancia ? ganancia : perdida;
    if (!cuentaResultado) throw invalida('El plan necesita las cuentas de diferencia de cambio.', 409, { codigo: 'SIN_CUENTAS_DE_CAMBIO' });
    const monto = Math.abs(diferencia);
    const sube = diferencia > 0; // el saldo natural de la cuenta aumenta
    const ladoCuenta = (c.tipo === 'activo') === sube ? 'debe' : 'haber';
    lineas.push({ cuenta_id: c.id, codigo: c.codigo, nombre: c.nombre, debe: ladoCuenta === 'debe' ? monto : 0, haber: ladoCuenta === 'haber' ? monto : 0, detalle: `Revaluación ${c.moneda}`, moneda: c.moneda, saldo_libro: libro, saldo_revaluado: objetivo });
    lineas.push({ cuenta_id: cuentaResultado.id, codigo: cuentaResultado.codigo, nombre: cuentaResultado.nombre, debe: ladoCuenta === 'debe' ? 0 : monto, haber: ladoCuenta === 'debe' ? monto : 0, detalle: `Revaluación ${c.moneda}` });
  }
  if (faltantes.size) throw invalida(`Falta la cotización de cierre de ${[...faltantes].join(', ')}: cargala o indicala para revaluar.`, 409, { codigo: 'SIN_COTIZACION', monedas: [...faltantes] }); // EX05
  const [[ya]] = await pool.query('SELECT asiento_id FROM con_revaluaciones WHERE periodo_id = ?', [p.id]);
  return { periodo, fecha: hasta, estado_periodo: p.estado, registrada: !!ya, asiento_id: ya?.asiento_id ?? null, cotizaciones: cotiz, lineas };
};

const registrar = async ({ periodo, cotizaciones } = {}, usuarioId, idSolicitud = null) => {
  const prop = await propuesta({ periodo, cotizaciones });
  if (prop.registrada) throw invalida('La revaluación de ese período ya está registrada.', 409, { codigo: 'YA_REGISTRADA' });
  if (!prop.lineas.length) throw invalida('No hay diferencias de cambio para registrar.', 409, { codigo: 'SIN_DIFERENCIAS' });
  const { p } = await periodoDe(periodo);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const a = await Asientos.crear(conn, { fecha: prop.fecha, tipo: 'revaluacion', leyenda: `Revaluación de moneda extranjera ${periodo}`, usuarioId, idSolicitud, exacto: true,
      lineas: prop.lineas.map((l) => ({ cuenta_id: l.cuenta_id, debe: l.debe, haber: l.haber, detalle: l.detalle })) });
    await conn.query('INSERT INTO con_revaluaciones (periodo_id, asiento_id, ms, usuario_id, cotizaciones) VALUES (?, ?, ?, ?, ?)', [p.id, a.id, Date.now(), usuarioId ?? null, JSON.stringify(prop.cotizaciones)]);
    await conn.commit();
    return { asiento_id: a.id, numero: a.numero, fecha: iso(prop.fecha) };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

module.exports = { propuesta, registrar };
