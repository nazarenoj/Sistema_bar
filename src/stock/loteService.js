const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const { idGlobal } = require('../utils/idGlobal');

// Lotes y vencimiento (Stock RF20, RN06, RN73, RN74), con la función STK-LOTES. FEFO: se egresa primero el lote que vence antes.
// Sin la función los ítems se manejan por cantidad y los lotes ya registrados se conservan.
class LoteInvalido extends Error {}
const invalido = (m, status = 400) => Object.assign(new LoteInvalido(m), { status });

const TABLA = { insumo: 'insumos', producto: 'productos' };
const COL = { insumo: 'insumo_id', producto: 'producto_id' };
const habilitado = () => Funciones.estaActiva('STK-LOTES');

const config = async (conn, item) => (await conn.query(`SELECT controla_lote, vida_util_dias, vencido_politica FROM ${TABLA[item.tipo]} WHERE id = ?`, [item.id]))[0][0] ?? null;
// ¿Se manejan lotes para este ítem? La función activa y el ítem con control de lote (un ítem sin control ignora el lote indicado).
const controla = async (conn, item) => (await habilitado()) && !!(await config(conn, item))?.controla_lote;

const hoy = () => new Date().toISOString().slice(0, 10);
const fecha = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const vencido = (l) => !!l.fecha_vencimiento && fecha(l.fecha_vencimiento) < hoy();
// Un lote bloqueado nunca se usa; uno vencido, solo si el ítem lo admite (advertir).
const usable = (l, politica) => !l.bloqueado && (politica === 'advertir' || !vencido(l));

const porCodigo = async (conn, item, codigo) => (await conn.query(`SELECT * FROM lotes WHERE ${COL[item.tipo]} = ? AND codigo = ?`, [item.id, codigo]))[0][0] ?? null;
const porId = async (conn, id) => (await conn.query('SELECT * FROM lotes WHERE id = ?', [id]))[0][0] ?? null;

// Lotes del ítem con saldo en un depósito, en orden FEFO (vencimiento más próximo primero; sin vencimiento al final).
const conSaldo = async (conn, item, deposito) => (await conn.query(
  `SELECT l.*, COALESCE(SUM(m.cantidad), 0) AS saldo FROM lotes l LEFT JOIN stock_movimientos m ON m.lote_id = l.id AND m.deposito_id = ?
   WHERE l.${COL[item.tipo]} = ? GROUP BY l.id HAVING saldo > 0 ORDER BY (l.fecha_vencimiento IS NULL), l.fecha_vencimiento, l.id`, [deposito, item.id]))[0]
  .map((l) => ({ ...l, saldo: Number(l.saldo) }));

// Datos del lote para un ingreso: lo crea si es nuevo o valida que coincida con el que ya existe. El vencimiento sale de la
// vida útil del ítem si no se indica (elaborados). Devuelve el lote, o null si el ítem no controla lotes.
const paraIngreso = async (conn, item, datos) => {
  if (!(await controla(conn, item))) return null;
  const cfg = await config(conn, item);
  if (!datos?.codigo || !String(datos.codigo).trim()) throw invalido('Este ítem controla lote: indicá el código del lote en cada línea.');
  const codigo = String(datos.codigo).trim();
  let venc = datos.fecha_vencimiento ?? null;
  if (!venc && cfg.vida_util_dias && datos.fecha_elaboracion) {
    const d = new Date(datos.fecha_elaboracion);
    d.setDate(d.getDate() + Number(cfg.vida_util_dias));
    venc = d.toISOString().slice(0, 10);
  }
  if (!venc) throw invalido('Este ítem controla lote: indicá la fecha de vencimiento (o la de elaboración, si tiene vida útil cargada).');
  const existente = await porCodigo(conn, item, codigo);
  if (existente) {
    if (fecha(existente.fecha_vencimiento) !== fecha(venc)) throw invalido(`El lote ${codigo} ya existe con otro vencimiento (${fecha(existente.fecha_vencimiento)}).`, 409);
    return existente;
  }
  const id_global = await idGlobal();
  const [r] = await conn.query(`INSERT INTO lotes (id_global, ${COL[item.tipo]}, codigo, fecha_elaboracion, fecha_vencimiento) VALUES (?, ?, ?, ?, ?)`, [id_global, item.id, codigo, datos.fecha_elaboracion ?? null, venc]);
  return porId(conn, r.insertId);
};

// Reparte `cantidad` entre los lotes: el indicado primero (si sirve), después FEFO sobre los usables. Lo que no alcanza queda sin
// lote (el descuento de una venta ya cerrada nunca se rechaza, RN73). `indicadoNoDisponible`: el indicado no sirvió o no alcanzó.
const asignar = async (conn, item, deposito, cantidad, { indicado = null } = {}) => {
  const cfg = await config(conn, item);
  const lotes = await conSaldo(conn, item, deposito);
  const asignaciones = [];
  let falta = cantidad;
  let indicadoNoDisponible = null;
  if (indicado) {
    const l = lotes.find((x) => x.codigo === indicado);
    if (l && usable(l, cfg.vencido_politica)) {
      const t = Math.min(falta, l.saldo);
      asignaciones.push({ lote: l, cantidad: t, origen: 'indicado' });
      falta -= t; l.saldo -= t;
      if (falta > 1e-9) indicadoNoDisponible = { codigo: indicado, motivo: 'sin saldo suficiente' };
    } else indicadoNoDisponible = { codigo: indicado, motivo: !l ? 'inexistente o sin saldo' : l.bloqueado ? 'bloqueado' : 'vencido' };
  }
  for (const l of lotes) {
    if (falta <= 1e-9) break;
    if (l.saldo <= 1e-9 || !usable(l, cfg.vencido_politica)) continue;
    const t = Math.min(falta, l.saldo);
    asignaciones.push({ lote: l, cantidad: t, origen: 'fefo' });
    falta -= t;
  }
  if (falta > 1e-9) asignaciones.push({ lote: null, cantidad: falta, origen: null });
  return { asignaciones, indicadoNoDisponible };
};

// Para un egreso manual o una transferencia: el lote que se nombra, o FEFO.
const paraEgreso = async (conn, item, deposito, cantidad, codigo = null) => {
  if (!(await controla(conn, item))) return [{ lote: null, cantidad, origen: null }];
  if (codigo) {
    const l = await porCodigo(conn, item, codigo);
    if (!l) throw invalido(`El lote ${codigo} no existe para ese ítem.`, 404);
    return [{ lote: l, cantidad, origen: 'indicado' }];
  }
  return (await asignar(conn, item, deposito, cantidad)).asignaciones;
};

// Existencias utilizables de un ítem con lotes (sin lo bloqueado ni lo vencido que no se admite) para el compromiso de venta.
const fisicoUtil = async (conn, item, deposito) => {
  const cfg = await config(conn, item);
  const lotes = await conSaldo(conn, item, deposito);
  const [[sin]] = await conn.query(`SELECT COALESCE(SUM(cantidad), 0) AS s FROM stock_movimientos WHERE ${COL[item.tipo]} = ? AND deposito_id = ? AND lote_id IS NULL`, [item.id, deposito]);
  return Number(sin.s) + lotes.filter((l) => usable(l, cfg.vencido_politica)).reduce((a, l) => a + l.saldo, 0);
};

// ¿Sirve el lote indicado para esa cantidad? (compromiso de venta, EX57). Devuelve null si sirve, o el motivo.
const motivoNoDisponible = async (conn, item, deposito, codigo, cantidad) => {
  const cfg = await config(conn, item);
  const l = (await conSaldo(conn, item, deposito)).find((x) => x.codigo === codigo);
  if (!l) return 'inexistente o sin saldo';
  if (l.bloqueado) return 'bloqueado';
  if (!usable(l, cfg.vencido_politica)) return 'vencido';
  return l.saldo + 1e-9 < cantidad ? `solo quedan ${l.saldo}` : null;
};

// Lotes con saldo que están vencidos o vencen dentro de `dias` días, por depósito (informe, alertas y merma de fin de día).
const proximosAVencer = async (dias = 0) => {
  const limite = new Date(Date.now() + dias * 86400000).toISOString().slice(0, 10);
  const [filas] = await pool.query(
    `SELECT l.id, l.codigo, l.fecha_vencimiento, l.bloqueado, l.insumo_id, l.producto_id, COALESCE(i.nombre, p.nombre) AS nombre, m.deposito_id, d.nombre AS deposito, SUM(m.cantidad) AS saldo
     FROM lotes l JOIN stock_movimientos m ON m.lote_id = l.id JOIN depositos d ON d.id = m.deposito_id
     LEFT JOIN insumos i ON i.id = l.insumo_id LEFT JOIN productos p ON p.id = l.producto_id
     WHERE l.fecha_vencimiento IS NOT NULL AND l.fecha_vencimiento <= ?
     GROUP BY l.id, l.codigo, l.fecha_vencimiento, l.bloqueado, l.insumo_id, l.producto_id, nombre, m.deposito_id, d.nombre HAVING saldo > 0 ORDER BY l.fecha_vencimiento, l.id`, [limite]);
  return filas.map((f) => ({ ...f, saldo: Number(f.saldo), fecha_vencimiento: fecha(f.fecha_vencimiento), vencido: fecha(f.fecha_vencimiento) < hoy() }));
};

module.exports = { LoteInvalido, habilitado, controla, config, usable, vencido, porCodigo, porId, conSaldo, paraIngreso, asignar, paraEgreso, fisicoUtil, motivoNoDisponible, proximosAVencer };
