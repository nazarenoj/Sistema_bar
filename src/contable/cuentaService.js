const pool = require('../config/db');
const { invalida } = require('./comun');

// Plan de cuentas (Contable RF01, RN03, RN09, EX04, EX10): jerárquico (rubro > subrubro > cuenta), solo las cuentas imputables reciben movimientos, una cuenta con movimientos no se elimina
// ni cambia de tipo, y la importación es completa o no se aplica.
const TIPOS = ['activo', 'pasivo', 'patrimonio', 'resultado_positivo', 'resultado_negativo'];
const vista = (c) => ({ id: c.id, codigo: c.codigo, nombre: c.nombre, tipo: c.tipo, padre_id: c.padre_id, imputable: !!c.imputable, moneda: c.moneda, estado: c.estado, clave: c.clave });

const listar = async ({ estado, tipo } = {}) => {
  const w = [], p = [];
  if (estado) { w.push('estado = ?'); p.push(estado); }
  if (tipo) { w.push('tipo = ?'); p.push(tipo); }
  const filas = (await pool.query(`SELECT * FROM con_cuentas ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY codigo`, p))[0];
  return filas.map((c) => ({ ...vista(c), nivel: c.codigo.split('.').length }));
};
const obtener = async (id, db = pool) => {
  const [[c]] = await db.query('SELECT * FROM con_cuentas WHERE id = ?', [id]);
  if (!c) throw invalida('Cuenta no encontrada.', 404);
  return c;
};
const porClave = async (clave, db = pool) => (await db.query("SELECT * FROM con_cuentas WHERE clave = ? AND estado = 'activa' ORDER BY id LIMIT 1", [clave]))[0][0] ?? null;
const conMovimientos = async (id) => Number((await pool.query('SELECT COUNT(*) AS n FROM con_asiento_lineas WHERE cuenta_id = ?', [id]))[0][0].n) > 0;

const validar = async (d, previa) => {
  const codigo = String(d.codigo ?? previa?.codigo ?? '').trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z.\-]{0,19}$/.test(codigo)) throw invalida('El código tiene hasta 20 letras, números, puntos o guiones.');
  const nombre = String(d.nombre ?? previa?.nombre ?? '').trim();
  if (!nombre || nombre.length > 120) throw invalida('Falta el nombre (hasta 120 caracteres).');
  const tipo = d.tipo ?? previa?.tipo;
  if (!TIPOS.includes(tipo)) throw invalida(`El tipo es uno de: ${TIPOS.join(', ')}.`);
  const padreId = d.padre_id !== undefined ? d.padre_id : previa?.padre_id ?? null;
  if (padreId) {
    const padre = await obtener(padreId).catch(() => null);
    if (!padre) throw invalida('La cuenta padre no existe.', 404);
    if (padre.imputable) throw invalida('Una cuenta imputable no puede tener subcuentas: el padre tiene que ser un rubro o subrubro.', 409, { codigo: 'PADRE_IMPUTABLE' });
    if (padre.tipo !== tipo) throw invalida('La cuenta tiene que ser del mismo tipo que su rubro.', 409, { codigo: 'TIPO_DISTINTO_AL_PADRE' });
  }
  const moneda = String(d.moneda ?? previa?.moneda ?? 'ARS').toUpperCase();
  if (!/^[A-Z]{3}$/.test(moneda)) throw invalida('La moneda es un código de 3 letras.');
  return { codigo, nombre, tipo, padreId, imputable: (d.imputable ?? previa?.imputable ?? true) ? 1 : 0, moneda, clave: d.clave !== undefined ? (d.clave ? String(d.clave).slice(0, 40) : null) : previa?.clave ?? null };
};

const crear = async (d) => {
  const v = await validar(d);
  try {
    const [r] = await pool.query('INSERT INTO con_cuentas (codigo, nombre, tipo, padre_id, imputable, moneda, clave) VALUES (?, ?, ?, ?, ?, ?, ?)', [v.codigo, v.nombre, v.tipo, v.padreId, v.imputable, v.moneda, v.clave]);
    return vista(await obtener(r.insertId));
  } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw invalida('Ya hay una cuenta con ese código.', 409, { codigo: 'CODIGO_DUPLICADO' }); throw err; }
};
const editar = async (id, d) => {
  const previa = await obtener(id);
  const v = await validar({ ...d, codigo: d.codigo ?? previa.codigo }, previa);
  if (await conMovimientos(id)) {
    if (v.tipo !== previa.tipo) throw invalida('Una cuenta con movimientos no cambia de tipo.', 409, { codigo: 'CON_MOVIMIENTOS' });
    if (v.codigo !== previa.codigo) throw invalida('Una cuenta con movimientos no cambia de código.', 409, { codigo: 'CON_MOVIMIENTOS' });
    if (!v.imputable && previa.imputable) throw invalida('Una cuenta con movimientos sigue siendo imputable.', 409, { codigo: 'CON_MOVIMIENTOS' });
  }
  if (v.imputable && Number((await pool.query('SELECT COUNT(*) AS n FROM con_cuentas WHERE padre_id = ?', [id]))[0][0].n)) throw invalida('Una cuenta con subcuentas no es imputable.', 409, { codigo: 'TIENE_HIJAS' });
  try { await pool.query('UPDATE con_cuentas SET codigo = ?, nombre = ?, tipo = ?, padre_id = ?, imputable = ?, moneda = ?, clave = ? WHERE id = ?', [v.codigo, v.nombre, v.tipo, v.padreId, v.imputable, v.moneda, v.clave, id]); } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida('Ya hay una cuenta con ese código.', 409, { codigo: 'CODIGO_DUPLICADO' });
    throw err;
  }
  return vista(await obtener(id));
};
// Las reglas de imputación que usan una cuenta (EX04): se completa en el checkpoint de reglas.
const reglasQueUsan = async (id) => {
  try { return (await pool.query('SELECT id, formulario, componente FROM con_reglas WHERE (cuenta_debe_id = ? OR cuenta_haber_id = ?) AND activa = 1', [id, id]))[0]; } catch { return []; }
};
const cambiarEstado = async (id, activa) => {
  const c = await obtener(id);
  const reglas = activa ? [] : await reglasQueUsan(id);
  await pool.query('UPDATE con_cuentas SET estado = ? WHERE id = ?', [activa ? 'activa' : 'inactiva', id]);
  return { ...vista({ ...c, estado: activa ? 'activa' : 'inactiva' }), ...(reglas.length && { advertencia: 'La cuenta la usan reglas de imputación vigentes.', reglas }) };
};
// Una cuenta con movimientos no se elimina, solo se desactiva (RN09).
const eliminar = async (id) => {
  await obtener(id);
  if (await conMovimientos(id)) throw invalida('La cuenta tiene movimientos: no se elimina, solo se desactiva.', 409, { codigo: 'CON_MOVIMIENTOS' });
  if (Number((await pool.query('SELECT COUNT(*) AS n FROM con_cuentas WHERE padre_id = ?', [id]))[0][0].n)) throw invalida('La cuenta tiene subcuentas.', 409, { codigo: 'TIENE_HIJAS' });
  if ((await reglasQueUsan(id)).length) throw invalida('La cuenta la usan reglas de imputación.', 409, { codigo: 'CON_REGLAS' });
  await pool.query('DELETE FROM con_cuentas WHERE id = ?', [id]);
  return { eliminada: true };
};

// ---- Importar y exportar ----

const exportar = async () => (await listar()).map((c) => ({ codigo: c.codigo, nombre: c.nombre, tipo: c.tipo, padre: c.codigo.includes('.') ? c.codigo.slice(0, c.codigo.lastIndexOf('.')) : '', imputable: c.imputable ? 1 : 0, moneda: c.moneda, estado: c.estado, clave: c.clave ?? '' }));
const csv = async () => {
  const filas = await exportar();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return ['codigo,nombre,tipo,padre,imputable,moneda,estado,clave', ...filas.map((f) => [f.codigo, f.nombre, f.tipo, f.padre, f.imputable, f.moneda, f.estado, f.clave].map(esc).join(','))].join('\n');
};
// Reemplaza el plan de una instalación sin asientos: o entra todo o no entra nada, y se informan las filas con error (EX10).
const importar = async (filas) => {
  if (!Array.isArray(filas) || !filas.length) throw invalida('El plan está vacío.');
  const errores = [];
  const vistos = new Map();
  filas.forEach((f, i) => {
    const n = i + 1, codigo = String(f.codigo ?? '').trim();
    if (!/^[0-9A-Za-z][0-9A-Za-z.\-]{0,19}$/.test(codigo)) errores.push({ fila: n, motivo: 'Código inválido.' });
    else if (vistos.has(codigo)) errores.push({ fila: n, motivo: `Código duplicado (${codigo}).` });
    else vistos.set(codigo, f);
    if (!String(f.nombre ?? '').trim()) errores.push({ fila: n, motivo: 'Falta el nombre.' });
    if (!TIPOS.includes(f.tipo)) errores.push({ fila: n, motivo: `Tipo inválido (${f.tipo}).` });
  });
  filas.forEach((f, i) => {
    const padre = String(f.padre ?? '').trim();
    if (!padre) return;
    const p = vistos.get(padre);
    if (!p) errores.push({ fila: i + 1, motivo: `El padre ${padre} no existe.` });
    else if (Number(p.imputable) === 1 || p.imputable === true) errores.push({ fila: i + 1, motivo: `El padre ${padre} es imputable: no puede tener subcuentas.` });
    else if (p.tipo !== f.tipo) errores.push({ fila: i + 1, motivo: 'La cuenta y su padre son de distinto tipo.' });
  });
  if (errores.length) throw invalida(`El plan tiene ${errores.length} error(es): no se importa.`, 400, { codigo: 'PLAN_INVALIDO', errores });
  if (Number((await pool.query('SELECT COUNT(*) AS n FROM con_asiento_lineas'))[0][0].n)) throw invalida('Ya hay asientos: el plan no se reemplaza, se edita cuenta por cuenta.', 409, { codigo: 'CON_MOVIMIENTOS' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    await conn.query('DELETE FROM con_cuentas');
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    const ids = new Map();
    const orden = [...vistos.values()].sort((a, b) => String(a.codigo).localeCompare(String(b.codigo), 'en', { numeric: true }));
    for (const f of orden) {
      const padre = String(f.padre ?? '').trim();
      const [r] = await conn.query('INSERT INTO con_cuentas (codigo, nombre, tipo, padre_id, imputable, moneda, estado, clave) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [String(f.codigo).trim(), String(f.nombre).trim(), f.tipo, padre ? ids.get(padre) ?? null : null, Number(f.imputable) === 0 || f.imputable === false ? 0 : 1, String(f.moneda ?? 'ARS').toUpperCase(), f.estado === 'inactiva' ? 'inactiva' : 'activa', f.clave ? String(f.clave) : null]);
      ids.set(String(f.codigo).trim(), r.insertId);
    }
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return { importadas: filas.length };
};

module.exports = { listar, obtener, porClave, crear, editar, cambiarEstado, eliminar, exportar, csv, importar, conMovimientos, TIPOS };
