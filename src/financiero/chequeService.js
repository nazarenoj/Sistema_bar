const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const Funciones = require('../funciones/servicio');
const { idGlobal } = require('../utils/idGlobal');
const Cuentas = require('./cuentaService');
const { invalida, r2, movimiento } = require('./comun');

// Cartera de cheques (Financiero RF07, RF08, FIN-CHEQUES): cheques de terceros físicos y e-cheq (de recibos de Clientes o cargados a mano) y propios. Estados: En cartera,
// Depositado, Endosado, Acreditado, Rechazado y Anulado. Banco + número + CUIT del librador identifican a un cheque físico; el identificador de la red, a un e-cheq (RN10).
// Financiero no toca saldos de clientes ni de proveedores: el rechazo se publica como evento y quien lo toma reabre la deuda (RN11).
const exigirFuncion = async () => {
  if (!(await Funciones.estaActiva('FIN-CHEQUES'))) throw invalida('La cartera de cheques necesita la función FIN-CHEQUES.', 409, { codigo: 'FUNCION_INACTIVA' });
};

const hoy = () => new Date().toISOString().slice(0, 10);
const iso = (f) => (f instanceof Date ? f.toISOString().slice(0, 10) : f);
const dias = (a, b) => Math.round((new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000);

const vista = (c) => ({
  id: c.id, id_global: c.id_global, origen: c.origen, tipo: c.tipo, banco: c.banco, numero: c.numero, cuit_librador: c.cuit_librador, identificador_red: c.identificador_red, librador: c.librador,
  importe: Number(c.importe), moneda: c.moneda, fecha_emision: iso(c.fecha_emision), fecha_pago: iso(c.fecha_pago), estado: c.estado, origen_modulo: c.origen_modulo, origen_doc: c.origen_doc,
  cliente_id: c.cliente_id, cuenta_id: c.cuenta_id, endosado_a: c.endosado_a, motivo_rechazo: c.motivo_rechazo, gastos_bancarios: Number(c.gastos_bancarios),
});
const fila = async (id, db = pool) => {
  const [[c]] = await db.query('SELECT * FROM fin_cheques WHERE id = ?', [id]);
  if (!c) throw invalida('Cheque no encontrado.', 404);
  return c;
};
const historial = async (db, id, estado, nota, userId) => db.query('INSERT INTO fin_cheque_historial (cheque_id, estado, nota, user_id, ts_ms) VALUES (?, ?, ?, ?, ?)', [id, estado, nota ?? null, userId ?? null, Date.now()]);

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const normalizar = (d) => {
  const tipo = d.tipo === 'echeq' ? 'echeq' : 'fisico';
  const origen = d.origen === 'propio' ? 'propio' : 'tercero';
  const importe = Number(d.importe);
  if (!(importe > 0)) throw invalida('El importe del cheque debe ser mayor a cero.');
  if (!FECHA.test(String(d.fecha_pago ?? ''))) throw invalida('La fecha de pago va como AAAA-MM-DD.');
  if (d.fecha_emision && !FECHA.test(String(d.fecha_emision))) throw invalida('La fecha de emisión va como AAAA-MM-DD.');
  let clave;
  if (tipo === 'echeq') {
    const id = String(d.identificador_red ?? '').trim();
    if (!id) throw invalida('Un e-cheq se identifica por el identificador de la red.');
    clave = `E:${id.toUpperCase()}`;
  } else {
    const ascii = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim(); // la clave es ASCII: sin tildes ni símbolos
    const banco = ascii(d.banco), numero = ascii(d.numero), cuit = String(d.cuit_librador ?? '').replace(/\D/g, '');
    if (!banco || !numero) throw invalida('El cheque lleva banco y número.');
    if (origen === 'tercero' && cuit.length !== 11) throw invalida('El CUIT del librador tiene 11 dígitos.');
    clave = `F:${banco}|${numero}|${cuit}`;
  }
  return { tipo, origen, importe: r2(importe), clave, moneda: String(d.moneda ?? 'ARS').toUpperCase() };
};

const registrar = async (d, { userId = null, origenModulo = 'manual', origenDoc = null, clienteId = null } = {}) => {
  await exigirFuncion();
  const n = normalizar(d);
  if (n.moneda !== 'ARS' && !(await Funciones.estaActiva('FIN-MONEDA-EXT'))) throw invalida('Un cheque en moneda extranjera necesita FIN-MONEDA-EXT.', 409, { codigo: 'FUNCION_INACTIVA' });
  try {
    const [r] = await pool.query(
      `INSERT INTO fin_cheques (id_global, clave_unica, origen, tipo, banco, numero, cuit_librador, identificador_red, librador, importe, moneda, fecha_emision, fecha_pago, origen_modulo, origen_doc, cliente_id, user_id, ts_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [await idGlobal(), n.clave, n.origen, n.tipo, d.banco ? String(d.banco).trim().slice(0, 80) : null, d.numero ? String(d.numero).trim().slice(0, 30) : null, d.cuit_librador ? String(d.cuit_librador).replace(/\D/g, '') : null,
        d.identificador_red ? String(d.identificador_red).trim().slice(0, 80) : null, d.librador ? String(d.librador).slice(0, 150) : null, n.importe, n.moneda, d.fecha_emision ?? null, d.fecha_pago,
        origenModulo, origenDoc, clienteId, userId, Date.now()]);
    await historial(pool, r.insertId, 'en_cartera', origenModulo === 'manual' ? 'Carga manual' : `Desde ${origenModulo} ${origenDoc ?? ''}`.trim(), userId);
    return vista(await fila(r.insertId));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') { // EX08: se bloquea y se muestra el cheque existente
      const [[ex]] = await pool.query('SELECT * FROM fin_cheques WHERE clave_unica = ?', [n.clave]);
      throw invalida('Ese cheque ya está registrado.', 409, { codigo: 'CHEQUE_DUPLICADO', detalle: { cheque: vista(ex) } });
    }
    throw err;
  }
};

// EX09: un cheque con más de N días desde su fecha de pago (parametrizable, 30 por defecto) se puede rechazar: se advierte y se pide confirmación.
const controlarPlazo = async (c, confirmar) => {
  const cfg = await Cuentas.config();
  const vencido = dias(hoy(), iso(c.fecha_pago));
  if (vencido > cfg.plazo_presentacion_cheque_dias && !confirmar)
    throw invalida(`El cheque tiene ${vencido} días desde su fecha de pago (el plazo de presentación es ${cfg.plazo_presentacion_cheque_dias}): puede ser rechazado. Confirmá para seguir.`, 409, { codigo: 'CHEQUE_VENCIDO', detalle: { dias: vencido, plazo: cfg.plazo_presentacion_cheque_dias } });
  if (dias(iso(c.fecha_pago), hoy()) > 0) throw invalida(`El cheque es de pago diferido: se puede presentar desde el ${iso(c.fecha_pago)}.`, 409, { codigo: 'CHEQUE_DIFERIDO' });
};

const depositar = async (id, { cuenta_id: cuentaId, confirmar = false }, userId) => {
  await exigirFuncion();
  const c = await fila(id);
  if (c.origen !== 'tercero') throw invalida('Solo se depositan los cheques de terceros.', 409);
  if (c.estado !== 'en_cartera') throw invalida(`Solo puede depositarse un cheque en cartera (está ${c.estado}).`, 409, { codigo: 'ESTADO_INVALIDO' });
  const cuenta = await Cuentas.obtenerFila(Number(cuentaId));
  if (!['banco', 'billetera'].includes(cuenta.tipo) || !cuenta.activa) throw invalida('El cheque se deposita en una cuenta bancaria activa.');
  if (cuenta.moneda !== c.moneda) throw invalida(`El cheque es en ${c.moneda} y la cuenta en ${cuenta.moneda}.`, 409);
  await controlarPlazo(c, confirmar);
  const [r] = await pool.query("UPDATE fin_cheques SET estado = 'depositado', cuenta_id = ? WHERE id = ? AND estado = 'en_cartera'", [cuenta.id, id]);
  if (!r.affectedRows) throw invalida('El cheque cambió de estado mientras tanto.', 409, { codigo: 'ESTADO_INVALIDO' });
  await historial(pool, id, 'depositado', `En ${cuenta.nombre}`, userId);
  return vista(await fila(id));
};

const endosar = async (id, { a, modulo = null, confirmar = false }, userId) => {
  await exigirFuncion();
  const c = await fila(id);
  if (c.origen !== 'tercero') throw invalida('Solo se endosan los cheques de terceros.', 409);
  if (c.estado !== 'en_cartera') throw invalida(`Solo puede endosarse un cheque en cartera (está ${c.estado}).`, 409, { codigo: 'ESTADO_INVALIDO' });
  if (!String(a ?? '').trim()) throw invalida('Indicá a quién se endosa.');
  await controlarPlazo(c, confirmar);
  const [r] = await pool.query("UPDATE fin_cheques SET estado = 'endosado', endosado_a = ?, endoso_modulo = ? WHERE id = ? AND estado = 'en_cartera'", [String(a).trim().slice(0, 150), modulo, id]);
  if (!r.affectedRows) throw invalida('El cheque cambió de estado mientras tanto.', 409, { codigo: 'ESTADO_INVALIDO' });
  await historial(pool, id, 'endosado', `A ${String(a).trim()}`, userId);
  return vista(await fila(id));
};

// El banco acreditó el depósito (cheque de tercero) o debitó el cheque propio: recién ahí se mueve plata (RN02).
const acreditar = async (id, { cuenta_id: cuentaId } = {}, userId) => {
  await exigirFuncion();
  const c = await fila(id);
  const propio = c.origen === 'propio';
  const permitido = propio ? c.estado === 'en_cartera' : c.estado === 'depositado';
  if (!permitido) throw invalida(`El cheque no se puede acreditar desde el estado ${c.estado}.`, 409, { codigo: 'ESTADO_INVALIDO' });
  const cuenta = await Cuentas.obtenerFila(Number(cuentaId ?? c.cuenta_id));
  if (!['banco', 'billetera'].includes(cuenta.tipo) || !cuenta.activa) throw invalida('Indicá la cuenta bancaria.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM fin_cuentas WHERE id = ? FOR UPDATE', [cuenta.id]);
    if (propio) {
      const saldo = await Cuentas.saldoDe(cuenta.id, conn);
      if (r2(saldo - Number(c.importe)) < -Number(cuenta.limite_descubierto)) throw invalida(`El débito dejaría "${cuenta.nombre}" por debajo de su descubierto.`, 409, { codigo: 'SALDO_INSUFICIENTE' });
    }
    const [u] = await conn.query("UPDATE fin_cheques SET estado = 'acreditado', cuenta_id = ? WHERE id = ? AND estado = ?", [cuenta.id, id, c.estado]);
    if (!u.affectedRows) throw invalida('El cheque cambió de estado mientras tanto.', 409, { codigo: 'ESTADO_INVALIDO' });
    await movimiento(conn, { cuentaId: cuenta.id, tipo: propio ? 'cheque_debitado' : 'cheque_acreditado', importe: propio ? -Number(c.importe) : Number(c.importe), moneda: c.moneda, docIdGlobal: c.id_global, motivo: `Cheque ${c.banco ?? ''} ${c.numero ?? c.identificador_red ?? ''}`.trim(), userId });
    await historial(conn, id, 'acreditado', cuenta.nombre, userId);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return vista(await fila(id));
};

// Rechazo (RF08): motivo y gastos bancarios; si ya estaba acreditado se revierte con un contramovimiento. Publica «Cheque rechazado» (el cliente lo toma si es suyo; si se endosó a
// un proveedor, Compras) y Financiero no conoce a los suscriptores: sin ellos el rechazo queda registrado sin aviso.
const rechazar = async (id, { motivo, gastos_bancarios: gastos = 0 }, userId) => {
  await exigirFuncion();
  const c = await fila(id);
  if (!['depositado', 'acreditado', 'endosado'].includes(c.estado)) throw invalida(`Un cheque ${c.estado} no se rechaza.`, 409, { codigo: 'ESTADO_INVALIDO' });
  if (typeof motivo !== 'string' || motivo.trim().length < 3) throw invalida('El motivo del rechazo es obligatorio.');
  const gb = Number(gastos ?? 0);
  if (!(gb >= 0)) throw invalida('Los gastos bancarios no pueden ser negativos.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (c.cuenta_id && ['depositado', 'acreditado'].includes(c.estado)) {
      await conn.query('SELECT id FROM fin_cuentas WHERE id = ? FOR UPDATE', [c.cuenta_id]);
      const [[cat]] = await conn.query("SELECT id FROM fin_categorias WHERE nombre = 'Comisiones bancarias y de tarjetas'");
      const [[orig]] = await conn.query("SELECT id FROM fin_movimientos WHERE doc_id_global = ? AND tipo = 'cheque_acreditado' LIMIT 1", [c.id_global]);
      if (c.estado === 'acreditado' && orig)
        await movimiento(conn, { cuentaId: c.cuenta_id, tipo: 'cheque_rechazado', importe: -Number(c.importe), moneda: c.moneda, vinculoId: orig.id, docIdGlobal: c.id_global, motivo: motivo.trim(), userId });
      if (gb > 0) await movimiento(conn, { cuentaId: c.cuenta_id, tipo: 'gasto_bancario', importe: -gb, moneda: c.moneda, categoriaId: cat?.id ?? null, docIdGlobal: c.id_global, motivo: `Gastos por cheque rechazado: ${motivo.trim()}`, userId });
    }
    const [u] = await conn.query("UPDATE fin_cheques SET estado = 'rechazado', motivo_rechazo = ?, gastos_bancarios = ? WHERE id = ? AND estado = ?", [motivo.trim().slice(0, 255), gb, id, c.estado]);
    if (!u.affectedRows) throw invalida('El cheque cambió de estado mientras tanto.', 409, { codigo: 'ESTADO_INVALIDO' });
    await historial(conn, id, 'rechazado', motivo.trim(), userId);
    const destino = c.estado === 'endosado' && c.endoso_modulo === 'compras' ? 'compras' : c.origen_modulo === 'clientes' ? 'clientes' : null;
    if (destino) await M.publicar(conn, { origen: 'financiero', destino, tipo: 'cheque_rechazado', docTipo: 'cheque', docIdGlobal: c.id_global, userId,
      contenido: { cheque_id: c.id, cheque_id_global: c.id_global, origen_modulo: c.origen_modulo, origen_doc: c.origen_doc, cliente_id: c.cliente_id, endosado_a: c.endosado_a, banco: c.banco, numero: c.numero ?? c.identificador_red,
        importe: Number(c.importe), moneda: c.moneda, gastos_bancarios: gb, motivo: motivo.trim() } });
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  M.despertar();
  return vista(await fila(id));
};

const anular = async (id, { motivo }, userId) => {
  await exigirFuncion();
  const c = await fila(id);
  if (c.estado !== 'en_cartera') throw invalida('Solo se anula un cheque que está en cartera.', 409, { codigo: 'ESTADO_INVALIDO' });
  if (typeof motivo !== 'string' || motivo.trim().length < 3) throw invalida('El motivo es obligatorio.');
  await pool.query("UPDATE fin_cheques SET estado = 'anulado' WHERE id = ? AND estado = 'en_cartera'", [id]);
  await historial(pool, id, 'anulado', motivo.trim(), userId);
  return vista(await fila(id));
};

const listar = async ({ estado, origen, desde, hasta, vencidos, limite = 200 } = {}) => {
  const w = [], p = [];
  if (estado) { w.push('estado = ?'); p.push(estado); }
  if (origen) { w.push('origen = ?'); p.push(origen); }
  if (desde) { w.push('fecha_pago >= ?'); p.push(desde); }
  if (hasta) { w.push('fecha_pago <= ?'); p.push(hasta); }
  if (vencidos) { w.push("fecha_pago < CURDATE() AND estado = 'en_cartera'"); }
  const [filas] = await pool.query(`SELECT * FROM fin_cheques ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY fecha_pago, id LIMIT ?`, [...p, Math.min(Number(limite) || 200, 1000)]);
  return filas.map(vista);
};
const obtener = async (id) => ({ ...vista(await fila(id)), historial: (await pool.query('SELECT h.estado, h.nota, h.ts_ms, u.username AS usuario FROM fin_cheque_historial h LEFT JOIN users u ON u.id = h.user_id WHERE h.cheque_id = ? ORDER BY h.id', [id]))[0].map((h) => ({ ...h, ts_ms: Number(h.ts_ms) })) });

// Los cheques que llegan de otros módulos: un recibo de Clientes (cheque de tercero) o una orden de pago de Compras (cheque propio). Sin la función se guardan solo como dato del recibo (RN27).
M.registrarReceptor('financiero', 'cheque_recibido', async (conn, c, ctx) => {
  if (!(await Funciones.estaActiva('FIN-CHEQUES', conn))) return { ignorado: true, motivo: 'FIN-CHEQUES inactiva: el cheque queda como dato del recibo.' };
  try {
    const ch = await registrar({ origen: 'tercero', ...c.cheque, importe: c.importe, moneda: c.moneda, librador: c.librador }, { userId: null, origenModulo: 'clientes', origenDoc: c.recibo, clienteId: c.cliente_id ?? null });
    return { cheque_id: ch.id };
  } catch (err) {
    if (err.codigo === 'CHEQUE_DUPLICADO' && err.detalle?.cheque?.origen_doc === c.recibo && err.detalle.cheque.origen_modulo === 'clientes') return { cheque_id: err.detalle.cheque.id, ya_registrado: true };
    if (err.codigo === 'CHEQUE_DUPLICADO' || err.status) throw new M.RechazoNegocio(err.message);
    throw err;
  }
});
M.registrarReceptor('financiero', 'cheque_propio_emitido', async (conn, c) => {
  if (!(await Funciones.estaActiva('FIN-CHEQUES', conn))) return { ignorado: true, motivo: 'FIN-CHEQUES inactiva.' };
  try { return { cheque_id: (await registrar({ origen: 'propio', ...c.cheque, importe: c.importe, moneda: c.moneda }, { origenModulo: 'compras', origenDoc: c.orden_pago })).id }; } catch (err) {
    if (err.status) throw new M.RechazoNegocio(err.message);
    throw err;
  }
});

module.exports = { registrar, depositar, endosar, acreditar, rechazar, anular, listar, obtener };
