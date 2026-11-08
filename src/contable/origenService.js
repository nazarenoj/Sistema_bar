const pool = require('../config/db');
const { consultar } = require('./consultaService');
const { invalida } = require('./comun');

// Navegación al documento de origen (Contable RF07, RF13): desde un asiento, el documento del módulo que lo generó. Si el módulo no responde, el origen se muestra «no disponible» y el asiento
// sigue consultable. Un asiento resumido lista todos sus documentos.
const MODULOS_DE_ORIGEN = new Set(['ventas', 'compras', 'financiero', 'stock', 'clientes']);

const deAsiento = async (asientoId) => {
  const [[a]] = await pool.query('SELECT id, numero, tipo FROM con_asientos WHERE id = ?', [asientoId]);
  if (!a) throw invalida('Asiento no encontrado.', 404);
  const [origenes] = await pool.query('SELECT modulo, tipo_documento, id_documento, relacionado, importe FROM con_asiento_origen WHERE asiento_id = ? ORDER BY id LIMIT 200', [asientoId]);
  const documentos = [];
  for (const o of origenes) {
    const base = { modulo: o.modulo, tipo_documento: o.tipo_documento, id_documento: o.id_documento, relacionado: o.relacionado, importe: o.importe === null ? null : Number(o.importe) };
    if (!MODULOS_DE_ORIGEN.has(o.modulo)) { documentos.push({ ...base, disponible: false, motivo: 'Origen sin consulta.' }); continue; }
    const r = await consultar(o.modulo, 'documento', { tipo: o.tipo_documento, id: o.id_documento });
    documentos.push(r.disponible ? { ...base, disponible: true, documento: r.valor } : { ...base, disponible: false, motivo: r.motivo });
  }
  return { asiento: { id: a.id, numero: a.numero, tipo: a.tipo }, manual: !origenes.length, documentos };
};

module.exports = { deAsiento };
