const pool = require('../config/db');
const Modulos = require('../modulos/registro');
const Funciones = require('../funciones/servicio');
const Cuentas = require('./cuentaService');
const Form = require('./formularios');
const { invalida, fechaLocal, esFecha, iso } = require('./comun');

// Reglas de imputación (Contable RF03, RN34, EX04, EX13). Una regla sin cuentas válidas (activas e imputables) no se guarda activa; si la cuenta de haber de una emisión o devengo
// (gift cards, vales, comisiones a pagar) no es un pasivo se pide confirmación.
const vista = (r) => ({ id: r.id, formulario: r.formulario, componente: r.componente, criterio: r.criterio, cuenta_debe_id: r.cuenta_debe_id, cuenta_haber_id: r.cuenta_haber_id,
  cuenta_debe: r.debe_codigo ? `${r.debe_codigo} ${r.debe_nombre}` : null, cuenta_haber: r.haber_codigo ? `${r.haber_codigo} ${r.haber_nombre}` : null, vigencia_desde: iso(r.vigencia_desde), activa: !!r.activa, predeterminada: !!r.predeterminada });
const SELECT = `SELECT r.*, d.codigo AS debe_codigo, d.nombre AS debe_nombre, h.codigo AS haber_codigo, h.nombre AS haber_nombre
  FROM con_reglas r LEFT JOIN con_cuentas d ON d.id = r.cuenta_debe_id LEFT JOIN con_cuentas h ON h.id = r.cuenta_haber_id`;

const funcionesActivas = async () => new Set((await Funciones.estado()).funciones.filter((f) => f.activa).map((f) => f.id));
const formularios = async () => {
  const modulos = new Map();
  for (const m of ['stock', 'compras', 'financiero', 'clientes', 'ventas_online']) modulos.set(m, await Modulos.estaInstalado(m));
  return Form.disponibles((m) => modulos.get(m), await funcionesActivas()).map((f) => ({ id: f.id, nombre: f.nombre, modulo: f.modulo, componentes: f.componentes.map(({ componente, descripcion, criterio }) => ({ componente, descripcion, criterio })) }));
};

const listar = async ({ formulario, activa } = {}) => {
  const w = [], p = [];
  if (formulario) { w.push('r.formulario = ?'); p.push(formulario); }
  if (activa !== undefined) { w.push('r.activa = ?'); p.push(activa === 'true' || activa === true ? 1 : 0); }
  return (await pool.query(`${SELECT} ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY r.formulario, r.componente, r.criterio, r.vigencia_desde`, p))[0].map(vista);
};
const obtener = async (id, db = pool) => {
  const [[r]] = await db.query(`${SELECT} WHERE r.id = ?`, [id]);
  if (!r) throw invalida('Regla no encontrada.', 404);
  return r;
};

// Cuentas válidas: existen, están activas y son imputables (EX04).
const cuentaValida = async (id, lado) => {
  if (!id) throw invalida(`Falta la cuenta del ${lado}.`, 400, { codigo: 'FALTA_CUENTA' });
  const c = await Cuentas.obtener(id).catch(() => null);
  if (!c) throw invalida(`La cuenta del ${lado} no existe.`, 404);
  if (c.estado !== 'activa') throw invalida(`La cuenta del ${lado} (${c.codigo}) está inactiva.`, 409, { codigo: 'CUENTA_INACTIVA' });
  if (!c.imputable) throw invalida(`La cuenta del ${lado} (${c.codigo}) no es imputable.`, 409, { codigo: 'CUENTA_NO_IMPUTABLE' });
  return c;
};

const validar = async (d, previa) => {
  const formulario = d.formulario ?? previa?.formulario, comp = d.componente ?? previa?.componente;
  const comp_def = Form.componente(formulario, comp);
  if (!comp_def) throw invalida('Formulario o componente desconocido.', 400, { codigo: 'FORMULARIO_INVALIDO' });
  if (!previa) { // los formularios de un módulo no instalado o de una función apagada no admiten reglas nuevas
    if (!(await formularios()).some((f) => f.id === formulario)) throw invalida('Ese formulario no está disponible: su módulo no está instalado o su función está desactivada.', 409, { codigo: 'FORMULARIO_NO_DISPONIBLE' });
  }
  const criterio = String(d.criterio ?? previa?.criterio ?? '*').trim() || '*';
  if (criterio.length > 60) throw invalida('El criterio tiene hasta 60 caracteres.');
  if (criterio !== '*' && !comp_def.criterio) throw invalida('Este componente no admite criterios: la regla es general.', 400, { codigo: 'SIN_CRITERIO' });
  const vigencia = d.vigencia_desde ?? iso(previa?.vigencia_desde) ?? fechaLocal();
  if (!esFecha(vigencia)) throw invalida('La vigencia va como AAAA-MM-DD.');
  const debeId = d.cuenta_debe_id !== undefined ? d.cuenta_debe_id : previa?.cuenta_debe_id;
  const haberId = d.cuenta_haber_id !== undefined ? d.cuenta_haber_id : previa?.cuenta_haber_id;
  const activa = d.activa !== undefined ? !!d.activa : previa ? !!previa.activa : true;
  let haber = null;
  if (activa || d.cuenta_debe_id !== undefined || d.cuenta_haber_id !== undefined) { await cuentaValida(debeId, 'debe'); haber = await cuentaValida(haberId, 'haber'); }
  if (haber && Form.porId(formulario).pasivoEnHaber && haber.tipo !== 'pasivo' && !d.confirmar) {
    throw invalida('La cuenta del haber no es un pasivo: confirmá para guardar la regla igual.', 409, { codigo: 'CONFIRMAR_NO_PASIVO' }); // EX13
  }
  return { formulario, componente: comp, criterio, vigencia, debeId, haberId, activa };
};

const crear = async (d) => {
  const v = await validar(d);
  try {
    const [r] = await pool.query('INSERT INTO con_reglas (formulario, componente, criterio, cuenta_debe_id, cuenta_haber_id, vigencia_desde, activa, actualizada_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [v.formulario, v.componente, v.criterio, v.debeId, v.haberId, v.vigencia, v.activa ? 1 : 0, Date.now()]);
    return vista(await obtener(r.insertId));
  } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw invalida('Ya hay una regla igual con esa vigencia.', 409, { codigo: 'REGLA_DUPLICADA' }); throw err; }
};
const editar = async (id, d) => {
  const previa = await obtener(id);
  const v = await validar({ ...d, formulario: previa.formulario, componente: previa.componente }, previa);
  try {
    await pool.query('UPDATE con_reglas SET criterio = ?, cuenta_debe_id = ?, cuenta_haber_id = ?, vigencia_desde = ?, activa = ?, predeterminada = 0, actualizada_ms = ? WHERE id = ?',
      [v.criterio, v.debeId, v.haberId, v.vigencia, v.activa ? 1 : 0, Date.now(), id]);
  } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw invalida('Ya hay una regla igual con esa vigencia.', 409, { codigo: 'REGLA_DUPLICADA' }); throw err; }
  return vista(await obtener(id));
};
const cambiarEstado = async (id, activa, confirmar) => editar(id, { activa, confirmar });
const eliminar = async (id) => { await obtener(id); await pool.query('DELETE FROM con_reglas WHERE id = ?', [id]); return { eliminada: true }; };

// La regla vigente a la fecha del documento (RN34): primero la del criterio exacto y, si no hay, la general ('*'); entre varias, la de vigencia más reciente.
const resolver = async (db, formulario, componente, criterio, fecha) => {
  const [r] = await db.query(`${SELECT} WHERE r.formulario = ? AND r.componente = ? AND r.activa = 1 AND r.vigencia_desde <= ? AND r.criterio IN (?, '*')
    ORDER BY (r.criterio = '*'), r.vigencia_desde DESC LIMIT 1`, [formulario, componente, fecha, criterio ?? '*']);
  return r[0] ?? null;
};

// Reglas por defecto de los formularios disponibles, con las cuentas que el plan reconoce por su clave; solo las que faltan y solo si ambas cuentas existen (idempotente).
const sembrar = async (db = pool, vigencia = fechaLocal()) => {
  const modulos = new Map();
  for (const m of ['stock', 'compras', 'financiero', 'clientes', 'ventas_online']) modulos.set(m, await Modulos.estaInstalado(m));
  const funciones = new Set((await Funciones.estado(db)).funciones.filter((f) => f.activa).map((f) => f.id));
  let nuevas = 0;
  for (const f of Form.disponibles((m) => modulos.get(m), funciones)) {
    for (const c of f.componentes) {
      const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM con_reglas WHERE formulario = ? AND componente = ? AND criterio = '*'", [f.id, c.componente]);
      if (Number(n)) continue;
      const debe = await Cuentas.porClave(c.debe, db), haber = await Cuentas.porClave(c.haber, db);
      if (!debe || !haber || !debe.imputable || !haber.imputable) continue;
      await db.query("INSERT IGNORE INTO con_reglas (formulario, componente, criterio, cuenta_debe_id, cuenta_haber_id, vigencia_desde, activa, predeterminada, actualizada_ms) VALUES (?, ?, '*', ?, ?, ?, 1, 1, ?)", [f.id, c.componente, debe.id, haber.id, vigencia, Date.now()]);
      nuevas++;
    }
  }
  return { nuevas };
};

module.exports = { formularios, listar, obtener, crear, editar, cambiarEstado, eliminar, resolver, sembrar };
