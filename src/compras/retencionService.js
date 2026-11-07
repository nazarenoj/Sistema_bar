const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const { invalida, r2, hoy, iso } = require('./comun');

// Retenciones practicadas (Compras RF09, RN11, EX08, CMP-RETENCIONES): regímenes con alícuota general, mínimo no sujeto y acumulación mensual; padrones de alícuotas por contribuyente;
// cálculo en cada orden de pago; certificados numerados en forma correlativa por régimen; y los archivos de exportación para los aplicativos de declaración.
const IMPUESTOS = ['IVA', 'GANANCIAS', 'IIBB', 'SUSS'];
const APLICA = ['mercaderia', 'servicios', 'ambos'];

const vistaRegimen = (r) => ({ id: r.id, codigo: r.codigo, nombre: r.nombre, impuesto: r.impuesto, jurisdiccion: r.jurisdiccion, alicuota_general: Number(r.alicuota_general), minimo_no_sujeto: Number(r.minimo_no_sujeto),
  acumulacion_mensual: !!r.acumulacion_mensual, usa_padron: !!r.usa_padron, aplica_a: r.aplica_a, ultimo_certificado: r.ultimo_certificado, activo: !!r.activo });
const regimenes = async () => (await pool.query('SELECT * FROM cmp_regimenes_retencion ORDER BY impuesto, codigo'))[0].map(vistaRegimen);
const regimenFila = async (id) => {
  const [[r]] = await pool.query('SELECT * FROM cmp_regimenes_retencion WHERE id = ?', [id]);
  if (!r) throw invalida('Régimen no encontrado.', 404);
  return r;
};

const validar = (d, actual = {}) => {
  const codigo = String(d.codigo ?? actual.codigo ?? '').trim();
  if (!/^[A-Za-z0-9._-]{2,30}$/.test(codigo)) throw invalida('El código del régimen tiene de 2 a 30 caracteres (letras, números, punto, guion).');
  const nombre = String(d.nombre ?? actual.nombre ?? '').trim();
  if (!nombre || nombre.length > 100) throw invalida('Indicá el nombre del régimen (hasta 100 caracteres).');
  const impuesto = d.impuesto ?? actual.impuesto;
  if (!IMPUESTOS.includes(impuesto)) throw invalida(`El impuesto es uno de: ${IMPUESTOS.join(', ')}.`);
  if (impuesto === 'IIBB' && !String(d.jurisdiccion ?? actual.jurisdiccion ?? '').trim()) throw invalida('Un régimen de Ingresos Brutos lleva su jurisdicción.');
  const alic = d.alicuota_general !== undefined ? Number(d.alicuota_general) : Number(actual.alicuota_general);
  if (!(alic >= 0 && alic <= 100)) throw invalida('La alícuota es un porcentaje entre 0 y 100.');
  const minimo = d.minimo_no_sujeto !== undefined ? Number(d.minimo_no_sujeto) : Number(actual.minimo_no_sujeto ?? 0);
  if (!(minimo >= 0)) throw invalida('El mínimo no sujeto no puede ser negativo.');
  const aplica = d.aplica_a ?? actual.aplica_a ?? 'ambos';
  if (!APLICA.includes(aplica)) throw invalida(`Aplica a: ${APLICA.join(', ')}.`);
  const flag = (k) => (d[k] !== undefined ? (d[k] ? 1 : 0) : actual[k] ? 1 : 0);
  return { codigo, nombre, impuesto, jurisdiccion: d.jurisdiccion !== undefined ? d.jurisdiccion || null : actual.jurisdiccion ?? null, alic, minimo, aplica, acumulacion: flag('acumulacion_mensual'), padron: flag('usa_padron'), activo: d.activo !== undefined ? (d.activo ? 1 : 0) : actual.activo ?? 1 };
};
const exigir = async () => { if (!(await Funciones.estaActiva('CMP-RETENCIONES'))) throw invalida('Las retenciones necesitan la función CMP-RETENCIONES.', 409, { codigo: 'FUNCION_INACTIVA' }); };
const crearRegimen = async (d) => {
  await exigir();
  const v = validar(d);
  try {
    const [r] = await pool.query('INSERT INTO cmp_regimenes_retencion (codigo, nombre, impuesto, jurisdiccion, alicuota_general, minimo_no_sujeto, acumulacion_mensual, usa_padron, aplica_a) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [v.codigo, v.nombre, v.impuesto, v.jurisdiccion, v.alic, v.minimo, v.acumulacion, v.padron, v.aplica]);
    return vistaRegimen(await regimenFila(r.insertId));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida(`Ya existe el régimen "${v.codigo}".`, 409);
    throw err;
  }
};
const actualizarRegimen = async (id, d) => {
  await exigir();
  const a = await regimenFila(id);
  const v = validar(d, a);
  await pool.query('UPDATE cmp_regimenes_retencion SET nombre = ?, jurisdiccion = ?, alicuota_general = ?, minimo_no_sujeto = ?, acumulacion_mensual = ?, usa_padron = ?, aplica_a = ?, activo = ? WHERE id = ?', [v.nombre, v.jurisdiccion, v.alic, v.minimo, v.acumulacion, v.padron, v.aplica, v.activo, id]);
  return vistaRegimen(await regimenFila(id));
};

// Padrón de alícuotas por contribuyente: «cuit;alicuota;AAAA-MM-DD» por línea (vigente hasta). Completo o no se aplica.
const importarPadron = async (regimenId, texto) => {
  await exigir();
  await regimenFila(regimenId);
  const filas = String(texto ?? '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => {
    const [cuit, alicuota, hasta] = l.split(/[;,]/).map((x) => x.trim());
    if (!/^\d{11}$/.test(cuit ?? '') || !(Number(alicuota) >= 0 && Number(alicuota) <= 100) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta ?? '')) throw invalida(`Línea ${i + 1} inválida: se espera cuit;alicuota;AAAA-MM-DD.`, 400, { codigo: 'PADRON_INVALIDO', detalle: { linea: i + 1 } });
    return [regimenId, cuit, Number(alicuota), hasta];
  });
  if (!filas.length) throw invalida('El padrón está vacío.', 400, { codigo: 'PADRON_INVALIDO' });
  await pool.query('INSERT INTO cmp_padron_retencion (regimen_id, cuit, alicuota, vigente_hasta) VALUES ? ON DUPLICATE KEY UPDATE alicuota = VALUES(alicuota), vigente_hasta = VALUES(vigente_hasta)', [filas]);
  return { importados: filas.length };
};

// ---- Cálculo (RN11) ----

// Las retenciones de un pago: por cada régimen activo que aplica al tipo de proveedor, sobre la base neta del pago, con el mínimo no sujeto y, si el régimen acumula por mes, sobre lo
// pagado en el mes (menos lo ya retenido). Con el padrón vencido o sin importar para ese CUIT se usa la alícuota general y se advierte (EX08).
const calcular = async (prov, base, fecha = hoy(), { db = pool, excluirOrden = null } = {}) => {
  const out = [];
  if (!(base > 0)) return out;
  const regs = (await db.query("SELECT * FROM cmp_regimenes_retencion WHERE activo = 1 AND aplica_a IN (?, 'ambos')", [prov.tipo === 'servicios' ? 'servicios' : prov.tipo === 'ambos' ? 'ambos' : 'mercaderia']))[0];
  if (/exento|no retener/i.test(prov.retenciones ?? '')) return out; // el proveedor está excluido de la retención
  for (const r of regs) {
    let alicuota = Number(r.alicuota_general), aviso = null;
    if (r.usa_padron) {
      const [[p]] = await db.query('SELECT alicuota, vigente_hasta FROM cmp_padron_retencion WHERE regimen_id = ? AND cuit = ?', [r.id, prov.cuit]);
      if (p && iso(p.vigente_hasta) >= fecha) alicuota = Number(p.alicuota);
      else aviso = p ? `El padrón de ${r.codigo} está vencido para este proveedor (${iso(p.vigente_hasta)}): se usa la alícuota general.` : `El padrón de ${r.codigo} no tiene a este proveedor: se usa la alícuota general.`;
    }
    let baseSujeta = base, previo = 0;
    if (r.acumulacion_mensual) {
      const mes = fecha.slice(0, 7);
      const [[a]] = await db.query(
        `SELECT COALESCE(SUM(o.deuda_aplicada - o.notas_credito - o.anticipos), 0) AS base, COALESCE(SUM(x.importe), 0) AS retenido FROM cmp_ordenes_pago o JOIN cmp_op_retenciones x ON x.orden_id = o.id AND x.regimen_id = ? AND x.anulado = 0
         WHERE o.proveedor_id = ? AND o.estado <> 'anulada' AND DATE_FORMAT(o.fecha, '%Y-%m') = ? AND o.id <> ?`, [r.id, prov.id, mes, excluirOrden ?? 0]);
      baseSujeta = base + Number(a.base); previo = Number(a.retenido);
    }
    const sujeta = Math.max(baseSujeta - Number(r.minimo_no_sujeto), 0);
    const importe = Math.max(r2(sujeta * alicuota / 100) - previo, 0);
    if (importe > 0) out.push({ regimen_id: r.id, codigo: r.codigo, nombre: r.nombre, base: r2(base), alicuota, calculado: r2(importe), aviso });
  }
  return out;
};

// Emite los certificados de una orden (número correlativo por régimen), dentro de su transacción.
const emitir = async (conn, ordenId, retenciones, fecha) => {
  for (const x of retenciones) {
    const [[r]] = await conn.query('SELECT ultimo_certificado FROM cmp_regimenes_retencion WHERE id = ? FOR UPDATE', [x.regimen_id]);
    const cert = r.ultimo_certificado + 1;
    await conn.query('UPDATE cmp_regimenes_retencion SET ultimo_certificado = ? WHERE id = ?', [cert, x.regimen_id]);
    await conn.query('INSERT INTO cmp_op_retenciones (orden_id, regimen_id, base, alicuota, importe, calculado, certificado, aviso, fecha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [ordenId, x.regimen_id, x.base, x.alicuota, x.importe, x.calculado, cert, x.aviso ?? null, fecha]);
  }
};

const activa = () => Funciones.estaActiva('CMP-RETENCIONES');

// Certificados y archivos de exportación (RF09, RF16): un renglón por retención del período para el aplicativo del régimen.
const certificados = async ({ regimenId, desde, hasta, proveedorId } = {}) => {
  const w = ['x.anulado = 0'], p = [];
  if (regimenId) { w.push('x.regimen_id = ?'); p.push(Number(regimenId)); }
  if (desde) { w.push('x.fecha >= ?'); p.push(desde); }
  if (hasta) { w.push('x.fecha <= ?'); p.push(hasta); }
  if (proveedorId) { w.push('o.proveedor_id = ?'); p.push(Number(proveedorId)); }
  const [filas] = await pool.query(
    `SELECT x.*, r.codigo, r.nombre AS regimen, r.impuesto, o.numero AS orden, pr.cuit, pr.razon_social FROM cmp_op_retenciones x JOIN cmp_regimenes_retencion r ON r.id = x.regimen_id JOIN cmp_ordenes_pago o ON o.id = x.orden_id
     JOIN cmp_proveedores pr ON pr.id = o.proveedor_id WHERE ${w.join(' AND ')} ORDER BY x.regimen_id, x.certificado LIMIT 5000`, p);
  return filas.map((x) => ({ regimen: x.codigo, impuesto: x.impuesto, certificado: x.certificado, fecha: iso(x.fecha), orden_pago: x.orden, cuit: x.cuit, proveedor: x.razon_social, base: Number(x.base), alicuota: Number(x.alicuota), importe: Number(x.importe) }));
};
const exportar = async (q) => {
  const filas = await certificados(q);
  const csv = ['regimen;certificado;fecha;cuit;proveedor;base;alicuota;importe', ...filas.map((f) => [f.regimen, f.certificado, f.fecha, f.cuit, `"${f.proveedor.replace(/"/g, '""')}"`, f.base.toFixed(2), f.alicuota.toFixed(3), f.importe.toFixed(2)].join(';'))].join('\n');
  return { filas: filas.length, csv };
};

module.exports = { regimenes, crearRegimen, actualizarRegimen, importarPadron, calcular, emitir, activa, certificados, exportar };
