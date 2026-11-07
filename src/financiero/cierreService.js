const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const Funciones = require('../funciones/servicio');
const llamar = require('../modulos/llamar');
const Integracion = require('../services/integracionVentasService');
const Cuentas = require('./cuentaService');
const Turnos = require('./turnoService');
const { invalida, r2, cts, movimiento } = require('./comun');

// Arqueo y cierre de turno (Financiero RF04, RF28, RN05, RN06, RN41). El efectivo teórico de la caja es su saldo derivado; la diferencia con lo contado se
// registra como un movimiento de «Faltante» o «Sobrante» (nada se edita, RN02). Si supera la tolerancia pide motivo y un supervisor (RN05, EX03).

const esCiego = (turno, cuenta) => !!cuenta.cierre_ciego && (turno.funciones ?? '').split(',').includes('FIN-CIERRE-CIEGO'); // la función vigente al abrir (RN39)

const numero = (v, nombre) => {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n) || n < 0) throw invalida(`${nombre} es obligatorio y no puede ser negativo.`);
  return r2(n);
};

// Valida el conteo por forma de pago (efectivo, cupones y, con FIN-CHEQUES, cheques) y por denominación (RF04).
const validarConteo = async (c = {}) => {
  const efectivo = numero(c.efectivo, 'El efectivo contado');
  const conteo = { efectivo };
  if (c.denominaciones !== undefined && c.denominaciones !== null) {
    const suma = Object.entries(c.denominaciones).reduce((a, [valor, cantidad]) => {
      if (!(Number(valor) > 0) || !Number.isInteger(Number(cantidad)) || Number(cantidad) < 0) throw invalida('Las denominaciones son valor => cantidad entera.');
      return a + cts(valor) * Number(cantidad);
    }, 0);
    if (suma !== cts(efectivo)) throw invalida(`Las denominaciones suman ${suma / 100} y el efectivo contado es ${efectivo}.`);
    conteo.denominaciones = c.denominaciones;
  }
  if (c.cupones !== undefined && c.cupones !== null) conteo.cupones = numero(c.cupones, 'El total de cupones');
  if (c.cheques !== undefined && c.cheques !== null) {
    if (!(await Funciones.estaActiva('FIN-CHEQUES'))) throw invalida('Contar cheques necesita la función FIN-CHEQUES.', 409, { codigo: 'FUNCION_INACTIVA' });
    conteo.cheques = numero(c.cheques, 'El total de cheques');
  }
  return conteo;
};

// Cupones de tarjeta del turno: lo cobrado en las cuentas de procesadores desde esa terminal mientras el turno estuvo abierto.
const cuponesTeoricos = async (turno, hastaMs, db = pool) => {
  const [[r]] = await db.query(
    `SELECT COALESCE(SUM(m.importe), 0) AS total FROM fin_movimientos m JOIN fin_cuentas c ON c.id = m.cuenta_id
     WHERE c.tipo = 'procesador' AND m.terminal_id <=> ? AND m.fecha_ms BETWEEN ? AND ? AND m.tipo IN ('cobro', 'devolucion', 'ajuste')`, [turno.terminal_id, Number(turno.abierto_ms), hastaMs]);
  return r2(r.total);
};

const efectivoDe = (pagos) => r2((pagos ?? []).filter((p) => p.forma === 'efectivo').reduce((a, p) => a + Number(p.importe), 0));

// La lista de cobros del turno con integración pendiente (RF28): (a) los que Ventas tiene Pendientes, Fallidos o Rechazados (llamada n.º 16) y (b) los mensajes que
// Financiero retuvo «en espera del original» o rechazó. `verificado` es falso si Ventas no respondió (el cierre se permite con motivo).
const pendientes = async (turno, { ciego = false } = {}) => {
  const hasta = Date.now();
  const items = [];
  const a = await llamar(16, 'financiero', () => Integracion.cobrosConIntegracionPendiente({ terminalId: turno.terminal_id, desdeMs: Number(turno.abierto_ms), hastaMs: hasta }));
  if (!a.fallo) for (const x of a.valor) items.push({ ref: x.venta, origen: 'ventas', estado: x.estado, motivo: x.motivo, efecto_efectivo: efectivoDe(x.pagos), pagos: x.pagos });
  const [dev] = await pool.query(
    `SELECT m.doc_id_global, m.estado, m.retenido_por_orden, m.motivo_rechazo, m.contenido FROM mensajes_integracion m
     WHERE m.modulo_destino = 'financiero' AND m.tipo = 'cobro_revertido' AND m.descartado = 0 AND m.estado <> 'confirmado' AND m.ts_origen_ms >= ?`, [Number(turno.abierto_ms)]);
  for (const d of dev) {
    const c = JSON.parse(d.contenido);
    const [[propia]] = await pool.query("SELECT 1 AS si FROM fin_movimientos WHERE doc_id_global = ? AND tipo = 'cobro' AND cuenta_id = ? LIMIT 1", [d.doc_id_global, turno.cuenta_id]);
    if (!propia) continue;
    items.push({ ref: `${d.doc_id_global}#devolucion`, origen: 'financiero', estado: d.retenido_por_orden ? 'en_espera_del_original' : d.estado, motivo: d.motivo_rechazo,
      efecto_efectivo: -efectivoDe(c.reintegros), pagos: (c.reintegros ?? []).map((r) => ({ forma: r.forma, importe: Number(r.importe) })) });
  }
  // Con el cierre ciego la lista no muestra importes ni saldos (RF28, RN06).
  const vista = ciego ? items.map(({ ref, origen, estado, motivo }) => ({ ref, origen, estado, motivo })) : items;
  return { verificado: !a.fallo, items: vista, _completos: items };
};

const fila = async (turnoId, db = pool) => Turnos.fila(turnoId, db);

const arquear = async (turnoId, { conteo, nota }, userId) => {
  const turno = await fila(turnoId);
  if (turno.estado !== 'abierto') throw invalida('El turno está cerrado.', 409);
  const cuenta = await Cuentas.obtenerFila(turno.cuenta_id);
  const c = await validarConteo(conteo);
  const teorico = await Cuentas.saldoDe(cuenta.id);
  const diferencia = r2(c.efectivo - teorico);
  const [r] = await pool.query('INSERT INTO fin_arqueos (turno_id, user_id, contado, teorico, diferencia, nota, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?)', [turnoId, userId, c.efectivo, teorico, diferencia, nota ? String(nota).slice(0, 255) : null, Date.now()]);
  // En un cierre ciego el cajero no ve el teórico ni la diferencia mientras cuenta (RN06).
  return esCiego(turno, cuenta) ? { id: r.insertId, registrado: true } : { id: r.insertId, contado: c.efectivo, teorico, diferencia };
};

const listaPendientes = async (turnoId) => {
  const turno = await fila(turnoId);
  const cuenta = await Cuentas.obtenerFila(turno.cuenta_id);
  const p = await pendientes(turno, { ciego: esCiego(turno, cuenta) && turno.estado === 'abierto' });
  return { verificado: p.verificado, pendientes: p.items };
};

// Cierra el turno. `ctx.autorizar()` valida la credencial de un supervisor cuando la diferencia supera la tolerancia (RN05, EX03).
const cerrar = async (turnoId, body, ctx) => {
  const turno = await fila(turnoId);
  if (turno.estado !== 'abierto') throw invalida('El turno ya está cerrado.', 409);
  const cuenta = await Cuentas.obtenerFila(turno.cuenta_id);
  const conteo = await validarConteo(body.conteo ?? { efectivo: body.efectivo });
  const ciego = esCiego(turno, cuenta);

  // RF28, EX29: cada cobro con integración pendiente se resuelve o se confirma con motivo; sin eso el turno no se cierra.
  const lista = await pendientes(turno, { ciego });
  const decisiones = new Map((body.pendientes ?? []).map((d) => [d.ref, d]));
  const sinDecidir = lista._completos.filter((i) => String(decisiones.get(i.ref)?.motivo ?? '').trim().length < 3);
  if (sinDecidir.length)
    throw invalida('Hay cobros con integración pendiente: resolvelos desde la bandeja de pendientes o confirmá cada uno con un motivo.', 409, { codigo: 'CIERRE_CON_PENDIENTES', detalle: { pendientes: ciego ? sinDecidir.map(({ ref, origen, estado, motivo }) => ({ ref, origen, estado, motivo })) : sinDecidir.map(({ pagos, ...i }) => ({ ...i, importe: r2(pagos.reduce((a, p) => a + p.importe, 0)) })) } });
  const noVerificados = !lista.verificado;
  if (noVerificados && String(body.motivo_pendientes ?? '').trim().length < 3)
    throw invalida('Ventas no respondió: para cerrar sin verificar los cobros pendientes indicá el motivo (queda marcado «pendientes no verificados»).', 409, { codigo: 'PENDIENTES_NO_VERIFICADOS' });
  const explicado = r2(lista._completos.reduce((a, i) => a + i.efecto_efectivo, 0));

  const config = await Cuentas.config();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM fin_cuentas WHERE id = ? FOR UPDATE', [cuenta.id]); // nadie mueve la caja mientras se cierra
    const [[vigente]] = await conn.query("SELECT estado FROM fin_turnos WHERE id = ? FOR UPDATE", [turnoId]);
    if (vigente.estado !== 'abierto') throw invalida('El turno ya está cerrado.', 409);
    const hasta = Date.now();
    const teorico = await Cuentas.saldoDe(cuenta.id, conn);
    const diferencia = r2(conteo.efectivo - teorico);
    // RN41(a): la diferencia se registra completa, pero la tolerancia se evalúa sin lo que explican los cobros pendientes.
    const evaluada = r2(diferencia - explicado);
    let autorizante = null, motivo = body.motivo ? String(body.motivo).trim().slice(0, 255) : null;
    if (Math.abs(evaluada) > config.tolerancia_diferencia) {
      if (!motivo || motivo.length < 3) throw invalida(`La diferencia (${diferencia}) supera la tolerancia (${config.tolerancia_diferencia}): indicá el motivo.`, 409, { codigo: 'DIFERENCIA_REQUIERE_MOTIVO', detalle: ciego ? undefined : { diferencia, tolerancia: config.tolerancia_diferencia } });
      const aut = await ctx.autorizar();
      if (!aut?.ok) throw invalida(aut?.error ?? 'La diferencia supera la tolerancia: necesita la autorización de un supervisor.', aut?.status ?? 403, { codigo: aut?.codigo ?? 'REQUIERE_AUTORIZACION' });
      autorizante = aut.supervisor;
    }
    const fondo = body.fondo_siguiente !== undefined && body.fondo_siguiente !== null ? numero(body.fondo_siguiente, 'El fondo de cambio siguiente') : Math.min(Number(cuenta.fondo_cambio), conteo.efectivo);
    if (fondo > conteo.efectivo) throw invalida('El fondo de cambio que queda no puede ser mayor al efectivo contado.');
    let movId = null;
    if (diferencia !== 0) {
      const [[cat]] = await conn.query("SELECT id FROM fin_categorias WHERE nombre = 'Faltantes y sobrantes de caja'");
      movId = await movimiento(conn, {
        cuentaId: cuenta.id, turnoId, tipo: diferencia > 0 ? 'sobrante' : 'faltante', importe: diferencia, moneda: cuenta.moneda, categoriaId: cat?.id ?? null,
        motivo: motivo ?? 'Diferencia de cierre', marcas: explicado !== 0 ? `explica_pendientes:${explicado}` : null, userId: ctx.userId, terminalId: turno.terminal_id,
      });
    }
    if (conteo.cupones !== undefined) conteo.cupones_teorico = await cuponesTeoricos(turno, hasta, conn);
    const [[{ v }]] = await conn.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM fin_cierres WHERE turno_id = ?', [turnoId]);
    const decididos = lista._completos.map((i) => ({ ...i, decision: String(decisiones.get(i.ref).motivo).trim() }));
    await conn.query(
      `INSERT INTO fin_cierres (turno_id, version, user_id, ciego, conteo, teorico, contado, diferencia, pendientes_importe, diferencia_evaluada, tolerancia, motivo, autorizante_id,
         pendientes, pendientes_no_verificados, fondo_siguiente, traslado_importe, movimiento_id, cerrado_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [turnoId, v, ctx.userId, ciego ? 1 : 0, JSON.stringify(conteo), teorico, conteo.efectivo, diferencia, explicado, evaluada, config.tolerancia_diferencia, motivo, autorizante?.id ?? null,
        JSON.stringify({ items: decididos, motivo_no_verificados: noVerificados ? String(body.motivo_pendientes).trim() : null }), noVerificados ? 1 : 0, fondo, r2(conteo.efectivo - fondo), movId, hasta]);
    await conn.query("UPDATE fin_turnos SET estado = 'cerrado', cuenta_abierta = NULL, cerrado_ms = ? WHERE id = ?", [hasta, turnoId]);
    // El evento «Cierre de turno» sale por la bandeja de salida; Financiero no conoce a quién lo toma (RN37).
    await M.publicar(conn, { origen: 'financiero', destino: 'contable', tipo: 'cierre_turno', docTipo: 'turno', docIdGlobal: turno.id_global, docVersion: v, userId: ctx.userId,
      contenido: { turno_id_global: turno.id_global, caja: cuenta.nombre, moneda: cuenta.moneda, diferencia, version: v, fecha_ms: hasta } });
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  M.despertar();
  return cierreDe(turnoId);
};

// RN41(b): el cobro que se confirma después del cierre y que ya explicaba un sobrante o faltante de ese cierre se compensa con un contramovimiento en el turno
// actual, sin modificar el cierre ni recalcularlo (RN02). `efecto` es lo que el cobro suma a la caja (negativo en una devolución en efectivo).
const compensarCierre = async (conn, { ref, cuentaId, efecto, turnoId, enEspera, docIdGlobal, userId }) => {
  if (!efecto) return null;
  const [[c]] = await conn.query(
    `SELECT c.id, c.version, c.movimiento_id FROM fin_cierres c JOIN fin_turnos t ON t.id = c.turno_id WHERE t.cuenta_id = ? AND c.movimiento_id IS NOT NULL AND c.pendientes LIKE ? ORDER BY c.id DESC LIMIT 1`,
    [cuentaId, `%"ref":${JSON.stringify(ref).replace(/([%_\\])/g, '\\$1')}%`]);
  if (!c) return null;
  const [[ya]] = await conn.query("SELECT 1 AS si FROM fin_movimientos WHERE tipo = 'compensacion' AND doc_id_global = ? AND vinculo_id = ? LIMIT 1", [docIdGlobal, c.movimiento_id]);
  if (ya) return null;
  return movimiento(conn, { cuentaId, turnoId, tipo: 'compensacion', importe: -efecto, vinculoId: c.movimiento_id, docIdGlobal, enEspera, userId,
    motivo: `Compensa la diferencia del cierre ${c.version} que explicaba este cobro` });
};

const vistaCierre = (c) => ({
  id: c.id, turno_id: c.turno_id, version: c.version, ciego: !!c.ciego, conteo: JSON.parse(c.conteo ?? '{}'), teorico: Number(c.teorico), contado: Number(c.contado),
  diferencia: Number(c.diferencia), pendientes_importe: Number(c.pendientes_importe), diferencia_evaluada: Number(c.diferencia_evaluada), tolerancia: Number(c.tolerancia), motivo: c.motivo,
  autorizante_id: c.autorizante_id, pendientes: JSON.parse(c.pendientes ?? '{}'), pendientes_no_verificados: !!c.pendientes_no_verificados, fondo_siguiente: Number(c.fondo_siguiente),
  traslado_importe: Number(c.traslado_importe), movimiento_id: c.movimiento_id, cerrado_ms: Number(c.cerrado_ms),
});

// El cierre (el último, o uno de los sucesivos), con la propuesta de transferir el resto a la caja central (RF04).
const cierreDe = async (turnoId, version = null) => {
  const [[c]] = await pool.query(`SELECT * FROM fin_cierres WHERE turno_id = ? ${version ? 'AND version = ?' : ''} ORDER BY version DESC LIMIT 1`, version ? [turnoId, version] : [turnoId]);
  if (!c) throw invalida('El turno no tiene cierre.', 404);
  const v = vistaCierre(c);
  const [[central]] = await pool.query("SELECT id, nombre FROM fin_cuentas WHERE tipo = 'caja_fuerte' AND activa = 1 AND moneda = (SELECT moneda FROM fin_cuentas WHERE id = (SELECT cuenta_id FROM fin_turnos WHERE id = ?)) ORDER BY id LIMIT 1", [turnoId]);
  if (v.traslado_importe > 0 && central) v.propuesta_transferencia = { importe: v.traslado_importe, hacia: central };
  return v;
};

const cierres = async (turnoId) => (await pool.query('SELECT * FROM fin_cierres WHERE turno_id = ? ORDER BY version', [turnoId]))[0].map(vistaCierre);

// El cierre imprimible (RF04).
const imprimible = async (turnoId) => {
  const t = await Turnos.obtener(turnoId, { verTeorico: false });
  const c = await cierreDe(turnoId);
  const m = (n) => Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[x]));
  const pend = c.pendientes.items ?? [];
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Cierre de turno ${t.id}</title><style>body{font-family:monospace;max-width:380px;margin:1rem auto}td{padding:2px 6px}.d{text-align:right}</style></head><body>
<h3>Cierre de turno N.º ${t.id} (cierre ${c.version})</h3><p>${esc(t.caja)} · ${esc(t.usuario)}${t.turno_servicio ? ` · ${esc(t.turno_servicio)}` : ''}<br>Abierto: ${new Date(t.abierto_ms).toLocaleString('es-AR')}<br>Cerrado: ${new Date(c.cerrado_ms).toLocaleString('es-AR')}</p>
<table><tr><td>Fondo de apertura</td><td class="d">${m(t.fondo_apertura)}</td></tr><tr><td>Efectivo teórico</td><td class="d">${m(c.teorico)}</td></tr><tr><td>Efectivo contado</td><td class="d">${m(c.contado)}</td></tr>
<tr><td><b>${c.diferencia < 0 ? 'Faltante' : c.diferencia > 0 ? 'Sobrante' : 'Diferencia'}</b></td><td class="d"><b>${m(c.diferencia)}</b></td></tr>
${c.pendientes_importe ? `<tr><td>Explicado por cobros pendientes</td><td class="d">${m(c.pendientes_importe)}</td></tr>` : ''}<tr><td>Fondo que queda</td><td class="d">${m(c.fondo_siguiente)}</td></tr><tr><td>A caja central</td><td class="d">${m(c.traslado_importe)}</td></tr></table>
${c.motivo ? `<p>Motivo: ${esc(c.motivo)}</p>` : ''}${pend.length ? `<h4>Cobros con integración pendiente</h4><ul>${pend.map((p) => `<li>${esc(p.ref)} (${esc(p.estado)}): ${esc(p.decision)}</li>`).join('')}</ul>` : ''}${c.pendientes_no_verificados ? '<p><b>Pendientes no verificados</b></p>' : ''}
<p>Firma del cajero: ______________ &nbsp; Supervisor: ______________</p></body></html>`;
};

module.exports = { compensarCierre, esCiego, validarConteo, pendientes, listaPendientes, arquear, cerrar, cierreDe, cierres, imprimible, cuponesTeoricos };
