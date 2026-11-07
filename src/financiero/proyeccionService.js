const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const Funciones = require('../funciones/servicio');
const Cuentas = require('./cuentaService');
const Recurrentes = require('./gastoRecurrenteService');
const { invalida, r2 } = require('./comun');

// Proyección de fondos (Financiero RF13): parte del saldo actual de cajas y cuentas y suma los ingresos esperados (acreditaciones pendientes, cheques en cartera, vencimientos de
// clientes) y resta los egresos esperados (cheques propios, gastos recurrentes, vencimientos de proveedores). Los componentes cuyo módulo o función no está presente se omiten sin error.
// Financiero no consulta a Clientes ni a Compras: ellos publican sus vencimientos por evento (RN37).
const hoyISO = () => new Date().toISOString().slice(0, 10);
const iso = (f) => (f instanceof Date ? f.toISOString().slice(0, 10) : f);
const suma = (iso0, dias) => new Date(new Date(`${iso0}T00:00:00Z`).getTime() + dias * 86400000).toISOString().slice(0, 10);

const receptorVencimientos = (origen, sentido) => async (conn, c) => {
  const version = Number(c.generado_ms ?? Date.now());
  const [[vig]] = await conn.query('SELECT MAX(version_ms) AS v FROM fin_vencimientos_externos WHERE origen = ?', [origen]);
  if (vig?.v && Number(vig.v) >= version) return { ignorado: true, motivo: 'Hay una foto más nueva de los vencimientos.' };
  await conn.query('DELETE FROM fin_vencimientos_externos WHERE origen = ?', [origen]);
  for (const v of c.vencimientos ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v.fecha)) || !(Number(v.importe) > 0)) throw new M.RechazoNegocio('Un vencimiento tiene fecha o importe inválidos.');
    await conn.query('INSERT INTO fin_vencimientos_externos (origen, sentido, fecha, importe, version_ms) VALUES (?, ?, ?, ?, ?)', [origen, sentido, v.fecha, r2(v.importe), version]);
  }
  return { vencimientos: (c.vencimientos ?? []).length };
};
M.registrarReceptor('financiero', 'vencimientos_por_cobrar', receptorVencimientos('clientes', 'cobrar'));
M.registrarReceptor('financiero', 'vencimientos_por_pagar', receptorVencimientos('compras', 'pagar'));

// Lo que hoy tienen las cajas y cuentas en pesos, sin contar los procesadores ni las pasarelas (su plata está en los créditos a acreditar, que se suman aparte).
const saldoActual = async () => {
  const [[r]] = await pool.query(
    `SELECT COALESCE(SUM(c.saldo_inicial + COALESCE(s.total, 0)), 0) AS saldo FROM fin_cuentas c LEFT JOIN (SELECT cuenta_id, SUM(importe) AS total FROM fin_movimientos GROUP BY cuenta_id) s ON s.cuenta_id = c.id
     WHERE c.activa = 1 AND c.moneda = 'ARS' AND c.tipo NOT IN ('procesador', 'pasarela')`);
  return r2(r.saldo);
};

const eventos = async (hasta) => {
  const out = [], componentes = [];
  const [acr] = await pool.query("SELECT fecha_estimada, bruto, comision_estimada FROM fin_acreditaciones WHERE estado = 'pendiente' AND fecha_estimada <= ?", [hasta]);
  componentes.push('acreditaciones');
  for (const a of acr) out.push({ fecha: iso(a.fecha_estimada), importe: r2(Number(a.bruto) - Number(a.comision_estimada)), fuente: 'acreditaciones' });
  if (await Funciones.estaActiva('FIN-CHEQUES')) {
    componentes.push('cheques');
    const [ch] = await pool.query("SELECT fecha_pago, importe, origen FROM fin_cheques WHERE estado = 'en_cartera' AND moneda = 'ARS' AND fecha_pago <= ?", [hasta]);
    for (const c of ch) out.push({ fecha: iso(c.fecha_pago), importe: c.origen === 'tercero' ? Number(c.importe) : -Number(c.importe), fuente: c.origen === 'tercero' ? 'cheques_cartera' : 'cheques_propios' });
  }
  if (await Funciones.estaActiva('FIN-GASTOS-REC')) {
    componentes.push('gastos_recurrentes');
    const [gr] = await pool.query('SELECT * FROM fin_gastos_recurrentes WHERE activo = 1');
    for (const g of gr) {
      let f = iso(g.proxima_fecha);
      for (let i = 0; f <= hasta && i < 400; i++) { out.push({ fecha: f, importe: -Number(g.importe_estimado), fuente: 'gastos_recurrentes' }); f = Recurrentes.siguiente(f, g.periodicidad, g.dia_mes); }
    }
  }
  const [ven] = await pool.query('SELECT origen, sentido, fecha, importe FROM fin_vencimientos_externos WHERE fecha <= ?', [hasta]);
  if (ven.length) componentes.push(...new Set(ven.map((v) => `vencimientos_${v.origen}`)));
  for (const v of ven) out.push({ fecha: iso(v.fecha), importe: v.sentido === 'cobrar' ? Number(v.importe) : -Number(v.importe), fuente: `vencimientos_${v.origen}` });
  return { eventos: out, componentes: [...new Set(componentes)] };
};

const clave = (fecha, periodo) => {
  if (periodo === 'mes') return fecha.slice(0, 7);
  if (periodo === 'semana') { const d = new Date(`${fecha}T00:00:00Z`); const dow = (d.getUTCDay() + 6) % 7; return suma(fecha, -dow); }
  return fecha;
};

const flujo = async ({ periodo = 'dia', dias } = {}) => {
  if (!['dia', 'semana', 'mes'].includes(periodo)) throw invalida('El período es dia, semana o mes.');
  const horizonte = dias === undefined ? { dia: 30, semana: 84, mes: 365 }[periodo] : Number(dias);
  if (!Number.isInteger(horizonte) || horizonte < 1 || horizonte > 730) throw invalida('El horizonte es un entero de días entre 1 y 730.');
  const hoy = hoyISO(), hasta = suma(hoy, horizonte);
  const inicial = await saldoActual();
  const { eventos: ev, componentes } = await eventos(hasta);
  const cubetas = new Map();
  const dar = (k) => { if (!cubetas.has(k)) cubetas.set(k, { periodo: k, ingresos: 0, egresos: 0 }); return cubetas.get(k); };
  // Lo vencido (fechas pasadas sin cumplir) cuenta en el primer período: todavía se espera.
  for (const e of ev) { const c = dar(clave(e.fecha < hoy ? hoy : e.fecha, periodo)); if (e.importe >= 0) c.ingresos += e.importe; else c.egresos -= e.importe; }
  dar(clave(hoy, periodo));
  let saldo = inicial;
  const filas = [...cubetas.values()].sort((a, b) => (a.periodo < b.periodo ? -1 : 1)).map((c) => {
    const f = { periodo: c.periodo, saldo_inicial: r2(saldo), ingresos: r2(c.ingresos), egresos: r2(c.egresos), saldo_final: r2(saldo + c.ingresos - c.egresos) };
    saldo = f.saldo_final;
    return f;
  });
  return { periodo, hasta, saldo_actual: inicial, componentes, filas };
};

// Saldo proyectado al final de un horizonte (para el tablero, RF25).
const saldoProyectado = async (dias) => {
  const f = await flujo({ periodo: 'dia', dias });
  return f.filas.length ? f.filas[f.filas.length - 1].saldo_final : f.saldo_actual;
};

// Lo real contra lo proyectado: para períodos ya transcurridos, los ingresos y egresos efectivos de cajas y cuentas.
const real = async ({ desde, hasta }) => {
  const [filas] = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN m.importe > 0 THEN m.importe END), 0) AS ingresos, COALESCE(SUM(CASE WHEN m.importe < 0 THEN -m.importe END), 0) AS egresos FROM fin_movimientos m JOIN fin_cuentas c ON c.id = m.cuenta_id
     WHERE m.moneda = 'ARS' AND c.tipo NOT IN ('procesador', 'pasarela') AND m.tipo NOT IN ('transferencia', 'compensacion') AND m.fecha_ms BETWEEN ? AND ?`,
    [new Date(`${desde}T00:00:00`).getTime(), new Date(`${hasta}T23:59:59.999`).getTime()]);
  return { ingresos: r2(filas[0].ingresos), egresos: r2(filas[0].egresos) };
};

module.exports = { flujo, saldoProyectado, saldoActual, real };
