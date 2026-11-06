const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const M = require('../mensajeria/servicio');
const Notificacion = require('../models/notificacionModel');
const llamar = require('../modulos/llamar');
const Clientes = require('./clienteService');
const { idGlobal } = require('../utils/idGlobal');

// Cuenta corriente (Clientes y CC RF03, RF04, RF05, RF09, RN03, RN05, RN06, RN09, RN15, RN36, RN37). El saldo es la suma de los débitos menos la suma
// de los créditos y no se edita nunca: solo cambia por comprobantes (venta, remito, nota de débito o crédito, recibo o ajuste). Los movimientos no se
// borran ni se editan (triggers); un error se corrige con otro movimiento.
class CuentaInvalida extends Error {}
const invalida = (m, status = 400, extra = {}) => Object.assign(new CuentaInvalida(m), { status, ...extra });

const MOTIVOS_NOTA = ['intereses_mora', 'diferencia_cambio', 'bonificacion', 'cheque_rechazado', 'error_facturacion', 'otros'];
let postDebito = null; // el control de crédito engancha acá: convierte la reserva y avisa si el crédito quedó excedido (E3)
const usarPostDebito = (fn) => { postDebito = fn; };
const num = (x) => Math.round(Number(x) * 100) / 100;
const hoy = () => { const d = new Date(), p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const sumarDias = (fecha, dias) => { const d = new Date(`${fecha}T12:00:00`); d.setDate(d.getDate() + Number(dias)); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const parametro = async (clave, def, conn = pool) => Number((await conn.query('SELECT valor FROM parametros WHERE clave = ?', [clave]))[0][0]?.valor ?? def);

const cuentaDe = async (id, conn = pool) => (await conn.query('SELECT * FROM cuentas_corrientes WHERE id = ?', [id]))[0][0] ?? null;
const saldoDe = async (cuentaId, conn = pool) => num((await conn.query(
  "SELECT COALESCE(SUM(IF(naturaleza = 'debito', importe, -importe)), 0) AS s FROM movimientos_cc WHERE cuenta_id = ? AND estado NOT IN ('facturado', 'pendiente_emision')", [cuentaId]))[0][0].s);

const vista = async (c, conn = pool) => {
  const saldo = await saldoDe(c.id, conn);
  const dMoraAut = c.dias_mora_autorizacion ?? await parametro('cc_dias_mora_autorizacion', 5, conn);
  const dMoraBlq = c.dias_mora_bloqueo ?? await parametro('cc_dias_mora_bloqueo', 30, conn);
  const reservas = num((await conn.query("SELECT COALESCE(SUM(importe), 0) AS t FROM reservas_credito WHERE cuenta_id = ? AND estado = 'vigente' AND vence_ms > ?", [c.id, Date.now()]))[0][0].t);
  return { ...c, limite_credito: num(c.limite_credito), dias_mora_autorizacion: dMoraAut, dias_mora_bloqueo: dMoraBlq, saldo, reservas_vigentes: reservas, disponible: num(Number(c.limite_credito) - Math.max(saldo, 0) - reservas) };
};

const validarMora = (aut, blq) => {
  if (aut !== null && blq !== null && !(Number(aut) < Number(blq))) throw invalida('Los días de mora para pedir autorización tienen que ser menores que los del bloqueo (RN33).');
};
const entero = (v, campo, min = 0) => {
  if (v === undefined || v === null || v === '') return null;
  if (!Number.isInteger(Number(v)) || Number(v) < min) throw invalida(`${campo} es un número entero de ${min} o más.`);
  return Number(v);
};

// Apertura (RF03): una cuenta por cliente y moneda; la moneda extranjera necesita CLI-MONEDA-EXT. El Consumidor Final no tiene cuenta (RN03).
const abrir = async (clienteId, d, { userId = null } = {}) => {
  const cli = await Clientes.fila(clienteId);
  if (!cli) throw invalida('Cliente no encontrado.', 404);
  if (cli.tipo_documento === 'CF') throw invalida('El Consumidor Final genérico no tiene cuenta corriente.', 409);
  if (cli.estado !== 'activo') throw invalida('Solo un cliente activo puede tener una cuenta nueva.', 409);
  const moneda = String(d.moneda ?? 'ARS').toUpperCase();
  if (moneda !== 'ARS' && !(await Funciones.estaActiva('CLI-MONEDA-EXT'))) throw invalida('Las cuentas en moneda extranjera necesitan la función CLI-MONEDA-EXT.', 409);
  const limite = num(d.limite_credito ?? 0);
  if (!(limite >= 0) || !Number.isFinite(limite)) throw invalida('El límite de crédito es un importe mayor o igual a cero.');
  const plazo = entero(d.plazo_dias, 'El plazo de pago', 0) ?? await parametro('cc_plazo_dias', 15);
  const aut = entero(d.dias_mora_autorizacion, 'Los días de mora para autorización', 0), blq = entero(d.dias_mora_bloqueo, 'Los días de mora para bloqueo', 1);
  validarMora(aut ?? await parametro('cc_dias_mora_autorizacion', 5), blq ?? await parametro('cc_dias_mora_bloqueo', 30));
  let tasa = null;
  if (d.tasa_mora !== undefined && d.tasa_mora !== null && d.tasa_mora !== '') {
    if (!(await Funciones.estaActiva('CLI-MORA'))) throw invalida('La tasa de mora necesita la función CLI-MORA.', 409);
    tasa = Number(d.tasa_mora);
    if (!(tasa >= 0)) throw invalida('La tasa de mora es un número mayor o igual a cero.');
  }
  try {
    const [r] = await pool.query('INSERT INTO cuentas_corrientes (cliente_id, moneda, limite_credito, plazo_dias, tasa_mora, dias_mora_autorizacion, dias_mora_bloqueo, creada_por) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [cli.id, moneda, limite, plazo, tasa, aut, blq, userId]);
    return obtener(r.insertId);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida('El cliente ya tiene una cuenta en esa moneda.', 409);
    throw err;
  }
};

const obtener = async (id) => {
  const c = await cuentaDe(id);
  if (!c) throw invalida('Cuenta no encontrada.', 404);
  return vista(c);
};
const deCliente = async (clienteId) => {
  if (!Number.isInteger(clienteId) || clienteId <= 0) throw invalida('Indicá el cliente (cliente_id).');
  const c = await Clientes.resolver(clienteId);
  if (!c) throw invalida('Cliente no encontrado.', 404);
  const filas = (await pool.query('SELECT * FROM cuentas_corrientes WHERE cliente_id = ? ORDER BY moneda', [c.id]))[0];
  return Promise.all(filas.map((x) => vista(x)));
};

// Cambiar límite, plazo, tasa o umbrales requiere permiso (la ruta) y queda auditado (RN16).
const actualizar = async (id, d) => {
  const c = await cuentaDe(id);
  if (!c) throw invalida('Cuenta no encontrada.', 404);
  if (c.estado === 'cerrada') throw invalida('La cuenta está cerrada.', 409);
  const limite = d.limite_credito === undefined ? Number(c.limite_credito) : num(d.limite_credito);
  if (!(limite >= 0) || !Number.isFinite(limite)) throw invalida('El límite de crédito es un importe mayor o igual a cero.');
  const plazo = d.plazo_dias === undefined ? c.plazo_dias : entero(d.plazo_dias, 'El plazo de pago', 0);
  const aut = d.dias_mora_autorizacion === undefined ? c.dias_mora_autorizacion : entero(d.dias_mora_autorizacion, 'Los días de mora para autorización', 0);
  const blq = d.dias_mora_bloqueo === undefined ? c.dias_mora_bloqueo : entero(d.dias_mora_bloqueo, 'Los días de mora para bloqueo', 1);
  validarMora(aut ?? await parametro('cc_dias_mora_autorizacion', 5), blq ?? await parametro('cc_dias_mora_bloqueo', 30));
  let tasa = c.tasa_mora;
  if (d.tasa_mora !== undefined) {
    if (d.tasa_mora !== null && !(await Funciones.estaActiva('CLI-MORA'))) throw invalida('La tasa de mora necesita la función CLI-MORA.', 409);
    tasa = d.tasa_mora === null ? null : Number(d.tasa_mora);
    if (tasa !== null && !(tasa >= 0)) throw invalida('La tasa de mora es un número mayor o igual a cero.');
  }
  await pool.query('UPDATE cuentas_corrientes SET limite_credito = ?, plazo_dias = ?, tasa_mora = ?, dias_mora_autorizacion = ?, dias_mora_bloqueo = ? WHERE id = ?', [limite, plazo, tasa, aut, blq, id]);
  return obtener(id);
};

// Una cuenta solo se cierra con saldo cero (RN15, EX10).
const cerrar = async (id) => {
  const c = await cuentaDe(id);
  if (!c) throw invalida('Cuenta no encontrada.', 404);
  const saldo = await saldoDe(id);
  if (saldo !== 0) throw invalida(`La cuenta tiene saldo (${saldo}): no se puede cerrar.`, 409, { saldo });
  await pool.query("UPDATE cuentas_corrientes SET estado = 'cerrada' WHERE id = ?", [id]);
  return obtener(id);
};

const movimientos = async (cuentaId, { desde, hasta, limite = 100, pagina = 1 } = {}) => {
  const donde = ['cuenta_id = ?'], p = [cuentaId];
  if (desde) { donde.push('fecha >= ?'); p.push(desde); }
  if (hasta) { donde.push('fecha <= ?'); p.push(hasta); }
  const lim = Math.min(Number(limite) || 100, 500);
  const [filas] = await pool.query(`SELECT * FROM movimientos_cc WHERE ${donde.join(' AND ')} ORDER BY fecha DESC, id DESC LIMIT ? OFFSET ?`, [...p, lim, (Math.max(Number(pagina) || 1, 1) - 1) * lim]);
  return filas.map((m) => ({ ...m, importe: num(m.importe), importe_pesos: m.importe_pesos === null ? null : num(m.importe_pesos), cotizacion: m.cotizacion === null ? null : Number(m.cotizacion), saldo_pendiente: num(m.saldo_pendiente), comprobante_fiscal: m.comprobante_fiscal ? JSON.parse(m.comprobante_fiscal) : null }));
};
const pendientes = async (cuentaId) => (await pool.query("SELECT id, tipo, comprobante_ref, fecha, fecha_vencimiento, importe, saldo_pendiente FROM movimientos_cc WHERE cuenta_id = ? AND naturaleza = 'debito' AND estado = 'pendiente' AND saldo_pendiente > 0 ORDER BY fecha_vencimiento, id", [cuentaId]))[0]
  .map((m) => ({ ...m, importe: num(m.importe), saldo_pendiente: num(m.saldo_pendiente) }));

// ---------- Efectos que piden otros módulos (RF04, RF05, RF28): idempotentes por ID_Operacion ----------

// Débito de una venta o de un remito. Un error de negocio rechaza el mensaje, sin reintento (RN37): cuenta inexistente o cerrada en la moneda, cliente
// inexistente o importe no válido. La venta ya existe: si la cuenta está bloqueada o el crédito excedido se registra igual (contingencia/E3).
const registrarDebito = async (conn, { tipo, clienteId, moneda = 'ARS', importe, importePesos = null, ref, fecha, idOperacion, reservaId = null, contingencia = false, detalle = null, cotizacion = null, importeMonedaCuenta = null }) => {
  const imp = num(importe);
  if (!(imp > 0) || !Number.isFinite(imp)) throw new M.RechazoNegocio('El importe del débito no es válido.');
  const cli = await Clientes.resolver(clienteId);
  if (!cli) throw new M.RechazoNegocio('El cliente no existe.');
  if (cli.tipo_documento === 'CF') throw new M.RechazoNegocio('No se vende a cuenta corriente al Consumidor Final genérico.');
  const [[cuenta]] = await conn.query('SELECT * FROM cuentas_corrientes WHERE cliente_id = ? AND moneda = ?', [cli.id, moneda]);
  if (!cuenta) throw new M.RechazoNegocio(`El cliente no tiene cuenta corriente en ${moneda}.`);
  if (cuenta.estado === 'cerrada') throw new M.RechazoNegocio('La cuenta corriente está cerrada.');
  const f = fecha || hoy();
  const [r] = await conn.query(
    `INSERT INTO movimientos_cc (id_global, cuenta_id, tipo, naturaleza, comprobante_ref, id_operacion, id_reserva_credito, en_contingencia, detalle, fecha, fecha_vencimiento, importe, importe_moneda_cuenta, cotizacion, importe_pesos, saldo_pendiente)
     VALUES (?, ?, ?, 'debito', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [await idGlobal(), cuenta.id, tipo, ref, idOperacion, reservaId, contingencia ? 1 : 0, detalle, f, sumarDias(f, cuenta.plazo_dias), imp, importeMonedaCuenta, cotizacion, importePesos, imp]);
  if (postDebito) await postDebito(conn, { cuenta, movimientoId: r.insertId, importe: imp, reservaId, contingencia, ref });
  return { cuenta, movimientoId: r.insertId };
};

// Cotización con la que se mide una cuenta en moneda extranjera (RF11): la vendedora vigente. Con la cotización vencida «advertir» usa la última con aviso y «bloquear» frena la operación (EX07).
const cotizacionDe = async (moneda) => {
  const Monedas = require('../servicios/monedaService');
  const c = await Monedas.vigente(moneda).catch(() => null);
  if (!c) throw invalida(`No hay una cotización cargada de ${moneda}.`, 409, { codigo: 'SIN_COTIZACION' });
  const modo = (await pool.query("SELECT valor FROM parametros WHERE clave = 'cc_cotizacion_vencida'"))[0][0]?.valor ?? 'advertir';
  if (c.vencida && modo === 'bloquear') throw invalida(`La cotización de ${moneda} está vencida (${c.antiguedad_horas} h): cargá una nueva.`, 409, { codigo: 'SIN_COTIZACION' });
  return { valor: c.vendedor, vencida: c.vencida, aviso: c.vencida ? `Se usó la última cotización de ${moneda}, con ${c.antiguedad_horas} h de antigüedad.` : null };
};

// Diferencia de cambio (RN11): una nota en pesos que se asienta en la cuenta en pesos del cliente (la de moneda extranjera ya quedó saldada en su moneda).
const notaDeCambio = async (p, importe, { userId = null, fiscal = false } = {}) => {
  const [[cu]] = await pool.query('SELECT cliente_id FROM cuentas_corrientes WHERE id = ?', [p.cuenta_id]);
  const [[pesos]] = await pool.query("SELECT * FROM cuentas_corrientes WHERE cliente_id = ? AND moneda = 'ARS' AND estado <> 'cerrada'", [cu.cliente_id]);
  if (!pesos) throw invalida('La diferencia de cambio se documenta en la cuenta en pesos del cliente: abrila primero.', 409);
  const [[origen]] = await pool.query('SELECT comprobante_ref FROM movimientos_cc WHERE id = ?', [p.movimiento_ref]);
  const tipo = p.naturaleza === 'debito' ? 'nd' : 'nc';
  const f = hoy();
  const [r] = await pool.query(
    `INSERT INTO movimientos_cc (id_global, cuenta_id, tipo, naturaleza, comprobante_ref, id_operacion, motivo, detalle, fecha, fecha_vencimiento, importe, saldo_pendiente, estado, fiscal, user_id)
     VALUES (?, ?, ?, ?, ?, ?, 'diferencia_cambio', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [await idGlobal(), pesos.id, tipo, tipo === 'nd' ? 'debito' : 'credito', origen.comprobante_ref, `cambio:${p.id}`, `Diferencia de cambio: ${p.detalle}`.slice(0, 255), f, tipo === 'nd' ? sumarDias(f, pesos.plazo_dias) : null, importe, importe, fiscal ? 'pendiente_emision' : 'pendiente', fiscal ? 1 : 0, userId]);
  if (fiscal) await emitirFiscal(r.insertId).catch(() => null);
  return unMovimiento(r.insertId);
};

// Anular un débito: contramovimiento que lo cancela (RN06); la venta original no se borra.
const anularDebito = async (conn, { ref, idOperacion, detalle = 'Anulación del comprobante' }) => {
  const [[orig]] = await conn.query("SELECT * FROM movimientos_cc WHERE comprobante_ref = ? AND naturaleza = 'debito' AND tipo IN ('venta', 'remito') ORDER BY id LIMIT 1 FOR UPDATE", [ref]);
  if (!orig) throw new M.RechazoNegocio('No hay un débito registrado para ese comprobante.');
  if (orig.estado === 'anulado') throw new M.RechazoNegocio('El débito ya estaba anulado.');
  if (num(orig.saldo_pendiente) !== num(orig.importe)) throw new M.RechazoNegocio('El débito tiene cobros imputados: desimputalos antes de anularlo.');
  await conn.query("UPDATE movimientos_cc SET estado = 'anulado', saldo_pendiente = 0 WHERE id = ?", [orig.id]);
  await conn.query(
    `INSERT INTO movimientos_cc (id_global, cuenta_id, tipo, naturaleza, comprobante_ref, referencia_id, id_operacion, detalle, fecha, importe, saldo_pendiente, estado)
     VALUES (?, ?, 'ajuste', 'credito', ?, ?, ?, ?, ?, ?, 0, 'cancelado')`, [await idGlobal(), orig.cuenta_id, `${ref}:anulacion`, orig.id, idOperacion, detalle, hoy(), orig.importe]);
  return { movimiento_anulado: orig.id };
};

// ---------- Notas de débito y crédito (RF09, RN09, EX06) ----------

let emisor = async (nota) => {
  const r = await llamar(12, 'clientes', async () => require('../services/notaFiscalService').emitir(nota));
  if (r.fallo) throw new Error(r.motivo ?? 'La emisión no respondió');
  if (r.valor.estado && r.valor.estado !== 'aprobada') throw new Error(`ARCA no aprobó la nota (${r.valor.estado})`);
  return r.valor;
};
const usarEmisor = (fn) => { emisor = fn; };

const receptorDe = (cli) => ({
  doc_tipo: cli.tipo_documento === 'CUIT' ? 80 : cli.tipo_documento === 'CUIL' ? 86 : cli.tipo_documento === 'DNI' ? 96 : 99,
  doc_nro: cli.nro_documento, condicion_iva_receptor_id: cli.condicion_iva_receptor_id ?? 5,
});

// Aplica una nota de crédito al comprobante que corrige: baja su saldo pendiente; lo que no entra queda como saldo a favor de la nota.
const aplicarNC = async (conn, nota, ref) => {
  const aplicado = Math.min(num(ref.saldo_pendiente), num(nota.importe));
  if (aplicado > 0) await conn.query("UPDATE movimientos_cc SET estado = IF(saldo_pendiente - ? <= 0, 'cancelado', estado), saldo_pendiente = saldo_pendiente - ? WHERE id = ?", [aplicado, aplicado, ref.id]); // el estado va primero: MySQL asigna de izquierda a derecha
  await conn.query('UPDATE movimientos_cc SET saldo_pendiente = ? WHERE id = ?', [num(nota.importe - aplicado), nota.id]);
};

const nota = async (cuentaId, { tipo, importe, motivo, referencia_id: referenciaId, fiscal = false, detalle = null }, { userId = null, idSolicitud = null } = {}) => {
  if (!['nd', 'nc'].includes(tipo)) throw invalida('El tipo es nd (nota de débito) o nc (nota de crédito).');
  if (!MOTIVOS_NOTA.includes(motivo)) throw invalida(`El motivo es uno de: ${MOTIVOS_NOTA.join(', ')}.`);
  const imp = num(importe);
  if (!(imp > 0) || !Number.isFinite(imp)) throw invalida('El importe es un número mayor que cero.');
  const cuenta = await cuentaDe(cuentaId);
  if (!cuenta) throw invalida('Cuenta no encontrada.', 404);
  if (cuenta.estado === 'cerrada') throw invalida('La cuenta está cerrada.', 409);
  let [[ref]] = await pool.query('SELECT * FROM movimientos_cc WHERE id = ? AND cuenta_id = ?', [referenciaId ?? 0, cuentaId]);
  if (!ref) throw invalida('La nota tiene que referenciar el comprobante que corrige (de esta cuenta).');
  let remitoOrigen = null;
  if (ref.estado === 'facturado' && ref.referencia_id) { // RN10: una nota sobre un remito facturado referencia la factura agrupada y no reabre el remito
    remitoOrigen = ref;
    [[ref]] = await pool.query('SELECT * FROM movimientos_cc WHERE id = ?', [ref.referencia_id]);
  }
  if (ref.naturaleza !== 'debito' || ref.estado === 'anulado') throw invalida('Solo se corrige un comprobante de débito vigente.', 409);
  if (tipo === 'nc') { // RN09: una nota de crédito no puede superar el importe del comprobante que corrige
    const [[{ ya }]] = await pool.query("SELECT COALESCE(SUM(importe), 0) AS ya FROM movimientos_cc WHERE referencia_id = ? AND tipo = 'nc' AND estado <> 'anulado'", [ref.id]);
    if (remitoOrigen && imp > num(ref.saldo_pendiente)) throw invalida(`La nota de crédito supera el saldo de la factura agrupada (${num(ref.saldo_pendiente)}).`, 409, { disponible: num(ref.saldo_pendiente) });
    if (imp > num(ref.importe) - num(ya)) throw invalida(`La nota de crédito supera lo que queda del comprobante (${num(ref.importe) - num(ya)}).`, 409, { disponible: num(ref.importe) - num(ya) });
  }
  const operacion = idSolicitud ? `nota:${idSolicitud}` : null;
  if (operacion) {
    const [[previa]] = await pool.query('SELECT id FROM movimientos_cc WHERE id_operacion = ?', [operacion]);
    if (previa) return { ...(await movimientos(cuentaId, {}).then((l) => l.find((m) => m.id === previa.id))), ya_procesada: true };
  }
  const f = hoy();
  const [r] = await pool.query(
    `INSERT INTO movimientos_cc (id_global, cuenta_id, tipo, naturaleza, comprobante_ref, referencia_id, id_operacion, motivo, detalle, fecha, fecha_vencimiento, importe, saldo_pendiente, estado, fiscal, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [await idGlobal(), cuentaId, tipo, tipo === 'nd' ? 'debito' : 'credito', ref.comprobante_ref, ref.id, operacion, motivo, remitoOrigen ? `${detalle ?? ''} [remito de origen: ${remitoOrigen.comprobante_ref}]`.trim() : detalle, f, tipo === 'nd' ? sumarDias(f, cuenta.plazo_dias) : null, imp, tipo === 'nd' ? imp : 0,
      fiscal ? 'pendiente_emision' : 'pendiente', fiscal ? 1 : 0, userId]);
  const id = r.insertId;
  if (fiscal) {
    const emitida = await emitirFiscal(id).catch(() => null);
    if (!emitida) return { ...(await unMovimiento(id)), aviso: 'La nota quedó pendiente de emisión: no afecta el saldo hasta obtener el comprobante.' }; // EX06
    return unMovimiento(id);
  }
  if (tipo === 'nc') { const c = await pool.getConnection(); try { await aplicarNC(c, { id, importe: imp }, ref); } finally { c.release(); } }
  return unMovimiento(id);
};

const unMovimiento = async (id) => {
  const [[m]] = await pool.query('SELECT * FROM movimientos_cc WHERE id = ?', [id]);
  return { ...m, importe: num(m.importe), saldo_pendiente: num(m.saldo_pendiente), comprobante_fiscal: m.comprobante_fiscal ? JSON.parse(m.comprobante_fiscal) : null };
};

// Pide el comprobante fiscal a Ventas. Si no se logra, la nota queda pendiente de emisión, sin tocar el saldo, y se alerta (EX06).
const emitirFiscal = async (movId) => {
  const [[m]] = await pool.query("SELECT * FROM movimientos_cc WHERE id = ? AND estado = 'pendiente_emision'", [movId]);
  if (!m) throw invalida('La nota no está pendiente de emisión.', 409);
  const [[cuenta]] = await pool.query('SELECT * FROM cuentas_corrientes WHERE id = ?', [m.cuenta_id]);
  const cli = await Clientes.fila(cuenta.cliente_id);
  const [[ref]] = await pool.query('SELECT * FROM movimientos_cc WHERE id = ?', [m.referencia_id]);
  const asociado = ref?.comprobante_fiscal ? (() => { const f = JSON.parse(ref.comprobante_fiscal); return { Tipo: f.tipo_comprobante, PtoVta: f.punto_venta, Nro: f.numero }; })() : null;
  let comp;
  try {
    comp = await emisor({ tipo: m.tipo, receptor: receptorDe(cli), importe: num(m.importe), asociado, idIntento: `nota-cc-${m.id_global}` });
  } catch (err) {
    await Notificacion.crear({ modulo: 'clientes', tipo: 'nota_pendiente_emision', severidad: 'alta', roles: ['administrador', 'gerente', 'administrativo'], clave: `nota-emision-${m.id}`, mensaje: `La nota ${m.tipo === 'nd' ? 'de débito' : 'de crédito'} ${m.id_global} sigue pendiente de emisión (${err.message}).` });
    return null;
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE movimientos_cc SET estado = 'pendiente', comprobante_fiscal = ? WHERE id = ?", [JSON.stringify(comp), m.id]);
    if (m.tipo === 'nc' && ref) await aplicarNC(conn, { id: m.id, importe: num(m.importe) }, ref);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  await Notificacion.resolverPorClave(`nota-emision-${m.id}`, 'La nota se emitió');
  return unMovimiento(m.id);
};

// La factura que agrupa remitos los reemplaza en la cuenta (RN10): los remitos pasan a «Facturado» y dejan de sumar al saldo, sus imputaciones pasan a la factura,
// y la deuda queda con el importe de la factura (la diferencia de precios queda documentada en el detalle). Sin duplicar deuda.
const facturarRemitos = async (conn, { clienteId, facturaRef, importe, fecha, remitos, idOperacion }) => {
  const filas = [];
  for (const r of remitos) {
    const [[m]] = await conn.query("SELECT * FROM movimientos_cc WHERE comprobante_ref = ? AND tipo = 'remito' ORDER BY id LIMIT 1 FOR UPDATE", [r.remito_id_global]);
    if (!m) throw new M.RechazoNegocio(`El remito ${r.remito_id_global} no está registrado en la cuenta.`);
    if (m.estado === 'facturado') throw new M.RechazoNegocio(`El remito ${r.remito_id_global} ya está facturado.`);
    if (m.estado === 'anulado') throw new M.RechazoNegocio(`El remito ${r.remito_id_global} está anulado.`);
    filas.push({ ...m, importe_facturado: r.importe_facturado });
  }
  const cuentas = new Set(filas.map((f) => f.cuenta_id));
  if (cuentas.size !== 1) throw new M.RechazoNegocio('Los remitos son de cuentas distintas.');
  const cuentaId = filas[0].cuenta_id;
  await conn.query("UPDATE movimientos_cc SET estado = 'facturado' WHERE id IN (?)", [filas.map((f) => f.id)]); // primero salen del saldo: así el débito de la factura no los duplica
  const detalle = `Factura agrupada de ${filas.length} remito(s): ${remitos.map((r) => `${r.remito_id_global} (${num(r.importe_remito)} → ${num(r.importe_facturado)})`).join(', ')}`.slice(0, 255);
  const d = await registrarDebito(conn, { tipo: 'venta', clienteId, importe, ref: facturaRef, fecha, idOperacion, detalle });
  let disponible = num(importe), trasladado = 0;
  for (const f of filas) {
    const [imps] = await conn.query("SELECT * FROM imputaciones WHERE debito_mov_id = ? AND estado = 'vigente' ORDER BY id FOR UPDATE", [f.id]);
    for (const i of imps) {
      const x = Math.min(num(i.importe), disponible);
      if (x > 0) { await conn.query('UPDATE imputaciones SET debito_mov_id = ?, importe = ? WHERE id = ?', [d.movimientoId, x, i.id]); disponible = num(disponible - x); trasladado = num(trasladado + x); }
      if (x < num(i.importe)) { // lo que no entra en la factura vuelve al crédito como saldo a favor
        const sobra = num(i.importe - Math.max(x, 0));
        await conn.query('UPDATE movimientos_cc SET saldo_pendiente = saldo_pendiente + ? WHERE id = ?', [sobra, i.credito_mov_id]);
        if (x <= 0) await conn.query("UPDATE imputaciones SET estado = 'desimputada', motivo_desimputacion = 'La factura agrupada es menor que lo cobrado' WHERE id = ?", [i.id]);
      }
    }
    await conn.query('UPDATE movimientos_cc SET saldo_pendiente = 0, referencia_id = ? WHERE id = ?', [d.movimientoId, f.id]);
  }
  await conn.query("UPDATE movimientos_cc SET saldo_pendiente = ?, estado = IF(? <= 0, 'cancelado', estado) WHERE id = ?", [num(importe - trasladado), num(importe - trasladado), d.movimientoId]);
  return { movimientoId: d.movimientoId, trasladado };
};

// Pide a Ventas el comprobante que agrupa los remitos (por defecto, todos los pendientes del cliente). Ventas devuelve siempre un resultado estructurado.
const facturarAgrupado = async ({ cliente_id: clienteId, remitos, aceptar_diferencias: aceptar, continuar_con_validos: continuar, previa }, { userId, idSolicitud }) => {
  const ids = Array.isArray(remitos) && remitos.length ? remitos : (await remitosPendientes(clienteId)).map((r) => r.remito);
  if (!ids.length) throw invalida('El cliente no tiene remitos pendientes de facturar.', 409);
  const c = await Clientes.resolver(clienteId);
  const r = await llamar(12, 'clientes', async () => require('../services/remitoService').facturar({ cliente_id: c.id, remitos: ids, aceptar_diferencias: aceptar, continuar_con_validos: continuar, previa }, { userId, idSolicitud }));
  if (r.fallo) throw invalida(`Ventas no respondió: ${r.motivo ?? 'sin respuesta'}. Reintentá.`, 502);
  return r.valor;
};

// Remitos pendientes de facturar de un cliente: la lista de trabajo (RF21).
const remitosPendientes = async (clienteId) => {
  if (!Number.isInteger(clienteId) || clienteId <= 0) throw invalida('Indicá el cliente (cliente_id).');
  const c = await Clientes.resolver(clienteId);
  if (!c) throw invalida('Cliente no encontrado.', 404);
  return (await pool.query(
    "SELECT m.id, m.comprobante_ref AS remito, m.fecha, m.importe, m.saldo_pendiente FROM movimientos_cc m JOIN cuentas_corrientes cc ON cc.id = m.cuenta_id WHERE cc.cliente_id = ? AND m.tipo = 'remito' AND m.estado IN ('pendiente', 'cancelado') ORDER BY m.fecha, m.id", [c.id]))[0]
    .map((m) => ({ ...m, importe: num(m.importe), saldo_pendiente: num(m.saldo_pendiente) }));
};

// Devolución parcial de una venta a cuenta: crédito interno que baja lo pendiente del comprobante (RN06: el débito original no se toca).
const devolverDebito = async (conn, { ref, importe, idOperacion }) => {
  const [[orig]] = await conn.query("SELECT * FROM movimientos_cc WHERE comprobante_ref = ? AND naturaleza = 'debito' AND tipo IN ('venta', 'remito') ORDER BY id LIMIT 1 FOR UPDATE", [ref]);
  if (!orig) throw new M.RechazoNegocio('No hay un débito registrado para ese comprobante.');
  if (orig.estado === 'anulado') throw new M.RechazoNegocio('El débito ya estaba anulado.');
  const imp = num(importe);
  if (!(imp > 0)) throw new M.RechazoNegocio('El importe de la devolución no es válido.');
  const [[{ ya }]] = await conn.query("SELECT COALESCE(SUM(importe), 0) AS ya FROM movimientos_cc WHERE referencia_id = ? AND naturaleza = 'credito' AND estado <> 'anulado'", [orig.id]);
  if (imp > num(orig.importe) - num(ya)) throw new M.RechazoNegocio('La devolución supera lo que queda del comprobante.');
  const [r] = await conn.query(
    `INSERT INTO movimientos_cc (id_global, cuenta_id, tipo, naturaleza, comprobante_ref, referencia_id, id_operacion, motivo, detalle, fecha, importe, saldo_pendiente, estado)
     VALUES (?, ?, 'nc', 'credito', ?, ?, ?, 'otros', 'Devolución de mercadería', ?, ?, 0, 'pendiente')`, [await idGlobal(), orig.cuenta_id, ref, orig.id, idOperacion, hoy(), imp]);
  await aplicarNC(conn, { id: r.insertId, importe: imp }, orig);
  return { movimiento_id: r.insertId };
};

module.exports = { cotizacionDe, notaDeCambio, facturarAgrupado, facturarRemitos, remitosPendientes, devolverDebito, usarPostDebito, CuentaInvalida, MOTIVOS_NOTA, abrir, obtener, deCliente, actualizar, cerrar, movimientos, pendientes, saldoDe, cuentaDe, vista, registrarDebito, anularDebito, nota, emitirFiscal, usarEmisor, hoy, sumarDias, num, parametro };
