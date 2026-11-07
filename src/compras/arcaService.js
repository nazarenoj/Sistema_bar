const crypto = require('crypto');
const pool = require('../config/db');
const config = require('../config/afipConfig');
const llamar = require('../modulos/llamar');
const Funciones = require('../funciones/servicio');
const Notificacion = require('../models/notificacionModel');
const Constatacion = require('../services/constatacionService');
const { invalida, r2, hoy, iso } = require('./comun');

// Libro IVA Compras (Compras RF13) y controles contra ARCA (RF14, EX12). El libro sale de los comprobantes del período, en los dos archivos del Libro IVA Digital (comprobantes y alícuotas);
// los controles comparan lo registrado con «Mis Comprobantes» (archivo, sin conexión) y constatan el CAE de lo recibido por el servicio de Ventas (con conexión).
const CODIGOS = {
  FACTURA: { A: 1, B: 6, C: 11, M: 51 }, NOTA_DEBITO: { A: 2, B: 7, C: 12, M: 52 }, NOTA_CREDITO: { A: 3, B: 8, C: 13, M: 53 }, TICKET: { A: 81, B: 82, C: 83 }, RECIBO: { A: 4, B: 9, C: 15 },
};
const codigoArca = (clase, tipo) => CODIGOS[clase]?.[tipo] ?? null;
const ALICUOTA_ID = { 0: 3, 2.5: 9, 5: 8, 10.5: 4, 21: 5, 27: 6 };

const importe = (n, largo = 15) => String(Math.round(Math.abs(Number(n)) * 100)).padStart(largo, '0');
const entero = (n, largo) => String(Math.trunc(Number(n))).padStart(largo, '0');
const texto = (s, largo) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '').toUpperCase().slice(0, largo).padEnd(largo, ' ');
const periodoDe = (p) => {
  if (!/^\d{6}$/.test(String(p)) || Number(String(p).slice(4)) < 1 || Number(String(p).slice(4)) > 12) throw invalida('El período va como AAAAMM.');
  return `${String(p).slice(0, 4)}-${String(p).slice(4)}`;
};

// ---- Libro IVA Compras ----

const generarLibro = async (periodo) => {
  const iva = periodoDe(periodo);
  const [comps] = await pool.query(
    `SELECT c.*, p.cuit, p.razon_social FROM cmp_comprobantes c JOIN cmp_proveedores p ON p.id = c.proveedor_id
     WHERE c.periodo_iva = ? AND c.estado IN ('registrado', 'pendiente_recepcion', 'con_diferencias') ORDER BY c.fecha, c.id`, [iva]);
  const cbte = [], alic = [], excluidos = [], diferencias = [];
  let total = 0, creditoFiscal = 0, netoTotal = 0;
  for (const c of comps) {
    const codigo = codigoArca(c.clase, c.tipo);
    if (!codigo) { excluidos.push({ id: c.id, clase: c.clase, tipo: c.tipo, motivo: 'No es un comprobante que se informe en el Libro IVA.' }); continue; }
    const [as] = await pool.query('SELECT alicuota, neto, iva FROM cmp_comprobante_alicuotas WHERE comprobante_id = ? ORDER BY alicuota', [c.id]);
    const suma = r2(Number(c.neto_gravado) + Number(c.no_gravado) + Number(c.exento) + Number(c.iva) + Number(c.percepciones_iva) + Number(c.percepciones_iibb) + Number(c.impuestos_internos) + Number(c.otros_tributos));
    if (Math.abs(suma - Number(c.total)) > 0.01) diferencias.push({ id: c.id, total: Number(c.total), suma });
    const sign = c.clase === 'NOTA_CREDITO' ? -1 : 1;
    const pv = entero(c.punto_venta, 5), nro = entero(c.numero, 20);
    cbte.push([
      iso(c.fecha).replace(/-/g, ''), entero(codigo, 3), pv, nro, texto('', 16), '80', entero(c.cuit, 20), texto(c.razon_social, 30),
      importe(c.total), importe(c.no_gravado), importe(c.exento), importe(c.percepciones_iva), importe(0), importe(c.percepciones_iibb), importe(0), importe(c.impuestos_internos),
      texto(c.moneda === 'ARS' ? 'PES' : c.moneda === 'USD' ? 'DOL' : c.moneda, 3), String(Math.round(Number(c.cotizacion ?? 1) * 1000000)).padStart(10, '0'),
      String(as.length), as.length ? ' ' : Number(c.exento) > 0 ? 'E' : 'N', importe(c.iva_computable), importe(c.otros_tributos), entero(0, 11), texto('', 30), importe(0),
    ].join(''));
    for (const a of as) alic.push([entero(codigo, 3), pv, nro, '80', entero(c.cuit, 20), importe(a.neto), entero(ALICUOTA_ID[Number(a.alicuota)] ?? 5, 4), importe(a.iva)].join(''));
    total += sign * Number(c.total); creditoFiscal += sign * Number(c.iva_computable); netoTotal += sign * Number(c.neto_gravado);
  }
  return { periodo, periodo_iva: iva, cantidad: cbte.length, total: r2(total), neto_gravado: r2(netoTotal), credito_fiscal: r2(creditoFiscal), cuadra: diferencias.length === 0, diferencias, excluidos,
    comprobantes: cbte.join('\r\n') + (cbte.length ? '\r\n' : ''), alicuotas: alic.join('\r\n') + (alic.length ? '\r\n' : '') };
};

// ---- Mis Comprobantes ----

const normal = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9. ]/g, '').trim();
const numero = (v) => { let s = String(v ?? '').trim(); if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); return Number(s); };
const fechaMc = (v) => {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

const importarMisComprobantes = async ({ contenido, cuit_receptor: receptor, periodo } = {}, userId) => {
  if (!(await Funciones.estaActiva('CMP-CONTROL-ARCA'))) throw invalida('Los controles contra ARCA necesitan la función CMP-CONTROL-ARCA.', 409, { codigo: 'FUNCION_INACTIVA' });
  const miCuit = String(config.cuit ?? '').replace(/\D/g, '');
  if (receptor && miCuit && String(receptor).replace(/\D/g, '') !== miCuit) throw invalida('El archivo es de otro CUIT: no se importa.', 400, { codigo: 'ARCHIVO_INVALIDO' }); // EX12
  const lineas = String(contenido ?? '').replace(/^﻿/, '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (lineas.length < 2) throw invalida('El archivo está vacío o no es de «Mis Comprobantes».', 400, { codigo: 'ARCHIVO_INVALIDO' });
  const sep = lineas[0].split(';').length >= lineas[0].split(',').length ? ';' : ',';
  const cab = lineas[0].split(sep).map(normal);
  const col = (...nombres) => cab.findIndex((c) => nombres.some((n) => c.startsWith(n)));
  const ix = { fecha: col('fecha'), tipo: col('tipo de comprobante', 'tipo'), pv: col('punto de venta'), nro: col('numero desde', 'numero'), cuit: col('nro. doc. emisor', 'nro doc emisor', 'cuit'), total: col('imp. total', 'importe total', 'total'),
    cae: col('cod. autorizacion', 'cod autorizacion', 'cae'), den: col('denominacion emisor', 'denominacion'), moneda: col('moneda') };
  if ([ix.fecha, ix.tipo, ix.pv, ix.nro, ix.cuit, ix.total].some((i) => i < 0)) throw invalida('El archivo no tiene las columnas de «Mis Comprobantes».', 400, { codigo: 'ARCHIVO_INVALIDO' });
  const filas = [];
  for (const [i, l] of lineas.slice(1).entries()) {
    const c = l.split(sep).map((x) => x.trim().replace(/^"|"$/g, ''));
    const fecha = fechaMc(c[ix.fecha]), tipo = parseInt(c[ix.tipo], 10), cuit = String(c[ix.cuit] ?? '').replace(/\D/g, ''), total = numero(c[ix.total]);
    if (!fecha || !(tipo > 0) || cuit.length !== 11 || !Number.isFinite(total)) throw invalida(`La fila ${i + 2} no es válida: el archivo no es de «Mis Comprobantes».`, 400, { codigo: 'ARCHIVO_INVALIDO' });
    filas.push({ fecha, tipo, pv: String(parseInt(c[ix.pv], 10)).padStart(5, '0'), nro: String(parseInt(c[ix.nro], 10)).padStart(8, '0'), cuit, den: ix.den >= 0 ? c[ix.den] : null, cae: ix.cae >= 0 ? String(c[ix.cae]).replace(/\D/g, '') || null : null, moneda: ix.moneda >= 0 ? c[ix.moneda] : null, total });
  }
  const per = String(periodo ?? filas[0].fecha.slice(0, 7).replace('-', ''));
  periodoDe(per);
  const hash = crypto.createHash('sha256').update(JSON.stringify(filas)).digest('hex');
  const [[previa]] = await pool.query('SELECT id FROM cmp_mis_comprobantes_imp WHERE periodo = ? AND hash = ?', [per, hash]);
  if (previa) return { id: previa.id, periodo: per, cantidad: filas.length, repetida: true };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query('INSERT INTO cmp_mis_comprobantes_imp (periodo, hash, cantidad, user_id, ts_ms) VALUES (?, ?, ?, ?, ?)', [per, hash, filas.length, userId ?? null, Date.now()]);
    for (const f of filas) await conn.query('INSERT INTO cmp_mis_comprobantes (importacion_id, fecha, tipo_codigo, punto_venta, numero, cuit_emisor, denominacion, cae, moneda, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [r.insertId, f.fecha, f.tipo, f.pv, f.nro, f.cuit, f.den, f.cae, f.moneda, f.total]);
    await conn.commit();
    return { id: r.insertId, periodo: per, cantidad: filas.length, repetida: false };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

// Lo registrado contra lo que publica ARCA: faltantes (están en ARCA y no acá), sobrantes (están acá con CAE y no en ARCA) y diferencias de importe.
const comparar = async (periodo) => {
  periodoDe(periodo);
  const [[imp]] = await pool.query('SELECT * FROM cmp_mis_comprobantes_imp WHERE periodo = ? ORDER BY id DESC LIMIT 1', [periodo]);
  if (!imp) throw invalida('No hay un archivo de «Mis Comprobantes» importado para ese período.', 404, { codigo: 'SIN_IMPORTACION' });
  const [arca] = await pool.query('SELECT * FROM cmp_mis_comprobantes WHERE importacion_id = ?', [imp.id]);
  const [mios] = await pool.query(
    `SELECT c.*, p.cuit FROM cmp_comprobantes c JOIN cmp_proveedores p ON p.id = c.proveedor_id WHERE DATE_FORMAT(c.fecha, '%Y%m') = ? AND c.estado IN ('registrado', 'pendiente_recepcion', 'con_diferencias')`, [periodo]);
  const clave = (cuit, tipo, pv, nro) => `${cuit}|${tipo}|${Number(pv)}|${Number(nro)}`;
  const mapaMios = new Map();
  for (const c of mios) { const cod = codigoArca(c.clase, c.tipo); if (cod) mapaMios.set(clave(c.cuit, cod, c.punto_venta, c.numero), c); }
  const mapaArca = new Map(arca.map((a) => [clave(a.cuit_emisor, a.tipo_codigo, a.punto_venta, a.numero), a]));
  const faltantes = [], diferencias = [], sobrantes = [];
  for (const [k, a] of mapaArca) {
    const c = mapaMios.get(k);
    if (!c) faltantes.push({ cuit_emisor: a.cuit_emisor, denominacion: a.denominacion, tipo_codigo: a.tipo_codigo, punto_venta: a.punto_venta, numero: a.numero, fecha: iso(a.fecha), total: Number(a.total) });
    else if (Math.abs(Number(a.total) - Number(c.total)) > 0.01) diferencias.push({ comprobante_id: c.id, cuit_emisor: a.cuit_emisor, punto_venta: a.punto_venta, numero: a.numero, total_arca: Number(a.total), total_registrado: Number(c.total), diferencia: r2(Number(c.total) - Number(a.total)) });
  }
  for (const [k, c] of mapaMios) if (!mapaArca.has(k) && c.cae) sobrantes.push({ comprobante_id: c.id, cuit_emisor: c.cuit, punto_venta: c.punto_venta, numero: c.numero, fecha: iso(c.fecha), total: Number(c.total) });
  return { periodo, importacion_id: imp.id, en_arca: arca.length, registrados: mapaMios.size, faltantes, sobrantes, diferencias };
};

// ---- Constatación del CAE ----

const constatar = async (id, userId) => {
  if (!(await Funciones.estaActiva('CMP-CONTROL-ARCA'))) throw invalida('Los controles contra ARCA necesitan la función CMP-CONTROL-ARCA.', 409, { codigo: 'FUNCION_INACTIVA' });
  const [[c]] = await pool.query('SELECT c.*, p.cuit FROM cmp_comprobantes c JOIN cmp_proveedores p ON p.id = c.proveedor_id WHERE c.id = ?', [id]);
  if (!c) throw invalida('Comprobante no encontrado.', 404);
  if (c.estado === 'anulado' || c.estado === 'borrador') throw invalida(`Un comprobante ${c.estado} no se constata.`, 409);
  const registrar = (resultado, detalle) => pool.query('INSERT INTO cmp_constataciones (comprobante_id, resultado, detalle, user_id, ts_ms) VALUES (?, ?, ?, ?, ?)', [id, resultado, detalle ?? null, userId ?? null, Date.now()]);
  const r = await llamar(14, 'compras', () => Constatacion.constatar({ cuit_emisor: c.cuit, tipo_codigo: codigoArca(c.clase, c.tipo), punto_venta: c.punto_venta, numero: c.numero, fecha: iso(c.fecha), importe: Number(c.total), cae: c.cae })).catch((e) => ({ fallo: true, motivo: e.message }));
  if (r.fallo) { await registrar('sin_respuesta', r.motivo); return { id, constatacion: c.constatacion, pendiente: true, aviso: 'ARCA no respondió: el comprobante queda pendiente de constatar.' }; } // el comprobante se usa igual
  const valido = !!r.valor?.valido;
  await pool.query('UPDATE cmp_comprobantes SET constatacion = ? WHERE id = ?', [valido ? 'constatado' : 'cae_no_valido', id]);
  await registrar(valido ? 'valido' : 'no_valido', r.valor?.detalle);
  if (!valido) await Notificacion.crear({ modulo: 'compras', tipo: 'cae_no_valido', severidad: 'alta', roles: ['administrativo', 'gerente'], clave: `cmp-cae:${id}`, mensaje: `El comprobante ${c.punto_venta}-${c.numero} de ${c.cuit} no pasó la constatación en ARCA.` }).catch(() => {});
  return { id, constatacion: valido ? 'constatado' : 'cae_no_valido', pendiente: false, detalle: r.valor?.detalle ?? null };
};

// Reintenta los comprobantes con CAE que todavía no se constataron (con conexión de nuevo).
const constatarPendientes = async (userId, limite = 50) => {
  const [ids] = await pool.query("SELECT id FROM cmp_comprobantes WHERE constatacion = 'no_constatado' AND cae IS NOT NULL AND estado IN ('registrado', 'pendiente_recepcion', 'con_diferencias') ORDER BY id LIMIT ?", [limite]);
  const salida = { constatados: 0, no_validos: 0, pendientes: 0 };
  for (const { id } of ids) {
    const r = await constatar(id, userId);
    if (r.pendiente) { salida.pendientes++; break; } // sin conexión no tiene sentido seguir
    if (r.constatacion === 'constatado') salida.constatados++; else salida.no_validos++;
  }
  return salida;
};

const historial = async (id) => (await pool.query('SELECT resultado, detalle, ts_ms FROM cmp_constataciones WHERE comprobante_id = ? ORDER BY id DESC LIMIT 50', [id]))[0].map((x) => ({ ...x, ts_ms: Number(x.ts_ms) }));

module.exports = { codigoArca, generarLibro, importarMisComprobantes, comparar, constatar, constatarPendientes, historial, hoy };
