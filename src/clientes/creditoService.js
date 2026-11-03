const crypto = require('crypto');
const pool = require('../config/db');
const Notificacion = require('../models/notificacionModel');
const Clientes = require('./clienteService');
const Cuentas = require('./cuentaService');

// Control de crédito (Clientes y CC RF12, RF13, RF26, RN03, RN04, RN33, RN34, EX04, EX22, EX26): Clientes es la única fuente de las reglas de crédito y mora.
// Ventas y Ventas Online piden un veredicto (Permitida / Requiere autorización / Bloqueada, con motivo exacto) y una reserva de crédito, y lo cumplen sin
// reglas propias. Una cuenta bloqueada nunca admite autorización de un supervisor.
class CreditoInvalido extends Error {}
const invalida = (m, status = 400, extra = {}) => Object.assign(new CreditoInvalido(m), { status, ...extra });

const MODOS = ['bloquear', 'requerir_autorizacion', 'solo_advertir'];
const ROLES_ALERTA = ['administrador', 'gerente', 'administrativo'];
const num = Cuentas.num;
const DIA_MS = 86400000;

const modo = async (conn = pool) => (await conn.query("SELECT valor FROM parametros WHERE clave = 'cc_modo_credito'"))[0][0]?.valor ?? 'requerir_autorizacion';
const configurarModo = async (nuevo) => {
  if (!MODOS.includes(nuevo)) throw invalida(`El modo de control de crédito es uno de: ${MODOS.join(', ')}.`);
  await pool.query("INSERT INTO parametros (clave, valor) VALUES ('cc_modo_credito', ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)", [nuevo]); // rige para los veredictos siguientes; las reservas vigentes conservan el suyo
  return { modo: nuevo };
};

const reservasVigentes = async (cuentaId, conn = pool, excluir = null) => num((await conn.query(
  "SELECT COALESCE(SUM(importe), 0) AS t FROM reservas_credito WHERE cuenta_id = ? AND estado = 'vigente' AND vence_ms > ? AND (? IS NULL OR id_reserva <> ?)", [cuentaId, Date.now(), excluir, excluir]))[0][0].t);

// Mora (RN33): días desde el vencimiento del comprobante vencido con saldo más antiguo.
const moraDe = async (cuentaId, conn = pool, desdeMov = 0) => {
  const [[m]] = await conn.query(
    "SELECT id, comprobante_ref, fecha_vencimiento, DATEDIFF(CURDATE(), fecha_vencimiento) AS dias FROM movimientos_cc WHERE cuenta_id = ? AND naturaleza = 'debito' AND estado = 'pendiente' AND saldo_pendiente > 0 AND fecha_vencimiento < CURDATE() AND id > ? ORDER BY fecha_vencimiento, id LIMIT 1", [cuentaId, desdeMov]);
  return m ? { dias: Number(m.dias), comprobante: m.comprobante_ref, vencimiento: m.fecha_vencimiento, movimiento_id: m.id } : { dias: 0, comprobante: null, vencimiento: null, movimiento_id: null };
};

// ---------- Bloqueo (RF13) ----------
const alertar = (tipo, severidad, clave, mensaje) => Notificacion.crear({ modulo: 'clientes', tipo, severidad, roles: ROLES_ALERTA, clave, mensaje });

const bloquear = async (cuentaId, { motivo, detalle = null, userId = null }) => {
  if (!['manual', 'mora'].includes(motivo)) throw invalida('El motivo de bloqueo es manual o mora.');
  const c = await Cuentas.cuentaDe(cuentaId);
  if (!c) throw invalida('Cuenta no encontrada.', 404);
  if (c.estado === 'cerrada') throw invalida('La cuenta está cerrada.', 409);
  if (c.estado === 'bloqueada') return Cuentas.obtener(cuentaId);
  if (motivo === 'manual' && !String(detalle ?? '').trim()) throw invalida('El bloqueo manual exige el motivo.');
  await pool.query("UPDATE cuentas_corrientes SET estado = 'bloqueada', motivo_bloqueo = ?, bloqueo_detalle = ?, bloqueada_en = NOW(), bloqueada_por = ? WHERE id = ?", [motivo, detalle ? String(detalle).slice(0, 255) : null, userId, cuentaId]);
  const cli = await Clientes.fila(c.cliente_id);
  await alertar('cuenta_bloqueada', 'alta', `cuenta-bloqueada-${cuentaId}`, `La cuenta de ${cli.razon_social} se bloqueó (${motivo === 'mora' ? 'por mora' : 'manualmente'}).`);
  return Cuentas.obtener(cuentaId);
};

// Salir del bloqueo exige permiso y motivo (RN16). Un comprobante que ya superaba el umbral no vuelve a bloquear la cuenta (RN33): solo uno posterior.
const desbloquear = async (cuentaId, { motivo, userId = null }) => {
  if (!String(motivo ?? '').trim()) throw invalida('Desbloquear exige el motivo.');
  const c = await Cuentas.cuentaDe(cuentaId);
  if (!c) throw invalida('Cuenta no encontrada.', 404);
  if (c.estado !== 'bloqueada') throw invalida('La cuenta no está bloqueada.', 409);
  const [[{ max }]] = await pool.query("SELECT COALESCE(MAX(id), 0) AS max FROM movimientos_cc WHERE cuenta_id = ? AND naturaleza = 'debito' AND estado = 'pendiente' AND saldo_pendiente > 0 AND fecha_vencimiento < CURDATE()", [cuentaId]);
  await pool.query("UPDATE cuentas_corrientes SET estado = 'activa', motivo_bloqueo = NULL, bloqueo_detalle = ?, mora_exenta_hasta_mov = GREATEST(mora_exenta_hasta_mov, ?), bloqueada_por = ? WHERE id = ?", [`Desbloqueada: ${String(motivo).slice(0, 200)}`, max, userId, cuentaId]);
  await Notificacion.resolverPorClave(`cuenta-bloqueada-${cuentaId}`, 'La cuenta se desbloqueó');
  return Cuentas.obtener(cuentaId);
};

// Bloqueo automático: un comprobante vencido por más de Dias_Mora_Bloqueo bloquea la cuenta, una sola vez por comprobante. Se evalúa en el proceso diario y
// al pedir un veredicto; rige en cualquier modo de control (también con "solo advertir").
const evaluarBloqueoAutomatico = async (cuenta) => {
  if (cuenta.estado !== 'activa') return cuenta;
  const v = await Cuentas.vista(cuenta);
  const mora = await moraDe(cuenta.id, pool, cuenta.mora_exenta_hasta_mov);
  if (mora.dias > v.dias_mora_bloqueo) {
    await bloquear(cuenta.id, { motivo: 'mora', detalle: `Comprobante ${mora.comprobante} vencido hace ${mora.dias} días` });
    return Cuentas.cuentaDe(cuenta.id);
  }
  return cuenta;
};
const revisarDiario = async () => {
  const cuentas = (await pool.query("SELECT * FROM cuentas_corrientes WHERE estado = 'activa'"))[0];
  let bloqueadas = 0;
  for (const c of cuentas) if ((await evaluarBloqueoAutomatico(c)).estado === 'bloqueada') bloqueadas++;
  return { revisadas: cuentas.length, bloqueadas };
};

// ---------- Veredicto (RN04) ----------
const calcular = async (conn, cuenta, importe, { excluirReserva = null } = {}) => {
  const v = await Cuentas.vista(cuenta, conn);
  const reservas = await reservasVigentes(cuenta.id, conn, excluirReserva);
  const saldo = v.saldo;
  const disponible = num(Number(cuenta.limite_credito) - Math.max(saldo, 0) - reservas);
  const excedente = importe > disponible ? num(importe - disponible) : 0;
  const mora = await moraDe(cuenta.id, conn);
  const sobreMora = mora.dias > v.dias_mora_autorizacion;
  return { limite: v.limite_credito, saldo, reservas, disponible, excedente, mora, sobreMora, dias_mora_autorizacion: v.dias_mora_autorizacion };
};

const veredicto = async ({ cliente_id: clienteId, moneda = 'ARS', importe }, conn = pool, opciones = {}) => {
  const imp = num(importe);
  if (!(imp > 0)) throw invalida('El importe a cuenta es un número mayor que cero.');
  const salida = async (v, extra = {}) => {
    await pool.query('INSERT INTO veredictos_credito (cuenta_id, cliente_id, importe, veredicto, motivo) VALUES (?, ?, ?, ?, ?)', [extra.cuenta_id ?? null, clienteId ?? null, imp, v, (extra.motivos ?? []).join(' | ').slice(0, 500)]);
    return { veredicto: v, motivos: [], ...extra };
  };
  const cli = clienteId ? await Clientes.resolver(clienteId) : null;
  if (!cli || cli.tipo_documento === 'CF') return salida('bloqueada', { motivos: ['Cliente no identificado: no se vende a cuenta corriente al Consumidor Final.'], codigo: 'CLIENTE_NO_IDENTIFICADO' });
  let [[cuenta]] = await conn.query('SELECT * FROM cuentas_corrientes WHERE cliente_id = ? AND moneda = ?', [cli.id, moneda]);
  if (!cuenta) return salida('bloqueada', { motivos: [`El cliente no tiene cuenta corriente en ${moneda}.`], codigo: 'SIN_CUENTA' });
  if (cuenta.estado === 'activa' && !opciones.sinBloqueoAutomatico) cuenta = await evaluarBloqueoAutomatico(cuenta);
  const base = { cuenta_id: cuenta.id, estado_cuenta: cuenta.estado };
  if (cuenta.estado === 'cerrada') return salida('bloqueada', { ...base, motivos: ['La cuenta corriente está cerrada.'], codigo: 'CUENTA_CERRADA' });
  if (cuenta.estado === 'bloqueada') return salida('bloqueada', { ...base, motivos: [`La cuenta está bloqueada (${cuenta.motivo_bloqueo === 'mora' ? 'por mora' : 'manualmente'}${cuenta.bloqueo_detalle ? `: ${cuenta.bloqueo_detalle}` : ''}).`], codigo: 'CUENTA_BLOQUEADA' });
  const c = await calcular(conn, cuenta, imp, opciones);
  const motivos = [];
  if (c.excedente > 0) motivos.push(`Crédito excedido: límite ${c.limite}, saldo ${c.saldo}, reservas vigentes ${c.reservas}, disponible ${c.disponible}, excedente ${c.excedente}.`);
  if (c.sobreMora) motivos.push(`Mora sobre el umbral de autorización (${c.dias_mora_autorizacion} días): ${c.mora.dias} días de mora, comprobante vencido más antiguo ${c.mora.comprobante}.`);
  const detalle = { ...base, limite: c.limite, saldo: c.saldo, reservas_vigentes: c.reservas, credito_disponible: c.disponible, excedente: c.excedente, dias_mora: c.mora.dias, comprobante_vencido: c.mora.comprobante };
  if (!motivos.length) return salida('permitida', detalle);
  const m = await modo();
  if (m === 'bloquear') return salida('bloqueada', { ...detalle, motivos, codigo: 'CREDITO_EXCEDIDO' });
  if (m === 'solo_advertir') return salida('permitida', { ...detalle, aviso: motivos.join(' ') });
  return salida('requiere_autorizacion', { ...detalle, motivos });
};

// ---------- Reserva de crédito (RF26) ----------
// Las solicitudes sobre una misma cuenta se atienden de a una (la cuenta se bloquea durante el cálculo): dos terminales no superan el límite a la vez.
const reservar = async ({ cliente_id: clienteId, moneda = 'ARS', importe, idSolicitud, reemplazaA = null, origen = null, autorizado = false, supervisorId = null }) => {
  if (!idSolicitud) throw invalida('Falta la clave de solicitud de la reserva.');
  const imp = num(importe);
  const [[previa]] = await pool.query('SELECT * FROM reservas_credito WHERE id_solicitud = ?', [idSolicitud]);
  if (previa) { // un reintento con la misma clave devuelve la misma reserva y no reserva dos veces (EX20)
    if (num(previa.importe) !== imp) {
      await alertar('conflicto_idempotencia', 'alta', `conflicto-${idSolicitud}`, `Se reutilizó la clave ${idSolicitud} con un importe distinto en una reserva de crédito.`);
      throw invalida('La clave de solicitud ya se usó con otro importe (conflicto de idempotencia).', 409, { codigo: 'CONFLICTO_IDEMPOTENCIA' });
    }
    return { veredicto: 'permitida', id_reserva: previa.id_reserva, vence_ms: Number(previa.vence_ms), reintento: true, estado_reserva: previa.estado };
  }
  const cli = clienteId ? await Clientes.resolver(clienteId) : null;
  if (!cli || cli.tipo_documento === 'CF') return veredicto({ cliente_id: clienteId, moneda, importe });
  // El bloqueo automático por mora se evalúa antes de tomar la cuenta (el UPDATE no puede esperar un candado propio).
  const [[c0]] = await pool.query('SELECT * FROM cuentas_corrientes WHERE cliente_id = ? AND moneda = ?', [cli.id, moneda]);
  if (c0) await evaluarBloqueoAutomatico(c0);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[cuenta]] = await conn.query('SELECT * FROM cuentas_corrientes WHERE cliente_id = ? AND moneda = ? FOR UPDATE', [cli.id, moneda]);
    if (!cuenta) { await conn.rollback(); return veredicto({ cliente_id: clienteId, moneda, importe }); }
    if (reemplazaA) await conn.query("UPDATE reservas_credito SET estado = 'liberada' WHERE id_reserva = ? AND cuenta_id = ? AND estado = 'vigente'", [reemplazaA, cuenta.id]);
    const v = await veredicto({ cliente_id: clienteId, moneda, importe }, conn, { excluirReserva: reemplazaA, sinBloqueoAutomatico: true });
    if (v.veredicto === 'bloqueada' || (v.veredicto === 'requiere_autorizacion' && !autorizado)) { await conn.commit(); return v; }
    const minutos = await Cuentas.parametro('cc_reserva_minutos', 5, conn);
    const id = `RC-${crypto.randomUUID()}`;
    const vence = Date.now() + minutos * 60000;
    await conn.query('INSERT INTO reservas_credito (id_reserva, cuenta_id, importe, id_solicitud, reemplaza_a, origen, modo, autorizada_por, vence_ms, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, cuenta.id, imp, idSolicitud, reemplazaA, origen, await modo(conn), v.veredicto === 'requiere_autorizacion' ? supervisorId : null, vence, Date.now()]);
    await conn.commit();
    return { ...v, id_reserva: id, vence_ms: vence };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const liberar = async (idReserva) => (await pool.query("UPDATE reservas_credito SET estado = 'liberada' WHERE id_reserva = ? AND estado = 'vigente'", [idReserva]))[0].affectedRows;
const renovar = async (idReserva) => {
  const [[r]] = await pool.query('SELECT * FROM reservas_credito WHERE id_reserva = ?', [idReserva]);
  if (!r) throw invalida('Reserva no encontrada.', 404);
  if (r.estado !== 'vigente' || Number(r.vence_ms) <= Date.now()) throw invalida('La reserva ya no está vigente: pedí un veredicto y una reserva nuevos.', 409, { codigo: 'RESERVA_VENCIDA' });
  if (r.renovaciones >= 3) throw invalida('La reserva ya se renovó 3 veces.', 409);
  const minutos = await Cuentas.parametro('cc_reserva_minutos', 5);
  const vence = Date.now() + minutos * 60000;
  await pool.query('UPDATE reservas_credito SET vence_ms = ?, renovaciones = renovaciones + 1 WHERE id_reserva = ?', [vence, idReserva]);
  return { id_reserva: idReserva, vence_ms: vence, renovaciones: r.renovaciones + 1 };
};
const reservasDeCuenta = async (cuentaId) => (await pool.query("SELECT id_reserva, importe, origen, vence_ms, estado FROM reservas_credito WHERE cuenta_id = ? AND estado = 'vigente' AND vence_ms > ? ORDER BY created_ms", [cuentaId, Date.now()]))[0].map((r) => ({ ...r, importe: num(r.importe), vence_ms: Number(r.vence_ms) }));

// El débito de la venta convierte la reserva en deuda en el mismo registro (no cuenta dos veces). Llega siempre, aunque la reserva haya vencido o la
// venta sea de contingencia, porque la venta ya existe: si deja el crédito excedido, la cuenta bloqueada o sobre el umbral de mora, avisa (RN34, RN35, EX27).
const alRegistrarDebito = async (conn, { cuenta, movimientoId, importe, reservaId, contingencia, ref }) => {
  let reservaViva = false;
  if (reservaId) {
    const [[r]] = await conn.query('SELECT estado, vence_ms FROM reservas_credito WHERE id_reserva = ? FOR UPDATE', [reservaId]);
    reservaViva = !!r && r.estado === 'vigente' && Number(r.vence_ms) > Date.now();
    if (r) await conn.query("UPDATE reservas_credito SET estado = 'convertida' WHERE id_reserva = ? AND estado IN ('vigente', 'vencida')", [reservaId]);
  }
  if (reservaViva && !contingencia) return;
  const v = await Cuentas.vista(await Cuentas.cuentaDe(cuenta.id, conn), conn);
  const exceso = num(Math.max(v.saldo - v.limite_credito, 0));
  const mora = await moraDe(cuenta.id, conn);
  const problemas = [];
  if (exceso > 0) problemas.push(`el crédito quedó excedido en ${exceso}`);
  if (contingencia && cuenta.estado === 'bloqueada') problemas.push('la cuenta estaba bloqueada'); // solo una venta de contingencia pudo cerrarse sin el veredicto
  else if (contingencia && mora.dias > v.dias_mora_autorizacion) problemas.push(`la cuenta tenía ${mora.dias} días de mora`);
  if (exceso > 0) await conn.query('UPDATE movimientos_cc SET excedente = ? WHERE id = ?', [exceso, movimientoId]);
  if (!problemas.length) return;
  const cli = await Clientes.fila(cuenta.cliente_id);
  const tipo = contingencia ? 'credito_excedido_contingencia' : 'credito_excedido';
  await alertar(tipo, 'alta', `${tipo}-${movimientoId}`, `${contingencia ? 'Venta en contingencia' : 'Débito con la reserva vencida'} ${ref} de ${cli.razon_social} por ${importe}: ${problemas.join('; ')}.`);
};

const contingencias = async () => {
  const [reg] = await pool.query(
    `SELECT m.id, m.comprobante_ref, m.importe, m.excedente, m.fecha, cc.cliente_id, IF(m.excedente IS NULL OR m.excedente = 0, 'registrada', 'registrada_con_exceso') AS estado
     FROM movimientos_cc m JOIN cuentas_corrientes cc ON cc.id = m.cuenta_id WHERE m.en_contingencia = 1 ORDER BY m.id DESC LIMIT 200`);
  const [pend] = await pool.query(
    "SELECT doc_id_global AS comprobante_ref, JSON_EXTRACT(contenido, '$.importe') AS importe, JSON_EXTRACT(contenido, '$.cliente_id') AS cliente_id, estado AS estado_mensaje FROM mensajes_integracion WHERE modulo_destino = 'clientes' AND tipo IN ('debito_venta', 'remito_emitido') AND JSON_EXTRACT(contenido, '$.contingencia') = TRUE AND estado <> 'confirmado'");
  return [...pend.map((p) => ({ ...p, importe: num(p.importe), estado: 'pendiente_de_registro' })), ...reg.map((r) => ({ ...r, importe: num(r.importe) }))];
};

Cuentas.usarPostDebito(alRegistrarDebito);

module.exports = { CreditoInvalido, MODOS, modo, configurarModo, moraDe, bloquear, desbloquear, evaluarBloqueoAutomatico, revisarDiario, veredicto, reservar, liberar, renovar, reservasDeCuenta, reservasVigentes, alRegistrarDebito, contingencias };
