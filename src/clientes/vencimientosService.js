const pool = require('../config/db');
const M = require('../mensajeria/servicio');

// Vencimientos por cobrar de Clientes (Clientes y CC → Financiero RF13): Clientes los publica como un evento (la foto completa de lo que está por vencer, en pesos) al que se suscribe la
// proyección de fondos; Financiero nunca consulta a Clientes. Cada foto reemplaza a la anterior. Si Financiero no está instalado, no se genera el mensaje.
const publicar = async () => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [filas] = await conn.query(
      `SELECT m.fecha_vencimiento AS fecha, SUM(m.saldo_pendiente) AS importe FROM movimientos_cc m JOIN cuentas_corrientes c ON c.id = m.cuenta_id
       WHERE m.naturaleza = 'debito' AND m.estado = 'pendiente' AND m.saldo_pendiente > 0 AND c.moneda = 'ARS' AND m.fecha_vencimiento IS NOT NULL GROUP BY m.fecha_vencimiento ORDER BY m.fecha_vencimiento`);
    const [[{ v }]] = await conn.query("SELECT COALESCE(MAX(doc_version), 0) + 1 AS v FROM mensajes_integracion WHERE doc_id_global = 'CLIENTES-VENCIMIENTOS' AND tipo = 'vencimientos_por_cobrar'");
    const r = await M.publicar(conn, { origen: 'clientes', destino: 'financiero', tipo: 'vencimientos_por_cobrar', docTipo: 'vencimientos', docIdGlobal: 'CLIENTES-VENCIMIENTOS', docVersion: v,
      contenido: { generado_ms: Date.now(), vencimientos: filas.map((f) => ({ fecha: f.fecha instanceof Date ? f.fecha.toISOString().slice(0, 10) : f.fecha, importe: Number(f.importe) })) } });
    await conn.commit();
    if (r) M.despertar();
    return r;
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

module.exports = { publicar };
