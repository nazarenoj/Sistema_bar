const pool = require('../config/db');
const { idGlobal } = require('../utils/idGlobal');
const Cuentas = require('./cuentaService');
const Turnos = require('./turnoService');
const { invalida, r2, movimiento } = require('./comun');
const Contable = require('./aContable');

// Transferencias entre cajas y cuentas (Financiero RF05): retiro a caja fuerte, depósito bancario, transferencia entre cuentas. Son dos movimientos vinculados que
// nacen juntos o ninguno (RN02, RN38). Una caja de efectivo no queda en negativo y una cuenta solo hasta su descubierto (RN08, EX04).

const claseDe = (o, d) => {
  if (Cuentas.ES_CAJA(o.tipo) && d.tipo === 'caja_fuerte') return 'retiro_fuerte';
  if (Cuentas.ES_CAJA(o.tipo) && ['banco', 'billetera'].includes(d.tipo)) return 'deposito';
  return 'transferencia';
};

// Corre dentro de la transacción de quien la llama (`conn`). `turnoOrigenId` lo usa el cierre de turno, que transfiere el resto antes de cerrar.
const transferirTx = async (conn, { origenId, destinoId, importe, motivo, userId, terminalId = null, turnoOrigenId = null }) => {
  const monto = Number(importe);
  if (!(monto > 0)) throw invalida('El importe debe ser mayor a cero.');
  if (typeof motivo !== 'string' || motivo.trim().length < 3) throw invalida('El motivo es obligatorio.');
  if (Number(origenId) === Number(destinoId)) throw invalida('El origen y el destino no pueden ser la misma caja o cuenta.');
  const ids = [Number(origenId), Number(destinoId)].sort((a, b) => a - b);
  for (const id of ids) await conn.query('SELECT id FROM fin_cuentas WHERE id = ? FOR UPDATE', [id]); // siempre en el mismo orden: sin bloqueos cruzados
  const origen = await Cuentas.obtenerFila(Number(origenId), conn);
  const destino = await Cuentas.obtenerFila(Number(destinoId), conn);
  if (!origen.activa || !destino.activa) throw invalida('La caja o cuenta está desactivada.', 409);
  if (origen.moneda !== destino.moneda) throw invalida(`El origen es en ${origen.moneda} y el destino en ${destino.moneda}: la compra y venta de divisas necesita FIN-MONEDA-EXT.`, 409, { codigo: 'MONEDA_DISTINTA' });
  const saldo = await Cuentas.saldoDe(origen.id, conn);
  const piso = Cuentas.ES_CAJA(origen.tipo) ? 0 : -Number(origen.limite_descubierto);
  if (r2(saldo - monto) < piso) throw invalida(`La operación dejaría "${origen.nombre}" ${Cuentas.ES_CAJA(origen.tipo) ? 'en negativo' : 'por debajo de su descubierto'}: el saldo disponible es ${r2(saldo - piso)}.`, 409, { codigo: 'SALDO_INSUFICIENTE', detalle: { saldo: r2(saldo - piso) } });
  let turnoO = turnoOrigenId;
  if (turnoO === null && Turnos.llevaTurno(origen)) {
    const ab = await Turnos.abiertoDe(origen.id, conn);
    if (!ab) throw invalida(`Abrí el turno de la caja "${origen.nombre}" antes de sacar dinero.`, 409, { codigo: 'SIN_TURNO_ABIERTO' });
    turnoO = ab.id;
  }
  const d = await Turnos.paraContramovimiento(conn, destino);
  const idO = await movimiento(conn, { cuentaId: origen.id, turnoId: turnoO, tipo: 'transferencia', importe: -monto, moneda: origen.moneda, motivo: motivo.trim(), userId, terminalId });
  const idD = await movimiento(conn, { cuentaId: destino.id, turnoId: d.turnoId, enEspera: d.enEspera, tipo: 'transferencia', importe: monto, moneda: destino.moneda, vinculoId: idO, motivo: motivo.trim(), userId, terminalId });
  const clase = claseDe(origen, destino);
  const idTransf = await idGlobal();
  const [r] = await conn.query('INSERT INTO fin_transferencias (id_global, clase, origen_id, destino_id, importe, motivo, mov_origen_id, mov_destino_id, user_id, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [idTransf, clase, origen.id, destino.id, monto, motivo.trim().slice(0, 255), idO, idD, userId ?? null, Date.now()]);
  // Entre una caja y una cuenta bancaria cambia la cuenta contable; entre dos de la misma clase no hay asiento (Contable RF03).
  if (origen.moneda === 'ARS' && Contable.claseDe(origen.tipo) !== Contable.claseDe(destino.tipo)) await Contable.publicar(conn, 'transferencia_cuentas', 'transferencia', idTransf,
    { transferencia_id_global: idTransf, importe: r2(monto), desde: Contable.claseDe(origen.tipo), hacia: Contable.claseDe(destino.tipo) }, { userId });
  return { id: r.insertId, clase, origen_id: origen.id, destino_id: destino.id, importe: r2(monto), mov_origen_id: idO, mov_destino_id: idD };
};

const transferir = async (d) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const t = await transferirTx(conn, d);
    await conn.commit();
    return { ...t, saldo_origen: await Cuentas.saldoDe(t.origen_id), saldo_destino: await Cuentas.saldoDe(t.destino_id) };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const listar = async ({ cuentaId, clase, desde, hasta, limite = 100 } = {}) => {
  const w = [], p = [];
  if (cuentaId) { w.push('(t.origen_id = ? OR t.destino_id = ?)'); p.push(Number(cuentaId), Number(cuentaId)); }
  if (clase) { w.push('t.clase = ?'); p.push(clase); }
  if (desde) { w.push('t.ts_ms >= ?'); p.push(new Date(`${desde}T00:00:00`).getTime()); }
  if (hasta) { w.push('t.ts_ms <= ?'); p.push(new Date(`${hasta}T23:59:59.999`).getTime()); }
  const [filas] = await pool.query(
    `SELECT t.*, o.nombre AS origen, d.nombre AS destino FROM fin_transferencias t JOIN fin_cuentas o ON o.id = t.origen_id JOIN fin_cuentas d ON d.id = t.destino_id
     ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY t.id DESC LIMIT ?`, [...p, Math.min(Number(limite) || 100, 500)]);
  return filas.map((t) => ({ id: t.id, clase: t.clase, origen_id: t.origen_id, origen: t.origen, destino_id: t.destino_id, destino: t.destino, importe: Number(t.importe), motivo: t.motivo,
    mov_origen_id: Number(t.mov_origen_id), mov_destino_id: Number(t.mov_destino_id), ts_ms: Number(t.ts_ms) }));
};

module.exports = { transferirTx, transferir, listar };
