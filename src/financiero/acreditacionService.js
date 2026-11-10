const pool = require('../config/db');
const { idGlobal } = require('../utils/idGlobal');
const Cuentas = require('./cuentaService');
const { invalida, r2, cts, movimiento } = require('./comun');
const Contable = require('./aContable');

// Acreditaciones de tarjetas y billeteras y liquidaciones del procesador (Financiero RF06, RN15, EX11). Cada cobro en una cuenta de procesador, billetera o
// pasarela genera un crédito a acreditar con su fecha estimada; la liquidación los concilia contra los cupones y registra comisiones, IVA, retenciones,
// percepciones y el neto acreditado en la cuenta de destino.
const CUENTAS_DE_COBRO = ['procesador', 'billetera', 'pasarela'];
const DESTINOS = ['banco', 'billetera'];

const crear = async (conn, { movimientoId, cuenta, forma, bruto, referencia, docIdGlobal, plazo, comisionPct, fechaMs }) => {
  if (!CUENTAS_DE_COBRO.includes(cuenta.tipo)) return null;
  const fecha = new Date((fechaMs ?? Date.now()) + plazo * 86400000).toISOString().slice(0, 10);
  const [r] = await conn.query(
    `INSERT INTO fin_acreditaciones (id_global, movimiento_id, cuenta_id, forma_codigo, doc_id_global, referencia, bruto_original, bruto, comision_estimada, fecha_estimada)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [await idGlobal(), movimientoId, cuenta.id, forma, docIdGlobal ?? null, referencia ?? null, bruto, bruto, r2(bruto * comisionPct / 100), fecha]);
  return r.insertId;
};

// Una devolución reduce el crédito que todavía está pendiente de ese cobro (Financiero RN40); si ya se liquidó, lo concilia la liquidación.
const reducir = async (conn, movimientoOriginalId, importe) => {
  const [[a]] = await conn.query("SELECT * FROM fin_acreditaciones WHERE movimiento_id = ? AND estado = 'pendiente' FOR UPDATE", [movimientoOriginalId]);
  if (!a) return null;
  const resto = r2(Math.max(Number(a.bruto) - importe, 0));
  await conn.query("UPDATE fin_acreditaciones SET bruto = ?, comision_estimada = ?, estado = ? WHERE id = ?",
    [resto, a.bruto_original > 0 ? r2(Number(a.comision_estimada) * resto / Number(a.bruto)) : 0, resto === 0 ? 'anulada' : 'pendiente', a.id]);
  return a.id;
};

const listar = async ({ estado = 'pendiente', cuentaId, hasta } = {}) => {
  const w = [], p = [];
  if (estado !== 'todas') { w.push('a.estado = ?'); p.push(estado); }
  if (cuentaId) { w.push('a.cuenta_id = ?'); p.push(Number(cuentaId)); }
  if (hasta) { w.push('a.fecha_estimada <= ?'); p.push(hasta); }
  const [filas] = await pool.query(
    `SELECT a.*, c.nombre AS cuenta FROM fin_acreditaciones a JOIN fin_cuentas c ON c.id = a.cuenta_id ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY a.fecha_estimada, a.id LIMIT 1000`, p);
  const lista = filas.map((a) => ({ id: a.id, cuenta_id: a.cuenta_id, cuenta: a.cuenta, forma: a.forma_codigo, venta: a.doc_id_global, referencia: a.referencia, bruto: Number(a.bruto),
    comision_estimada: Number(a.comision_estimada), fecha_estimada: a.fecha_estimada instanceof Date ? a.fecha_estimada.toISOString().slice(0, 10) : a.fecha_estimada, estado: a.estado, liquidacion_id: a.liquidacion_id }));
  return { total: r2(lista.reduce((s, a) => s + a.bruto, 0)), acreditaciones: lista };
};

const fecha = (v, nombre) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) || Number.isNaN(new Date(`${v}T00:00:00`).getTime())) throw invalida(`${nombre} debe tener el formato AAAA-MM-DD.`);
  return String(v);
};
const monto = (v, nombre) => {
  const n = v === undefined || v === null || v === '' ? 0 : Number(v);
  if (!Number.isFinite(n) || n < 0) throw invalida(`${nombre} no puede ser negativo.`);
  return r2(n);
};

// Registra la liquidación del procesador: concilia los cupones contra los créditos pendientes y deja un movimiento por cada concepto (RN02).
const liquidar = async (d, userId) => {
  const cuenta = await Cuentas.obtenerFila(Number(d.cuenta_id));
  if (!CUENTAS_DE_COBRO.includes(cuenta.tipo)) throw invalida('La liquidación es de una cuenta de procesador, billetera o pasarela.');
  const destino = await Cuentas.obtenerFila(Number(d.destino_id));
  if (!DESTINOS.includes(destino.tipo)) throw invalida('El neto se acredita en una cuenta bancaria o una billetera.');
  if (!cuenta.activa || !destino.activa) throw invalida('La caja o cuenta está desactivada.', 409);
  if (cuenta.moneda !== destino.moneda) throw invalida('La cuenta del procesador y la de destino tienen distinta moneda.', 409);
  const referencia = String(d.referencia ?? '').trim();
  if (!referencia || referencia.length > 80) throw invalida('Indicá la referencia o número de la liquidación (hasta 80 caracteres).');
  const f = fecha(d.fecha, 'La fecha');
  if (!Array.isArray(d.cupones) || !d.cupones.length) throw invalida('La liquidación necesita al menos un cupón.');
  const cupones = d.cupones.map((c) => {
    const importe = Number(c.importe);
    if (!(importe > 0)) throw invalida('El importe de cada cupón debe ser mayor a cero.');
    if (!c.referencia && !c.venta) throw invalida('Cada cupón se identifica por su referencia o por la venta.');
    return { referencia: c.referencia ? String(c.referencia) : null, venta: c.venta ? String(c.venta) : null, importe: r2(importe) };
  });
  const claves = cupones.map((c) => c.referencia ?? c.venta);
  if (new Set(claves).size !== claves.length) throw invalida('Un cupón aparece dos veces en la misma liquidación.');
  const comision = monto(d.comision, 'La comisión'), iva = monto(d.iva_comision, 'El IVA de la comisión'), retenciones = monto(d.retenciones, 'Las retenciones'), percepciones = monto(d.percepciones, 'Las percepciones');
  const bruto = r2(cupones.reduce((s, c) => s + c.importe, 0));
  const neto = r2(bruto - comision - iva - retenciones - percepciones);
  if (d.neto !== undefined && d.neto !== null && Math.abs(Number(d.neto) - neto) > 0.01) throw invalida(`El neto informado (${d.neto}) no coincide con los cupones menos los descuentos (${neto}).`, 400, { codigo: 'NETO_NO_CUADRA' });
  if (neto < 0) throw invalida('Los descuentos superan a los cupones.');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM fin_cuentas WHERE id = ? FOR UPDATE', [cuenta.id]);
    const [[dup]] = await conn.query('SELECT id FROM fin_liquidaciones WHERE cuenta_id = ? AND referencia = ?', [cuenta.id, referencia]);
    if (dup) throw invalida(`La liquidación "${referencia}" ya está registrada.`, 409, { codigo: 'LIQUIDACION_DUPLICADA', detalle: { liquidacion_id: dup.id } });
    // RN15: un cupón solo se liquida una vez.
    const lineas = [];
    const yaLiquidados = [];
    for (const c of cupones) {
      const [[liq]] = await conn.query("SELECT id FROM fin_acreditaciones WHERE cuenta_id = ? AND estado = 'liquidada' AND (referencia <=> ? OR doc_id_global <=> ?) AND (? IS NOT NULL OR ? IS NOT NULL)", [cuenta.id, c.referencia, c.venta, c.referencia, c.venta]);
      if (liq) { yaLiquidados.push(c.referencia ?? c.venta); continue; }
      const [[a]] = await conn.query("SELECT * FROM fin_acreditaciones WHERE cuenta_id = ? AND estado = 'pendiente' AND (referencia <=> ? OR doc_id_global <=> ?) AND (? IS NOT NULL OR ? IS NOT NULL) ORDER BY id LIMIT 1 FOR UPDATE", [cuenta.id, c.referencia, c.venta, c.referencia, c.venta]);
      if (!a) lineas.push({ ...c, acreditacion: null, estado: 'sin_cobro_asociado', motivo: 'El cupón no está en el sistema' });
      else if (cts(a.bruto) !== cts(c.importe)) lineas.push({ ...c, acreditacion: null, estado: 'sin_cobro_asociado', motivo: `El importe difiere del cobro registrado (${Number(a.bruto)})` });
      else lineas.push({ ...c, acreditacion: a, estado: 'conciliado', motivo: null });
    }
    if (yaLiquidados.length) throw invalida(`Estos cupones ya se liquidaron: ${yaLiquidados.join(', ')}.`, 409, { codigo: 'CUPON_YA_LIQUIDADO', detalle: { cupones: yaLiquidados } });

    const conciliado = r2(lineas.filter((l) => l.estado === 'conciliado').reduce((s, l) => s + l.importe, 0));
    const sinCobro = r2(bruto - conciliado);
    const estimada = r2(lineas.filter((l) => l.acreditacion).reduce((s, l) => s + Number(l.acreditacion.comision_estimada), 0));
    const idLiq = await idGlobal();
    const [r] = await conn.query(
      `INSERT INTO fin_liquidaciones (id_global, cuenta_id, destino_id, referencia, fecha, bruto, comision, iva_comision, retenciones, percepciones, neto, comision_estimada, user_id, ts_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [idLiq, cuenta.id, destino.id, referencia, f, bruto, comision, iva, retenciones, percepciones, neto, estimada, userId ?? null, Date.now()]);
    const liqId = r.insertId;
    for (const l of lineas) {
      await conn.query('INSERT INTO fin_liquidacion_cupones (liquidacion_id, acreditacion_id, referencia, importe, estado, motivo) VALUES (?, ?, ?, ?, ?, ?)', [liqId, l.acreditacion?.id ?? null, l.referencia ?? l.venta, l.importe, l.estado, l.motivo]);
      if (l.acreditacion) await conn.query("UPDATE fin_acreditaciones SET estado = 'liquidada', liquidacion_id = ? WHERE id = ?", [liqId, l.acreditacion.id]);
    }
    const base = { moneda: cuenta.moneda, userId, docIdGlobal: `LIQ-${liqId}` };
    const [[catCom]] = await conn.query("SELECT id FROM fin_categorias WHERE nombre = 'Comisiones bancarias y de tarjetas'");
    if (conciliado > 0) {
      const idO = await movimiento(conn, { ...base, cuentaId: cuenta.id, tipo: 'liquidacion', importe: -conciliado, motivo: `Liquidación ${referencia}` });
      await movimiento(conn, { ...base, cuentaId: destino.id, tipo: 'acreditacion', importe: conciliado, vinculoId: idO, motivo: `Liquidación ${referencia}` });
    }
    if (sinCobro > 0) await movimiento(conn, { ...base, cuentaId: destino.id, tipo: 'acreditacion_sin_cobro', importe: sinCobro, marcas: 'sin_cobro_asociado', motivo: `Liquidación ${referencia}: cupones sin cobro asociado` });
    for (const [tipo, importe] of [['comision', comision], ['comision_iva', iva], ['retencion', retenciones], ['percepcion', percepciones]])
      if (importe > 0) await movimiento(conn, { ...base, cuentaId: destino.id, tipo, importe: -importe, categoriaId: catCom?.id ?? null, motivo: `Liquidación ${referencia}` });
    // Lo que descuenta el procesador (comisión, IVA, retenciones y percepciones) sale de la cuenta donde se acreditó el cobro bruto (Contable RF19).
    if (cuenta.moneda === 'ARS' && comision + iva + retenciones + percepciones > 0) await Contable.publicar(conn, 'liquidacion_tarjeta', 'liquidacion', idLiq,
      { liquidacion_id_global: idLiq, referencia, comision, iva, retenciones, percepciones, fecha: f }, { userId });
    await conn.commit();
    return obtener(liqId);
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const vistaLiq = (l) => ({
  id: l.id, cuenta_id: l.cuenta_id, destino_id: l.destino_id, referencia: l.referencia, fecha: l.fecha instanceof Date ? l.fecha.toISOString().slice(0, 10) : l.fecha, bruto: Number(l.bruto),
  comision: Number(l.comision), iva_comision: Number(l.iva_comision), retenciones: Number(l.retenciones), percepciones: Number(l.percepciones), neto: Number(l.neto),
  comision_estimada: Number(l.comision_estimada), diferencia_comision: r2(Number(l.comision) + Number(l.iva_comision) - Number(l.comision_estimada)), ts_ms: Number(l.ts_ms),
});
const obtener = async (id) => {
  const [[l]] = await pool.query('SELECT * FROM fin_liquidaciones WHERE id = ?', [id]);
  if (!l) throw invalida('Liquidación no encontrada.', 404);
  const [cup] = await pool.query('SELECT referencia, importe, estado, motivo FROM fin_liquidacion_cupones WHERE liquidacion_id = ? ORDER BY id', [id]);
  return { ...vistaLiq(l), cupones: cup.map((c) => ({ ...c, importe: Number(c.importe) })) };
};
const listarLiquidaciones = async ({ cuentaId, limite = 100 } = {}) =>
  (await pool.query(`SELECT * FROM fin_liquidaciones ${cuentaId ? 'WHERE cuenta_id = ?' : ''} ORDER BY id DESC LIMIT ?`, cuentaId ? [Number(cuentaId), Math.min(Number(limite) || 100, 500)] : [Math.min(Number(limite) || 100, 500)]))[0].map(vistaLiq);

module.exports = { CUENTAS_DE_COBRO, crear, reducir, listar, liquidar, obtener, listarLiquidaciones };
