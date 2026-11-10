const M = require('../mensajeria/servicio');
const afipConfig = require('../config/afipConfig');
const { idGlobal } = require('../utils/idGlobal');
const Proveedores = require('./proveedorService');
const Comprobantes = require('./comprobanteService');
const { r2 } = require('./comun');

// Compras como receptor del «Gasto con comprobante fiscal» que publica Financiero (Compras RF03, Financiero RF10, RN13): el gasto ya se pagó y Contable lo imputa por su cuenta, así que acá solo se
// incorpora el comprobante al Libro IVA Compras (con su IVA computable según RN04), sin deuda ni vencimientos. Idempotente por el ID del gasto. Si el CUIT del emisor no es un proveedor dado de alta,
// el mensaje queda Rechazado en la bandeja de pendientes de integración hasta que se lo da de alta y se reintenta.
const ALICUOTAS = [27, 21, 10.5, 5, 2.5, 0];

M.registrarReceptor('compras', 'gasto_con_comprobante_fiscal', async (conn, c, ctx) => {
  const [[previo]] = await conn.query('SELECT id FROM cmp_comprobantes WHERE id_solicitud = ?', [`gasto:${c.gasto_id_global}`]);
  if (previo) return { comprobante_id: previo.id, ya_procesado: true };
  const comp = c.comprobante ?? {};
  const cuit = String(comp.cuit ?? '').replace(/\D/g, '');
  const prov = await Proveedores.porCuit(cuit, conn);
  if (!prov) throw new M.RechazoNegocio(`El CUIT ${cuit || 'del emisor'} no está dado de alta como proveedor: el gasto no entra al Libro IVA hasta darlo de alta.`);
  const neto = r2(Number(c.neto ?? comp.neto ?? 0)), iva = r2(Number(c.iva ?? comp.iva ?? 0)), total = r2(Number(c.importe));
  const letra = String(comp.tipo ?? 'C').toUpperCase();
  const ri = afipConfig.condicionIvaEmisor === 'responsable_inscripto';
  const ivaComputable = ri && ['A', 'M'].includes(letra) ? iva : 0;
  const per = await Comprobantes.periodoImputable(c.fecha, conn);
  const idG = await idGlobal();
  const [r] = await conn.query(
    `INSERT INTO cmp_comprobantes (id_global, proveedor_id, clase, tipo, punto_venta, numero, fecha, cae, moneda, neto_gravado, no_gravado, iva, iva_computable, total, estado, origen, periodo_iva, clave, id_solicitud, observacion, ts_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ARS', ?, ?, ?, ?, ?, 'registrado', 'financiero', ?, ?, ?, ?, ?)`,
    [idG, prov.id, String(comp.clase ?? 'FACTURA').toUpperCase(), letra, String(comp.punto_venta ?? '').replace(/\D/g, '').padStart(5, '0'), String(comp.numero ?? '').replace(/\D/g, '').padStart(8, '0'), c.fecha,
      comp.cae ? String(comp.cae).replace(/\D/g, '') : null, neto, r2(Math.max(total - neto - iva, 0)), iva, ivaComputable, total, per.periodo, c.clave ?? null, `gasto:${c.gasto_id_global}`, 'Gasto de Financiero', Date.now()]);
  if (iva > 0 && neto > 0) {
    const ratio = (iva / neto) * 100;
    const alicuota = ALICUOTAS.reduce((mejor, a) => (Math.abs(a - ratio) < Math.abs(mejor - ratio) ? a : mejor), 21);
    await conn.query('INSERT INTO cmp_comprobante_alicuotas (comprobante_id, alicuota, neto, iva) VALUES (?, ?, ?, ?)', [r.insertId, alicuota, neto, iva]);
  }
  return { comprobante_id: r.insertId, id_global: idG };
});

module.exports = {};
