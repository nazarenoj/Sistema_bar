const crypto = require('crypto');
const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const M = require('../mensajeria/servicio');
const Notificacion = require('../models/notificacionModel');
const Correo = require('../servicios/correoService');
const Clientes = require('./clienteService');
const { idGlobal } = require('../utils/idGlobal');

// Fidelización, gift cards, saldo a favor y vales (Clientes y CC RF22 a RF24, RF29, RF31, RN23 a RN31, EX13 a EX17, EX30, EX31, EX33, EX34; función CLI-FIDEL).
// Solo se acumula y se canjea a nombre de un socio identificado con consentimiento; los movimientos no se editan ni se borran (el saldo es la suma); cada
// instrumento pertenece a la instancia que lo emitió; el canje retiene el saldo (reservar, confirmar y vencer) y nunca excede el saldo del instrumento.
class FidelizacionInvalida extends Error {}
const invalida = (m, status = 400, extra = {}) => Object.assign(new FidelizacionInvalida(m), { status, ...extra });
const num = (x) => Math.round(Number(x) * 100) / 100;
const TIPOS_INSTRUMENTO = { gift_card: 'GC', saldo_favor: 'SF', vale: 'VL' };
const VENC_CAMPO = { sellos: 'venc_sellos_dias', puntos: 'venc_puntos_dias', saldo_favor: 'venc_saldo_dias', gift_card: 'venc_giftcard_dias', vale: 'venc_vale_dias' };
const hoy = () => { const d = new Date(), p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const sumarDias = (f, n) => { const d = new Date(`${f}T12:00:00`); d.setDate(d.getDate() + Number(n)); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const iso = (f) => (f ? hoyDe(f) : null);
const hoyDe = (f) => { const d = new Date(f); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const ROLES_ALERTA = ['administrador', 'gerente', 'administrativo'];
// La función con la que se abrió el documento manda (RN40): un mensaje de una venta emitida con CLI-FIDEL activa se procesa aunque hoy esté apagada.
const conFuncion = (ctx) => { if (ctx && !(ctx.funciones ?? []).includes('CLI-FIDEL')) throw new M.RechazoNegocio('La función CLI-FIDEL estaba desactivada cuando se emitió el documento.'); };
const instancia = async (conn = pool) => (await conn.query('SELECT codigo_instancia AS c FROM configuracion_instancia WHERE id = 1'))[0][0]?.c ?? 'LOCAL';

// ---------- Programa y reglas de sellos (RF22) ----------
const programa = async () => (await pool.query('SELECT * FROM fid_programa WHERE id = 1'))[0][0];
const CAMPOS_PROGRAMA = ['nombre', 'estado', 'vigente_desde', 'vigente_hasta', 'importe_por_punto', 'valor_punto', 'redondeo', 'tope_puntos_venta', 'venc_sellos_dias', 'venc_puntos_dias', 'venc_saldo_dias', 'venc_giftcard_dias', 'venc_vale_dias', 'venc_base', 'aviso_dias'];
const configurarPrograma = async (d) => {
  const p = await programa();
  const n = { ...p };
  for (const c of CAMPOS_PROGRAMA) if (d[c] !== undefined) n[c] = d[c] === '' ? null : d[c];
  if (!['activo', 'inactivo'].includes(n.estado)) throw invalida('El estado del programa es activo o inactivo.');
  if (!(Number(n.importe_por_punto) > 0) || !(Number(n.valor_punto) > 0)) throw invalida('El importe por punto y el valor del punto son mayores que cero.');
  if (!['abajo', 'arriba', 'cercano'].includes(n.redondeo)) throw invalida('El redondeo es abajo, arriba o cercano.');
  if (!['emision', 'actividad'].includes(n.venc_base)) throw invalida('El vencimiento cuenta desde la emisión o desde la última actividad.');
  for (const c of ['tope_puntos_venta', 'venc_sellos_dias', 'venc_puntos_dias', 'venc_saldo_dias', 'venc_giftcard_dias', 'venc_vale_dias', 'aviso_dias'])
    if (n[c] !== null && n[c] !== undefined && !(Number.isInteger(Number(n[c])) && Number(n[c]) >= 0)) throw invalida(`${c} es un número entero de cero o más (vacío = sin tope ni vencimiento).`);
  await pool.query(`UPDATE fid_programa SET ${CAMPOS_PROGRAMA.map((c) => `${c} = ?`).join(', ')} WHERE id = 1`, CAMPOS_PROGRAMA.map((c) => n[c] ?? null));
  return { ...(await programa()), aviso: 'Los saldos pertenecen a la sucursal donde se acumularon: no se consolidan ni se canjean en otra (RN26).' };
};
const vigente = async () => {
  const p = await programa();
  const h = hoy();
  return p.estado === 'activo' && (!p.vigente_desde || hoyDe(p.vigente_desde) <= h) && (!p.vigente_hasta || hoyDe(p.vigente_hasta) >= h);
};
const crearRegla = async (d) => {
  if (!String(d.nombre ?? '').trim()) throw invalida('Falta el nombre de la regla.');
  if (!d.producto_id && !d.categoria_id) throw invalida('La regla es por artículo o por categoría.');
  if (!(Number.isInteger(d.sellos_para_premio) && d.sellos_para_premio > 0)) throw invalida('Los sellos para el premio son un entero mayor que cero.');
  const porUnidad = d.sellos_por_unidad ?? 1;
  if (!(Number.isInteger(porUnidad) && porUnidad > 0)) throw invalida('Los sellos por unidad son un entero mayor que cero.');
  if (!['producto_gratis', 'descuento_fijo'].includes(d.premio_tipo)) throw invalida('El premio es producto_gratis o descuento_fijo.');
  if (d.premio_tipo === 'producto_gratis' && !d.premio_producto_id) throw invalida('El premio de producto gratis indica el producto.');
  if (d.premio_tipo === 'descuento_fijo' && !(Number(d.premio_importe) > 0)) throw invalida('El descuento fijo es un importe mayor que cero.');
  const [r] = await pool.query('INSERT INTO fid_reglas_sellos (nombre, producto_id, categoria_id, sellos_por_unidad, sellos_para_premio, premio_tipo, premio_producto_id, premio_importe, tope_sellos_venta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [d.nombre.trim(), d.producto_id ?? null, d.categoria_id ?? null, porUnidad, d.sellos_para_premio, d.premio_tipo, d.premio_producto_id ?? null, d.premio_importe ?? null, d.tope_sellos_venta ?? null]);
  return (await pool.query('SELECT * FROM fid_reglas_sellos WHERE id = ?', [r.insertId]))[0][0];
};
const reglas = async () => (await pool.query('SELECT * FROM fid_reglas_sellos ORDER BY id'))[0].map((r) => ({ ...r, activa: !!r.activa }));
const activarRegla = async (id, activa) => { await pool.query('UPDATE fid_reglas_sellos SET activa = ? WHERE id = ?', [activa ? 1 : 0, id]); return (await reglas()).find((r) => r.id === Number(id)); };

// ---------- Socios (RF22, RN23) ----------
const esSocio = async (clienteId, conn = pool) => { const c = await Clientes.resolver(clienteId); return !!c && !!(await conn.query("SELECT 1 FROM fid_socios WHERE cliente_id = ? AND estado = 'activo'", [c.id]))[0].length; };
const publicarSocio = async (clienteId) => { // RN42: Ventas guarda en su copia local la condición de socio
  const c = await Clientes.fila(clienteId);
  if (!c) return;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await M.publicar(conn, { origen: 'clientes', destino: 'ventas', tipo: 'cliente_actualizado', docTipo: 'cliente', docIdGlobal: c.id_global, docVersion: Date.now(),
      contenido: { cliente_id: c.id, razon_social: c.razon_social, lista_precio_id: c.lista_precio_id, socio: await esSocio(c.id, conn), version_ms: Date.now() } });
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  M.despertar();
};
const adherir = async (clienteId, { consentimiento }, { userId = null } = {}) => {
  if (consentimiento !== true) throw invalida('La adhesión exige el consentimiento del cliente.');
  const c = await Clientes.resolver(clienteId);
  if (!c) throw invalida('Cliente no encontrado.', 404);
  if (c.tipo_documento === 'CF') throw invalida('El Consumidor Final genérico no acumula.', 409); // RN23
  if (c.estado !== 'activo') throw invalida('El cliente no está activo.', 409);
  await pool.query("INSERT INTO fid_socios (cliente_id, estado, consentimiento_en, consentimiento_user) VALUES (?, 'activo', NOW(), ?) ON DUPLICATE KEY UPDATE estado = 'activo', baja_en = NULL, consentimiento_en = NOW(), consentimiento_user = VALUES(consentimiento_user)", [c.id, userId]);
  await publicarSocio(c.id);
  return socio(c.id);
};
const baja = async (clienteId) => {
  const c = await Clientes.resolver(clienteId);
  const [r] = await pool.query("UPDATE fid_socios SET estado = 'baja', baja_en = NOW() WHERE cliente_id = ? AND estado = 'activo'", [c?.id ?? 0]);
  if (!r.affectedRows) throw invalida('El cliente no es socio.', 404);
  await publicarSocio(c.id);
  return socio(c.id);
};
// Alta rápida durante la venta (nombre, teléfono y consentimiento), sin interrumpirla. Sin documento se asigna uno interno de socio.
const altaRapida = async ({ nombre, telefono, documento, tipo_documento: tipo, consentimiento }, { userId = null } = {}) => {
  if (consentimiento !== true) throw invalida('El alta de socio exige el consentimiento.');
  if (!String(nombre ?? '').trim() || !String(telefono ?? '').trim()) throw invalida('El alta rápida lleva nombre y teléfono.');
  const datos = documento ? { tipo_documento: tipo ?? 'DNI', nro_documento: documento } : { tipo_documento: 'PASAPORTE', nro_documento: `SOCIO${crypto.randomBytes(4).toString('hex').toUpperCase()}` };
  const c = await Clientes.crear({ ...datos, razon_social: String(nombre).trim(), telefono: String(telefono).trim(), consultar_arca: false }, { userId, origen: 'alta_rapida_socio' });
  return adherir(c.id, { consentimiento: true }, { userId });
};
const socio = async (clienteId) => {
  const c = await Clientes.resolver(clienteId);
  if (!c) throw invalida('Cliente no encontrado.', 404);
  const [[s]] = await pool.query('SELECT * FROM fid_socios WHERE cliente_id = ?', [c.id]);
  const p = await programa();
  const ids = await Clientes.idsDe(c.id);
  const [mov] = await pool.query("SELECT tipo, regla_id, SUM(cantidad) AS c FROM fid_movimientos WHERE cliente_id IN (?) GROUP BY tipo, regla_id", [ids]);
  const puntos = num(mov.filter((m) => m.tipo === 'puntos').reduce((a, m) => a + Number(m.c), 0));
  const rs = await reglas();
  const sellos = mov.filter((m) => m.tipo === 'sellos').map((m) => { const r = rs.find((x) => x.id === m.regla_id); return { regla_id: m.regla_id, regla: r?.nombre, sellos: num(m.c), para_premio: r?.sellos_para_premio, premios_disponibles: r ? Math.max(Math.floor(Number(m.c) / r.sellos_para_premio), 0) : 0 }; });
  const [instr] = await pool.query("SELECT i.id, i.codigo, i.tipo, i.estado, i.vence_en FROM fid_instrumentos i WHERE i.cliente_id IN (?) AND i.estado IN ('vigente', 'vencido')", [ids]);
  const instrumentos = [];
  for (const i of instr) instrumentos.push({ ...i, vence_en: iso(i.vence_en), saldo: await saldoDe(i.id) });
  return { cliente_id: c.id, razon_social: c.razon_social, socio: s?.estado === 'activo', estado: s?.estado ?? 'no_adherido', consentimiento_en: s?.consentimiento_en ?? null, puntos, valor_puntos: num(puntos * Number(p.valor_punto)), sellos, instrumentos };
};
// Identificar en el mostrador por documento, teléfono o QR (EX15): sin ficha ofrece el alta rápida; con varias, la lista para elegir.
const identificar = async (q) => {
  const lista = await Clientes.buscar(q);
  const socios = [];
  for (const c of lista) socios.push({ cliente_id: c.id, razon_social: c.razon_social, telefono: c.telefono, socio: await esSocio(c.id) });
  return { resultados: socios, accion: !socios.length ? 'alta_rapida' : socios.length > 1 ? 'elegir' : 'ok' };
};

// ---------- Sellos y puntos (RN24) ----------
const redondear = (x, modo) => (modo === 'arriba' ? Math.ceil(x) : modo === 'cercano' ? Math.round(x) : Math.floor(x));
const operacionUnica = (id, suf) => `${id}:${suf}`;
// Acumulación por una venta cobrada: sobre el importe pagado sin contar lo abonado con vales, gift cards o puntos; los artículos de premio no acumulan sellos.
const acumular = async (conn, { clienteId, ventaId, lineas = [], importePagado, idOperacion, terminal = null, userId = null }) => {
  const c = await Clientes.resolver(clienteId);
  if (!c) throw new M.RechazoNegocio('El cliente no existe.');
  const [[s]] = await conn.query("SELECT 1 AS si FROM fid_socios WHERE cliente_id = ? AND estado = 'activo'", [c.id]);
  if (!s || !(await vigente())) return { acumulado: false, motivo: 'El cliente no es un socio activo o el programa no está vigente.' };
  const p = await programa();
  const hechos = [];
  const insertar = async (tipo, cantidad, reglaId, suf) => {
    await conn.query("INSERT INTO fid_movimientos (cliente_id, tipo, movimiento, cantidad, regla_id, venta_id_global, id_operacion, user_id, terminal) VALUES (?, ?, 'acumulacion', ?, ?, ?, ?, ?, ?)", [c.id, tipo, cantidad, reglaId, ventaId, operacionUnica(idOperacion, suf), userId, terminal]);
    hechos.push({ tipo, cantidad, regla_id: reglaId });
  };
  for (const r of (await conn.query('SELECT * FROM fid_reglas_sellos WHERE activa = 1'))[0]) {
    let unidades = 0;
    for (const l of lineas) if (!l.premio && ((r.producto_id && l.producto_id === r.producto_id) || (r.categoria_id && l.categoria_id === r.categoria_id))) unidades += Number(l.cantidad);
    let sellos = unidades * r.sellos_por_unidad;
    if (r.tope_sellos_venta) sellos = Math.min(sellos, r.tope_sellos_venta);
    if (sellos > 0) await insertar('sellos', sellos, r.id, `sellos:${r.id}`);
  }
  let puntos = redondear(Number(importePagado) / Number(p.importe_por_punto), p.redondeo);
  if (p.tope_puntos_venta) puntos = Math.min(puntos, p.tope_puntos_venta);
  if (puntos > 0) await insertar('puntos', puntos, null, 'puntos');
  await conn.query("UPDATE fid_instrumentos SET ultima_actividad = ? WHERE cliente_id = ?", [hoy(), c.id]);
  return { acumulado: true, movimientos: hechos };
};
// Anulación o devolución de la venta: revierte lo acumulado aunque el saldo quede negativo (se compensa con las próximas acumulaciones, EX17) y devuelve los canjes al mismo instrumento.
const revertir = async (conn, { ventaId, idOperacion }) => {
  const [acum] = await conn.query("SELECT * FROM fid_movimientos WHERE venta_id_global = ? AND movimiento IN ('acumulacion', 'canje') ORDER BY id", [ventaId]);
  for (const m of acum) {
    if ((await conn.query("SELECT 1 FROM fid_movimientos WHERE id_operacion = ?", [operacionUnica(idOperacion, `rev:${m.id}`)]))[0].length) continue;
    await conn.query("INSERT INTO fid_movimientos (cliente_id, tipo, movimiento, cantidad, regla_id, venta_id_global, id_operacion, motivo) VALUES (?, ?, 'reversion', ?, ?, ?, ?, 'Anulación o devolución de la venta')", [m.cliente_id, m.tipo, -m.cantidad, m.regla_id, ventaId, operacionUnica(idOperacion, `rev:${m.id}`)]);
  }
  const [canjes] = await conn.query("SELECT * FROM fid_instrumento_movs WHERE venta_id_global = ? AND movimiento = 'canje'", [ventaId]);
  for (const m of canjes) {
    const op = operacionUnica(idOperacion, `revc:${m.id}`);
    if ((await conn.query('SELECT 1 FROM fid_instrumento_movs WHERE id_operacion = ?', [op]))[0].length) continue;
    await conn.query("INSERT INTO fid_instrumento_movs (instrumento_id, movimiento, importe, venta_id_global, id_operacion, motivo) VALUES (?, 'reversion', ?, ?, ?, 'Anulación o devolución de la venta')", [m.instrumento_id, -m.importe, ventaId, op]);
    await conn.query("UPDATE fid_instrumentos SET estado = IF(estado = 'agotado', 'vigente', estado) WHERE id = ?", [m.instrumento_id]);
  }
  return { revertidos: acum.length, canjes_restituidos: canjes.length };
};
const saldoPuntos = async (clienteId, conn = pool) => num((await conn.query("SELECT COALESCE(SUM(cantidad), 0) AS s FROM fid_movimientos WHERE cliente_id IN (?) AND tipo = 'puntos'", [await Clientes.idsDe(clienteId, conn)]))[0][0].s);
const saldoSellos = async (clienteId, reglaId, conn = pool) => num((await conn.query("SELECT COALESCE(SUM(cantidad), 0) AS s FROM fid_movimientos WHERE cliente_id IN (?) AND tipo = 'sellos' AND regla_id = ?", [await Clientes.idsDe(clienteId, conn), reglaId]))[0][0].s);

// Premio de sellos alcanzado (RF24): Ventas lo aplica en el cobro como regla aprobada del programa, sin el permiso de descuentos.
const premio = async (clienteId, reglaId) => {
  const c = await Clientes.resolver(clienteId);
  const [[r]] = await pool.query('SELECT * FROM fid_reglas_sellos WHERE id = ? AND activa = 1', [reglaId]);
  if (!c || !r) throw invalida('La regla de sellos no existe.', 404);
  if (!(await esSocio(c.id))) throw invalida('El cliente no es socio activo.', 409);
  if ((await saldoSellos(c.id, r.id)) < r.sellos_para_premio) throw invalida('El socio no alcanzó los sellos del premio.', 409);
  return { regla_id: r.id, nombre: r.nombre, sellos: r.sellos_para_premio, tipo: r.premio_tipo, producto_id: r.premio_producto_id, importe: r.premio_importe === null ? null : Number(r.premio_importe) };
};
const canjearSellos = async (conn, { clienteId, reglaId, ventaId, idOperacion }) => {
  const c = await Clientes.resolver(clienteId);
  const [[r]] = await conn.query('SELECT * FROM fid_reglas_sellos WHERE id = ?', [reglaId]);
  if (!c || !r) throw new M.RechazoNegocio('La regla de sellos o el cliente no existen.');
  if ((await saldoSellos(c.id, r.id, conn)) < r.sellos_para_premio) throw new M.RechazoNegocio('El socio no tiene los sellos del premio.');
  await conn.query("INSERT INTO fid_movimientos (cliente_id, tipo, movimiento, cantidad, regla_id, venta_id_global, id_operacion, motivo) VALUES (?, 'sellos', 'canje', ?, ?, ?, ?, 'Premio de sellos')", [c.id, -r.sellos_para_premio, r.id, ventaId, idOperacion]);
  return { canjeado: r.sellos_para_premio };
};
const ajustar = async (clienteId, { tipo, cantidad, regla_id: reglaId = null, motivo }, { userId = null } = {}) => {
  if (!['sellos', 'puntos'].includes(tipo) || !Number.isFinite(Number(cantidad)) || Number(cantidad) === 0) throw invalida('El ajuste lleva tipo (sellos o puntos) y una cantidad distinta de cero.');
  if (!String(motivo ?? '').trim()) throw invalida('Ajustar un saldo exige el motivo.');
  const c = await Clientes.resolver(clienteId);
  if (!c || !(await esSocio(c.id))) throw invalida('El cliente no es socio activo.', 409);
  await pool.query("INSERT INTO fid_movimientos (cliente_id, tipo, movimiento, cantidad, regla_id, motivo, user_id) VALUES (?, ?, 'ajuste', ?, ?, ?, ?)", [c.id, tipo, Number(cantidad), reglaId, String(motivo).trim().slice(0, 255), userId]);
  return socio(c.id);
};

// ---------- Instrumentos (RF23, RF29) ----------
const saldoDe = async (id, conn = pool) => num((await conn.query('SELECT COALESCE(SUM(importe), 0) AS s FROM fid_instrumento_movs WHERE instrumento_id = ?', [id]))[0][0].s);
const vencimientoDe = async (tipo, base = hoy()) => { const p = await programa(); const d = p[VENC_CAMPO[tipo]]; return d === null || d === undefined ? null : sumarDias(base, d); }; // por defecto no vencen hasta que se configure (RN27)
const codigoNuevo = async (tipo) => `${await instancia()}-${TIPOS_INSTRUMENTO[tipo]}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
const emitir = async (conn, { tipo, codigo, clienteId = null, importe, ventaId = null, devolucionId = null, ncId = null, importeDevuelto = null, idOperacion, userId = null, motivo = null }) => {
  const imp = num(importe);
  if (!(imp > 0) || !Number.isFinite(imp)) throw new M.RechazoNegocio('El importe del instrumento no es válido.');
  let cliente = null;
  if (clienteId) { cliente = await Clientes.resolver(clienteId); if (!cliente) throw new M.RechazoNegocio('El cliente no existe.'); }
  const cod = codigo ?? await codigoNuevo(tipo);
  const inst = await instancia(conn);
  if (codigo && !String(codigo).startsWith(`${inst}-`)) throw new M.RechazoNegocio(`El código ${codigo} no es de esta instancia (${inst}).`);
  if ((await conn.query('SELECT 1 FROM fid_instrumentos WHERE codigo = ?', [cod]))[0].length) throw new M.RechazoNegocio(`El código ${cod} ya existe.`); // RF29: si ya existe, rechaza
  const vence = await vencimientoDe(tipo);
  const [r] = await conn.query('INSERT INTO fid_instrumentos (codigo, tipo, cliente_id, importe_inicial, vence_en, instancia, venta_id_global, devolucion_id, nc_id, importe_devuelto, ultima_actividad) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [cod, tipo, cliente?.id ?? null, imp, vence, inst, ventaId, devolucionId, ncId, importeDevuelto, hoy()]);
  await conn.query("INSERT INTO fid_instrumento_movs (instrumento_id, movimiento, importe, venta_id_global, id_operacion, motivo, user_id) VALUES (?, 'emision', ?, ?, ?, ?, ?)", [r.insertId, imp, ventaId, idOperacion, motivo, userId]);
  // La gift card es una deuda hasta su canje (Contable RF25). El vale de una devolución ya nace en la nota de crédito, por su forma de pago, y no se informa dos veces.
  if (tipo === 'gift_card') await M.publicar(conn, { origen: 'clientes', destino: 'contable', tipo: 'pasivo_instrumento', docTipo: 'instrumento', docIdGlobal: cod,
    contenido: { tipo, codigo: cod, importe: imp, venta_id_global: ventaId, fecha_ms: Date.now() } });
  return { id: r.insertId, codigo: cod, importe: imp, vence_en: vence };
};
const detalleInstrumento = async (i) => ({ id: i.id, codigo: i.codigo, tipo: i.tipo, estado: i.estado, cliente_id: i.cliente_id, importe_inicial: num(i.importe_inicial), saldo: await saldoDe(i.id), vence_en: iso(i.vence_en), instancia: i.instancia, devolucion_id: i.devolucion_id, venta_id_global: i.venta_id_global });
// Consulta de saldo y vencimiento por código (QR) o por documento del cliente (RF23). Un código con mensaje de emisión todavía sin procesar figura «pendiente de activación».
const consultar = async ({ codigo, q }) => {
  if (codigo) {
    const [[i]] = await pool.query('SELECT * FROM fid_instrumentos WHERE codigo = ?', [codigo]);
    if (i) return [await detalleInstrumento(i)];
    const [[pend]] = await pool.query("SELECT 1 AS si FROM mensajes_integracion WHERE modulo_destino = 'clientes' AND tipo = 'emision_gift_card' AND estado <> 'confirmado' AND contenido LIKE ? LIMIT 1", [`%${String(codigo).replace(/[%_]/g, '')}%`]);
    if (pend) return [{ codigo, estado: 'pendiente_de_activacion', saldo: 0 }];
    throw invalida('No hay un instrumento con ese código.', 404);
  }
  const clientes = await Clientes.buscar(q);
  const out = [];
  for (const c of clientes) for (const i of (await pool.query('SELECT * FROM fid_instrumentos WHERE cliente_id = ?', [c.id]))[0]) out.push(await detalleInstrumento(i));
  return out;
};
const instrumentos = async ({ tipo, estado, devolucion_id: dev, cliente_id: cli } = {}) => {
  const donde = [], p = [];
  if (tipo) { donde.push('tipo = ?'); p.push(tipo); }
  if (estado) { donde.push('estado = ?'); p.push(estado); }
  if (dev) { donde.push('devolucion_id = ?'); p.push(dev); }
  if (cli) { donde.push('cliente_id = ?'); p.push(Number(cli)); }
  const filas = (await pool.query(`SELECT * FROM fid_instrumentos ${donde.length ? `WHERE ${donde.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 300`, p))[0];
  return Promise.all(filas.map(detalleInstrumento));
};
// Saldo a favor (monedero): recarga o bonificación a un cliente identificado.
const recargarSaldo = async ({ cliente_id: clienteId, importe, motivo }, { userId = null } = {}) => {
  if (!String(motivo ?? '').trim()) throw invalida('Cargar saldo a favor exige el motivo.');
  const c = await Clientes.resolver(clienteId);
  if (!c || !(await esSocio(c.id))) throw invalida('El saldo a favor es de un socio identificado.', 409);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const r = await emitir(conn, { tipo: 'saldo_favor', clienteId: c.id, importe, idOperacion: `saldo-favor:${crypto.randomUUID()}`, userId, motivo: String(motivo).trim().slice(0, 255) });
    await conn.commit();
    return consultar({ codigo: r.codigo });
  } catch (err) { await conn.rollback(); if (err instanceof M.RechazoNegocio) throw invalida(err.message); throw err; } finally { conn.release(); }
};
const mover = async (id, movimiento, importe, { motivo, userId = null, ventaId = null }) => pool.query('INSERT INTO fid_instrumento_movs (instrumento_id, movimiento, importe, venta_id_global, id_operacion, motivo, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, movimiento, importe, ventaId, `${movimiento}:${id}:${crypto.randomUUID()}`, motivo, userId]);
const anular = async (id, { motivo }, { userId = null } = {}) => {
  if (!String(motivo ?? '').trim()) throw invalida('Anular un instrumento exige el motivo.');
  const [[i]] = await pool.query('SELECT * FROM fid_instrumentos WHERE id = ?', [id]);
  if (!i) throw invalida('Instrumento no encontrado.', 404);
  if (i.estado === 'anulado') throw invalida('El instrumento ya está anulado.', 409);
  const saldo = await saldoDe(id);
  if (saldo > 0) await mover(id, 'anulacion', -saldo, { motivo: String(motivo).trim().slice(0, 255), userId });
  await pool.query("UPDATE fid_instrumentos SET estado = 'anulado' WHERE id = ?", [id]);
  return detalleInstrumento((await pool.query('SELECT * FROM fid_instrumentos WHERE id = ?', [id]))[0][0]);
};
// Un saldo vencido no se canjea, queda registrado como movimiento y no se borra; reactivarlo exige permiso y motivo (RN27).
const reactivar = async (id, { motivo, dias = null }, { userId = null } = {}) => {
  if (!String(motivo ?? '').trim()) throw invalida('Reactivar un saldo vencido exige el motivo.');
  const [[i]] = await pool.query('SELECT * FROM fid_instrumentos WHERE id = ?', [id]);
  if (!i) throw invalida('Instrumento no encontrado.', 404);
  if (i.estado !== 'vencido') throw invalida('Solo se reactiva un instrumento vencido.', 409);
  const [[v]] = await pool.query("SELECT COALESCE(SUM(-importe), 0) AS venc FROM fid_instrumento_movs WHERE instrumento_id = ? AND movimiento = 'vencimiento'", [id]);
  if (Number(v.venc) > 0) await mover(id, 'reactivacion', Number(v.venc), { motivo: String(motivo).trim().slice(0, 255), userId });
  await pool.query("UPDATE fid_instrumentos SET estado = 'vigente', vence_en = ?, avisado_vencimiento = 0, ultima_actividad = ? WHERE id = ?", [dias ? sumarDias(hoy(), dias) : null, hoy(), id]);
  return detalleInstrumento((await pool.query('SELECT * FROM fid_instrumentos WHERE id = ?', [id]))[0][0]);
};

// ---------- Emisiones que piden otros módulos (RF29) ----------
const emitirGiftCard = async (conn, c, ctx) => {
  conFuncion(ctx);
  const r = await emitir(conn, { tipo: 'gift_card', codigo: c.codigo, clienteId: c.cliente_id ?? null, importe: c.importe, ventaId: c.venta_id_global, idOperacion: ctx.idOperacion });
  return { codigo: r.codigo };
};
const emitirVale = async (conn, c, ctx) => {
  conFuncion(ctx);
  if (!(num(c.importe) > 0)) throw new M.RechazoNegocio('El importe del vale no es válido.');
  if (num(c.importe) > num(c.importe_devuelto)) throw new M.RechazoNegocio('El vale no puede ser mayor al importe devuelto.'); // EX30
  const r = await emitir(conn, { tipo: 'vale', clienteId: c.cliente_id ?? null, importe: c.importe, ventaId: c.venta_id_global, devolucionId: c.devolucion_id, ncId: c.nc_id ?? null, importeDevuelto: c.importe_devuelto, idOperacion: ctx.idOperacion });
  return { codigo: r.codigo }; // el resultado Confirmado devuelve a Ventas el código para mostrarlo o imprimirlo
};
// Revertir la emisión de una gift card: si ya tiene canjes se rechaza (EX31); si no, se anula con un contramovimiento.
const revertirEmision = async (conn, c, ctx) => {
  conFuncion(ctx);
  const [insts] = await conn.query('SELECT * FROM fid_instrumentos WHERE venta_id_global = ? AND tipo IN (?, ?) FOR UPDATE', [c.venta_id_global, 'gift_card', 'vale']);
  if (!insts.length) throw new M.RechazoNegocio('No hay instrumentos emitidos por esa venta.');
  for (const i of insts) {
    const [[{ canjes }]] = await conn.query("SELECT COUNT(*) AS canjes FROM fid_instrumento_movs WHERE instrumento_id = ? AND movimiento = 'canje'", [i.id]);
    if (canjes) throw new M.RechazoNegocio('instrumento con canjes');
  }
  for (const i of insts) {
    const saldo = await saldoDe(i.id, conn);
    if (saldo > 0) await conn.query("INSERT INTO fid_instrumento_movs (instrumento_id, movimiento, importe, venta_id_global, id_operacion, motivo) VALUES (?, 'anulacion', ?, ?, ?, 'Anulación o devolución de la venta')", [i.id, -saldo, c.venta_id_global, `${ctx.idOperacion}:${i.id}`]);
    await conn.query("UPDATE fid_instrumentos SET estado = 'anulado' WHERE id = ?", [i.id]);
  }
  return { anulados: insts.length };
};

// ---------- Retención de saldo para canje (RF31) ----------
const retener = async ({ codigo, cliente_id: clienteId, importe, idSolicitud, reemplazaA = null }) => {
  if (!idSolicitud) throw invalida('Falta la clave de solicitud de la retención.');
  const imp = num(importe);
  if (!(imp > 0)) throw invalida('El importe a canjear es mayor que cero.');
  const [[previa]] = await pool.query('SELECT * FROM fid_retenciones WHERE id_solicitud = ?', [idSolicitud]);
  if (previa) {
    if (num(previa.importe) !== imp) throw invalida('La clave de solicitud ya se usó con otro importe (conflicto de idempotencia).', 409, { codigo: 'CONFLICTO_IDEMPOTENCIA' });
    return { estado: 'retenida', id_retencion: previa.id_retencion, vence_ms: Number(previa.vence_ms), reintento: true };
  }
  const minutos = Number((await pool.query("SELECT valor FROM parametros WHERE clave = 'fid_retencion_minutos'"))[0][0]?.valor ?? 5); // antes de la transacción: una lectura previa fijaría la instantánea y no veríamos la retención de la otra terminal
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const id = `RS-${crypto.randomUUID()}`;
    const vence = Date.now() + minutos * 60000;
    if (codigo) {
      const [[i]] = await conn.query('SELECT * FROM fid_instrumentos WHERE codigo = ? FOR UPDATE', [codigo]); // atómico por instrumento (EX16)
      if (!i) { await conn.rollback(); const inst = String(codigo).split('-')[0]; return { estado: 'rechazada', motivo: `El instrumento no existe en esta instancia${inst ? ` (el código parece de ${inst})` : ''}.`, codigo: 'OTRA_SUCURSAL' }; }
      if (i.instancia !== (await instancia(conn))) { await conn.rollback(); return { estado: 'rechazada', motivo: `Instrumento emitido por otra sucursal (${i.instancia}).` }; }
      if (reemplazaA) await conn.query("UPDATE fid_retenciones SET estado = 'liberada' WHERE id_retencion = ? AND estado = 'vigente'", [reemplazaA]);
      if (i.estado !== 'vigente') { await conn.rollback(); return { estado: 'rechazada', motivo: `El instrumento está ${i.estado}.` }; }
      if (i.vence_en && hoyDe(i.vence_en) < hoy()) { await conn.rollback(); return { estado: 'rechazada', motivo: 'El instrumento está vencido.' }; }
      const saldo = await saldoDe(i.id, conn);
      const [[{ ret }]] = await conn.query("SELECT COALESCE(SUM(importe), 0) AS ret FROM fid_retenciones WHERE instrumento_id = ? AND estado = 'vigente' AND vence_ms > ?", [i.id, Date.now()]);
      const disponible = num(saldo - Number(ret));
      if (imp > disponible) { await conn.commit(); return { estado: 'saldo_insuficiente', saldo_actual: disponible }; } // la segunda terminal recibe el saldo restante (EX16)
      await conn.query("INSERT INTO fid_retenciones (id_retencion, tipo, instrumento_id, importe, id_solicitud, reemplaza_a, vence_ms, created_ms) VALUES (?, 'instrumento', ?, ?, ?, ?, ?, ?)", [id, i.id, imp, idSolicitud, reemplazaA, vence, Date.now()]);
      await conn.commit();
      return { estado: 'retenida', id_retencion: id, vence_ms: vence, saldo_restante: num(disponible - imp) };
    }
    // Puntos del socio: el importe en pesos se convierte con la equivalencia del programa.
    const c = await Clientes.resolver(clienteId);
    if (!c || !(await esSocio(c.id, conn))) { await conn.rollback(); return { estado: 'rechazada', motivo: 'El cliente no es socio activo.' }; }
    await conn.query('SELECT cliente_id FROM fid_socios WHERE cliente_id = ? FOR UPDATE', [c.id]);
    if (reemplazaA) await conn.query("UPDATE fid_retenciones SET estado = 'liberada' WHERE id_retencion = ? AND estado = 'vigente'", [reemplazaA]);
    const p = await programa();
    const puntosNec = Math.ceil(imp / Number(p.valor_punto));
    const [[{ ret }]] = await conn.query("SELECT COALESCE(SUM(puntos), 0) AS ret FROM fid_retenciones WHERE cliente_id = ? AND tipo = 'puntos' AND estado = 'vigente' AND vence_ms > ?", [c.id, Date.now()]);
    const disponible = num((await saldoPuntos(c.id, conn)) - Number(ret));
    if (puntosNec > disponible) { await conn.commit(); return { estado: 'saldo_insuficiente', saldo_actual: num(disponible * Number(p.valor_punto)), puntos_disponibles: disponible }; }
    await conn.query("INSERT INTO fid_retenciones (id_retencion, tipo, cliente_id, importe, puntos, id_solicitud, reemplaza_a, vence_ms, created_ms) VALUES (?, 'puntos', ?, ?, ?, ?, ?, ?, ?)", [id, c.id, imp, puntosNec, idSolicitud, reemplazaA, vence, Date.now()]);
    await conn.commit();
    return { estado: 'retenida', id_retencion: id, vence_ms: vence, puntos: puntosNec };
  } catch (err) { await conn.rollback().catch(() => {}); throw err; } finally { conn.release(); }
};
const liberar = async (idRetencion) => (await pool.query("UPDATE fid_retenciones SET estado = 'liberada' WHERE id_retencion = ? AND estado = 'vigente'", [idRetencion]))[0].affectedRows;
const renovar = async (idRetencion) => {
  const [[r]] = await pool.query('SELECT * FROM fid_retenciones WHERE id_retencion = ?', [idRetencion]);
  if (!r) throw invalida('Retención no encontrada.', 404);
  if (r.estado !== 'vigente' || Number(r.vence_ms) <= Date.now()) throw invalida('La retención ya no está vigente: pedí una nueva.', 409, { codigo: 'RESERVA_VENCIDA' });
  if (r.renovaciones >= 3) throw invalida('La retención ya se renovó 3 veces.', 409);
  const minutos = Number((await pool.query("SELECT valor FROM parametros WHERE clave = 'fid_retencion_minutos'"))[0][0]?.valor ?? 5);
  await pool.query('UPDATE fid_retenciones SET vence_ms = ?, renovaciones = renovaciones + 1 WHERE id_retencion = ?', [Date.now() + minutos * 60000, idRetencion]);
  return { id_retencion: idRetencion, renovaciones: r.renovaciones + 1 };
};
// El mensaje de canje que el origen graba al cerrar la venta consume la retención (idempotente por ID_Operacion). Con la retención vencida se retiene de nuevo si el
// saldo sigue disponible; si no, se rechaza con el motivo «reserva vencida» (EX34). Nunca excede el saldo ni el total de la venta (RN25).
const consumir = async (conn, c, ctx) => {
  conFuncion(ctx);
  const [[r]] = await conn.query('SELECT * FROM fid_retenciones WHERE id_retencion = ? FOR UPDATE', [c.id_retencion]);
  if (!r) throw new M.RechazoNegocio('La retención no existe.');
  if (r.estado === 'consumida') return { ya_consumida: true };
  if (r.estado === 'liberada') throw new M.RechazoNegocio('La retención fue liberada: reserva vencida.');
  const vencida = r.estado === 'vencida' || Number(r.vence_ms) <= Date.now();
  if (r.tipo === 'instrumento') {
    const [[i]] = await conn.query('SELECT * FROM fid_instrumentos WHERE id = ? FOR UPDATE', [r.instrumento_id]);
    const saldo = await saldoDe(i.id, conn);
    const [[{ otras }]] = await conn.query("SELECT COALESCE(SUM(importe), 0) AS otras FROM fid_retenciones WHERE instrumento_id = ? AND estado = 'vigente' AND vence_ms > ? AND id_retencion <> ?", [i.id, Date.now(), r.id_retencion]);
    if (i.estado !== 'vigente' && !(i.estado === 'agotado' && saldo > 0)) throw new M.RechazoNegocio(`El instrumento está ${i.estado}.`);
    if (num(r.importe) > saldo || (vencida && num(r.importe) > num(saldo - Number(otras)))) throw new M.RechazoNegocio(vencida ? 'reserva vencida' : 'Saldo insuficiente.');
    await conn.query("INSERT INTO fid_instrumento_movs (instrumento_id, movimiento, importe, venta_id_global, id_operacion, motivo) VALUES (?, 'canje', ?, ?, ?, 'Canje en venta')", [i.id, -r.importe, c.venta_id_global, ctx.idOperacion]);
    if (saldo - num(r.importe) <= 0) await conn.query("UPDATE fid_instrumentos SET estado = 'agotado' WHERE id = ?", [i.id]);
    await conn.query('UPDATE fid_instrumentos SET ultima_actividad = ? WHERE id = ?', [hoy(), i.id]);
  } else {
    const saldo = await saldoPuntos(r.cliente_id, conn);
    if (Number(r.puntos) > saldo) throw new M.RechazoNegocio(vencida ? 'reserva vencida' : 'Puntos insuficientes.');
    await conn.query("INSERT INTO fid_movimientos (cliente_id, tipo, movimiento, cantidad, venta_id_global, id_operacion, motivo) VALUES (?, 'puntos', 'canje', ?, ?, ?, 'Canje en venta')", [r.cliente_id, -r.puntos, c.venta_id_global, ctx.idOperacion]);
  }
  await conn.query("UPDATE fid_retenciones SET estado = 'consumida' WHERE id_retencion = ?", [r.id_retencion]);
  return { consumida: true, reretenida: vencida };
};

// ---------- Vencimientos y avisos (RN27) ----------
const vencer = async () => {
  const p = await programa();
  const h = hoy();
  const [vencidos] = await pool.query("SELECT * FROM fid_instrumentos WHERE estado = 'vigente' AND vence_en IS NOT NULL AND vence_en < ?", [h]);
  for (const i of vencidos) {
    const saldo = await saldoDe(i.id);
    if (saldo > 0) await mover(i.id, 'vencimiento', -saldo, { motivo: 'Vencimiento' });
    await pool.query("UPDATE fid_instrumentos SET estado = 'vencido' WHERE id = ?", [i.id]);
  }
  const [prox] = await pool.query("SELECT * FROM fid_instrumentos WHERE estado = 'vigente' AND vence_en IS NOT NULL AND avisado_vencimiento = 0 AND vence_en <= ?", [sumarDias(h, p.aviso_dias)]);
  let avisados = 0;
  for (const i of prox) {
    if (!(await saldoDe(i.id))) continue;
    await Notificacion.crear({ modulo: 'clientes', tipo: 'vencimiento_saldo', severidad: 'baja', roles: ROLES_ALERTA, clave: `vence-instrumento-${i.id}`, mensaje: `El ${i.tipo.replace('_', ' ')} ${i.codigo} vence el ${iso(i.vence_en)} con saldo ${await saldoDe(i.id)}.` });
    if (i.cliente_id && (await Funciones.estaActiva('USU-CORREO'))) {
      const c = await Clientes.fila(i.cliente_id);
      if (c?.email) await Correo.encolar({ para: c.email, asunto: 'Tu saldo está por vencer', cuerpo: `Hola ${c.razon_social}, tu ${i.tipo.replace('_', ' ')} ${i.codigo} vence el ${iso(i.vence_en)}. Te quedan ${await saldoDe(i.id)} para usar.` }).catch(() => {});
    }
    await pool.query('UPDATE fid_instrumentos SET avisado_vencimiento = 1 WHERE id = ?', [i.id]);
    avisados++;
  }
  return { vencidos: vencidos.length, avisados };
};

// ---------- Informes (RF24) ----------
const informes = async ({ desde, hasta, dias = 30 } = {}) => {
  const d = desde ? `${desde} 00:00:00` : '1970-01-01', h = hasta ? `${hasta} 23:59:59` : '2999-12-31';
  const [porTipo] = await pool.query(`SELECT i.tipo, i.estado, COUNT(*) AS cantidad, COALESCE(SUM(s.saldo), 0) AS saldo FROM fid_instrumentos i LEFT JOIN (SELECT instrumento_id, SUM(importe) AS saldo FROM fid_instrumento_movs GROUP BY instrumento_id) s ON s.instrumento_id = i.id GROUP BY i.tipo, i.estado`);
  const [mov] = await pool.query('SELECT movimiento, COUNT(*) AS cantidad, SUM(importe) AS importe FROM fid_instrumento_movs WHERE created_at >= ? AND created_at <= ? GROUP BY movimiento', [d, h]);
  const [prox] = await pool.query("SELECT i.id, i.codigo, i.tipo, i.vence_en FROM fid_instrumentos i WHERE i.estado = 'vigente' AND i.vence_en IS NOT NULL AND i.vence_en <= ? ORDER BY i.vence_en", [sumarDias(hoy(), Number(dias))]);
  const proximos = [];
  for (const i of prox) proximos.push({ ...i, vence_en: iso(i.vence_en), saldo: await saldoDe(i.id) });
  const [[pts]] = await pool.query("SELECT COALESCE(SUM(cantidad), 0) AS puntos FROM fid_movimientos WHERE tipo = 'puntos'");
  const [negativos] = await pool.query("SELECT cliente_id, tipo, SUM(cantidad) AS saldo FROM fid_movimientos GROUP BY cliente_id, tipo, regla_id HAVING saldo < 0");
  const p = await programa();
  const vigentes = porTipo.filter((x) => x.estado === 'vigente');
  return {
    saldos_vigentes: vigentes.map((x) => ({ tipo: x.tipo, instrumentos: Number(x.cantidad), saldo: num(x.saldo) })),
    movimientos: mov.map((m) => ({ movimiento: m.movimiento, cantidad: Number(m.cantidad), importe: num(m.importe) })),
    vencimientos_proximos: proximos,
    pasivo: { instrumentos: num(vigentes.reduce((a, x) => a + Number(x.saldo), 0)), puntos: num(Number(pts.puntos) * Number(p.valor_punto)), total: num(vigentes.reduce((a, x) => a + Number(x.saldo), 0) + Number(pts.puntos) * Number(p.valor_punto)) },
    saldos_negativos: negativos.map((n) => ({ cliente_id: n.cliente_id, tipo: n.tipo, saldo: num(n.saldo) })),
  };
};

// Desactivar CLI-FIDEL con saldos vigentes exige confirmación; no borra nada (EX18).
const saldosVigentes = async () => {
  const out = [];
  const [[{ n, imp }]] = await pool.query("SELECT COUNT(*) AS n, COALESCE(SUM(s.saldo), 0) AS imp FROM fid_instrumentos i LEFT JOIN (SELECT instrumento_id, SUM(importe) AS saldo FROM fid_instrumento_movs GROUP BY instrumento_id) s ON s.instrumento_id = i.id WHERE i.estado = 'vigente' AND COALESCE(s.saldo, 0) > 0");
  if (Number(n)) out.push(`${n} instrumento(s) vigente(s) por ${num(imp)}`);
  const [[{ socios }]] = await pool.query("SELECT COUNT(*) AS socios FROM fid_socios WHERE estado = 'activo'");
  if (Number(socios)) out.push(`${socios} socio(s) con sellos y puntos`);
  return out;
};
Funciones.registrarComprobacion('CLI-FIDEL', { pendientes: saldosVigentes });

module.exports = {
  FidelizacionInvalida, programa, configurarPrograma, vigente, crearRegla, reglas, activarRegla, esSocio, adherir, baja, altaRapida, socio, identificar,
  acumular, revertir, saldoPuntos, saldoSellos, premio, canjearSellos, ajustar, saldoDe, consultar, instrumentos, recargarSaldo, anular, reactivar,
  emitirGiftCard, emitirVale, revertirEmision, retener, liberar, renovar, consumir, vencer, informes, hoy,
};
