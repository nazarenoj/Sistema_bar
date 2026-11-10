const pool = require('../config/db');
const Consultas = require('../modulos/consultas');

// Lo que Financiero responde a Contable (llamada n.º 18): saldos de cajas y bancos en pesos y el turno de un documento de origen.
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const CAJAS = ['caja_efectivo', 'caja_reparto', 'caja_fuerte'];

Consultas.registrar('financiero', 'saldos', async () => {
  const [filas] = await pool.query(`SELECT c.tipo, c.moneda, c.saldo_inicial + COALESCE(s.total, 0) AS saldo FROM fin_cuentas c
    LEFT JOIN (SELECT cuenta_id, SUM(importe) AS total FROM fin_movimientos GROUP BY cuenta_id) s ON s.cuenta_id = c.id`);
  let caja = 0, bancos = 0, otras = 0;
  for (const f of filas) { if (f.moneda !== 'ARS') { otras++; continue; } if (CAJAS.includes(f.tipo)) caja += Number(f.saldo); else bancos += Number(f.saldo); }
  const [divisas] = await pool.query(`SELECT c.id_global, c.nombre, c.tipo, c.moneda, c.saldo_inicial + COALESCE(s.total, 0) AS saldo FROM fin_cuentas c
    LEFT JOIN (SELECT cuenta_id, SUM(importe) AS total FROM fin_movimientos GROUP BY cuenta_id) s ON s.cuenta_id = c.id WHERE c.moneda <> 'ARS'`);
  return { caja: r2(caja), bancos: r2(bancos), total: r2(caja + bancos), cuentas_en_otras_monedas: otras,
    divisas: divisas.map((d) => ({ id_global: d.id_global, nombre: d.nombre, tipo: d.tipo, moneda: d.moneda, saldo_divisa: r2(d.saldo) })) };
});

Consultas.registrar('financiero', 'documento', async ({ tipo, id }) => {
  const por = { gasto: 'fin_gastos', transferencia: 'fin_transferencias', liquidacion: 'fin_liquidaciones' };
  const tabla = por[String(tipo).split('_')[0]];
  if (tabla) { const [[d]] = await pool.query(`SELECT id_global FROM ${tabla} WHERE id_global = ?`, [id]); return d ? { tipo: String(tipo).split('_')[0], id_global: d.id_global } : null; }
  const [[t]] = await pool.query('SELECT id_global, estado FROM fin_turnos WHERE id_global = ?', [id]);
  return t ? { tipo: 'turno', id_global: t.id_global, estado: t.estado } : null;
});
