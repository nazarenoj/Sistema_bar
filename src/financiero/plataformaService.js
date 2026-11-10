const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const { invalida, r2 } = require('./comun');
const Contable = require('./aContable');
const iso = (f) => (f instanceof Date ? f.toISOString().slice(0, 10) : f);

// Comisiones y liquidaciones de las plataformas de delivery y marketplaces (Financiero RF24, Ventas Online RN28, EX18). Ventas Online entrega por mensajes la comisión de cada pedido entregado y los
// datos de cada liquidación que recibe la plataforma. Financiero registra la comisión y concilia la liquidación contra los pedidos entregados del período: si coincide, queda conciliada; si no,
// queda «con diferencia», señalada, y no se ajusta sola: la resuelve a mano un usuario con permiso. Los mensajes repetidos no duplican nada (ID_Operacion / ID_Liquidacion).
M.registrarReceptor('financiero', 'comision_plataforma', async (conn, c, ctx) => {
  const [r] = await conn.query('INSERT IGNORE INTO fin_plataforma_comisiones (id_operacion, plataforma, pedido_global, id_externo, bruto, comision, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [ctx.idOperacion, c.plataforma, c.pedido_global, c.id_externo, c.bruto, c.comision, c.fecha]);
  // La comisión se imputa una sola vez, contra lo que la plataforma debe liquidar (Contable RF19, RN37).
  if (r.affectedRows === 1 && Number(c.comision) > 0) await Contable.publicar(conn, 'comision_de_plataforma', 'comision', c.pedido_global, { pedido_global: c.pedido_global, plataforma: c.plataforma, importe: Number(c.comision), fecha: c.fecha });
  return { registrada: r.affectedRows === 1 };
});

M.registrarReceptor('financiero', 'liquidacion_plataforma', async (conn, c) => {
  const [[previa]] = await conn.query('SELECT id, estado FROM fin_plataforma_liquidaciones WHERE id_liquidacion = ?', [c.id_liquidacion]);
  if (previa) return { id: previa.id, estado: previa.estado, ya_procesado: true };
  const [[esp]] = await conn.query('SELECT COALESCE(SUM(bruto), 0) AS bruto, COALESCE(SUM(comision), 0) AS comision FROM fin_plataforma_comisiones WHERE plataforma = ? AND fecha BETWEEN ? AND ? AND liquidacion_id IS NULL', [c.plataforma, c.desde, c.hasta]);
  const concilia = Math.abs(Number(esp.bruto) - Number(c.bruto)) < 0.01 && Math.abs(Number(esp.comision) - Number(c.comision)) < 0.01;
  const [r] = await conn.query('INSERT INTO fin_plataforma_liquidaciones (id_liquidacion, plataforma, desde, hasta, bruto, comision, neto, esperado_bruto, esperado_comision, estado, recibida_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [c.id_liquidacion, c.plataforma, c.desde, c.hasta, c.bruto, c.comision, c.neto, esp.bruto, esp.comision, concilia ? 'conciliada' : 'con_diferencia', Date.now()]);
  if (concilia) await conn.query('UPDATE fin_plataforma_comisiones SET liquidacion_id = ? WHERE plataforma = ? AND fecha BETWEEN ? AND ? AND liquidacion_id IS NULL', [r.insertId, c.plataforma, c.desde, c.hasta]);
  // Lo que la plataforma efectivamente liquidó (neto) cancela lo que debía; la diferencia, cuando se resuelve (Contable RN24).
  await Contable.publicar(conn, 'liquidacion_de_plataforma', 'liquidacion', c.id_liquidacion, { id_liquidacion: c.id_liquidacion, plataforma: c.plataforma, importe: Number(c.neto), fecha: c.hasta });
  return { id: r.insertId, estado: concilia ? 'conciliada' : 'con_diferencia' };
});

const liquidaciones = async ({ plataforma, estado } = {}) => {
  const w = [], p = [];
  if (plataforma) { w.push('plataforma = ?'); p.push(plataforma); }
  if (estado) { w.push('estado = ?'); p.push(estado); }
  return (await pool.query(`SELECT * FROM fin_plataforma_liquidaciones ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 200`, p))[0].map((l) => ({
    id: l.id, id_liquidacion: l.id_liquidacion, plataforma: l.plataforma, desde: iso(l.desde), hasta: iso(l.hasta), bruto: Number(l.bruto), comision: Number(l.comision), neto: Number(l.neto),
    esperado_bruto: l.esperado_bruto === null ? null : Number(l.esperado_bruto), esperado_comision: l.esperado_comision === null ? null : Number(l.esperado_comision),
    diferencia_bruto: l.esperado_bruto === null ? null : r2(Number(l.bruto) - Number(l.esperado_bruto)), estado: l.estado, nota: l.nota }));
};
const comisiones = async ({ plataforma, desde, hasta } = {}) => {
  const w = [], p = [];
  if (plataforma) { w.push('plataforma = ?'); p.push(plataforma); }
  if (desde) { w.push('fecha >= ?'); p.push(desde); }
  if (hasta) { w.push('fecha <= ?'); p.push(hasta); }
  return (await pool.query(`SELECT plataforma, pedido_global, id_externo, bruto, comision, fecha, liquidacion_id FROM fin_plataforma_comisiones ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 500`, p))[0]
    .map((c) => ({ ...c, bruto: Number(c.bruto), comision: Number(c.comision), fecha: iso(c.fecha) }));
};
// La diferencia no se corrige sola (EX18): se resuelve a mano con un motivo.
const resolver = async (id, { nota }) => {
  if (typeof nota !== 'string' || nota.trim().length < 3) throw invalida('Explicá cómo se resolvió la diferencia.');
  const [[l]] = await pool.query('SELECT * FROM fin_plataforma_liquidaciones WHERE id = ?', [id]);
  if (!l) throw invalida('Liquidación no encontrada.', 404);
  if (l.estado !== 'con_diferencia') throw invalida(`La liquidación está ${l.estado}.`, 409);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE fin_plataforma_liquidaciones SET estado = 'resuelta', nota = ? WHERE id = ?", [nota.trim().slice(0, 255), id]);
    // Lo que se esperaba cobrar (bruto menos comisión) contra lo que se liquidó: la diferencia va a una cuenta de diferencias de conciliación.
    const faltante = r2((Number(l.esperado_bruto) - Number(l.esperado_comision)) - Number(l.neto));
    if (faltante !== 0) await Contable.publicar(conn, 'diferencia_conciliacion', 'liquidacion', l.id_liquidacion, { id_liquidacion: l.id_liquidacion, importe: faltante, fecha: iso(l.hasta) }, { docVersion: 2, secuencia: 2 });
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  M.despertar();
  return (await liquidaciones()).find((x) => x.id === id);
};

module.exports = { liquidaciones, comisiones, resolver };
