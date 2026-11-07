const M = require('../mensajeria/servicio');
const Notificacion = require('../models/notificacionModel');
const Destinos = require('./destinoService');
const Cuentas = require('./cuentaService');
const Turnos = require('./turnoService');
const Cierres = require('./cierreService');
const { movimiento, r2 } = require('./comun');

// Financiero como receptor de los cobros y devoluciones que registra Ventas (Financiero RF17, RF27, RN29 a RN32, RN41, RN42, RN46). Cada mensaje se aplica una
// sola vez por ID_Operacion (la mensajería lo guarda en la misma transacción); un error de negocio lo deja Rechazado, con su motivo, en la bandeja de pendientes,
// sin reintento y sin tocar la venta (RN32). Una devolución espera a que su cobro original esté Confirmado (RN31, EX22).
const ROLES = ['gerente', 'encargado'];

const marcasDe = (...m) => m.filter(Boolean).join(',') || null;

// Un cobro registrado dos veces con la misma referencia externa (ID de la pasarela o del cupón) es un duplicado (RN30, EX21): para la misma venta siempre; en una
// cuenta de pasarela, tampoco puede respaldar el cobro de dos ventas distintas.
const controlarReferencia = async (conn, { referencia, docIdGlobal, cuenta }) => {
  if (!referencia) return;
  const [dup] = await conn.query(
    "SELECT id, doc_id_global FROM fin_movimientos WHERE referencia_externa = ? AND tipo = 'cobro' AND (doc_id_global = ? OR (cuenta_id = ? AND ? = 'pasarela')) LIMIT 1",
    [referencia, docIdGlobal, cuenta.id, cuenta.tipo]);
  if (!dup.length) return;
  await Notificacion.crear({
    modulo: 'financiero', tipo: 'cobro_duplicado', severidad: 'alta', roles: ROLES, clave: `cobro-duplicado:${docIdGlobal}:${referencia}`,
    mensaje: `Cobro duplicado: la referencia ${referencia} ya respalda el movimiento ${dup[0].id} (venta ${dup[0].doc_id_global}).`,
  });
  throw new M.RechazoNegocio(`Cobro duplicado: la referencia externa ${referencia} ya respalda el movimiento ${dup[0].id}.`);
};

const importeDelPago = (cuenta, p) => {
  const divisa = p.moneda && p.moneda !== 'ARS';
  if (!divisa) {
    if (cuenta.moneda !== 'ARS') throw new M.RechazoNegocio(`El cobro es en pesos y el destino "${cuenta.nombre}" es en ${cuenta.moneda}.`);
    return { importe: r2(p.importe) };
  }
  if (cuenta.moneda !== p.moneda) throw new M.RechazoNegocio(`El cobro es en ${p.moneda} y el destino "${cuenta.nombre}" es en ${cuenta.moneda}.`);
  if (!(Number(p.cotizacion) > 0) || !(Number(p.importe_divisa) > 0)) throw new M.RechazoNegocio(`El cobro en ${p.moneda} llegó sin cotización o sin importe en divisa.`);
  return { importe: r2(p.importe_divisa), moneda: p.moneda, importeDivisa: r2(p.importe_divisa), cotizacion: Number(p.cotizacion) };
};

M.registrarReceptor('financiero', 'cobro_registrado', async (conn, c, ctx) => {
  const ids = [];
  for (const [linea, p] of (c.pagos ?? []).entries()) {
    if (Destinos.NO_FONDOS.has(p.forma)) continue;
    const { cuenta } = await Destinos.resolver(conn, p.forma, c.terminal_id);
    const monto = importeDelPago(cuenta, p);
    await controlarReferencia(conn, { referencia: p.referencia, docIdGlobal: ctx.docIdGlobal, cuenta });
    // Un cobro de un turno que ya se cerró nunca lo modifica: va como ajuste al turno actual de la caja, o queda en espera (RN41, EX30).
    const t = await Turnos.paraCobro(conn, cuenta, { fechaMs: c.fecha_ms ?? null });
    if (t.ajuste && p.forma === 'efectivo') // el cobro ya explicaba una diferencia del cierre de su turno (RN41 b)
      await Cierres.compensarCierre(conn, { ref: ctx.docIdGlobal, cuentaId: cuenta.id, efecto: monto.importe, turnoId: t.turnoId, enEspera: t.enEspera, docIdGlobal: ctx.docIdGlobal, userId: null });
    ids.push(await movimiento(conn, {
      cuentaId: cuenta.id, turnoId: t.turnoId, tipo: t.ajuste ? 'ajuste' : 'cobro', ...monto, formaPago: p.forma, referenciaExterna: p.referencia ?? null,
      idOperacion: ctx.idOperacion, linea, docIdGlobal: ctx.docIdGlobal, enEspera: t.enEspera, terminalId: c.terminal_id ?? null,
      marcas: marcasDe(c.no_fiscal && 'venta_no_fiscal', c.turno_no_verificado && 'turno_no_verificado', t.ajuste && 'cobro_posterior_al_cierre'), // RN46, RN04, RN41
    }));
  }
  return { movimientos: ids };
});

// El cobro revertido por una devolución (contramovimiento, RN02): se registra siempre, en la caja o cuenta del cobro original (RN42). Si la caja de efectivo
// queda en negativo sin una autorización previa, se marca, se alerta al supervisor y se deja el movimiento para ratificar (EX31).
M.registrarReceptor('financiero', 'cobro_revertido', async (conn, c, ctx) => {
  const ids = [];
  for (const [linea, r] of (c.reintegros ?? []).entries()) {
    if (Destinos.NO_FONDOS.has(r.forma)) continue;
    const [orig] = await conn.query("SELECT * FROM fin_movimientos WHERE doc_id_global = ? AND forma_pago = ? AND tipo IN ('cobro', 'ajuste') AND importe > 0 ORDER BY id LIMIT 1", [c.venta_id_global, r.forma]);
    let cuenta;
    if (orig.length) [[cuenta]] = await conn.query('SELECT * FROM fin_cuentas WHERE id = ?', [orig[0].cuenta_id]);
    else cuenta = (await Destinos.resolver(conn, r.forma, c.terminal_id)).cuenta;
    if (!cuenta.activa) throw new M.RechazoNegocio(`La caja o cuenta "${cuenta.nombre}" está desactivada.`);
    const importe = cuenta.moneda === 'ARS' ? r2(r.importe) : r2(r.importe_divisa ?? r.importe);
    const t = await Turnos.paraContramovimiento(conn, cuenta);
    const id = await movimiento(conn, {
      cuentaId: cuenta.id, turnoId: t.turnoId, tipo: 'devolucion', importe: -importe, moneda: cuenta.moneda, formaPago: r.forma, idOperacion: ctx.idOperacion, linea,
      docIdGlobal: c.venta_id_global, vinculoId: orig[0]?.id ?? null, motivo: c.motivo ?? null, enEspera: t.enEspera, terminalId: c.terminal_id ?? null,
    });
    ids.push(id);
    if (Cuentas.ES_CAJA(cuenta.tipo)) {
      const saldo = await Cuentas.saldoDe(cuenta.id, conn);
      if (saldo < 0) {
        const marca = c.saldo_autorizado_por ? 'saldo_negativo_autorizado' : 'saldo_negativo_sin_autorizacion';
        await conn.query('UPDATE fin_movimientos SET marcas = ? WHERE id = ?', [`${marca}:${saldo}`, id]);
        if (!c.saldo_autorizado_por) await Notificacion.crear({
          modulo: 'financiero', tipo: 'saldo_negativo_sin_autorizacion', severidad: 'critica', roles: ROLES, clave: `saldo-negativo:${id}`,
          mensaje: `La devolución del movimiento ${id} dejó "${cuenta.nombre}" con saldo ${saldo} sin autorización previa: ratificala con un supervisor.`,
        });
      }
    }
  }
  return { movimientos: ids };
}, { revierte: 'cobro_registrado' });
