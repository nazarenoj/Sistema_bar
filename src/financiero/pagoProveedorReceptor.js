const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const Funciones = require('../funciones/servicio');
const Cuentas = require('./cuentaService');
const Turnos = require('./turnoService');
const Cheques = require('./chequeService');
const { r2, movimiento } = require('./comun');

// Financiero como receptor del pago de una orden de Compras (Financiero RF17, RN32, EX07; Compras RF06): efectivo y transferencias salen de la caja o cuenta elegida (una caja no queda en
// negativo y una cuenta solo hasta su descubierto), el cheque propio o e-cheq entra a la cartera y el cheque de terceros se endosa al proveedor. Un error de negocio rechaza el mensaje
// completo, sin reintento: la orden queda Aprobada (EX07). La anulación es un contramovimiento que espera al pago original (RN31).
const fallo = (m) => new M.RechazoNegocio(m);

M.registrarReceptor('financiero', 'pago_proveedor', async (conn, c, ctx) => {
  const [yaHecho] = await conn.query("SELECT id FROM fin_movimientos WHERE doc_id_global = ? AND tipo = 'pago_proveedor' LIMIT 1", [c.orden_id_global]);
  if (yaHecho.length) return { ya_procesado: true };
  const conCheques = await Funciones.estaActiva('FIN-CHEQUES', conn);
  const [[cat]] = await conn.query("SELECT id FROM fin_categorias WHERE nombre = 'Pagos a proveedores'");
  const salidas = [];
  // 1) Se valida todo antes de mover nada.
  for (const [i, m] of c.medios.entries()) {
    if (['efectivo', 'transferencia', 'cheque_propio', 'echeq'].includes(m.medio)) {
      const [[cuenta]] = await conn.query('SELECT * FROM fin_cuentas WHERE id = ? FOR UPDATE', [Number(m.cuenta_id)]);
      if (!cuenta || !cuenta.activa) throw fallo(`La caja o cuenta del medio ${i + 1} no existe o está desactivada.`);
      if (cuenta.moneda !== c.moneda) throw fallo(`La caja o cuenta "${cuenta.nombre}" es en ${cuenta.moneda} y la orden en ${c.moneda}.`);
      if (['efectivo', 'transferencia'].includes(m.medio)) {
        const saldo = await Cuentas.saldoDe(cuenta.id, conn) - salidas.filter((s) => s.cuenta.id === cuenta.id).reduce((a, s) => a + s.importe, 0);
        const piso = Cuentas.ES_CAJA(cuenta.tipo) ? 0 : -Number(cuenta.limite_descubierto);
        if (r2(saldo - m.importe) < piso) throw fallo(`Fondos insuficientes en "${cuenta.nombre}": el saldo disponible es ${r2(saldo - piso)}.`); // EX07
        const t = await Turnos.paraContramovimiento(conn, cuenta);
        if (Turnos.llevaTurno(cuenta) && !t.turnoId) throw fallo(`La caja "${cuenta.nombre}" no tiene un turno abierto.`);
        salidas.push({ cuenta, importe: m.importe, turnoId: t.turnoId, medio: m });
      }
    }
    if (['cheque_propio', 'echeq', 'cheque_tercero'].includes(m.medio) && !conCheques) throw fallo('Pagar con cheques necesita la función FIN-CHEQUES.');
    if (m.medio === 'cheque_tercero') {
      const [[ch]] = await conn.query('SELECT * FROM fin_cheques WHERE id = ?', [Number(m.cheque_id)]);
      if (!ch || ch.origen !== 'tercero') throw fallo(`El cheque de terceros del medio ${i + 1} no existe.`);
      if (ch.estado !== 'en_cartera') throw fallo(`El cheque ${ch.banco ?? ''} ${ch.numero ?? ch.identificador_red} está ${ch.estado}: solo se endosa uno en cartera.`);
      if (Number(ch.importe) !== Number(m.importe)) throw fallo(`El cheque vale ${Number(ch.importe)} y el medio es por ${m.importe}.`);
    }
  }
  // 2) Movimientos de efectivo y transferencias.
  const ids = [];
  for (const [linea, s] of salidas.entries())
    ids.push(await movimiento(conn, { cuentaId: s.cuenta.id, turnoId: s.turnoId, tipo: 'pago_proveedor', importe: -s.importe, moneda: s.cuenta.moneda, categoriaId: cat?.id ?? null, formaPago: s.medio.medio, referenciaExterna: s.medio.referencia,
      idOperacion: ctx.idOperacion, linea, docIdGlobal: c.orden_id_global, motivo: `Orden de pago ${c.numero}: ${c.proveedor}` }));
  // 3) Cheques: el propio entra a la cartera; el de terceros se endosa al proveedor.
  const cheques = [];
  for (const m of c.medios) {
    if (['cheque_propio', 'echeq'].includes(m.medio)) {
      const ch = await Cheques.registrar({ origen: 'propio', tipo: m.medio === 'echeq' ? 'echeq' : 'fisico', importe: m.importe, moneda: c.moneda, fecha_pago: m.cheque.fecha_pago, banco: m.cheque.banco, numero: m.cheque.numero, identificador_red: m.cheque.identificador_red, librador: 'Propio' },
        { origenModulo: 'compras', origenDoc: c.orden_id_global }).catch((e) => { throw e.status ? fallo(e.message) : e; });
      cheques.push({ cheque_id: ch.id });
    }
    if (m.medio === 'cheque_tercero') {
      const ch = await Cheques.endosar(Number(m.cheque_id), { a: c.proveedor, modulo: 'compras' }, null).catch((e) => { throw e.status ? fallo(e.message) : e; });
      cheques.push({ cheque_id: ch.id, endosado: true });
    }
  }
  return { movimientos: ids, cheques };
});

// La anulación revierte los egresos con contramovimientos (nunca se borran, RN02). Un cheque que ya salió de la cartera no se puede revertir: la anulación se rechaza con su motivo.
M.registrarReceptor('financiero', 'anulacion_pago_proveedor', async (conn, c, ctx) => {
  const [orig] = await conn.query("SELECT * FROM fin_movimientos WHERE doc_id_global = ? AND tipo = 'pago_proveedor' ORDER BY id", [c.orden_id_global]);
  const [cheques] = await conn.query("SELECT * FROM fin_cheques WHERE origen_doc = ? AND origen_modulo = 'compras'", [c.orden_id_global]);
  for (const ch of cheques) if (ch.estado !== 'en_cartera') throw fallo(`El cheque ${ch.banco ?? ''} ${ch.numero ?? ch.identificador_red} ya salió de la cartera (${ch.estado}): no se puede revertir.`);
  const ids = [];
  for (const [linea, m] of orig.entries()) {
    const [[cuenta]] = await conn.query('SELECT * FROM fin_cuentas WHERE id = ?', [m.cuenta_id]);
    const t = await Turnos.paraContramovimiento(conn, cuenta);
    ids.push(await movimiento(conn, { cuentaId: cuenta.id, turnoId: t.turnoId, enEspera: t.enEspera, tipo: 'anulacion_pago_proveedor', importe: -Number(m.importe), moneda: cuenta.moneda, categoriaId: m.categoria_id, formaPago: m.forma_pago, vinculoId: m.id,
      idOperacion: ctx.idOperacion, linea, docIdGlobal: c.orden_id_global, motivo: c.motivo ?? 'Orden de pago anulada' }));
  }
  for (const ch of cheques) await pool.query("UPDATE fin_cheques SET estado = 'anulado' WHERE id = ? AND estado = 'en_cartera'", [ch.id]);
  return { movimientos: ids };
}, { revierte: 'pago_proveedor' });
