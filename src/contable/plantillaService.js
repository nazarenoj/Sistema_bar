const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const Libros = require('./libroService');
const { invalida, iso } = require('./comun');

// Exportación al estudio contable (Contable RF12, EX07) [CON-EXPORT-PLANTILLAS]: el diario en el formato de otro sistema, con el orden de columnas, el separador y la equivalencia de códigos de
// cuenta que defina la plantilla. Si alguna cuenta del diario no tiene equivalencia no se genera nada: se listan las que faltan.
const COLUMNAS = ['fecha', 'numero', 'cuenta', 'nombre_cuenta', 'debe', 'haber', 'leyenda', 'detalle', 'tipo'];
const SEPARADORES = [',', ';', '\t', '|'];

const exigirFuncion = async () => {
  if (!(await Funciones.estaActiva('CON-EXPORT-PLANTILLAS'))) throw invalida('La función CON-EXPORT-PLANTILLAS está desactivada.', 409, { codigo: 'FUNCION_DESACTIVADA' });
};

const vista = (p) => ({ id: p.id, nombre: p.nombre, separador: p.separador, decimal: p.decimal_sep, formato_fecha: p.formato_fecha, encabezado: !!p.encabezado, columnas: JSON.parse(p.columnas), equivalencias: JSON.parse(p.equivalencias), activa: !!p.activa });

const validar = (d) => {
  const nombre = String(d.nombre ?? '').trim();
  if (!nombre || nombre.length > 80) throw invalida('Falta el nombre de la plantilla.');
  const separador = d.separador ?? ';';
  if (!SEPARADORES.includes(separador)) throw invalida(`El separador es uno de: ${SEPARADORES.map((s) => (s === '\t' ? 'tab' : s)).join(' ')}.`);
  const decimal = d.decimal ?? ',';
  if (![',', '.'].includes(decimal) || decimal === separador) throw invalida('El separador decimal es «,» o «.» y distinto del de columnas.');
  const formato = d.formato_fecha ?? 'dmy';
  if (!['dmy', 'iso'].includes(formato)) throw invalida('El formato de fecha es dmy o iso.');
  const columnas = d.columnas;
  if (!Array.isArray(columnas) || !columnas.length || columnas.some((c) => !COLUMNAS.includes(c))) throw invalida(`Las columnas son una lista de: ${COLUMNAS.join(', ')}.`, 400, { codigo: 'PLANTILLA_INVALIDA' });
  const equiv = d.equivalencias ?? {};
  if (typeof equiv !== 'object' || Array.isArray(equiv) || Object.values(equiv).some((v) => !String(v).trim())) throw invalida('Las equivalencias son un objeto código → código externo.', 400, { codigo: 'PLANTILLA_INVALIDA' });
  return { nombre, separador, decimal, formato, encabezado: d.encabezado === false ? 0 : 1, columnas: JSON.stringify(columnas), equivalencias: JSON.stringify(equiv) };
};

const listar = async () => { await exigirFuncion(); return (await pool.query('SELECT * FROM con_plantillas ORDER BY nombre'))[0].map(vista); };
const obtener = async (id) => {
  const [[p]] = await pool.query('SELECT * FROM con_plantillas WHERE id = ?', [id]);
  if (!p) throw invalida('Plantilla no encontrada.', 404);
  return p;
};
const crear = async (d) => {
  await exigirFuncion();
  const v = validar(d);
  try {
    const [r] = await pool.query('INSERT INTO con_plantillas (nombre, separador, decimal_sep, formato_fecha, encabezado, columnas, equivalencias) VALUES (?, ?, ?, ?, ?, ?, ?)', [v.nombre, v.separador, v.decimal, v.formato, v.encabezado, v.columnas, v.equivalencias]);
    return vista(await obtener(r.insertId));
  } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw invalida('Ya hay una plantilla con ese nombre.', 409, { codigo: 'NOMBRE_DUPLICADO' }); throw err; }
};
const editar = async (id, d) => {
  await exigirFuncion(); await obtener(id);
  const v = validar(d);
  await pool.query('UPDATE con_plantillas SET nombre = ?, separador = ?, decimal_sep = ?, formato_fecha = ?, encabezado = ?, columnas = ?, equivalencias = ?, activa = ? WHERE id = ?', [v.nombre, v.separador, v.decimal, v.formato, v.encabezado, v.columnas, v.equivalencias, d.activa === false ? 0 : 1, id]);
  return vista(await obtener(id));
};
const eliminar = async (id) => { await exigirFuncion(); await obtener(id); await pool.query('DELETE FROM con_plantillas WHERE id = ?', [id]); return { eliminada: true }; };

const celda = (valor, sep) => {
  const t = String(valor ?? '');
  return t.includes(sep) || t.includes('"') || t.includes('\n') ? `"${t.replace(/"/g, '""')}"` : t;
};

// Genera el diario del rango en el formato de la plantilla. EX07: si faltan equivalencias, no hay archivo parcial.
const exportarDiario = async (plantillaId, rango) => {
  await exigirFuncion();
  const p = vista(await obtener(plantillaId));
  if (!p.activa) throw invalida('La plantilla está inactiva.', 409, { codigo: 'PLANTILLA_INACTIVA' });
  const d = await Libros.diario(rango);
  const usadas = new Map();
  for (const a of d.asientos) for (const l of a.lineas) usadas.set(l.codigo, l.nombre);
  const sinEquivalencia = [...usadas].filter(([codigo]) => !p.equivalencias[codigo]).map(([codigo, nombre]) => ({ codigo, nombre }));
  if (sinEquivalencia.length) throw invalida(`${sinEquivalencia.length} cuenta(s) sin equivalencia en la plantilla: no se genera el archivo.`, 409, { codigo: 'SIN_EQUIVALENCIA', cuentas: sinEquivalencia });
  const num = (x) => x.toFixed(2).replace('.', p.decimal);
  const fecha = (f) => (p.formato_fecha === 'iso' ? f : `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`);
  const valor = { fecha: (a) => fecha(a.fecha), numero: (a) => a.numero, cuenta: (a, l) => p.equivalencias[l.codigo], nombre_cuenta: (a, l) => l.nombre, debe: (a, l) => num(l.debe), haber: (a, l) => num(l.haber), leyenda: (a) => a.leyenda, detalle: (a, l) => l.detalle, tipo: (a) => a.tipo };
  const filas = [];
  if (p.encabezado) filas.push(p.columnas.join(p.separador));
  for (const a of d.asientos) for (const l of a.lineas) filas.push(p.columnas.map((c) => celda(valor[c](a, l), p.separador)).join(p.separador));
  return { texto: `${filas.join('\r\n')}\r\n`, nombre: `diario-${p.nombre.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${iso(d.desde)}.csv`, lineas: filas.length - (p.encabezado ? 1 : 0), total_debe: d.total_debe, total_haber: d.total_haber };
};

module.exports = { listar, crear, editar, eliminar, exportarDiario, COLUMNAS };
