const pool = require('../config/db');
const Consultas = require('../modulos/consultas');

// Lo que Clientes y CC responde a Contable (llamada n.º 18): los deudores, el saldo de gift cards y vales y el documento de un recibo o instrumento.
const r2 = (x) => Math.round(Number(x) * 100) / 100;

Consultas.registrar('clientes', 'deudores', async () => {
  const [[r]] = await pool.query("SELECT COALESCE(SUM(IF(naturaleza = 'debito', importe, -importe)), 0) AS saldo FROM movimientos_cc WHERE estado NOT IN ('facturado', 'pendiente_emision')");
  return { total: r2(r.saldo) };
});

Consultas.registrar('clientes', 'instrumentos', async () => {
  const [filas] = await pool.query(`SELECT i.tipo, COALESCE(SUM(s.saldo), 0) AS saldo FROM fid_instrumentos i
    LEFT JOIN (SELECT instrumento_id, SUM(importe) AS saldo FROM fid_instrumento_movs GROUP BY instrumento_id) s ON s.instrumento_id = i.id WHERE i.estado = 'vigente' GROUP BY i.tipo`);
  const por = Object.fromEntries(filas.map((f) => [f.tipo, r2(f.saldo)]));
  return { gift_cards: por.gift_card ?? 0, vales: por.vale ?? 0, total: r2((por.gift_card ?? 0) + (por.vale ?? 0)) };
});

Consultas.registrar('clientes', 'documento', async ({ tipo, id }) => {
  if (tipo === 'pasivo_instrumento') {
    const [[i]] = await pool.query('SELECT codigo, tipo, estado, importe_inicial FROM fid_instrumentos WHERE codigo = ?', [id]);
    return i ? { tipo: i.tipo, codigo: i.codigo, estado: i.estado, importe: Number(i.importe_inicial) } : null;
  }
  const [[r]] = await pool.query('SELECT id_global, total, created_at FROM recibos WHERE id_global = ?', [id]);
  return r ? { tipo: 'recibo', id_global: r.id_global, importe: Number(r.total) } : null;
});
