const pool = require('../config/db');
const Asientos = require('./asientoService');
const Cuentas = require('./cuentaService');
const Config = require('./configService');
const Funciones = require('../funciones/servicio');
const { consultar } = require('./consultaService');
const { invalida, r2, iso } = require('./comun');

// Asiento de apertura y saldos iniciales (Contable RF13, RN18, EX12). Los módulos instalados informan sus saldos a la fecha de inicio; el sistema los propone como líneas editables y el
// Administrador confirma o corrige antes de registrar. El asiento de apertura es uno solo y deja fija la fecha de inicio.
const propuesta = async () => {
  const cfg = await Config.config();
  if (!cfg.fecha_inicio) throw invalida('Todavía no se inició la contabilidad.', 409, { codigo: 'SIN_INICIO' });
  const lineas = [], fuentes = [];
  const agregar = async (clave, importe, lado, origen, nota) => {
    if (!(importe > 0)) return;
    const cuenta = await Cuentas.porClave(clave);
    if (!cuenta) { fuentes.push({ modulo: origen, estado: 'sin_cuenta', motivo: `El plan no tiene la cuenta «${clave}».` }); return; }
    lineas.push({ cuenta_id: cuenta.id, codigo: cuenta.codigo, nombre: cuenta.nombre, debe: lado === 'debe' ? r2(importe) : 0, haber: lado === 'haber' ? r2(importe) : 0, origen, nota });
  };
  const fuente = async (modulo, nombre, procesar, { funcion } = {}) => {
    if (funcion && !(await Funciones.estaActiva(funcion))) return;
    const r = await consultar(modulo, nombre, {});
    if (!r.instalado) return;
    if (!r.disponible) { fuentes.push({ modulo, estado: 'no_disponible', motivo: r.motivo }); return; }
    await procesar(r.valor);
    fuentes.push({ modulo, estado: 'ok' });
  };
  await fuente('financiero', 'saldos', async (v) => {
    await agregar('caja', v.caja, 'debe', 'financiero', 'Cajas'); await agregar('bancos', v.bancos, 'debe', 'financiero', 'Bancos y billeteras');
    // Las cajas y cuentas en divisa entran a la cotización de hoy (comprador), con su importe en divisa (RN10).
    for (const d of v.divisas ?? []) {
      if (!(d.saldo_divisa > 0)) continue;
      const cuenta = await require('./divisas').asegurarCuenta(pool, d);
      const cot = await require('../servicios/monedaService').vigente(d.moneda).catch(() => null);
      if (!cot) { fuentes.push({ modulo: 'financiero', estado: 'sin_cotizacion', motivo: `Falta la cotización de ${d.moneda} para valuar ${d.nombre}.` }); continue; }
      lineas.push({ cuenta_id: cuenta.id, codigo: cuenta.codigo, nombre: cuenta.nombre, debe: r2(d.saldo_divisa * cot.comprador), haber: 0, importe_divisa: d.saldo_divisa, cotizacion: cot.comprador, origen: 'financiero', nota: `${d.saldo_divisa} ${d.moneda}` });
    }
  });
  await fuente('stock', 'inventario', async (v) => agregar('insumos', v.total, 'debe', 'stock', 'Existencias valorizadas'));
  await fuente('clientes', 'deudores', async (v) => agregar('deudores', v.total, 'debe', 'clientes', 'Saldo de deudores'));
  await fuente('clientes', 'instrumentos', async (v) => { await agregar('gift_cards', v.gift_cards, 'haber', 'clientes', 'Gift cards vigentes'); await agregar('vales', v.vales, 'haber', 'clientes', 'Vales vigentes'); }, { funcion: 'CLI-FIDEL' });
  await fuente('compras', 'proveedores', async (v) => agregar('proveedores', v.total, 'haber', 'compras', 'Deuda con proveedores'));
  const debe = lineas.reduce((s, l) => s + l.debe, 0), haber = lineas.reduce((s, l) => s + l.haber, 0);
  const resto = r2(debe - haber);
  // Lo que queda sin contrapartida es el patrimonio neto de arranque.
  if (resto !== 0) await agregar('capital', Math.abs(resto), resto > 0 ? 'haber' : 'debe', 'ajuste', 'Patrimonio neto de apertura');
  return { fecha: iso(cfg.fecha_inicio), registrada: !!cfg.asiento_apertura_id, asiento_apertura_id: cfg.asiento_apertura_id, lineas, fuentes, total_debe: r2(lineas.reduce((s, l) => s + l.debe, 0)), total_haber: r2(lineas.reduce((s, l) => s + l.haber, 0)) };
};

// Registra el asiento de apertura con fecha igual a la de inicio; un segundo asiento de apertura se bloquea (EX12).
const registrar = async ({ lineas, leyenda } = {}, usuarioId, idSolicitud = null) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[cfg]] = await conn.query('SELECT fecha_inicio, asiento_apertura_id FROM con_config WHERE id = 1 FOR UPDATE');
    if (!cfg.fecha_inicio) throw invalida('Todavía no se inició la contabilidad.', 409, { codigo: 'SIN_INICIO' });
    if (cfg.asiento_apertura_id) throw invalida('Ya hay un asiento de apertura. Corregí con un asiento manual de ajuste.', 409, { codigo: 'APERTURA_REGISTRADA' }); // EX12
    const limpias = (lineas ?? []).map((l) => ({ cuenta_id: Number(l.cuenta_id), debe: Number(l.debe ?? 0), haber: Number(l.haber ?? 0), detalle: l.nota ?? l.detalle ?? null, importe_divisa: l.importe_divisa ?? null, cotizacion: l.cotizacion ?? null }));
    const a = await Asientos.crear(conn, { fecha: iso(cfg.fecha_inicio), tipo: 'apertura', leyenda: String(leyenda ?? 'Asiento de apertura').slice(0, 200), lineas: limpias, usuarioId, idSolicitud, exacto: true });
    await conn.query('UPDATE con_config SET asiento_apertura_id = ? WHERE id = 1', [a.id]);
    await conn.commit();
    return Asientos.vista(a.id);
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

module.exports = { propuesta, registrar };
