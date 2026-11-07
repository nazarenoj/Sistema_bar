const pool = require('../config/db');
const llamar = require('../modulos/llamar');
const Padron = require('../services/padronService');
const { idGlobal } = require('../utils/idGlobal');
const { invalida } = require('./comun');

// Proveedores (Compras RF01, RF17, RN02, RN16, RN18). El CUIT identifica a uno solo y lleva dígito verificador; el CBU, también. Con conexión los datos fiscales se completan desde el
// padrón de ARCA (por el servicio de Ventas, llamada n.º 14); sin ella se cargan a mano y quedan «no verificados».
const TIPOS = ['mercaderia', 'servicios', 'ambos'];
const DIAS = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'];
const ESTRICTO = /^\d{11}$/;

// CBU de 22 dígitos: dos bloques con su dígito verificador (RN16).
const cbuValido = (cbu) => {
  if (!/^\d{22}$/.test(cbu)) return false;
  const d = cbu.split('').map(Number);
  const dv = (digitos, pesos) => (10 - (digitos.reduce((a, x, i) => a + x * pesos[i], 0) % 10)) % 10;
  return dv(d.slice(0, 7), [7, 1, 3, 9, 7, 1, 3]) === d[7] && dv(d.slice(8, 21), [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3]) === d[21];
};
const aliasValido = (a) => /^[A-Za-z0-9.-]{6,20}$/.test(a);

const texto = (v, nombre, max, obligatorio = false) => {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (!s) { if (obligatorio) throw invalida(`Falta ${nombre}.`); return null; }
  if (s.length > max) throw invalida(`${nombre} admite hasta ${max} caracteres.`);
  return s;
};

const vista = (p) => ({
  id: p.id, id_global: p.id_global, cuit: p.cuit, razon_social: p.razon_social, condicion_iva: p.condicion_iva, domicilio: p.domicilio, contactos: p.contactos ? JSON.parse(p.contactos) : [],
  cbu_alias: p.cbu_alias, condicion_pago_dias: p.condicion_pago_dias, moneda: p.moneda, tipo: p.tipo, retenciones: p.retenciones, rubro_id: p.rubro_id, rubro: p.rubro ?? null,
  plazo_entrega_dias: p.plazo_entrega_dias, dias_entrega: p.dias_entrega ? String(p.dias_entrega).split(',') : [], hora_corte: p.hora_corte ? String(p.hora_corte).slice(0, 5) : null,
  pedido_minimo: p.pedido_minimo === null ? null : Number(p.pedido_minimo), verificado_arca: !!p.verificado_arca, estado: p.estado,
});

const fila = async (id, db = pool) => {
  const [[p]] = await db.query('SELECT p.*, r.nombre AS rubro FROM cmp_proveedores p LEFT JOIN cmp_rubros r ON r.id = p.rubro_id WHERE p.id = ?', [id]);
  if (!p) throw invalida('Proveedor no encontrado.', 404);
  return p;
};
const obtener = async (id) => vista(await fila(id));
const porCuit = async (cuit, db = pool) => {
  const [[p]] = await db.query('SELECT p.*, r.nombre AS rubro FROM cmp_proveedores p LEFT JOIN cmp_rubros r ON r.id = p.rubro_id WHERE p.cuit = ?', [String(cuit)]);
  return p ? vista(p) : null;
};

const listar = async ({ q, estado, rubroId, tipo, limite = 200 } = {}) => {
  const w = [], p = [];
  if (q) { w.push('(p.razon_social LIKE ? OR p.cuit LIKE ?)'); p.push(`%${q}%`, `%${String(q).replace(/\D/g, '') || q}%`); }
  if (estado) { w.push('p.estado = ?'); p.push(estado); }
  if (rubroId) { w.push('p.rubro_id = ?'); p.push(Number(rubroId)); }
  if (tipo) { w.push('p.tipo = ?'); p.push(tipo); }
  const [filas] = await pool.query(`SELECT p.*, r.nombre AS rubro FROM cmp_proveedores p LEFT JOIN cmp_rubros r ON r.id = p.rubro_id ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY p.razon_social LIMIT ?`, [...p, Math.min(Number(limite) || 200, 1000)]);
  return filas.map(vista);
};

const ENTREGA = ['plazo_entrega_dias', 'dias_entrega', 'hora_corte', 'pedido_minimo'];

// Valida los datos de entrega (RF17).
const entrega = (d, actual = {}) => {
  const plazo = d.plazo_entrega_dias !== undefined ? (d.plazo_entrega_dias === null ? null : Number(d.plazo_entrega_dias)) : actual.plazo_entrega_dias ?? null;
  if (plazo !== null && (!Number.isInteger(plazo) || plazo < 0 || plazo > 365)) throw invalida('El plazo de entrega es un entero de días entre 0 y 365.');
  let dias = d.dias_entrega !== undefined ? d.dias_entrega : actual.dias_entrega ?? null;
  if (Array.isArray(dias)) { if (dias.some((x) => !DIAS.includes(x))) throw invalida(`Los días de entrega son: ${DIAS.join(', ')}.`); dias = [...new Set(dias)].join(',') || null; }
  const corte = d.hora_corte !== undefined ? d.hora_corte : actual.hora_corte ?? null;
  if (corte !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(corte).slice(0, 5))) throw invalida('La hora de corte va como HH:MM.');
  const minimo = d.pedido_minimo !== undefined ? (d.pedido_minimo === null ? null : Number(d.pedido_minimo)) : actual.pedido_minimo ?? null;
  if (minimo !== null && !(minimo >= 0)) throw invalida('El pedido mínimo no puede ser negativo.');
  return { plazo, dias, corte: corte === null ? null : String(corte).slice(0, 5), minimo: minimo === null ? null : Number(minimo) };
};

const validar = async (d, actual = null) => {
  const cuit = actual?.cuit ?? String(d.cuit ?? '').replace(/[\s-]/g, '');
  if (!actual) {
    if (!ESTRICTO.test(cuit) || !Padron.cuitValido(cuit)) throw invalida('El CUIT no es válido (11 dígitos con dígito verificador).', 400, { codigo: 'CUIT_INVALIDO' });
  } else if (d.cuit !== undefined && String(d.cuit).replace(/[\s-]/g, '') !== actual.cuit) throw invalida('El CUIT de un proveedor no se cambia.', 409);
  const tipo = d.tipo ?? actual?.tipo ?? 'mercaderia';
  if (!TIPOS.includes(tipo)) throw invalida(`El tipo es: ${TIPOS.join(', ')}.`);
  const moneda = String(d.moneda ?? actual?.moneda ?? 'ARS').toUpperCase();
  if (!/^[A-Z]{3}$/.test(moneda)) throw invalida('La moneda es un código de 3 letras.');
  const pago = d.condicion_pago_dias !== undefined ? Number(d.condicion_pago_dias) : actual?.condicion_pago_dias ?? 0;
  if (!Number.isInteger(pago) || pago < 0 || pago > 365) throw invalida('La condición de pago son días enteros entre 0 y 365.');
  let cbu = d.cbu_alias !== undefined ? texto(d.cbu_alias, 'el CBU o alias', 40) : actual?.cbu_alias ?? null;
  if (cbu && !(cbuValido(cbu) || aliasValido(cbu))) throw invalida('El CBU no supera la validación de dígitos verificadores, o el alias no es válido (6 a 20 caracteres).', 400, { codigo: 'CBU_INVALIDO' });
  let rubro = d.rubro_id !== undefined ? d.rubro_id : actual?.rubro_id ?? null;
  if (rubro !== null && rubro !== undefined) {
    const [[r]] = await pool.query('SELECT id FROM cmp_rubros WHERE id = ? AND activo = 1', [Number(rubro)]);
    if (!r) throw invalida('El rubro no existe o está desactivado.', 404);
    rubro = Number(rubro);
  }
  let contactos = d.contactos !== undefined ? d.contactos : actual?.contactos ?? [];
  if (!Array.isArray(contactos)) throw invalida('Los contactos son una lista.');
  contactos = contactos.map((c) => ({ nombre: texto(c.nombre, 'el nombre del contacto', 80), telefono: texto(c.telefono, 'el teléfono', 40), email: texto(c.email, 'el correo', 120) }));
  for (const c of contactos) if (c.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) throw invalida(`El correo "${c.email}" no es válido.`);
  return { cuit, tipo, moneda, pago, cbu, rubro, contactos };
};

const crear = async (d, { userId } = {}) => {
  const v = await validar(d);
  if (await porCuit(v.cuit)) throw invalida('Ya existe un proveedor con ese CUIT.', 409, { codigo: 'CUIT_DUPLICADO', detalle: { proveedor: await porCuit(v.cuit) } });
  let razon = texto(d.razon_social, 'la razón social', 150), condicion = texto(d.condicion_iva, 'la condición frente al IVA', 40), domicilio = texto(d.domicilio, 'el domicilio', 200), verificado = false, aviso = null;
  if (d.consultar_arca !== false) { // RF01: con conexión completa los datos fiscales desde el padrón; sin ella, a mano
    const r = await llamar(14, 'compras', async () => Padron.consultar(v.cuit)).catch(() => ({ fallo: true }));
    if (!r.fallo && r.valor?.estado === 'ok') { razon = razon ?? r.valor.razon_social; condicion = condicion ?? r.valor.condicion_iva; domicilio = domicilio ?? r.valor.domicilio; verificado = true; } else aviso = 'No se pudo consultar el padrón de ARCA: los datos fiscales quedan sin verificar.';
  }
  if (!razon) throw invalida('Falta la razón social.');
  const e = entrega(d);
  const [r] = await pool.query(
    `INSERT INTO cmp_proveedores (id_global, cuit, razon_social, condicion_iva, domicilio, contactos, cbu_alias, condicion_pago_dias, moneda, tipo, retenciones, rubro_id, plazo_entrega_dias, dias_entrega, hora_corte, pedido_minimo, verificado_arca, creado_por)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [await idGlobal(), v.cuit, razon, condicion, domicilio, JSON.stringify(v.contactos), v.cbu, v.pago, v.moneda, v.tipo, texto(d.retenciones, 'la situación frente a las retenciones', 60), v.rubro, e.plazo, e.dias, e.corte, e.minimo, verificado ? 1 : 0, userId ?? null]);
  return { ...(await obtener(r.insertId)), ...(aviso && { aviso }) };
};

// `puedeEntrega`: editar los datos de entrega es una acción con permiso aparte (RN29).
const actualizar = async (id, d, { puedeEntrega = false } = {}) => {
  const p = vista(await fila(id));
  const v = await validar(d, p);
  if (ENTREGA.some((k) => d[k] !== undefined) && !puedeEntrega) throw invalida('Editar los datos de entrega necesita su permiso.', 403, { codigo: 'SIN_PERMISO' });
  const e = entrega(d, { plazo_entrega_dias: p.plazo_entrega_dias, dias_entrega: p.dias_entrega.join(',') || null, hora_corte: p.hora_corte, pedido_minimo: p.pedido_minimo });
  const razon = d.razon_social !== undefined ? texto(d.razon_social, 'la razón social', 150, true) : p.razon_social;
  await pool.query(
    `UPDATE cmp_proveedores SET razon_social = ?, condicion_iva = ?, domicilio = ?, contactos = ?, cbu_alias = ?, condicion_pago_dias = ?, moneda = ?, tipo = ?, retenciones = ?, rubro_id = ?, plazo_entrega_dias = ?, dias_entrega = ?, hora_corte = ?, pedido_minimo = ? WHERE id = ?`,
    [razon, d.condicion_iva !== undefined ? texto(d.condicion_iva, 'la condición frente al IVA', 40) : p.condicion_iva, d.domicilio !== undefined ? texto(d.domicilio, 'el domicilio', 200) : p.domicilio, JSON.stringify(v.contactos), v.cbu, v.pago, v.moneda, v.tipo,
      d.retenciones !== undefined ? texto(d.retenciones, 'la situación frente a las retenciones', 60) : p.retenciones, v.rubro, e.plazo, e.dias, e.corte, e.minimo, id]);
  return obtener(id);
};

const cambiarEstado = async (id, activo) => {
  await fila(id);
  await pool.query('UPDATE cmp_proveedores SET estado = ? WHERE id = ?', [activo ? 'activo' : 'inactivo', id]);
  return obtener(id);
};

// Vuelve a consultar el padrón de un proveedor cargado a mano.
const verificarArca = async (id) => {
  const p = await fila(id);
  const r = await llamar(14, 'compras', async () => Padron.consultar(p.cuit)).catch(() => ({ fallo: true }));
  if (r.fallo || r.valor?.estado !== 'ok') return { ...(await obtener(id)), aviso: 'El padrón de ARCA no respondió: queda pendiente de verificar.' };
  await pool.query('UPDATE cmp_proveedores SET razon_social = ?, condicion_iva = COALESCE(?, condicion_iva), domicilio = COALESCE(?, domicilio), verificado_arca = 1 WHERE id = ?', [r.valor.razon_social ?? p.razon_social, r.valor.condicion_iva ?? null, r.valor.domicilio ?? null, id]);
  return obtener(id);
};

// ---- Rubros y configuración ----

const rubros = async () => (await pool.query('SELECT id, nombre, activo FROM cmp_rubros ORDER BY nombre'))[0].map((r) => ({ ...r, activo: !!r.activo }));
const crearRubro = async ({ nombre }) => {
  const n = texto(nombre, 'el nombre del rubro', 60, true);
  try { const [r] = await pool.query('INSERT INTO cmp_rubros (nombre) VALUES (?)', [n]); return { id: r.insertId, nombre: n, activo: true }; } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida(`Ya existe el rubro "${n}".`, 409);
    throw err;
  }
};
const actualizarRubro = async (id, d) => {
  const [[r]] = await pool.query('SELECT * FROM cmp_rubros WHERE id = ?', [id]);
  if (!r) throw invalida('Rubro no encontrado.', 404);
  const n = d.nombre !== undefined ? texto(d.nombre, 'el nombre del rubro', 60, true) : r.nombre;
  try { await pool.query('UPDATE cmp_rubros SET nombre = ?, activo = ? WHERE id = ?', [n, d.activo === undefined ? r.activo : d.activo ? 1 : 0, id]); } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida(`Ya existe el rubro "${n}".`, 409);
    throw err;
  }
  return (await rubros()).find((x) => x.id === id);
};

const config = async (db = pool) => {
  const [[c]] = await db.query('SELECT * FROM cmp_config WHERE id = 1');
  return { tolerancia_redondeo: Number(c.tolerancia_redondeo), actualizacion_costo: c.actualizacion_costo, variacion_costo_pct: Number(c.variacion_costo_pct), aviso_vencimiento_dias: c.aviso_vencimiento_dias,
    importe_aprobacion_op: Number(c.importe_aprobacion_op), bloquear_cae_invalido: !!c.bloquear_cae_invalido, tolerancia_peso_pct: Number(c.tolerancia_peso_pct), retencion_solicitudes_dias: c.retencion_solicitudes_dias };
};
const actualizarConfig = async (d) => {
  const a = await config();
  const num = (k, min, max, nombre) => { const v = d[k] !== undefined ? Number(d[k]) : a[k]; if (!(v >= min && v <= max)) throw invalida(`${nombre} debe estar entre ${min} y ${max}.`); return v; };
  const tol = num('tolerancia_redondeo', 0, 100, 'La tolerancia de redondeo'), pct = num('variacion_costo_pct', 0, 1000, 'La variación de costo'), aviso = num('aviso_vencimiento_dias', 0, 60, 'Los días de aviso'),
    importe = num('importe_aprobacion_op', 0, 1e12, 'El importe de aprobación'), peso = num('tolerancia_peso_pct', 0, 100, 'La tolerancia de peso'), ret = num('retencion_solicitudes_dias', 90, 3650, 'La retención de solicitudes');
  const act = d.actualizacion_costo ?? a.actualizacion_costo;
  if (!['siempre', 'solo_si_aumenta', 'con_confirmacion'].includes(act)) throw invalida('La actualización del costo es siempre, solo_si_aumenta o con_confirmacion.');
  await pool.query('UPDATE cmp_config SET tolerancia_redondeo = ?, actualizacion_costo = ?, variacion_costo_pct = ?, aviso_vencimiento_dias = ?, importe_aprobacion_op = ?, bloquear_cae_invalido = ?, tolerancia_peso_pct = ?, retencion_solicitudes_dias = ? WHERE id = 1',
    [tol, act, pct, aviso, importe, d.bloquear_cae_invalido !== undefined ? (d.bloquear_cae_invalido ? 1 : 0) : a.bloquear_cae_invalido ? 1 : 0, peso, ret]);
  return config();
};

module.exports = { cbuValido, aliasValido, obtener, porCuit, listar, crear, actualizar, cambiarEstado, verificarArca, rubros, crearRubro, actualizarRubro, config, actualizarConfig, fila };
