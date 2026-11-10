const pool = require('../config/db');
const Auto = require('./automaticos');
const Cuentas = require('./cuentaService');
const { consultar } = require('./consultaService');
const { r2, cts } = require('./comun');

// Cuentas y operaciones en moneda extranjera (Contable RN10, RF09, RF21): cada caja o cuenta en divisa de Financiero tiene su propia cuenta contable (clave `fin:<ID_Global>`), que guarda el
// importe en divisa y la cotización de cada línea; la revaluación (CON-REVALUACION) las usa. Los libros se llevan en pesos.
const { linea, resolver, registrar } = Auto;
const num = (x) => Number(x ?? 0);

// La cuenta contable de una caja o cuenta en divisa, creada la primera vez bajo «Disponibilidades en moneda extranjera».
const asegurarCuenta = async (db, { id_global: idGlobal, nombre, moneda }) => {
  const clave = `fin:${idGlobal}`;
  const [[ya]] = await db.query('SELECT * FROM con_cuentas WHERE clave = ?', [clave]);
  if (ya) return ya;
  let [[rubro]] = await db.query("SELECT id FROM con_cuentas WHERE codigo = '1.2'");
  if (!rubro) {
    const [[raiz]] = await db.query("SELECT id FROM con_cuentas WHERE codigo = '1'");
    const [r] = await db.query("INSERT INTO con_cuentas (codigo, nombre, tipo, padre_id, imputable) VALUES ('1.2', 'Disponibilidades en moneda extranjera', 'activo', ?, 0)", [raiz?.id ?? null]);
    rubro = { id: r.insertId };
  }
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM con_cuentas WHERE padre_id = ?', [rubro.id]);
  let sec = Number(n) + 1, codigo;
  for (;;) { codigo = `1.2.${String(sec).padStart(2, '0')}`; const [[x]] = await db.query('SELECT id FROM con_cuentas WHERE codigo = ?', [codigo]); if (!x) break; sec++; }
  const [r] = await db.query("INSERT INTO con_cuentas (codigo, nombre, tipo, padre_id, imputable, moneda, clave) VALUES (?, ?, 'activo', ?, 1, ?, ?)", [codigo, `${String(nombre).slice(0, 90)} (${moneda})`, rubro.id, moneda, clave]);
  return (await db.query('SELECT * FROM con_cuentas WHERE id = ?', [r.insertId]))[0][0];
};

// Crea las cuentas de las cajas y cuentas en divisa que Financiero ya tenía antes de instalar Contable.
const sincronizar = async (db = pool) => {
  const r = await consultar('financiero', 'saldos', {});
  if (!r.disponible) return { creadas: 0 };
  let creadas = 0;
  for (const d of r.valor.divisas ?? []) { const antes = (await db.query('SELECT id FROM con_cuentas WHERE clave = ?', [`fin:${d.id_global}`]))[0].length; await asegurarCuenta(db, d); if (!antes) creadas++; }
  return { creadas };
};

registrar('cuenta_divisa', { formulario: 'diferencia_cambio', modulo: 'financiero', reprocesable: false, importe: () => null, construir: async (db, c) => { await asegurarCuenta(db, c); return []; } });

// Compra: la cuenta en divisa sube por lo pagado en pesos. Venta: baja por su costo (el promedio de lo que hay) y la diferencia con lo cobrado es resultado por diferencia de cambio.
registrar('operacion_divisa', { formulario: 'diferencia_cambio', modulo: 'financiero', importe: (c) => c.importe_pesos, relacionado: (c) => c.cuenta_divisa?.id_global,
  construir: async (db, c, f) => {
    const cuenta = await asegurarCuenta(db, { ...c.cuenta_divisa, moneda: c.moneda });
    const pesos = await Cuentas.porClave(c.medio, db);
    const importe = r2(num(c.importe_pesos)), divisa = num(c.importe_divisa), cot = num(c.cotizacion);
    if (c.tipo === 'compra') return [{ cuenta_id: cuenta.id, debe: importe, haber: 0, importe_divisa: divisa, cotizacion: cot, detalle: `Compra de ${c.moneda}` }, { cuenta_id: pesos.id, debe: 0, haber: importe, detalle: `Compra de ${c.moneda}` }];
    // venta: costo de las divisas que salen
    const [[s]] = await db.query('SELECT COALESCE(SUM(debe - haber), 0) AS libro, COALESCE(SUM(CASE WHEN importe_divisa IS NULL THEN 0 WHEN debe > 0 THEN importe_divisa ELSE -importe_divisa END), 0) AS divisa FROM con_asiento_lineas WHERE cuenta_id = ?', [cuenta.id]);
    const costo = num(s.divisa) > 0 ? r2(num(s.libro) * Math.min(divisa / num(s.divisa), 1)) : importe;
    const out = [{ cuenta_id: pesos.id, debe: importe, haber: 0, detalle: `Venta de ${c.moneda}` }, { cuenta_id: cuenta.id, debe: 0, haber: costo, importe_divisa: divisa, cotizacion: cot, detalle: `Venta de ${c.moneda}` }];
    const dif = r2(importe - costo);
    if (dif > 0) out.push({ cuenta_id: (await resolver(db, 'diferencia_cambio', 'ganancia', '*', f)).cuenta_haber_id, debe: 0, haber: dif, detalle: 'Diferencia de cambio' });
    if (dif < 0) out.push({ cuenta_id: (await resolver(db, 'diferencia_cambio', 'perdida', '*', f)).cuenta_debe_id, debe: -dif, haber: 0, detalle: 'Diferencia de cambio' });
    return out;
  } });

// Control cruzado de divisas: la suma en divisa de las cuentas contables de cada moneda contra el saldo en divisa de las cajas y cuentas de Financiero.
const controlDivisas = async () => {
  const r = await consultar('financiero', 'saldos', {});
  if (!r.instalado) return [];
  if (!r.disponible) return [{ id: 'divisas', nombre: 'Cajas y cuentas en divisa contra Financiero', estado: 'no_disponible', motivo: r.motivo }];
  const porMoneda = new Map();
  for (const d of r.valor.divisas ?? []) porMoneda.set(d.moneda, r2((porMoneda.get(d.moneda) ?? 0) + num(d.saldo_divisa)));
  const [filas] = await pool.query("SELECT c.moneda, COALESCE(SUM(CASE WHEN l.importe_divisa IS NULL THEN 0 WHEN l.debe > 0 THEN l.importe_divisa ELSE -l.importe_divisa END), 0) AS divisa FROM con_cuentas c LEFT JOIN con_asiento_lineas l ON l.cuenta_id = c.id WHERE c.moneda <> 'ARS' AND c.clave LIKE 'fin:%' GROUP BY c.moneda");
  for (const f of filas) if (!porMoneda.has(f.moneda)) porMoneda.set(f.moneda, 0);
  return [...porMoneda].map(([moneda, modulo]) => {
    const contable = r2(num(filas.find((f) => f.moneda === moneda)?.divisa));
    const diferencia = r2(contable - modulo);
    return { id: `divisas:${moneda}`, nombre: `Cajas y cuentas en ${moneda} contra Financiero`, estado: Math.abs(diferencia) <= 0.01 ? 'ok' : 'diferencia', saldo_contable: contable, saldo_modulo: modulo, diferencia };
  });
};

module.exports = { asegurarCuenta, sincronizar, controlDivisas, cts };
