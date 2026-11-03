const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const Notificacion = require('../models/notificacionModel');
const Clientes = require('./clienteService');
const Cuentas = require('./cuentaService');
const { idGlobal } = require('../utils/idGlobal');

// Recibos e imputación (Clientes y CC RF06, RF07, RF17, RN07, RN08, RN36, RN39, EX05, EX09, EX28). Un recibo reúne formas de pago (el cheque lleva sus datos
// propios), se numera en forma correlativa por punto de emisión sin saltos y cancela comprobantes: por vencimiento del más antiguo al más reciente (automática)
// o los que elige el usuario (manual). El excedente queda como saldo a favor. El registro es idempotente por ID_Operacion: un reintento no duplica el recibo,
// su imputación ni consume otro número. Un recibo anulado conserva su número con estado «Anulado».
// shortcut: sin Financiero los valores quedan solo como datos del recibo; cuando exista, el ingreso viaja como mensaje (RF06) y la anulación de un valor
// depositado se bloquea (EX08).
class ReciboInvalido extends Error {}
const invalida = (m, status = 400, extra = {}) => Object.assign(new ReciboInvalido(m), { status, ...extra });
const num = Cuentas.num;

const canonico = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((c) => [c, x[c]])) : x));
const FORMAS_PROPIAS = ['cheque', 'echeq'];

const normalizarValores = async (valores, conn) => {
  if (!Array.isArray(valores) || !valores.length) throw invalida('Indicá al menos una forma de pago en el recibo.');
  const [formas] = await conn.query('SELECT codigo, admite_vuelto FROM formas_pago WHERE activa = 1');
  const porCodigo = new Map(formas.map((f) => [f.codigo, f]));
  return valores.map((v) => {
    const importe = num(v.importe);
    if (!(importe > 0) || !Number.isFinite(importe)) throw invalida('El importe de cada forma de pago es un número mayor que cero.');
    const propia = FORMAS_PROPIAS.includes(v.forma);
    const f = porCodigo.get(v.forma);
    if (!propia && (!f || v.forma === 'cuenta_corriente')) throw invalida(`La forma de pago "${v.forma}" no existe, está desactivada o no se usa en un recibo.`);
    let cheque = {};
    if (propia) {
      const c = v.cheque ?? {};
      if (!String(c.banco ?? '').trim() || !String(c.numero ?? '').trim()) throw invalida('El cheque lleva banco y número.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(c.fecha_pago ?? '')) throw invalida('La fecha de pago del cheque va como AAAA-MM-DD.');
      if (!Clientes.cuitValido(String(c.cuit_librador ?? '').replace(/\D/g, ''))) throw invalida('El CUIT del librador no es válido.');
      cheque = { banco: String(c.banco).trim().slice(0, 80), numero: String(c.numero).trim().slice(0, 30), fecha_pago: c.fecha_pago, cuit_librador: String(c.cuit_librador).replace(/\D/g, '') };
    }
    let recibido = null, vuelto = 0;
    if (v.recibido !== undefined && v.recibido !== null) { // RN07: el vuelto solo se admite en las formas configuradas para darlo
      recibido = num(v.recibido);
      if (recibido < importe) throw invalida('Lo recibido no puede ser menor que el importe.');
      vuelto = num(recibido - importe);
      if (vuelto > 0 && !(f?.admite_vuelto)) throw invalida(`La forma "${v.forma}" no admite vuelto.`);
    }
    return { forma: v.forma, importe, recibido, vuelto, referencia: v.referencia ? String(v.referencia).slice(0, 100) : null, cheque };
  });
};

// Imputa un crédito (recibo, nota de crédito con saldo, saldo a favor) a los débitos de la cuenta. Con los débitos bloqueados: dos usuarios que imputan al
// mismo comprobante a la vez no lo pasan (la segunda se rechaza y recalcula los pendientes, EX09).
const imputarEn = async (conn, { cuentaId, credito, modo = 'automatica', items = [], userId = null }) => {
  const [[cred]] = await conn.query('SELECT * FROM movimientos_cc WHERE id = ? AND cuenta_id = ? FOR UPDATE', [credito, cuentaId]);
  if (!cred || cred.naturaleza !== 'credito' || cred.estado === 'anulado') throw invalida('El crédito a imputar no existe o está anulado.', 404);
  let disponible = num(cred.saldo_pendiente);
  if (disponible <= 0) return { aplicado: 0, restante: 0, imputaciones: [] };
  const [debitos] = await conn.query("SELECT * FROM movimientos_cc WHERE cuenta_id = ? AND naturaleza = 'debito' AND estado = 'pendiente' AND saldo_pendiente > 0 ORDER BY fecha_vencimiento, id FOR UPDATE", [cuentaId]);
  const hoy = Cuentas.hoy();
  const aplicar = [];
  if (modo === 'automatica') {
    for (const d of debitos) { if (disponible <= 0) break; const x = Math.min(disponible, num(d.saldo_pendiente)); aplicar.push([d, x]); disponible = num(disponible - x); }
  } else {
    const porId = new Map(debitos.map((d) => [d.id, d]));
    const vistos = new Set();
    for (const it of items) {
      const d = porId.get(Number(it.debito_id));
      const x = num(it.importe);
      if (!d) throw invalida(`El comprobante ${it.debito_id} no tiene saldo pendiente (quizá otro usuario ya lo imputó): revisá los pendientes.`, 409, { codigo: 'COMPROBANTE_SIN_SALDO' });
      if (vistos.has(d.id)) throw invalida('Un comprobante figura dos veces en la imputación.');
      vistos.add(d.id);
      if (!(x > 0)) throw invalida('El importe imputado a cada comprobante es mayor que cero.');
      if (x > num(d.saldo_pendiente)) throw invalida(`El importe supera el saldo pendiente del comprobante ${d.id} (${num(d.saldo_pendiente)}).`, 409, { codigo: 'COMPROBANTE_SIN_SALDO', saldo_pendiente: num(d.saldo_pendiente) });
      if (x > disponible) throw invalida(`El recibo no alcanza: quedan ${disponible} por imputar.`);
      aplicar.push([d, x]); disponible = num(disponible - x);
    }
  }
  const creadas = [];
  for (const [d, x] of aplicar) {
    const [r] = await conn.query("INSERT INTO imputaciones (credito_mov_id, debito_mov_id, importe, fecha, user_id) VALUES (?, ?, ?, ?, ?)", [cred.id, d.id, x, hoy, userId]);
    await conn.query("UPDATE movimientos_cc SET estado = IF(saldo_pendiente - ? <= 0, 'cancelado', estado), saldo_pendiente = saldo_pendiente - ? WHERE id = ?", [x, x, d.id]); // el estado va primero: MySQL asigna de izquierda a derecha
    creadas.push({ id: r.insertId, debito_id: d.id, importe: x });
  }
  const aplicado = num(creadas.reduce((a, c) => a + c.importe, 0));
  await conn.query('UPDATE movimientos_cc SET saldo_pendiente = saldo_pendiente - ? WHERE id = ?', [aplicado, cred.id]);
  return { aplicado, restante: num(cred.saldo_pendiente - aplicado), imputaciones: creadas };
};

const huellaDe = (cuentaId, valores, imputacion, items) => crypto.createHash('sha256').update(canonico({ cuentaId, valores, imputacion, items })).digest('hex');

const cuentaDe = async (conn, { cuenta_id: cuentaId, cliente_id: clienteId, moneda = 'ARS' }) => {
  if (cuentaId) return (await conn.query('SELECT * FROM cuentas_corrientes WHERE id = ? FOR UPDATE', [cuentaId]))[0][0];
  const c = await Clientes.resolver(clienteId);
  return c ? (await conn.query('SELECT * FROM cuentas_corrientes WHERE cliente_id = ? AND moneda = ? FOR UPDATE', [c.id, moneda]))[0][0] : null;
};

const registrar = async (d, { userId = null, idOperacion } = {}) => {
  if (!idOperacion) throw invalida('Falta la clave de la operación (X-ID-Solicitud).');
  const conn = await pool.getConnection();
  try {
    const valores = await normalizarValores(d.valores, conn);
    const imputacion = d.imputacion ?? 'automatica';
    if (!['automatica', 'manual', 'ninguna'].includes(imputacion)) throw invalida('La imputación es automatica, manual o ninguna.');
    const huella = huellaDe(d.cuenta_id ?? `${d.cliente_id}:${d.moneda ?? 'ARS'}`, valores, imputacion, d.imputaciones ?? []);
    const [[previo]] = await conn.query('SELECT id, huella FROM recibos WHERE id_operacion = ?', [idOperacion]);
    if (previo) { // un reintento devuelve el recibo original sin repetir nada (RN36, EX28); la misma clave con otro contenido es un conflicto
      if (previo.huella !== huella) {
        await Notificacion.crear({ modulo: 'clientes', tipo: 'conflicto_idempotencia', severidad: 'alta', roles: ['administrador', 'gerente', 'administrativo'], clave: `conflicto-recibo-${idOperacion}`, mensaje: `Se reutilizó la clave ${idOperacion} con otro contenido en un recibo.` });
        throw invalida('La clave de la operación ya se usó con otro contenido (conflicto de idempotencia).', 409, { codigo: 'CONFLICTO_IDEMPOTENCIA' });
      }
      return { ...(await obtener(previo.id)), ya_procesado: true };
    }
    await conn.beginTransaction();
    const cuenta = await cuentaDe(conn, d);
    if (!cuenta) throw invalida('La cuenta corriente no existe.', 404);
    if (cuenta.estado === 'cerrada') throw invalida('La cuenta está cerrada: no admite recibos.', 409);
    const total = num(valores.reduce((a, v) => a + v.importe, 0));
    const [[{ deuda }]] = await conn.query("SELECT COALESCE(SUM(saldo_pendiente), 0) AS deuda FROM movimientos_cc WHERE cuenta_id = ? AND naturaleza = 'debito' AND estado = 'pendiente'", [cuenta.id]);
    if (imputacion !== 'ninguna' && total > num(deuda) && !d.confirmar_excedente)
      throw invalida(`El recibo (${total}) supera la deuda pendiente (${num(deuda)}): confirmá que el excedente queda como saldo a favor.`, 409, { codigo: 'EXCEDENTE', excedente: num(total - num(deuda)) }); // EX05
    if (imputacion === 'manual' && num((d.imputaciones ?? []).reduce((a, i) => a + num(i.importe), 0)) > total) throw invalida('Lo imputado supera el total del recibo.');
    const punto = await Cuentas.parametro('recibo_punto_emision', 1, conn);
    await conn.query('INSERT IGNORE INTO recibo_numeracion (punto_emision, ultimo) VALUES (?, 0)', [punto]);
    const [[{ ultimo }]] = await conn.query('SELECT ultimo FROM recibo_numeracion WHERE punto_emision = ? FOR UPDATE', [punto]);
    const numero = ultimo + 1;
    await conn.query('UPDATE recibo_numeracion SET ultimo = ? WHERE punto_emision = ?', [numero, punto]);
    const cfg = await Funciones.estado(conn);
    const fecha = Cuentas.hoy();
    const ref = `REC-${String(punto).padStart(4, '0')}-${String(numero).padStart(8, '0')}`;
    const [mov] = await conn.query(
      `INSERT INTO movimientos_cc (id_global, cuenta_id, tipo, naturaleza, comprobante_ref, id_operacion, fecha, importe, saldo_pendiente, estado, user_id)
       VALUES (?, ?, 'recibo', 'credito', ?, ?, ?, ?, ?, 'pendiente', ?)`, [await idGlobal(), cuenta.id, ref, `recibo:${idOperacion}`, fecha, total, total, userId]);
    const [r] = await conn.query(
      `INSERT INTO recibos (id_global, id_operacion, huella, punto_emision, numero, cliente_id, cuenta_id, movimiento_id, fecha, total, user_id, config_version, instantanea)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [await idGlobal(), idOperacion, huella, punto, numero, cuenta.cliente_id, cuenta.id, mov.insertId, fecha, total, userId, cfg.version, JSON.stringify(cfg.funciones.filter((f) => f.activa).map((f) => f.id))]);
    for (const v of valores)
      await conn.query('INSERT INTO recibo_valores (recibo_id, forma, importe, recibido, vuelto, referencia, cheque_banco, cheque_numero, cheque_fecha_pago, cheque_cuit_librador) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [r.insertId, v.forma, v.importe, v.recibido, v.vuelto, v.referencia, v.cheque.banco ?? null, v.cheque.numero ?? null, v.cheque.fecha_pago ?? null, v.cheque.cuit_librador ?? null]);
    if (imputacion !== 'ninguna') await imputarEn(conn, { cuentaId: cuenta.id, credito: mov.insertId, modo: imputacion, items: d.imputaciones ?? [], userId });
    await conn.commit();
    return obtener(r.insertId);
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.code === 'ER_DUP_ENTRY' && /uq_recibo_operacion/.test(err.message)) { // dos envíos simultáneos con la misma clave: gana el primero
      const [[p]] = await pool.query('SELECT id FROM recibos WHERE id_operacion = ?', [idOperacion]);
      if (p) return { ...(await obtener(p.id)), ya_procesado: true };
    }
    throw err;
  } finally { conn.release(); }
};

const formato = (r) => `${String(r.punto_emision).padStart(4, '0')}-${String(r.numero).padStart(8, '0')}`;
const obtener = async (id) => {
  const [[r]] = await pool.query('SELECT * FROM recibos WHERE id = ?', [id]);
  if (!r) throw invalida('Recibo no encontrado.', 404);
  const [valores] = await pool.query('SELECT forma, importe, recibido, vuelto, referencia, cheque_banco, cheque_numero, cheque_fecha_pago, cheque_cuit_librador FROM recibo_valores WHERE recibo_id = ? ORDER BY id', [id]);
  const [imps] = await pool.query("SELECT i.id, i.debito_mov_id AS debito_id, i.importe, i.estado, m.comprobante_ref FROM imputaciones i JOIN movimientos_cc m ON m.id = i.debito_mov_id WHERE i.credito_mov_id = ? ORDER BY i.id", [r.movimiento_id]);
  const [[mov]] = await pool.query('SELECT saldo_pendiente FROM movimientos_cc WHERE id = ?', [r.movimiento_id]);
  return { ...r, numero_completo: formato(r), total: num(r.total), instantanea: r.instantanea ? JSON.parse(r.instantanea) : [], valores: valores.map((v) => ({ ...v, importe: num(v.importe), vuelto: num(v.vuelto) })),
    imputaciones: imps.map((i) => ({ ...i, importe: num(i.importe) })), saldo_a_favor: r.estado === 'vigente' ? num(mov.saldo_pendiente) : 0 };
};
const listar = async ({ cuenta_id: cuentaId, estado } = {}) => (await pool.query(`SELECT id, punto_emision, numero, cliente_id, cuenta_id, fecha, total, estado FROM recibos ${cuentaId ? 'WHERE cuenta_id = ?' : ''} ${estado ? (cuentaId ? 'AND' : 'WHERE') + ' estado = ?' : ''} ORDER BY id DESC LIMIT 200`, [cuentaId, estado].filter((x) => x !== undefined)))[0]
  .map((r) => ({ ...r, numero_completo: formato(r), total: num(r.total) }));

// Anular (RF17): exige permiso y motivo; desimputa los comprobantes y deja un contramovimiento. Conserva su número con estado «Anulado» (RN08).
const anular = async (id, { motivo, userId = null }) => {
  if (!String(motivo ?? '').trim()) throw invalida('Anular un recibo exige el motivo.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[r]] = await conn.query('SELECT * FROM recibos WHERE id = ? FOR UPDATE', [id]);
    if (!r) throw invalida('Recibo no encontrado.', 404);
    if (r.estado === 'anulado') throw invalida('El recibo ya está anulado.', 409);
    await conn.query('SELECT id FROM cuentas_corrientes WHERE id = ? FOR UPDATE', [r.cuenta_id]);
    const [imps] = await conn.query("SELECT * FROM imputaciones WHERE credito_mov_id = ? AND estado = 'vigente' FOR UPDATE", [r.movimiento_id]);
    for (const i of imps) {
      await conn.query("UPDATE movimientos_cc SET saldo_pendiente = saldo_pendiente + ?, estado = 'pendiente' WHERE id = ?", [i.importe, i.debito_mov_id]);
      await conn.query("UPDATE imputaciones SET estado = 'desimputada', desimputada_por = ?, motivo_desimputacion = 'Anulación del recibo' WHERE id = ?", [userId, i.id]);
    }
    await conn.query("UPDATE movimientos_cc SET estado = 'anulado', saldo_pendiente = 0 WHERE id = ?", [r.movimiento_id]);
    await conn.query(
      `INSERT INTO movimientos_cc (id_global, cuenta_id, tipo, naturaleza, comprobante_ref, referencia_id, id_operacion, detalle, fecha, importe, saldo_pendiente, estado, user_id)
       VALUES (?, ?, 'ajuste', 'debito', ?, ?, ?, 'Anulación de recibo', ?, ?, 0, 'cancelado', ?)`, [await idGlobal(), r.cuenta_id, `${formato(r)}:anulacion`, r.movimiento_id, `recibo-anulacion:${r.id_global}`, Cuentas.hoy(), r.total, userId]);
    await conn.query("UPDATE recibos SET estado = 'anulado', motivo_anulacion = ?, anulado_por = ?, anulado_en = NOW() WHERE id = ?", [String(motivo).trim().slice(0, 255), userId, id]);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return obtener(id);
};

// Imputar un crédito que quedó con saldo (excedente de un recibo, nota de crédito) a la deuda, después (RF07).
const imputar = async (cuentaId, { credito_id: credito, modo = 'automatica', imputaciones = [] }, { userId = null } = {}) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM cuentas_corrientes WHERE id = ? FOR UPDATE', [cuentaId]);
    const r = await imputarEn(conn, { cuentaId, credito: Number(credito), modo, items: imputaciones, userId });
    await conn.commit();
    return r;
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

// Desimputar requiere permiso (la ruta) y motivo: el comprobante vuelve a deber y el crédito a quedar con saldo.
const desimputar = async (imputacionId, { motivo, userId = null }) => {
  if (!String(motivo ?? '').trim()) throw invalida('Desimputar exige el motivo.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[i]] = await conn.query('SELECT * FROM imputaciones WHERE id = ? FOR UPDATE', [imputacionId]);
    if (!i) throw invalida('Imputación no encontrada.', 404);
    if (i.estado !== 'vigente') throw invalida('La imputación ya está desimputada.', 409);
    const [[cred]] = await conn.query('SELECT estado FROM movimientos_cc WHERE id = ? FOR UPDATE', [i.credito_mov_id]);
    if (cred.estado === 'anulado') throw invalida('El crédito está anulado.', 409);
    await conn.query("UPDATE movimientos_cc SET saldo_pendiente = saldo_pendiente + ?, estado = 'pendiente' WHERE id = ?", [i.importe, i.debito_mov_id]);
    await conn.query('UPDATE movimientos_cc SET saldo_pendiente = saldo_pendiente + ? WHERE id = ?', [i.importe, i.credito_mov_id]);
    await conn.query("UPDATE imputaciones SET estado = 'desimputada', desimputada_por = ?, motivo_desimputacion = ? WHERE id = ?", [userId, String(motivo).trim().slice(0, 255), imputacionId]);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return { desimputada: true };
};

// Recibo en PDF para imprimir o enviar (RF06).
const pdf = async (id) => {
  const r = await obtener(id);
  const cli = await Clientes.fila(r.cliente_id);
  const doc = new PDFDocument({ size: 'A5', margin: 40 });
  const trozos = [];
  doc.on('data', (t) => trozos.push(t));
  const fin = new Promise((res) => doc.on('end', res));
  doc.fontSize(16).text(`Recibo ${r.numero_completo}${r.estado === 'anulado' ? ' (ANULADO)' : ''}`);
  doc.moveDown().fontSize(10).text(`Fecha: ${String(r.fecha).slice(0, 10)}`).text(`Cliente: ${cli.razon_social} (${cli.tipo_documento} ${cli.nro_documento})`);
  doc.moveDown().text('Formas de pago:');
  for (const v of r.valores) doc.text(`  ${v.forma}: $ ${v.importe.toFixed(2)}${v.cheque_numero ? ` — cheque ${v.cheque_banco} N° ${v.cheque_numero}, pago ${String(v.cheque_fecha_pago).slice(0, 10)}` : ''}`);
  doc.moveDown().text('Comprobantes cancelados:');
  for (const i of r.imputaciones.filter((x) => x.estado === 'vigente')) doc.text(`  ${i.comprobante_ref}: $ ${i.importe.toFixed(2)}`);
  if (r.saldo_a_favor > 0) doc.text(`  Saldo a favor: $ ${r.saldo_a_favor.toFixed(2)}`);
  doc.moveDown().fontSize(12).text(`Total: $ ${r.total.toFixed(2)}`);
  doc.end();
  await fin;
  return Buffer.concat(trozos);
};

module.exports = { ReciboInvalido, registrar, obtener, listar, anular, imputar, desimputar, pdf, imputarEn };
