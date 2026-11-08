const pool = require('../config/db');
const { invalida, r2, iso, esFecha } = require('./comun');

// Libros contables (Contable RF06, RF07, RF08): diario, mayor y balance de sumas y saldos, siempre derivados de las mismas líneas de asiento, de modo que el mayor concilia con el diario y el
// balance suma cero. Los asientos anulados y sus contraasientos se muestran (el diario es correlativo); sus efectos se compensan.
const MES_FIN = (anio, mes) => new Date(anio, mes, 0).getDate();

// `periodo=AAAA-MM`, `desde`/`hasta` o `ejercicio_id`.
const rango = async ({ periodo, desde, hasta, ejercicio_id: ejercicio } = {}) => {
  if (periodo) {
    if (!/^\d{4}-\d{2}$/.test(periodo)) throw invalida('El período va como AAAA-MM.');
    const [a, m] = periodo.split('-').map(Number);
    return { desde: `${periodo}-01`, hasta: `${periodo}-${String(MES_FIN(a, m)).padStart(2, '0')}` };
  }
  if (ejercicio) {
    const [[e]] = await pool.query('SELECT desde, hasta FROM con_ejercicios WHERE id = ?', [Number(ejercicio)]);
    if (!e) throw invalida('Ejercicio no encontrado.', 404);
    return { desde: iso(e.desde), hasta: iso(e.hasta) };
  }
  if (desde && !esFecha(desde)) throw invalida('"desde" va como AAAA-MM-DD.');
  if (hasta && !esFecha(hasta)) throw invalida('"hasta" va como AAAA-MM-DD.');
  if (desde && hasta && desde > hasta) throw invalida('"desde" es posterior a "hasta".');
  const [[ini]] = await pool.query('SELECT fecha_inicio FROM con_config WHERE id = 1');
  return { desde: desde ?? (ini.fecha_inicio ? iso(ini.fecha_inicio) : '1900-01-01'), hasta: hasta ?? '9999-12-31' };
};

// ---- Diario ----

const diario = async (q = {}) => {
  const r = await rango(q);
  const [asientos] = await pool.query('SELECT id, numero, ejercicio_id, fecha, tipo, leyenda, estado FROM con_asientos WHERE fecha BETWEEN ? AND ? ORDER BY ejercicio_id, numero', [r.desde, r.hasta]);
  const ids = asientos.map((a) => a.id);
  const [lineas] = ids.length ? await pool.query('SELECT l.asiento_id, l.cuenta_id, c.codigo, c.nombre, l.debe, l.haber, l.detalle FROM con_asiento_lineas l JOIN con_cuentas c ON c.id = l.cuenta_id WHERE l.asiento_id IN (?) ORDER BY l.id', [ids]) : [[]];
  const por = new Map();
  for (const l of lineas) { if (!por.has(l.asiento_id)) por.set(l.asiento_id, []); por.get(l.asiento_id).push({ cuenta_id: l.cuenta_id, codigo: l.codigo, nombre: l.nombre, debe: Number(l.debe), haber: Number(l.haber), detalle: l.detalle }); }
  const out = asientos.map((a) => ({ id: a.id, numero: a.numero, ejercicio_id: a.ejercicio_id, fecha: iso(a.fecha), tipo: a.tipo, leyenda: a.leyenda, estado: a.estado, lineas: por.get(a.id) ?? [] }));
  const debe = r2(out.reduce((s, a) => s + a.lineas.reduce((x, l) => x + l.debe, 0), 0)), haber = r2(out.reduce((s, a) => s + a.lineas.reduce((x, l) => x + l.haber, 0), 0));
  return { ...r, asientos: out, total_debe: debe, total_haber: haber };
};

// ---- Mayor ----

const cuentas = async () => (await pool.query('SELECT id, codigo, nombre, tipo, padre_id, imputable FROM con_cuentas ORDER BY codigo'))[0];
// Una cuenta con subcuentas suma las de su rama.
const rama = (todas, id) => {
  const hijos = new Map();
  for (const c of todas) { if (!hijos.has(c.padre_id)) hijos.set(c.padre_id, []); hijos.get(c.padre_id).push(c.id); }
  const out = [], pila = [id];
  while (pila.length) { const x = pila.pop(); out.push(x); pila.push(...(hijos.get(x) ?? [])); }
  return out;
};
const natural = (tipo) => (tipo === 'activo' || tipo === 'resultado_negativo' ? 1 : -1); // saldo positivo en su lado natural

const mayor = async (q = {}) => {
  const cuentaId = Number(q.cuenta_id);
  const todas = await cuentas();
  const cta = todas.find((c) => c.id === cuentaId);
  if (!cta) throw invalida('Indicá la cuenta (cuenta_id).', cuentaId ? 404 : 400);
  const r = await rango(q);
  const ids = rama(todas, cuentaId);
  const [[ini]] = await pool.query('SELECT COALESCE(SUM(l.debe), 0) AS d, COALESCE(SUM(l.haber), 0) AS h FROM con_asiento_lineas l JOIN con_asientos a ON a.id = l.asiento_id WHERE l.cuenta_id IN (?) AND a.fecha < ?', [ids, r.desde]);
  const s = natural(cta.tipo);
  let saldo = r2((Number(ini.d) - Number(ini.h)) * s);
  const saldoInicial = saldo;
  const [movs] = await pool.query(`SELECT a.id AS asiento_id, a.numero, a.fecha, a.leyenda, a.estado, l.id AS linea_id, l.cuenta_id, l.debe, l.haber, l.detalle,
      (SELECT COUNT(*) FROM con_asiento_origen o WHERE o.asiento_id = a.id) AS documentos,
      (SELECT CONCAT(o.modulo, '|', o.tipo_documento, '|', o.id_documento) FROM con_asiento_origen o WHERE o.asiento_id = a.id ORDER BY o.id LIMIT 1) AS origen
    FROM con_asiento_lineas l JOIN con_asientos a ON a.id = l.asiento_id WHERE l.cuenta_id IN (?) AND a.fecha BETWEEN ? AND ? ORDER BY a.fecha, a.ejercicio_id, a.numero, l.id`, [ids, r.desde, r.hasta]);
  let td = 0, th = 0;
  const movimientos = movs.map((m) => {
    const d = Number(m.debe), h = Number(m.haber);
    td += d; th += h;
    saldo = r2(saldo + (d - h) * s);
    const [modulo, tipo_documento, id_documento] = m.origen ? m.origen.split('|') : [null, null, null];
    return { asiento_id: m.asiento_id, numero: m.numero, fecha: iso(m.fecha), leyenda: m.leyenda, estado: m.estado, cuenta_id: m.cuenta_id, debe: d, haber: h, saldo, documentos: Number(m.documentos), origen: m.origen ? { modulo, tipo_documento, id_documento } : null };
  });
  return { cuenta: { id: cta.id, codigo: cta.codigo, nombre: cta.nombre, tipo: cta.tipo }, ...r, saldo_inicial: saldoInicial, movimientos, total_debe: r2(td), total_haber: r2(th), saldo_final: saldo };
};

// ---- Sumas y saldos ----

// Debe y haber de cada cuenta en el período y acumulados hasta el fin del período.
const sumas = async (desde, hasta) => {
  const [filas] = await pool.query(`SELECT l.cuenta_id,
      COALESCE(SUM(CASE WHEN a.fecha >= ? THEN l.debe ELSE 0 END), 0) AS d_per, COALESCE(SUM(CASE WHEN a.fecha >= ? THEN l.haber ELSE 0 END), 0) AS h_per,
      COALESCE(SUM(l.debe), 0) AS d_acum, COALESCE(SUM(l.haber), 0) AS h_acum
    FROM con_asiento_lineas l JOIN con_asientos a ON a.id = l.asiento_id WHERE a.fecha <= ? GROUP BY l.cuenta_id`, [desde, desde, hasta]);
  return new Map(filas.map((f) => [f.cuenta_id, { d_per: Number(f.d_per), h_per: Number(f.h_per), d_acum: Number(f.d_acum), h_acum: Number(f.h_acum) }]));
};

const balanceDe = async (todas, desde, hasta, nivel) => {
  const mov = await sumas(desde, hasta);
  const por = new Map(todas.map((c) => [c.id, c]));
  const profundidad = (c) => { let n = 1; for (let x = c; x.padre_id; x = por.get(x.padre_id)) n++; return n; };
  const ancestro = (c, lvl) => { let x = c; while (profundidad(x) > lvl) x = por.get(x.padre_id); return x; };
  const grupos = new Map();
  for (const [id, m] of mov) {
    const c = por.get(id);
    const g = nivel ? ancestro(c, nivel) : c;
    const e = grupos.get(g.id) ?? { cuenta_id: g.id, codigo: g.codigo, nombre: g.nombre, tipo: g.tipo, debe: 0, haber: 0, debe_acum: 0, haber_acum: 0 };
    e.debe += m.d_per; e.haber += m.h_per; e.debe_acum += m.d_acum; e.haber_acum += m.h_acum;
    grupos.set(g.id, e);
  }
  const filas = [...grupos.values()].sort((a, b) => a.codigo.localeCompare(b.codigo, 'en', { numeric: true })).map((e) => {
    const neto = r2(e.debe_acum - e.haber_acum);
    return { ...e, debe: r2(e.debe), haber: r2(e.haber), debe_acum: r2(e.debe_acum), haber_acum: r2(e.haber_acum), saldo_deudor: neto > 0 ? neto : 0, saldo_acreedor: neto < 0 ? -neto : 0 };
  });
  const suma = (k) => r2(filas.reduce((s, f) => s + f[k], 0));
  const totales = { debe: suma('debe'), haber: suma('haber'), debe_acum: suma('debe_acum'), haber_acum: suma('haber_acum'), saldo_deudor: suma('saldo_deudor'), saldo_acreedor: suma('saldo_acreedor') };
  return { filas, totales, cuadra: totales.debe_acum === totales.haber_acum && totales.saldo_deudor === totales.saldo_acreedor };
};

// Balance a una fecha o para un período, por nivel de cuenta y con comparación entre períodos (`comparar_periodo`, o `comparar_desde` y `comparar_hasta`).
const balance = async (q = {}) => {
  const r = await rango(q);
  const nivel = q.nivel ? Number(q.nivel) : null;
  if (nivel !== null && (!Number.isInteger(nivel) || nivel < 1)) throw invalida('El nivel es un número desde 1.');
  const todas = await cuentas();
  const actual = await balanceDe(todas, r.desde, r.hasta, nivel);
  const out = { ...r, nivel, ...actual };
  if (q.comparar_periodo || q.comparar_desde || q.comparar_hasta) {
    const c = await rango({ periodo: q.comparar_periodo, desde: q.comparar_desde, hasta: q.comparar_hasta });
    const otro = await balanceDe(todas, c.desde, c.hasta, nivel);
    const antes = new Map(otro.filas.map((f) => [f.cuenta_id, f]));
    out.comparacion = { ...c, totales: otro.totales, cuadra: otro.cuadra };
    out.filas = actual.filas.map((f) => {
      const o = antes.get(f.cuenta_id);
      const saldo = r2(f.saldo_deudor - f.saldo_acreedor), previo = o ? r2(o.saldo_deudor - o.saldo_acreedor) : 0;
      return { ...f, saldo_comparado: previo, diferencia: r2(saldo - previo) };
    });
    for (const o of otro.filas) if (!actual.filas.some((f) => f.cuenta_id === o.cuenta_id))
      out.filas.push({ cuenta_id: o.cuenta_id, codigo: o.codigo, nombre: o.nombre, tipo: o.tipo, debe: 0, haber: 0, debe_acum: 0, haber_acum: 0, saldo_deudor: 0, saldo_acreedor: 0, saldo_comparado: r2(o.saldo_deudor - o.saldo_acreedor), diferencia: r2(-(o.saldo_deudor - o.saldo_acreedor)) });
    out.filas.sort((a, b) => a.codigo.localeCompare(b.codigo, 'en', { numeric: true }));
  }
  return out;
};

// Documentos para exportar (PDF, Excel, CSV) con el formato común de los reportes.
const doc = (titulo, r, columnas, filas, resumen) => ({ titulo, subtitulo: `${r.desde} a ${r.hasta}`, filtros: [], resumen, hojas: [{ nombre: titulo.slice(0, 28), columnas, filas }] });
const moneda = (key, label) => ({ key, label, tipo: 'moneda' });
const exportarDiario = (d) => doc('Libro Diario', d, [{ key: 'numero', label: 'Asiento', tipo: 'numero' }, { key: 'fecha', label: 'Fecha', tipo: 'fecha' }, { key: 'cuenta', label: 'Cuenta' }, moneda('debe', 'Debe'), moneda('haber', 'Haber'), { key: 'leyenda', label: 'Leyenda' }],
  d.asientos.flatMap((a) => a.lineas.map((l) => ({ numero: a.numero, fecha: a.fecha, cuenta: `${l.codigo} ${l.nombre}`, debe: l.debe, haber: l.haber, leyenda: a.leyenda }))),
  [{ label: 'Total debe', valor: d.total_debe, tipo: 'moneda' }, { label: 'Total haber', valor: d.total_haber, tipo: 'moneda' }]);
const exportarMayor = (m) => doc(`Mayor ${m.cuenta.codigo}`, m, [{ key: 'fecha', label: 'Fecha', tipo: 'fecha' }, { key: 'numero', label: 'Asiento', tipo: 'numero' }, { key: 'leyenda', label: 'Leyenda' }, moneda('debe', 'Debe'), moneda('haber', 'Haber'), moneda('saldo', 'Saldo')],
  m.movimientos, [{ label: 'Saldo inicial', valor: m.saldo_inicial, tipo: 'moneda' }, { label: 'Saldo final', valor: m.saldo_final, tipo: 'moneda' }]);
const exportarBalance = (b) => doc('Sumas y saldos', b, [{ key: 'codigo', label: 'Código' }, { key: 'nombre', label: 'Cuenta' }, moneda('debe', 'Debe'), moneda('haber', 'Haber'), moneda('saldo_deudor', 'Saldo deudor'), moneda('saldo_acreedor', 'Saldo acreedor'),
  ...(b.comparacion ? [moneda('saldo_comparado', 'Saldo comparado'), moneda('diferencia', 'Diferencia')] : [])], b.filas,
  [{ label: 'Debe', valor: b.totales.debe_acum, tipo: 'moneda' }, { label: 'Haber', valor: b.totales.haber_acum, tipo: 'moneda' }, { label: 'Cuadra', valor: b.cuadra ? 'Sí' : 'No' }]);

module.exports = { diario, mayor, balance, rango, exportarDiario, exportarMayor, exportarBalance, natural };
