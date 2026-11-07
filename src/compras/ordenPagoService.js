const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const Modulos = require('../modulos/registro');
const Funciones = require('../funciones/servicio');
const Notificacion = require('../models/notificacionModel');
const { idGlobal } = require('../utils/idGlobal');
const Comprobantes = require('./comprobanteService');
const Proveedores = require('./proveedorService');
const Vencimientos = require('./vencimientoService');
const Retenciones = require('./retencionService');
const { invalida, r2, cts, hoy, iso } = require('./comun');

// Órdenes de pago, anticipos y pagos programados (Compras RF06, RF07, RF08, RN09, RN10, RN33 a RN36, EX07). La orden aplica cuotas de comprobantes, notas de crédito y anticipos; la suma
// de los medios más las retenciones es igual al importe neto aplicado (RN09). Con Financiero, la ejecución del pago viaja como mensaje y la orden pasa a Pagada recién cuando Financiero
// lo confirma; sin él se marca a mano. Una orden pagada no se modifica: se anula con un mensaje inverso (RN10). Las programadas nunca se ejecutan solas (RF07).
const MEDIOS = ['efectivo', 'transferencia', 'cheque_propio', 'echeq', 'cheque_tercero'];
const SIN_FINANCIERO = ['efectivo', 'transferencia'];
const financiero = () => Modulos.estaInstalado('financiero');

const idOpPago = (op) => `compras:pago_proveedor:${op.id_global}:1`;

const vistaOp = (o) => ({
  id: o.id, id_global: o.id_global, numero: o.numero, tipo: o.tipo, proveedor_id: o.proveedor_id, proveedor: o.proveedor ?? null, moneda: o.moneda, fecha: iso(o.fecha), estado: o.estado, fecha_programada: iso(o.fecha_programada),
  deuda_aplicada: Number(o.deuda_aplicada), notas_credito: Number(o.notas_credito), anticipos: Number(o.anticipos), retenciones: Number(o.retenciones), medios_total: Number(o.medios_total),
  ejecutada: !!o.ejecutada_ms, medio_manual: o.medio_manual, observacion: o.observacion, motivo_anulacion: o.motivo_anulacion, ts_ms: Number(o.ts_ms),
});
const fila = async (id, db = pool) => {
  const [[o]] = await db.query('SELECT o.*, p.razon_social AS proveedor FROM cmp_ordenes_pago o JOIN cmp_proveedores p ON p.id = o.proveedor_id WHERE o.id = ?', [id]);
  if (!o) throw invalida('Orden de pago no encontrada.', 404);
  return o;
};

// La orden pasa a Pagada cuando Financiero confirma el movimiento; mientras tanto sigue Aprobada con su estado de integración visible (RF06, RN33).
const integracion = async (o) => {
  if (!o.ejecutada_ms) return null;
  const [[m]] = await pool.query('SELECT estado, motivo_rechazo, confirmado_ms FROM mensajes_integracion WHERE id_operacion = ?', [idOpPago(o)]);
  if (!m) return { estado: 'sin_financiero' };
  if (m.estado === 'confirmado' && o.estado === 'aprobada') await pool.query("UPDATE cmp_ordenes_pago SET estado = 'pagada', pagada_ms = ? WHERE id = ? AND estado = 'aprobada'", [m.confirmado_ms ?? Date.now(), o.id]);
  return { estado: m.estado === 'confirmado' ? 'confirmado' : m.estado === 'rechazado' ? 'rechazado' : m.estado === 'fallido' ? 'fallido' : 'pendiente', motivo: m.motivo_rechazo ?? null };
};

const obtener = async (id) => {
  let o = await fila(id);
  const integ = await integracion(o);
  if (integ?.estado === 'confirmado') o = await fila(id);
  const [apl] = await pool.query('SELECT tipo, vencimiento_id, comprobante_id, anticipo_id, importe FROM cmp_op_aplicaciones WHERE orden_id = ?', [id]);
  const [medios] = await pool.query('SELECT medio, importe, cuenta_id, cheque, cheque_id, referencia FROM cmp_op_medios WHERE orden_id = ?', [id]);
  const [rets] = await pool.query('SELECT x.regimen_id, r.codigo, x.base, x.alicuota, x.importe, x.calculado, x.certificado, x.anulado, x.aviso FROM cmp_op_retenciones x JOIN cmp_regimenes_retencion r ON r.id = x.regimen_id WHERE x.orden_id = ?', [id]);
  return { ...vistaOp(o), integracion: integ, instantanea: o.instantanea, aplicaciones: apl.map((a) => ({ ...a, importe: Number(a.importe) })),
    medios: medios.map((m) => ({ ...m, importe: Number(m.importe), cheque: m.cheque ? JSON.parse(m.cheque) : null })),
    retenciones_detalle: rets.map((x) => ({ ...x, base: Number(x.base), alicuota: Number(x.alicuota), importe: Number(x.importe), calculado: Number(x.calculado), anulado: !!x.anulado })) };
};

const listar = async ({ proveedorId, estado, desde, hasta, tipo, limite = 200 } = {}) => {
  const w = [], p = [];
  if (proveedorId) { w.push('o.proveedor_id = ?'); p.push(Number(proveedorId)); }
  if (estado) { w.push('o.estado = ?'); p.push(estado); }
  if (tipo) { w.push('o.tipo = ?'); p.push(tipo); }
  if (desde) { w.push('o.fecha >= ?'); p.push(desde); }
  if (hasta) { w.push('o.fecha <= ?'); p.push(hasta); }
  const [filas] = await pool.query(`SELECT o.*, p.razon_social AS proveedor FROM cmp_ordenes_pago o JOIN cmp_proveedores p ON p.id = o.proveedor_id ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY o.numero DESC LIMIT ?`, [...p, Math.min(Number(limite) || 200, 1000)]);
  return filas.map(vistaOp);
};

// ---- Armar la orden ----

const aplicar = async (conn, d, prov, moneda) => {
  const aplic = [];
  for (const a of d.aplicaciones ?? []) {
    const [[v]] = await conn.query("SELECT v.*, c.proveedor_id, c.moneda, c.estado AS comp_estado, c.constatacion FROM cmp_vencimientos v JOIN cmp_comprobantes c ON c.id = v.comprobante_id WHERE v.id = ? FOR UPDATE", [Number(a.vencimiento_id)]);
    if (!v || v.proveedor_id !== prov.id) throw invalida(`La cuota ${a.vencimiento_id} no es de este proveedor.`, 404);
    if (v.moneda !== moneda) throw invalida('Las cuotas son de otra moneda.', 409);
    if (v.constatacion === 'cae_no_valido' && (await Proveedores.config(conn)).bloquear_cae_invalido) throw invalida(`El comprobante de la cuota ${a.vencimiento_id} tiene un CAE no valido segun ARCA: no se paga.`, 409, { codigo: 'CAE_NO_VALIDO' });
    if (v.estado !== 'pendiente') throw invalida(`La cuota ${a.vencimiento_id} ya está ${v.estado}.`, 409, { codigo: 'CUOTA_NO_PENDIENTE' });
    const importe = r2(a.importe ?? v.saldo);
    if (!(importe > 0) || cts(importe) > cts(v.saldo)) throw invalida(`El importe de la cuota ${a.vencimiento_id} no puede superar su saldo (${Number(v.saldo)}).`, 400, { codigo: 'IMPORTE_SUPERA_SALDO' });
    aplic.push({ tipo: 'deuda', vencimiento_id: v.id, comprobante_id: v.comprobante_id, importe });
  }
  for (const n of d.notas_credito ?? []) {
    const [[c]] = await conn.query("SELECT id, proveedor_id, moneda, clase, total, estado FROM cmp_comprobantes WHERE id = ? FOR UPDATE", [Number(n.comprobante_id)]);
    if (!c || c.proveedor_id !== prov.id || c.clase !== 'NOTA_CREDITO' || c.estado === 'anulado') throw invalida(`El comprobante ${n.comprobante_id} no es una nota de crédito vigente de este proveedor.`, 404);
    if (c.moneda !== moneda) throw invalida('La nota de crédito es de otra moneda.', 409);
    const disponible = await creditoDisponible(conn, c);
    const importe = r2(n.importe ?? disponible);
    if (!(importe > 0) || cts(importe) > cts(disponible)) throw invalida(`La nota de crédito ${n.comprobante_id} tiene ${disponible} disponibles.`, 400, { codigo: 'CREDITO_INSUFICIENTE' });
    aplic.push({ tipo: 'nota_credito', comprobante_id: c.id, importe });
  }
  for (const a of d.anticipos ?? []) {
    const [[x]] = await conn.query("SELECT * FROM cmp_anticipos WHERE id = ? FOR UPDATE", [Number(a.anticipo_id)]);
    if (!x || x.proveedor_id !== prov.id || x.estado !== 'vigente') throw invalida(`El anticipo ${a.anticipo_id} no existe o no es de este proveedor.`, 404);
    if (x.moneda !== moneda) throw invalida('El anticipo es de otra moneda.', 409);
    const importe = r2(a.importe ?? x.saldo);
    if (!(importe > 0) || cts(importe) > cts(x.saldo)) throw invalida(`El anticipo ${a.anticipo_id} tiene ${Number(x.saldo)} disponibles.`, 400, { codigo: 'ANTICIPO_INSUFICIENTE' });
    aplic.push({ tipo: 'anticipo', anticipo_id: x.id, importe });
  }
  return aplic;
};

const creditoDisponible = async (db, c) => {
  const [[u]] = await db.query("SELECT COALESCE(SUM(a.importe), 0) AS usado FROM cmp_op_aplicaciones a JOIN cmp_ordenes_pago o ON o.id = a.orden_id WHERE a.tipo = 'nota_credito' AND a.comprobante_id = ? AND o.estado <> 'anulada'", [c.id]);
  return r2(Number(c.total) - Number(u.usado));
};

const validarMedios = async (medios, { conFin, neto }) => {
  if (!Array.isArray(medios)) throw invalida('Indicá los medios de pago.');
  const out = medios.map((m, i) => {
    if (!MEDIOS.includes(m.medio)) throw invalida(`El medio de pago de la línea ${i + 1} es uno de: ${MEDIOS.join(', ')}.`);
    if (!conFin && !SIN_FINANCIERO.includes(m.medio)) throw invalida(`Sin Financiero solo se ofrecen efectivo y transferencia (${m.medio}).`, 409, { codigo: 'MEDIO_NO_DISPONIBLE' });
    const importe = r2(m.importe);
    if (!(importe > 0)) throw invalida(`El importe del medio ${i + 1} debe ser mayor a cero.`);
    if (conFin && !m.cuenta_id && m.medio !== 'cheque_tercero') throw invalida(`El medio ${i + 1} necesita la caja o cuenta de Financiero.`);
    if (['cheque_propio', 'echeq'].includes(m.medio)) {
      const c = m.cheque ?? {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.fecha_pago ?? ''))) throw invalida(`El cheque del medio ${i + 1} lleva su fecha de pago (AAAA-MM-DD).`);
      if (m.medio === 'echeq' ? !c.identificador_red : !(c.banco && c.numero)) throw invalida(`El cheque del medio ${i + 1} lleva ${m.medio === 'echeq' ? 'el identificador de la red' : 'banco y número'}.`);
    }
    if (m.medio === 'cheque_tercero' && !m.cheque_id) throw invalida(`Elegí el cheque de terceros del medio ${i + 1}.`);
    return { medio: m.medio, importe, cuenta_id: m.cuenta_id ?? null, cheque: m.cheque ?? null, cheque_id: m.cheque_id ?? null, referencia: m.referencia ? String(m.referencia).slice(0, 100) : null };
  });
  void neto;
  return out;
};

const siguienteNumero = async (conn) => {
  const [[n]] = await conn.query("SELECT ultimo FROM cmp_numeracion WHERE clave = 'orden_pago' FOR UPDATE");
  await conn.query("UPDATE cmp_numeracion SET ultimo = ? WHERE clave = 'orden_pago'", [n.ultimo + 1]);
  return n.ultimo + 1;
};

// Las retenciones de la orden: las calculadas, o las que un usuario con permiso modificó (queda registrado el valor calculado).
const retencionesDe = async (prov, neto, fecha, d, ctx, excluirOrden = null) => {
  if (!(await Retenciones.activa())) return [];
  const calc = await Retenciones.calcular(prov, neto, fecha, { excluirOrden });
  if (!Array.isArray(d.retenciones)) return calc.map((c) => ({ ...c, importe: c.calculado }));
  if (!ctx.puedeModificarRetenciones) throw invalida('Modificar una retención calculada necesita su permiso.', 403, { codigo: 'SIN_PERMISO' });
  return calc.map((c) => { const m = d.retenciones.find((x) => Number(x.regimen_id) === c.regimen_id); const imp = m ? r2(m.importe) : c.calculado; if (!(imp >= 0)) throw invalida('Una retención no puede ser negativa.'); return { ...c, importe: imp }; });
};

// Calcula las retenciones de una orden antes de armarla (RF06).
const calcular = async (d) => {
  const prov = await Proveedores.obtener(Number(d.proveedor_id));
  const conn = await pool.getConnection();
  try {
    const aplic = await aplicar(conn, d, prov, String(d.moneda ?? prov.moneda).toUpperCase());
    const suma = (t) => r2(aplic.filter((a) => a.tipo === t).reduce((s, a) => s + a.importe, 0));
    const neto = r2(suma('deuda') - suma('nota_credito') - suma('anticipo'));
    return { deuda_aplicada: suma('deuda'), notas_credito: suma('nota_credito'), anticipos: suma('anticipo'), neto, retenciones: await retencionesDe(prov, neto, hoy(), {}, {}) };
  } finally { conn.release(); }
};

const crear = async (d, ctx = {}) => {
  const prov = await Proveedores.obtener(Number(d.proveedor_id));
  if (prov.estado !== 'activo') throw invalida('El proveedor está desactivado.', 409);
  const tipo = d.tipo === 'anticipo' ? 'anticipo' : 'pago';
  const moneda = String(d.moneda ?? prov.moneda).toUpperCase();
  const conFin = await financiero();
  const cfg = await Proveedores.config();
  const programada = !!d.fecha_programada;
  if (programada) {
    if (!(await Funciones.estaActiva('CMP-PAGOS-PROGRAMADOS'))) throw invalida('Programar pagos necesita la función CMP-PAGOS-PROGRAMADOS.', 409, { codigo: 'FUNCION_INACTIVA' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.fecha_programada)) || d.fecha_programada <= hoy()) throw invalida('La fecha programada es futura (AAAA-MM-DD).');
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const aplic = tipo === 'pago' ? await aplicar(conn, d, prov, moneda) : [];
    if (tipo === 'pago' && !aplic.some((a) => a.tipo === 'deuda')) throw invalida('Elegí al menos una cuota a pagar.');
    const suma = (t) => r2(aplic.filter((a) => a.tipo === t).reduce((s, a) => s + a.importe, 0));
    const deuda = suma('deuda'), nc = suma('nota_credito'), ant = suma('anticipo');
    const neto = tipo === 'anticipo' ? r2(d.importe) : r2(deuda - nc - ant);
    if (!(neto >= 0) || (tipo === 'anticipo' && !(neto > 0))) throw invalida('El importe a pagar no es válido (las notas de crédito y anticipos no pueden superar la deuda).', 400, { codigo: 'IMPORTE_INVALIDO' });
    const rets = tipo === 'pago' ? await retencionesDe(prov, neto, hoy(), d, ctx) : [];
    const totalRet = r2(rets.reduce((s, x) => s + x.importe, 0));
    const medios = await validarMedios(d.medios ?? [], { conFin, neto });
    const totalMedios = r2(medios.reduce((s, m) => s + m.importe, 0));
    // RN09: los medios más las retenciones son el importe aplicado. En una programada el cálculo se rehace al ejecutarla (RN36), con el mismo total.
    if (Math.abs(totalMedios + totalRet - neto) > 0.01 && !(programada && Math.abs(totalMedios + totalRet - neto) <= neto)) throw invalida(`Los medios (${totalMedios}) más las retenciones (${totalRet}) tienen que sumar ${neto}.`, 400, { codigo: 'MEDIOS_NO_CIERRAN', detalle: { neto, medios: totalMedios, retenciones: totalRet } });
    const estado = programada ? 'programada' : cfg.importe_aprobacion_op > 0 && neto > cfg.importe_aprobacion_op ? 'pendiente_aprobacion' : 'aprobada';
    const fn = await Funciones.estado(conn);
    const instantanea = ['CMP-RETENCIONES', 'CMP-PAGOS-PROGRAMADOS'].map((f) => `${f}=${fn.funciones.find((x) => x.id === f)?.activa ? 1 : 0}`).concat(`FIN=${conFin ? 1 : 0}`).join(',');
    const numero = await siguienteNumero(conn);
    const idG = await idGlobal();
    const [r] = await conn.query(
      `INSERT INTO cmp_ordenes_pago (id_global, numero, tipo, proveedor_id, moneda, fecha, estado, fecha_programada, deuda_aplicada, notas_credito, anticipos, retenciones, medios_total, instantanea, version_config, id_solicitud, creada_por, observacion, ts_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [idG, numero, tipo, prov.id, moneda, hoy(), estado, programada ? d.fecha_programada : null, deuda, nc, ant, totalRet, totalMedios, instantanea, fn.version, ctx.idSolicitud ?? null, ctx.userId ?? null, d.observacion ? String(d.observacion).slice(0, 255) : null, Date.now()]);
    for (const a of aplic) {
      await conn.query('INSERT INTO cmp_op_aplicaciones (orden_id, tipo, vencimiento_id, comprobante_id, anticipo_id, importe) VALUES (?, ?, ?, ?, ?, ?)', [r.insertId, a.tipo, a.vencimiento_id ?? null, a.comprobante_id ?? null, a.anticipo_id ?? null, a.importe]);
      if (a.tipo === 'deuda') await conn.query("UPDATE cmp_vencimientos SET estado = IF(saldo - ? <= 0.001, 'pagado', estado), saldo = saldo - ? WHERE id = ?", [a.importe, a.importe, a.vencimiento_id]);
      if (a.tipo === 'anticipo') await conn.query('UPDATE cmp_anticipos SET saldo = saldo - ? WHERE id = ?', [a.importe, a.anticipo_id]);
    }
    for (const m of medios) await conn.query('INSERT INTO cmp_op_medios (orden_id, medio, importe, cuenta_id, cheque, cheque_id, referencia) VALUES (?, ?, ?, ?, ?, ?, ?)', [r.insertId, m.medio, m.importe, m.cuenta_id, m.cheque ? JSON.stringify(m.cheque) : null, m.cheque_id, m.referencia]);
    if (!programada) await Retenciones.emitir(conn, r.insertId, rets.map((x) => ({ ...x })), hoy());
    if (tipo === 'anticipo') await conn.query("INSERT INTO cmp_anticipos (proveedor_id, orden_id, moneda, importe, saldo, fecha) VALUES (?, ?, ?, ?, ?, ?)", [prov.id, r.insertId, moneda, neto, neto, hoy()]);
    if (!programada && estado === 'aprobada') await publicarOrden(conn, { id_global: idG, numero, tipo, proveedor: prov, moneda, deuda, totalRet, totalMedios });
    await conn.commit();
    M.despertar();
    Vencimientos.publicar().catch(() => {});
    return obtener(r.insertId);
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

// La orden y sus retenciones, como eventos para Contable (RF06, RF09, RN28).
const publicarOrden = (conn, o) => M.publicar(conn, { origen: 'compras', destino: 'contable', tipo: 'orden_pago', docTipo: 'orden_pago', docIdGlobal: o.id_global,
  contenido: { orden_id_global: o.id_global, numero: o.numero, tipo: o.tipo, proveedor: o.proveedor.razon_social, cuit: o.proveedor.cuit, moneda: o.moneda, deuda_aplicada: o.deuda, retenciones: o.totalRet, medios: o.totalMedios, fecha: hoy() } });

// ---- Aprobar, ejecutar, anular ----

const aprobar = async (id, ctx) => {
  const o = await fila(id);
  if (!['programada', 'pendiente_aprobacion'].includes(o.estado)) throw invalida(`La orden está ${o.estado}: no hay nada que aprobar.`, 409);
  if (o.estado === 'pendiente_aprobacion' && ctx.supervisorId === o.creada_por) throw invalida('La aprobación la da otro usuario.', 403);
  await pool.query("UPDATE cmp_ordenes_pago SET estado = 'aprobada', aprobada_por = ? WHERE id = ? AND estado IN ('programada', 'pendiente_aprobacion')", [ctx.supervisorId ?? ctx.userId ?? null, id]);
  return obtener(id);
};

const ejecutar = async (id, d, ctx) => {
  let o = await fila(id);
  await integracion(o);
  o = await fila(id);
  if (o.estado === 'pagada') throw invalida('La orden ya está pagada.', 409, { codigo: 'YA_PAGADA' });
  if (o.estado !== 'aprobada') throw invalida(`La orden está ${o.estado}: hay que aprobarla antes de ejecutarla.`, 409, { codigo: 'NO_APROBADA' });
  if (o.ejecutada_ms) throw invalida('La orden ya se ejecutó: está esperando la confirmación de Financiero.', 409, { codigo: 'YA_EJECUTADA' });
  const prov = await Proveedores.obtener(o.proveedor_id);
  const conFin = await financiero();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Una programada rehace sus retenciones al ejecutarse, con la instantánea con que se creó (RN36); la diferencia ajusta el primer medio.
    if (o.fecha_programada && !(await conn.query('SELECT 1 FROM cmp_op_retenciones WHERE orden_id = ? LIMIT 1', [id]))[0].length && /CMP-RETENCIONES=1/.test(o.instantanea ?? '')) {
      const neto = r2(Number(o.deuda_aplicada) - Number(o.notas_credito) - Number(o.anticipos));
      const calc = await Retenciones.calcular(prov, neto, hoy(), { db: conn, excluirOrden: id });
      await Retenciones.emitir(conn, id, calc.map((c) => ({ ...c, importe: c.calculado })), hoy());
      const totalRet = r2(calc.reduce((s, c) => s + c.calculado, 0));
      const [[m]] = await conn.query('SELECT id, importe FROM cmp_op_medios WHERE orden_id = ? ORDER BY id LIMIT 1', [id]);
      const medios = r2(neto - totalRet);
      const [[sum]] = await conn.query('SELECT COALESCE(SUM(importe), 0) AS t FROM cmp_op_medios WHERE orden_id = ?', [id]);
      await conn.query('UPDATE cmp_op_medios SET importe = ? WHERE id = ?', [r2(Number(m.importe) + medios - Number(sum.t)), m.id]);
      await conn.query('UPDATE cmp_ordenes_pago SET retenciones = ?, medios_total = ? WHERE id = ?', [totalRet, medios, id]);
      await publicarOrden(conn, { id_global: o.id_global, numero: o.numero, tipo: o.tipo, proveedor: prov, moneda: o.moneda, deuda: Number(o.deuda_aplicada), totalRet, totalMedios: medios });
    }
    if (conFin) {
      const [medios] = await conn.query('SELECT * FROM cmp_op_medios WHERE orden_id = ? ORDER BY id', [id]);
      await M.publicar(conn, { origen: 'compras', destino: 'financiero', tipo: 'pago_proveedor', docTipo: 'orden_pago', docIdGlobal: o.id_global, docVersion: 1, secuencia: 1, userId: ctx.userId,
        contenido: { orden_id_global: o.id_global, numero: o.numero, tipo: o.tipo, proveedor: prov.razon_social, cuit: prov.cuit, moneda: o.moneda, instantanea: o.instantanea, total: Number(o.medios_total),
          medios: medios.map((m) => ({ medio: m.medio, importe: Number(m.importe), cuenta_id: m.cuenta_id, cheque_id: m.cheque_id, cheque: m.cheque ? JSON.parse(m.cheque) : null, referencia: m.referencia })) } });
      await conn.query('UPDATE cmp_ordenes_pago SET ejecutada_ms = ? WHERE id = ?', [Date.now(), id]);
    } else {
      // Sin Financiero: se marca Pagada a mano indicando el medio, sin movimiento de fondos ni control de saldo (RF06).
      if (!SIN_FINANCIERO.includes(d.medio_manual)) throw invalida('Sin Financiero indicá el medio usado: efectivo o transferencia.', 400, { codigo: 'FALTA_MEDIO' });
      await conn.query("UPDATE cmp_ordenes_pago SET estado = 'pagada', pagada_ms = ?, ejecutada_ms = ?, medio_manual = ? WHERE id = ?", [Date.now(), Date.now(), d.medio_manual, id]);
    }
    await conn.commit();
    M.despertar();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return obtener(id);
};

const restaurar = async (conn, o) => {
  const [apl] = await conn.query('SELECT * FROM cmp_op_aplicaciones WHERE orden_id = ?', [o.id]);
  for (const a of apl) {
    if (a.tipo === 'deuda') await conn.query("UPDATE cmp_vencimientos SET saldo = saldo + ?, estado = 'pendiente' WHERE id = ? AND estado <> 'anulado'", [a.importe, a.vencimiento_id]);
    if (a.tipo === 'anticipo') await conn.query('UPDATE cmp_anticipos SET saldo = saldo + ? WHERE id = ?', [a.importe, a.anticipo_id]);
  }
  await conn.query('UPDATE cmp_op_retenciones SET anulado = 1 WHERE orden_id = ?', [o.id]); // el certificado anulado conserva su número
  if (o.tipo === 'anticipo') await conn.query("UPDATE cmp_anticipos SET estado = 'anulado' WHERE orden_id = ?", [o.id]);
};

const anular = async (id, d, ctx) => {
  let o = await fila(id);
  await integracion(o);
  o = await fila(id);
  if (o.estado === 'anulada') throw invalida('La orden ya está anulada.', 409);
  if (typeof d.motivo !== 'string' || d.motivo.trim().length < 3) throw invalida('El motivo es obligatorio.');
  const conFin = await financiero();
  const entregada = o.estado === 'pagada' || !!o.ejecutada_ms;
  if (entregada && !conFin && d.valores_entregados !== false) throw invalida('Sin Financiero la orden pagada solo se anula si los valores no fueron entregados.', 409, { codigo: 'VALORES_ENTREGADOS' }); // RN10
  if (o.tipo === 'anticipo') {
    const [[a]] = await pool.query('SELECT importe, saldo FROM cmp_anticipos WHERE orden_id = ?', [id]);
    if (a && Number(a.saldo) !== Number(a.importe)) throw invalida('El anticipo ya se aplicó a una orden de pago: desimputalo antes de anularlo.', 409, { codigo: 'ANTICIPO_APLICADO' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE cmp_ordenes_pago SET estado = 'anulada', motivo_anulacion = ? WHERE id = ?", [d.motivo.trim().slice(0, 255), id]);
    await restaurar(conn, o);
    // La reversión viaja como mensaje inverso con la fecha actual y Financiero la aplica solo después de la operación original (RN10, RN34).
    if (o.ejecutada_ms && conFin) await M.publicar(conn, { origen: 'compras', destino: 'financiero', tipo: 'anulacion_pago_proveedor', docTipo: 'orden_pago', docIdGlobal: o.id_global, docVersion: 2, secuencia: 2, userId: ctx.userId,
      contenido: { orden_id_global: o.id_global, motivo: d.motivo.trim() } });
    await M.publicar(conn, { origen: 'compras', destino: 'contable', tipo: 'orden_pago_anulada', docTipo: 'orden_pago', docIdGlobal: o.id_global, docVersion: 3, secuencia: 3, userId: ctx.userId, contenido: { orden_id_global: o.id_global, motivo: d.motivo.trim(), fecha: hoy() } });
    await conn.commit();
    M.despertar();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  Vencimientos.publicar().catch(() => {});
  return obtener(id);
};

// ---- Anticipos, programadas, cuenta ----

const anticipos = async ({ proveedorId } = {}) => (await pool.query(
  `SELECT a.id, a.proveedor_id, p.razon_social AS proveedor, a.orden_id, a.moneda, a.importe, a.saldo, a.fecha, a.estado FROM cmp_anticipos a JOIN cmp_proveedores p ON p.id = a.proveedor_id
   WHERE a.estado = 'vigente' ${proveedorId ? 'AND a.proveedor_id = ?' : ''} ORDER BY a.id DESC`, proveedorId ? [Number(proveedorId)] : []))[0].map((a) => ({ ...a, fecha: iso(a.fecha), importe: Number(a.importe), saldo: Number(a.saldo) }));

// Las programadas avisan en su fecha y nunca se ejecutan solas (RF07).
const avisarProgramadas = async () => {
  const [filas] = await pool.query("SELECT o.id, o.numero, o.fecha_programada, p.razon_social FROM cmp_ordenes_pago o JOIN cmp_proveedores p ON p.id = o.proveedor_id WHERE o.estado IN ('programada', 'aprobada') AND o.fecha_programada IS NOT NULL AND o.fecha_programada <= ? AND o.ejecutada_ms IS NULL", [hoy()]);
  for (const o of filas) await Notificacion.crear({ modulo: 'compras', tipo: 'pago_programado', severidad: 'media', roles: ['administrativo', 'gerente'], clave: `cmp-op-prog:${o.id}`, mensaje: `Hoy toca la orden de pago ${o.numero} a ${o.razon_social} (programada para el ${iso(o.fecha_programada)}).` });
  return { avisos: filas.length };
};

// Los pagos entran a la cuenta corriente del proveedor (RF02): lo que se pagó en efectivo o valores más las retenciones, o el anticipo.
Vencimientos.alArmarCuenta(async (proveedorId, moneda) => {
  const [filas] = await pool.query("SELECT id, numero, tipo, fecha, medios_total, retenciones FROM cmp_ordenes_pago WHERE proveedor_id = ? AND moneda = ? AND estado IN ('aprobada', 'pagada')", [proveedorId, moneda]);
  return filas.map((o) => ({ fecha: iso(o.fecha), orden: 1000000 + o.id, concepto: `${o.tipo === 'anticipo' ? 'Anticipo' : 'Orden de pago'} ${o.numero}`, orden_pago_id: o.id, importe: -r2(Number(o.medios_total) + (o.tipo === 'pago' ? Number(o.retenciones) : 0)) }));
});

// Un comprobante con pagos imputados no se anula (RN08).
Comprobantes.alAnular(async (c) => {
  const [[x]] = await pool.query("SELECT COUNT(*) AS n FROM cmp_op_aplicaciones a JOIN cmp_ordenes_pago o ON o.id = a.orden_id WHERE a.comprobante_id = ? AND a.tipo IN ('deuda', 'nota_credito') AND o.estado <> 'anulada'", [c.id]);
  return x.n ? { mensaje: 'El comprobante tiene pagos imputados: anulá antes la orden de pago.', codigo: 'TIENE_PAGOS' } : null;
});

module.exports = { MEDIOS, obtener, listar, calcular, crear, aprobar, ejecutar, anular, anticipos, avisarProgramadas, integracion, fila, creditoDisponible, idOpPago };
