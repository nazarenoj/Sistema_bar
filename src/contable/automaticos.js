const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const Reglas = require('./reglaService');
const Asientos = require('./asientoService');
const Funciones = require('../funciones/servicio');
const Form = require('./formularios');
const Periodos = require('./periodoService');
const Pendientes = require('./pendienteService');
const { gancho } = require('./receptor');
const { invalida, r2, cts, iso, fechaLocal } = require('./comun');

// Asientos automáticos (Contable RF04, RN11, RN28, RN29, RN34, RF26). Cada evento de un módulo se traduce, con las reglas de imputación vigentes a la fecha del documento, en un asiento
// individual o en las líneas de un asiento resumido del día. Es idempotente por ID_Operacion y nunca modifica el documento de origen.
class SinRegla extends Error {
  constructor(formulario, componente, criterio) { super(`Sin regla de imputación para ${formulario} / ${componente}${criterio && criterio !== '*' ? ` (${criterio})` : ''}.`); Object.assign(this, { formulario, componente, criterio }); }
}

const nombreForm = (id) => Form.porId(id)?.nombre ?? id;

class EsperaOriginal extends Error {}

// ---- Cálculo de líneas ----

// Venta neta e IVA de cada línea (los precios incluyen IVA): el neto de una línea es su importe menos su IVA, redondeado por línea.
const neto = (lineas) => {
  let n = 0, iva = 0, total = 0;
  for (const l of lineas ?? []) {
    if (l.gift_card) continue; // una gift card no es venta (RF25)
    const imp = cts(l.importe), a = Number(l.alicuota_iva ?? 0);
    const i = a > 0 ? Math.round(imp - imp / (1 + a / 100)) : 0;
    iva += i; n += imp - i; total += imp;
  }
  return { neto: n / 100, iva: iva / 100, total: total / 100 };
};

const linea = (regla, importe, detalle) => [
  { cuenta_id: regla.cuenta_debe_id, debe: importe, haber: 0, detalle }, { cuenta_id: regla.cuenta_haber_id, debe: 0, haber: importe, detalle }];

// El cobro del comprobante, por forma de pago y en el orden en que Ventas las informa: lo que excede el total del comprobante corresponde a gift cards (RF25) y la cuenta corriente no es cobro.
const cobros = (pagos, totalComprobante) => {
  let resto = cts(totalComprobante);
  const out = [];
  for (const p of pagos ?? []) {
    const forma = p.forma ?? p.metodo_pago;
    const toma = Math.min(cts(p.importe), resto);
    resto -= toma;
    if (toma > 0 && forma !== 'cuenta_corriente') out.push({ forma, importe: toma / 100 });
  }
  return out;
};

const resolver = async (db, formulario, componente, criterio, fecha) => {
  const r = await Reglas.resolver(db, formulario, componente, criterio, fecha);
  if (!r) throw new SinRegla(formulario, componente, criterio);
  return r;
};

// Venta, venta regularizada y nota de crédito: ingreso neto (por modalidad), IVA y cobro por forma de pago.
const lineasDeVenta = async (db, formulario, c, fecha, devolucion) => {
  const lineas = c.lineas_contables ?? [];
  const { neto: n, iva, total } = neto(lineas);
  const modalidad = c.modalidad ?? 'salon';
  const out = [];
  if (n > 0) out.push(...linea(await resolver(db, formulario, 'ingreso', modalidad, fecha), n, `Venta ${modalidad}`));
  if (iva > 0) out.push(...linea(await resolver(db, formulario, 'iva', null, fecha), iva, 'IVA'));
  const pagos = devolucion ? (c.reintegros ?? []).map((x) => ({ forma: x.forma ?? x.metodo_pago, importe: x.importe })) : c.pagos;
  for (const p of cobros(pagos, total)) out.push(...linea(await resolver(db, formulario, 'cobro', p.forma, fecha), p.importe, p.forma));
  return out;
};

// Cada tipo de evento que Contable toma: su formulario, el módulo de origen y cómo arma las líneas. `esperar` retiene el evento hasta que su original esté confirmado (RN29) y
// `reprocesable: false` lo deja fuera del reprocesamiento (un contraasiento no se regenera con las reglas nuevas).
const EVENTOS = {};
const registrar = (tipo, def) => { EVENTOS[tipo] = def; };

registrar('venta_confirmada', { formulario: 'venta', modulo: 'ventas', construir: (db, c, f) => lineasDeVenta(db, 'venta', c, f, false) });
registrar('venta_regularizada', { formulario: 'venta_regularizada', modulo: 'ventas', construir: (db, c, f) => lineasDeVenta(db, 'venta_regularizada', c, f, false) });
registrar('venta_devuelta', { formulario: 'nota_credito_venta', modulo: 'ventas', construir: (db, c, f) => lineasDeVenta(db, 'nota_credito_venta', c, f, true), esperar: (conn, c) => esperarMensajes(conn, c.venta_id_global, ['venta_confirmada', 'venta_regularizada'], 'la venta de esta devolución') });

// ---- Modo de generación ----

const modoDe = async (db, formulario) => {
  const [[m]] = await db.query('SELECT modo FROM con_modos WHERE formulario = ?', [formulario]);
  if (!m || m.modo !== 'resumido') return 'individual';
  return (await Funciones.estaActiva('CON-ASIENTOS-RESUMIDOS', db)) ? 'resumido' : 'individual'; // desactivada, todo pasa a individual (RF04)
};

// ---- Aplicar un evento ----

const importeDe = (c) => c.total ?? null;

// RN29: una devolución no se aplica antes que la venta que corrige. Si el mensaje de la venta aún no se confirmó (o quedó rechazado) se reintenta más tarde; si nunca existió (la venta
// es anterior a la instalación de Contable) se imputa por su propia fecha.
const esperarMensajes = async (conn, docIdGlobal, tipos, que) => {
  if (!docIdGlobal) return;
  const [msgs] = await conn.query("SELECT estado FROM mensajes_integracion WHERE doc_id_global = ? AND modulo_destino = 'contable' AND tipo IN (?)", [docIdGlobal, tipos]);
  if (msgs.some((m) => m.estado !== 'confirmado')) throw new EsperaOriginal(`Espera al original: ${que} todavía no se contabilizó.`);
};

const aplicar = async (conn, tipo, c, ctx, fecha) => {
  const def = EVENTOS[tipo];
  const formulario = def.formulario;
  const [[ya]] = await conn.query('SELECT asiento_id FROM con_asiento_origen WHERE id_operacion = ?', [ctx.idOperacion]);
  if (ya) return { asiento_id: ya.asiento_id, ya_procesado: true }; // RN28
  if (def.esperar) await def.esperar(conn, c, ctx);
  const lineas = Asientos.consolidar(await def.construir(conn, c, fecha, ctx));
  const origen = { modulo: def.modulo, tipo_documento: tipo, id_documento: ctx.docIdGlobal, id_operacion: ctx.idOperacion, relacionado: (def.relacionado ? def.relacionado(c) : c.venta_id_global) ?? null, importe: def.importe ? def.importe(c) : importeDe(c), contenido: c, tipo_evento: tipo, fecha_documento: fecha, instantanea: ctx.instantanea };
  if (!lineas.length) { // por ejemplo una venta toda de gift cards: nada que contabilizar
    return { sin_asiento: true };
  }
  const modo = await modoDe(conn, formulario);
  const leyenda = `${nombreForm(formulario)} ${ctx.docIdGlobal}`;
  if (modo === 'resumido') {
    const { periodo, desplazado } = await Periodos.periodoPara(conn, fecha);
    const dia = desplazado ? `${periodo.anio}-${String(periodo.mes).padStart(2, '0')}-01` : fecha;
    const clave = `${formulario}:${dia}`;
    const [[existente]] = await conn.query("SELECT id, numero FROM con_asientos WHERE resumen_clave = ? AND estado = 'registrado' ORDER BY id LIMIT 1 FOR UPDATE", [clave]);
    if (existente) {
      await Asientos.sumarLineas(conn, existente.id, lineas);
      await Asientos.agregarOrigen(conn, existente.id, origen);
      return { asiento_id: existente.id, numero: existente.numero, resumido: true };
    }
    const a = await Asientos.crear(conn, { fecha, tipo: 'automatico', leyenda: `${nombreForm(formulario)} del ${Asientos.fmt(fecha)}`, lineas, resumenClave: clave, origen });
    return { asiento_id: a.id, numero: a.numero, resumido: true };
  }
  const a = await Asientos.crear(conn, { fecha, tipo: 'automatico', leyenda, lineas, origen, configVersion: null, instantanea: ctx.instantanea });
  return { asiento_id: a.id, numero: a.numero };
};

// Lo que no se pudo contabilizar queda en Pendientes de imputar (RF15) sin frenar al origen: sin regla se responde Rechazado (RN30) y una devolución que llegó antes que su venta espera (RN29).
gancho.tomar = async (conn, tipo, c, ctx, fecha) => {
  const datos = { idOperacion: ctx.idOperacion, modulo: EVENTOS[tipo]?.modulo ?? 'otro', tipoEvento: tipo, idDocumento: ctx.docIdGlobal, fecha, importe: EVENTOS[tipo]?.importe ? EVENTOS[tipo].importe(c) : importeDe(c) };
  if (!EVENTOS[tipo]) {
    await Pendientes.registrar({ ...datos, motivo: 'sin_regla', detalle: `El evento ${tipo} todavía no tiene reglas.` });
    throw new M.RechazoNegocio(`Sin regla de imputación para el evento ${tipo}.`);
  }
  try {
    const r = await aplicar(conn, tipo, c, ctx, fecha);
    await Pendientes.resolver(conn, ctx.idOperacion, { asientoId: r.asiento_id ?? null });
    return r;
  } catch (err) {
    if (err instanceof SinRegla) {
      const detalle = `${err.formulario} / ${err.componente}${err.criterio && err.criterio !== '*' ? ` (${err.criterio})` : ''}`;
      await Pendientes.registrar({ ...datos, motivo: 'sin_regla', detalle });
      throw new M.RechazoNegocio(`Sin regla de imputación: ${detalle}.`); // RN30
    }
    if (err instanceof EsperaOriginal) await Pendientes.registrar({ ...datos, motivo: 'espera_original', detalle: err.message }); // EX19: sigue como pendiente hasta que el original se confirme
    throw err;
  }
};

// ---- Reprocesamiento (RF14) ----

// Regenera los asientos automáticos de los períodos abiertos con las reglas vigentes. Sin `confirmar` solo muestra la vista previa de las diferencias; los períodos cerrados se excluyen (EX08).
const reprocesar = async ({ desde, hasta, confirmar = false } = {}, usuarioId = null) => {
  const w = ["a.tipo = 'automatico'", "a.estado = 'registrado'"], p = [];
  if (desde) { w.push('a.fecha >= ?'); p.push(desde); }
  if (hasta) { w.push('a.fecha <= ?'); p.push(hasta); }
  const [asientos] = await pool.query(`SELECT a.id, a.numero, a.fecha, a.leyenda, a.resumen_clave, per.estado AS periodo_estado, per.anio, per.mes FROM con_asientos a JOIN con_periodos per ON per.id = a.periodo_id WHERE ${w.join(' AND ')} ORDER BY a.id`, p);
  const excluidos = [...new Set(asientos.filter((a) => a.periodo_estado === 'cerrado').map((a) => `${a.anio}-${String(a.mes).padStart(2, '0')}`))];
  const abiertos = asientos.filter((a) => a.periodo_estado === 'abierto');
  const conn = await pool.getConnection();
  const cambios = [], sinRegla = [];
  try {
    await conn.beginTransaction();
    for (const a of abiertos) {
      const [origenes] = await conn.query('SELECT * FROM con_asiento_origen WHERE asiento_id = ? ORDER BY id', [a.id]);
      let nuevas = [];
      let falla = null;
      for (const o of origenes) {
        const def = EVENTOS[o.tipo_evento];
        if (def && def.reprocesable === false) { falla = null; nuevas = null; break; } // un contraasiento no se regenera
        if (!def || !o.contenido) { falla = 'sin contenido para reprocesar'; break; }
        try { nuevas.push(...await def.construir(conn, JSON.parse(o.contenido), iso(o.fecha_documento), { idOperacion: o.id_operacion, docIdGlobal: o.id_documento })); } catch (err) { if (err instanceof SinRegla) { falla = err.message; break; } throw err; }
      }
      if (nuevas === null) continue;
      if (falla) { sinRegla.push({ asiento: a.numero, motivo: falla }); continue; }
      nuevas = Asientos.consolidar(nuevas);
      const [actuales] = await conn.query('SELECT cuenta_id, debe, haber FROM con_asiento_lineas WHERE asiento_id = ?', [a.id]);
      const clave = (l) => `${l.cuenta_id}:${Number(l.debe)}:${Number(l.haber)}`;
      const antes = new Set(actuales.map(clave)), despues = new Set(nuevas.map(clave));
      if (antes.size === despues.size && [...antes].every((x) => despues.has(x))) continue;
      cambios.push({ asiento_id: a.id, numero: a.numero, leyenda: a.leyenda,
        antes: actuales.map((l) => ({ cuenta_id: l.cuenta_id, debe: Number(l.debe), haber: Number(l.haber) })), despues: nuevas.map((l) => ({ cuenta_id: l.cuenta_id, debe: l.debe, haber: l.haber })) });
      if (confirmar) {
        await Asientos.validarLineas(conn, nuevas);
        await conn.query('DELETE FROM con_asiento_lineas WHERE asiento_id = ?', [a.id]);
        for (const l of nuevas) await conn.query('INSERT INTO con_asiento_lineas (asiento_id, cuenta_id, debe, haber, detalle) VALUES (?, ?, ?, ?, ?)', [a.id, l.cuenta_id, l.debe, l.haber, l.detalle]);
      }
    }
    if (confirmar) {
      await conn.query('INSERT INTO con_reprocesos (ms, usuario_id, desde, hasta, asientos, excluidos) VALUES (?, ?, ?, ?, ?, ?)', [Date.now(), usuarioId, desde ?? null, hasta ?? null, cambios.length, excluidos.join(',') || null]);
      await conn.commit();
    } else await conn.rollback();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return { confirmado: !!confirmar, asientos_revisados: abiertos.length, asientos_con_cambios: cambios.length, cambios, periodos_excluidos: excluidos, sin_regla: sinRegla };
};

const modos = async () => {
  const [filas] = await pool.query('SELECT formulario, modo FROM con_modos');
  const m = new Map(filas.map((f) => [f.formulario, f.modo]));
  const activa = await Funciones.estaActiva('CON-ASIENTOS-RESUMIDOS');
  return { resumidos_activos: activa, formularios: [...new Set(Object.values(EVENTOS).map((e) => e.formulario))].map((id) => ({ formulario: id, nombre: nombreForm(id), modo: m.get(id) ?? 'individual' })) };
};
const fijarModo = async (formulario, modo) => {
  if (!Form.porId(formulario)) throw invalida('Formulario desconocido.', 404);
  if (!['individual', 'resumido'].includes(modo)) throw invalida('El modo es individual o resumido.');
  if (modo === 'resumido' && !(await Funciones.estaActiva('CON-ASIENTOS-RESUMIDOS'))) throw invalida('La función CON-ASIENTOS-RESUMIDOS está desactivada.', 409, { codigo: 'FUNCION_DESACTIVADA' });
  await pool.query('INSERT INTO con_modos (formulario, modo) VALUES (?, ?) ON DUPLICATE KEY UPDATE modo = VALUES(modo)', [formulario, modo]);
  return modos();
};

module.exports = { aplicar, reprocesar, modos, fijarModo, neto, cobros, SinRegla, EsperaOriginal, EVENTOS, registrar, linea, resolver, esperarMensajes };
