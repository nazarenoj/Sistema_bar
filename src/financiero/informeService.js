const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const Monedas = require('../servicios/monedaService');
const Cuentas = require('./cuentaService');
const { invalida, r2 } = require('./comun');

// Informes de Financiero (RF14, RF16, RF15). Balance de actividad con el criterio de lo percibido (RN16): una venta a cuenta corriente cuenta recién cuando se cobra.
const iso = (f) => (f instanceof Date ? f.toISOString().slice(0, 10) : f);
const rango = (desde, hasta) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(desde ?? '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(hasta ?? '')) || desde > hasta) throw invalida('Indicá el período (desde y hasta, AAAA-MM-DD).');
  return [new Date(`${desde}T00:00:00`).getTime(), new Date(`${hasta}T23:59:59.999`).getTime()];
};
const dias = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000) + 1;
const suma = (f, n) => new Date(new Date(`${f}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

// Lo que se mueve entre cuentas propias o se compensa no es ingreso ni egreso. Los cobros sin categoría son ventas; el resto de los conceptos tiene un nombre por defecto.
const INTERNOS = ['transferencia', 'liquidacion', 'acreditacion', 'compensacion', 'compra_divisa', 'venta_divisa'];
const ETIQUETA = `CASE
  WHEN m.tipo IN ('cobro', 'devolucion') OR (m.tipo = 'ajuste' AND m.forma_pago IS NOT NULL) THEN 'Ventas'
  WHEN m.tipo IN ('cheque_acreditado', 'cheque_rechazado') THEN 'Cobranzas por cheque'
  WHEN m.tipo IN ('ingreso', 'retiro') THEN 'Ingresos y retiros manuales'
  WHEN m.tipo = 'acreditacion_sin_cobro' THEN 'Cupones sin cobro asociado'
  ELSE 'Sin categoría' END`;

const balanceUno = async (desde, hasta, agrupar) => {
  const [d, h] = rango(desde, hasta);
  const grupo = agrupar === 'cuenta' ? 'c.nombre' : `COALESCE(k.nombre, ${ETIQUETA})`;
  const [filas] = await pool.query(
    `SELECT ${grupo} AS grupo, COALESCE(SUM(CASE WHEN m.importe > 0 THEN m.importe END), 0) AS ingresos, COALESCE(SUM(CASE WHEN m.importe < 0 THEN -m.importe END), 0) AS egresos
     FROM fin_movimientos m JOIN fin_cuentas c ON c.id = m.cuenta_id LEFT JOIN fin_categorias k ON k.id = m.categoria_id
     WHERE m.moneda = 'ARS' AND m.tipo NOT IN (?) AND NOT (m.tipo = 'ajuste' AND m.forma_pago IS NULL) AND m.fecha_ms BETWEEN ? AND ? GROUP BY grupo ORDER BY grupo`, [INTERNOS, d, h]);
  const lista = filas.map((f) => ({ grupo: f.grupo, ingresos: r2(f.ingresos), egresos: r2(f.egresos), neto: r2(f.ingresos - f.egresos) }));
  return { desde, hasta, filas: lista, ingresos: r2(lista.reduce((a, f) => a + f.ingresos, 0)), egresos: r2(lista.reduce((a, f) => a + f.egresos, 0)) };
};

const balance = async ({ desde, hasta, agrupar = 'categoria', comparar } = {}) => {
  if (!['categoria', 'cuenta'].includes(agrupar)) throw invalida('Se agrupa por categoria o cuenta.');
  const actual = await balanceUno(desde, hasta, agrupar);
  actual.neto = r2(actual.ingresos - actual.egresos);
  if (!comparar) return { agrupar, ...actual };
  const largo = dias(desde, hasta);
  const previo = await balanceUno(suma(desde, -largo), suma(desde, -1), agrupar);
  previo.neto = r2(previo.ingresos - previo.egresos);
  const claves = new Set([...actual.filas, ...previo.filas].map((f) => f.grupo));
  const comparacion = [...claves].sort().map((g) => {
    const a = actual.filas.find((f) => f.grupo === g)?.neto ?? 0, p = previo.filas.find((f) => f.grupo === g)?.neto ?? 0;
    return { grupo: g, actual: a, anterior: p, diferencia: r2(a - p) };
  });
  return { agrupar, ...actual, anterior: previo, comparacion };
};

// Historial de turnos con las diferencias por cajero, los cierres sucesivos de cada turno y sus reaperturas (RF16, RF18).
const turnos = async ({ desde, hasta, cuentaId, userId } = {}) => {
  const w = [], p = [];
  if (desde) { w.push('t.abierto_ms >= ?'); p.push(new Date(`${desde}T00:00:00`).getTime()); }
  if (hasta) { w.push('t.abierto_ms <= ?'); p.push(new Date(`${hasta}T23:59:59.999`).getTime()); }
  if (cuentaId) { w.push('t.cuenta_id = ?'); p.push(Number(cuentaId)); }
  if (userId) { w.push('t.user_id = ?'); p.push(Number(userId)); }
  const [ts] = await pool.query(`SELECT t.id, t.abierto_ms, t.cerrado_ms, t.estado, t.reaperturas, t.fondo_apertura, c.nombre AS caja, u.username AS cajero FROM fin_turnos t JOIN fin_cuentas c ON c.id = t.cuenta_id JOIN users u ON u.id = t.user_id ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY t.id DESC LIMIT 500`, p);
  const ids = ts.map((t) => t.id);
  const [cs] = ids.length ? await pool.query('SELECT turno_id, version, diferencia, contado, teorico, pendientes_no_verificados FROM fin_cierres WHERE turno_id IN (?) ORDER BY version', [ids]) : [[]];
  const filas = ts.map((t) => {
    const cierres = cs.filter((c) => c.turno_id === t.id).map((c) => ({ version: c.version, teorico: Number(c.teorico), contado: Number(c.contado), diferencia: Number(c.diferencia), pendientes_no_verificados: !!c.pendientes_no_verificados }));
    return { turno_id: t.id, caja: t.caja, cajero: t.cajero, estado: t.estado, abierto_ms: Number(t.abierto_ms), cerrado_ms: t.cerrado_ms === null ? null : Number(t.cerrado_ms), reaperturas: t.reaperturas,
      fondo_apertura: Number(t.fondo_apertura), cierres, diferencia: cierres.length ? cierres[cierres.length - 1].diferencia : null };
  });
  const por = new Map();
  for (const f of filas) {
    if (f.diferencia === null) continue;
    const x = por.get(f.cajero) ?? { cajero: f.cajero, turnos: 0, faltantes: 0, sobrantes: 0, neto: 0 };
    x.turnos++;
    if (f.diferencia < 0) x.faltantes = r2(x.faltantes - f.diferencia); else x.sobrantes = r2(x.sobrantes + f.diferencia);
    x.neto = r2(x.neto + f.diferencia);
    por.set(f.cajero, x);
  }
  return { filas, por_cajero: [...por.values()].sort((a, b) => a.neto - b.neto) };
};

// Valuación de los saldos en moneda extranjera a la cotización vigente (RF15): el valor en pesos contra lo que costó según la cotización de cada movimiento.
const valuacion = async () => {
  if (!(await Funciones.estaActiva('FIN-MONEDA-EXT'))) throw invalida('La valuación de divisas necesita la función FIN-MONEDA-EXT.', 409, { codigo: 'FUNCION_INACTIVA' });
  const [cuentas] = await pool.query("SELECT * FROM fin_cuentas WHERE moneda <> 'ARS' AND activa = 1 ORDER BY moneda, nombre");
  const filas = [];
  for (const c of cuentas) {
    const saldo = await Cuentas.saldoDe(c.id);
    const cot = await Monedas.vigente(c.moneda).catch(() => null);
    const [[costo]] = await pool.query('SELECT COALESCE(SUM(importe_divisa * cotizacion * SIGN(importe)), 0) AS pesos, COALESCE(SUM(importe_divisa * SIGN(importe)), 0) AS divisa FROM fin_movimientos WHERE cuenta_id = ? AND cotizacion IS NOT NULL AND importe_divisa IS NOT NULL', [c.id]);
    const sinCosto = r2(saldo - Number(costo.divisa)); // lo que no tiene cotización propia (saldo inicial) se valúa a la vigente: no genera diferencia
    const valor = cot ? r2(saldo * cot.comprador) : null;
    filas.push({ cuenta_id: c.id, cuenta: c.nombre, moneda: c.moneda, saldo, cotizacion: cot?.comprador ?? null, cotizacion_vencida: cot ? !!cot.vencida : null, valor_pesos: valor,
      costo_pesos: cot ? r2(Number(costo.pesos) + sinCosto * cot.comprador) : null, diferencia_cambio: cot ? r2(valor - Number(costo.pesos) - sinCosto * cot.comprador) : null });
  }
  return { filas, total_pesos: r2(filas.reduce((a, f) => a + (f.valor_pesos ?? 0), 0)), diferencia_cambio: r2(filas.reduce((a, f) => a + (f.diferencia_cambio ?? 0), 0)) };
};

module.exports = { balance, turnos, valuacion };
