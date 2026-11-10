const pool = require('../config/db');
const Modulos = require('../modulos/registro');
const Funciones = require('../funciones/servicio');
const Equivalencias = require('../servicios/equivalenciaTerceroService');
const Presentacion = require('../models/presentacionModel');
const Proveedores = require('./proveedorService');
const Costos = require('./costoService');
const { invalida, r2, r4, hoy, iso } = require('./comun');

// Listas de precios de proveedor (Compras RF10, RN15, EX09, CMP-LISTAS-PROVEEDOR): se importan (CSV) o se cargan a mano, con moneda, vigencia y bonificaciones. Los códigos del proveedor se
// relacionan con los ítems por el servicio de Equivalencias; una línea puede expresarse por unidad de compra (una presentación de Stock, de la que se guarda solo el factor aplicado).
// La importación es completa o no se aplica (RN15): las filas con error se informan y la lista se rechaza. Antes de confirmar hay una vista previa de los cambios de costo.
const exigir = async () => { if (!(await Funciones.estaActiva('CMP-LISTAS-PROVEEDOR'))) throw invalida('Las listas de proveedor necesitan la función CMP-LISTAS-PROVEEDOR.', 409, { codigo: 'FUNCION_INACTIVA' }); };

const numero = (v) => {
  let s = String(v ?? '').trim().replace(/[$\s]/g, '');
  if (!s) return NaN;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  return Number(s);
};
const filasCsv = (texto) => {
  const lineas = String(texto ?? '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (lineas.length < 2) throw invalida('La lista está vacía o no tiene encabezado.', 400, { codigo: 'LISTA_INVALIDA' });
  const sep = lineas[0].split(';').length > lineas[0].split(',').length ? ';' : ',';
  const cab = lineas[0].split(sep).map((c) => c.trim().toLowerCase());
  return lineas.slice(1).map((l, i) => { const c = l.split(sep).map((x) => x.trim()); return { fila: i + 2, ...Object.fromEntries(cab.map((k, j) => [k, c[j] ?? ''])) }; });
};

// Resuelve cada fila a un ítem, una presentación y un costo por unidad base. Devuelve las líneas y los errores (con la fila).
// Planilla de Excel (primera hoja, con encabezados en la primera fila): las mismas columnas que el CSV (codigo, descripcion, precio, bonificacion, ...).
const filasXlsx = async (base64) => {
  const ExcelJS = require('exceljs');
  const libro = new ExcelJS.Workbook();
  try { await libro.xlsx.load(Buffer.from(String(base64), 'base64')); } catch { throw invalida('El archivo no es una planilla de Excel válida.', 400, { codigo: 'LISTA_INVALIDA' }); }
  const hoja = libro.worksheets[0];
  if (!hoja || hoja.rowCount < 2) return [];
  const texto = (c) => { const v = c?.value; return v === null || v === undefined ? '' : typeof v === 'object' ? String(v.result ?? v.text ?? '') : String(v); };
  const cab = hoja.getRow(1).values.slice(1).map((c) => texto({ value: c }).trim().toLowerCase());
  const filas = [];
  hoja.eachRow((row, n) => { if (n === 1) return; const v = row.values.slice(1); if (v.every((x) => x === null || x === undefined || x === '')) return; filas.push({ fila: n, ...Object.fromEntries(cab.map((k, j) => [k, texto({ value: v[j] }).trim()])) }); });
  return filas;
};

const resolver = async (prov, filas, aviso) => {
  const lineas = [], errores = [];
  const stock = await Modulos.estaInstalado('stock');
  const conPresentaciones = stock && (await Funciones.estaActiva('CMP-UNIDADES-COMPRA'));
  for (const f of filas) {
    const falla = (motivo) => errores.push({ fila: f.fila, codigo: f.codigo ?? f.descripcion ?? null, motivo });
    const precio = numero(f.precio), bonif = f.bonificacion === undefined || f.bonificacion === '' ? 0 : numero(f.bonificacion);
    if (!(precio > 0)) { falla('El precio debe ser un número mayor a cero.'); continue; }
    if (!(bonif >= 0 && bonif <= 100)) { falla('La bonificación es un porcentaje entre 0 y 100.'); continue; }
    let item = f.item_tipo && f.item_id ? { tipo: f.item_tipo, id: Number(f.item_id) } : null, presentacionId = f.presentacion_id ? Number(f.presentacion_id) : null;
    if (!item) {
      const e = await Equivalencias.resolver({ cuit: prov.cuit, descripcion: f.codigo || f.descripcion }).catch(() => null);
      if (!e || e.tipo_destino !== 'item_stock') { falla('Sin equivalencia: el código del proveedor no está asociado a un ítem.'); continue; } // RN15
      if (e.estado === 'revisar') { falla(e.motivo ?? 'La equivalencia está para revisar.'); continue; }
      item = { tipo: 'insumo', id: e.id_destino };
      presentacionId = presentacionId ?? e.presentacion_id ?? null;
    }
    let factor = 1, unidad = f.unidad || null;
    if (presentacionId) {
      if (!conPresentaciones) { falla('Sin Stock no hay unidades de compra: la unidad es texto.'); continue; }
      const p = await Presentacion.getById(presentacionId);
      if (!p || p.insumo_id !== item.id || !String(p.usos).split(',').includes('compra') || (p.vigente_hasta && new Date(p.vigente_hasta) <= new Date())) { falla('Sin equivalencia: la presentación no existe, no es de compra o no está vigente.'); continue; }
      factor = Number(p.factor); unidad = p.nombre;
    }
    lineas.push({ codigo: f.codigo || null, descripcion: f.descripcion || null, item, presentacion_id: presentacionId, factor, unidad, precio: r4(precio), bonificacion_pct: bonif, costo_unidad_base: r4(precio * (1 - bonif / 100) / factor) });
  }
  void aviso;
  return { lineas, errores };
};

const datos = async (d) => {
  await exigir();
  const prov = await Proveedores.obtener(Number(d.proveedor_id));
  if (prov.estado !== 'activo') throw invalida('El proveedor está desactivado.', 409);
  const moneda = String(d.moneda ?? prov.moneda).toUpperCase();
  const desde = d.vigente_desde ?? hoy();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(desde))) throw invalida('La vigencia va como AAAA-MM-DD.');
  const filas = d.xlsx_base64 !== undefined ? await filasXlsx(d.xlsx_base64) : d.contenido !== undefined ? filasCsv(d.contenido) : (d.filas ?? []).map((f, i) => ({ fila: i + 1, ...f }));
  if (!filas.length) throw invalida('La lista no tiene líneas.', 400, { codigo: 'LISTA_INVALIDA' });
  const r = await resolver(prov, filas);
  return { prov, moneda, desde, nombre: String(d.nombre ?? `Lista ${desde}`).slice(0, 80), ...r };
};

// Vista previa de los cambios de costo, sin guardar nada.
const vistaPrevia = async (d) => {
  const x = await datos(d);
  if (x.errores.length) throw invalida(`La lista tiene ${x.errores.length} fila(s) con error: no se aplica.`, 400, { codigo: 'LISTA_INVALIDA', detalle: { errores: x.errores } }); // EX09
  const cfg = await Proveedores.config();
  const cambios = [];
  for (const l of x.lineas) {
    const c = await Costos.actual(l.item);
    const variacion = c && c.moneda === x.moneda && Number(c.costo) ? r2((l.costo_unidad_base - Number(c.costo)) / Number(c.costo) * 100) : null;
    cambios.push({ codigo: l.codigo, item: l.item, unidad: l.unidad, precio: l.precio, costo_unidad_base: l.costo_unidad_base, costo_actual: c ? Number(c.costo) : null, variacion_pct: variacion, pide_confirmacion: variacion !== null && Math.abs(variacion) > cfg.variacion_costo_pct });
  }
  return { proveedor_id: x.prov.id, moneda: x.moneda, lineas: cambios.length, cambios };
};

const guardar = async (d, userId) => {
  const x = await datos(d);
  if (x.errores.length) throw invalida(`La lista tiene ${x.errores.length} fila(s) con error: no se aplica.`, 400, { codigo: 'LISTA_INVALIDA', detalle: { errores: x.errores } });
  const conn = await pool.getConnection();
  const resumen = { aplicados: 0, pendientes: 0, sin_cambio: 0 };
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE cmp_listas_proveedor SET estado = 'historica', vigente_hasta = ? WHERE proveedor_id = ? AND estado = 'vigente'", [x.desde, x.prov.id]);
    const [r] = await conn.query('INSERT INTO cmp_listas_proveedor (proveedor_id, nombre, moneda, vigente_desde, origen, user_id, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?)', [x.prov.id, x.nombre, x.moneda, x.desde, d.contenido !== undefined ? 'importada' : 'manual', userId ?? null, Date.now()]);
    for (const l of x.lineas) {
      await conn.query('INSERT INTO cmp_lista_lineas (lista_id, codigo_proveedor, item_tipo, item_id, descripcion, presentacion_id, factor_aplicado, unidad, precio, bonificacion_pct, costo_unidad_base) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [r.insertId, l.codigo, l.item.tipo, l.item.id, l.descripcion, l.presentacion_id, l.presentacion_id ? l.factor : null, l.unidad, l.precio, l.bonificacion_pct, l.costo_unidad_base]);
      const a = await Costos.proponer(conn, l.item, { costo: l.costo_unidad_base, moneda: x.moneda, fuente: 'lista', ref: `LP-${r.insertId}`, proveedorId: x.prov.id });
      if (a.accion === 'aplicado') resumen.aplicados++; else if (a.accion === 'pendiente') resumen.pendientes++; else resumen.sin_cambio++;
    }
    await conn.commit();
    require('../mensajeria/servicio').despertar();
    return { ...(await obtener(r.insertId)), resumen };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const obtener = async (id) => {
  const [[l]] = await pool.query('SELECT l.*, p.razon_social AS proveedor FROM cmp_listas_proveedor l JOIN cmp_proveedores p ON p.id = l.proveedor_id WHERE l.id = ?', [id]);
  if (!l) throw invalida('Lista no encontrada.', 404);
  const [lin] = await pool.query('SELECT codigo_proveedor, item_tipo, item_id, descripcion, presentacion_id, factor_aplicado, unidad, precio, bonificacion_pct, costo_unidad_base FROM cmp_lista_lineas WHERE lista_id = ? ORDER BY id', [id]);
  return { id: l.id, proveedor_id: l.proveedor_id, proveedor: l.proveedor, nombre: l.nombre, moneda: l.moneda, vigente_desde: iso(l.vigente_desde), vigente_hasta: iso(l.vigente_hasta), estado: l.estado, origen: l.origen,
    lineas: lin.map((x) => ({ ...x, factor_aplicado: x.factor_aplicado === null ? null : Number(x.factor_aplicado), precio: Number(x.precio), bonificacion_pct: Number(x.bonificacion_pct), costo_unidad_base: Number(x.costo_unidad_base) })) };
};
const listar = async ({ proveedorId, estado } = {}) => {
  const w = [], p = [];
  if (proveedorId) { w.push('l.proveedor_id = ?'); p.push(Number(proveedorId)); }
  if (estado) { w.push('l.estado = ?'); p.push(estado); }
  return (await pool.query(`SELECT l.id, l.proveedor_id, pr.razon_social AS proveedor, l.nombre, l.moneda, l.vigente_desde, l.vigente_hasta, l.estado, l.origen, (SELECT COUNT(*) FROM cmp_lista_lineas x WHERE x.lista_id = l.id) AS lineas
    FROM cmp_listas_proveedor l JOIN cmp_proveedores pr ON pr.id = l.proveedor_id ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY l.id DESC LIMIT 200`, p))[0]
    .map((l) => ({ ...l, vigente_desde: iso(l.vigente_desde), vigente_hasta: iso(l.vigente_hasta), lineas: Number(l.lineas) }));
};

module.exports = { vistaPrevia, guardar, obtener, listar };
