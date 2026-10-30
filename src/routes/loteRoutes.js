const { Router } = require('express');
const pool = require('../config/db');
const Lotes = require('../stock/loteService');
const Mov = require('../stock/movimientoService');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');

// Lotes y vencimiento (Stock RF20, RN06): consulta, configuración del ítem, bloqueo y merma de fin de día.
const router = Router();
const VER = requierePermiso('stock.movimientos.ver');
const REGISTRAR = requierePermiso('stock.movimientos.registrar');

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof Lotes.LoteInvalido || err instanceof Mov.MovimientoInvalido) return res.status(err.status || 400).json({ error: err.message, codigo: 'LOTE_INVALIDO' });
    next(err);
  }
};
const TABLA = { insumo: 'insumos', producto: 'productos' };

// Lotes con su saldo por depósito: ?item_tipo&item_id[&deposito_id]
router.get('/', VER, manejar(async (req, res) => {
  const { item_tipo: tipo, item_id: id, deposito_id: dep } = req.query;
  if (!TABLA[tipo] || !Number.isInteger(Number(id))) return res.status(400).json({ error: 'Indicá item_tipo (insumo | producto) e item_id.' });
  const col = tipo === 'insumo' ? 'insumo_id' : 'producto_id';
  const [rows] = await pool.query(
    `SELECT l.id, l.codigo, l.fecha_elaboracion, l.fecha_vencimiento, l.bloqueado, l.motivo_bloqueo, m.deposito_id, d.nombre AS deposito, COALESCE(SUM(m.cantidad), 0) AS saldo
     FROM lotes l LEFT JOIN stock_movimientos m ON m.lote_id = l.id LEFT JOIN depositos d ON d.id = m.deposito_id
     WHERE l.${col} = ? ${dep ? 'AND m.deposito_id = ?' : ''} GROUP BY l.id, m.deposito_id, d.nombre ORDER BY (l.fecha_vencimiento IS NULL), l.fecha_vencimiento, l.id`, dep ? [id, dep] : [id]);
  res.json(rows.map((r) => ({ ...r, saldo: Number(r.saldo), vencido: Lotes.vencido(r) })));
}));

// Informe de próximos vencimientos (?dias=N, 0 = vencidos y los que vencen hoy).
router.get('/vencimientos', VER, manejar(async (req, res) => res.json(await Lotes.proximosAVencer(Number(req.query.dias) || 0))));

// Configuración del ítem: si controla lote, su vida útil (para calcular el vencimiento) y qué hace con un lote vencido.
router.put('/configuracion/:tipo/:id', REGISTRAR, manejar(async (req, res) => {
  const { tipo } = req.params;
  const b = req.body;
  if (!TABLA[tipo]) return res.status(400).json({ error: 'tipo debe ser insumo o producto.' });
  if (b.controla_lote !== undefined && typeof b.controla_lote !== 'boolean') return res.status(400).json({ error: '"controla_lote" debe ser true o false.' });
  if (b.vida_util_dias !== undefined && b.vida_util_dias !== null && !(Number.isInteger(b.vida_util_dias) && b.vida_util_dias > 0)) return res.status(400).json({ error: '"vida_util_dias" debe ser un entero mayor que cero.' });
  if (b.vencido_politica !== undefined && !['bloquear', 'advertir'].includes(b.vencido_politica)) return res.status(400).json({ error: '"vencido_politica" debe ser bloquear o advertir.' });
  const [[f]] = await pool.query(`SELECT id FROM ${TABLA[tipo]} WHERE id = ?`, [req.params.id]);
  if (!f) return res.status(404).json({ error: 'Ítem no encontrado.' });
  for (const c of ['controla_lote', 'vida_util_dias', 'vencido_politica'])
    if (b[c] !== undefined) await pool.query(`UPDATE ${TABLA[tipo]} SET ${c} = ? WHERE id = ?`, [typeof b[c] === 'boolean' ? (b[c] ? 1 : 0) : b[c], f.id]);
  res.json((await pool.query(`SELECT id, nombre, controla_lote, vida_util_dias, vencido_politica FROM ${TABLA[tipo]} WHERE id = ?`, [f.id]))[0][0]);
}));

// Bloquea o libera un lote (por ejemplo, ante un retiro). Un lote bloqueado no se vende ni vuelve a stock por una devolución.
router.put('/:id/bloqueo', REGISTRAR, manejar(async (req, res) => {
  if (typeof req.body.bloqueado !== 'boolean') return res.status(400).json({ error: '"bloqueado" debe ser true o false.' });
  if (req.body.bloqueado && !String(req.body.motivo ?? '').trim()) return res.status(400).json({ error: 'El motivo del bloqueo es obligatorio.' });
  const [r] = await pool.query('UPDATE lotes SET bloqueado = ?, motivo_bloqueo = ? WHERE id = ?', [req.body.bloqueado ? 1 : 0, req.body.bloqueado ? String(req.body.motivo).trim() : null, req.params.id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Lote no encontrado.' });
  await auditar(req, { modulo: 'stock', accion: req.body.bloqueado ? 'lote_bloqueado' : 'lote_liberado', entidad: 'lote', entidad_id: String(req.params.id), detalle: req.body.motivo });
  res.json(await Lotes.porId(pool, Number(req.params.id)));
}));

// Merma de fin de día (RF20): propone los lotes vencidos o que vencen hoy, y la confirma el usuario (egreso "Merma de fin de día").
router.get('/merma-fin-dia', VER, manejar(async (req, res) => res.json(await Lotes.proximosAVencer(0))));
router.post('/merma-fin-dia', REGISTRAR, manejar(async (req, res) => {
  const propuesta = await Lotes.proximosAVencer(0);
  const elegidos = Array.isArray(req.body.lotes) ? propuesta.filter((p) => req.body.lotes.includes(p.id)) : propuesta;
  if (!elegidos.length) return res.status(400).json({ error: 'No hay lotes vencidos o que venzan hoy para dar de baja.' });
  const resultados = [];
  for (const p of elegidos) {
    const r = await Mov.egresar({ deposito_id: p.deposito_id, motivo: 'merma_fin_dia', observacion: `Lote ${p.codigo} (${p.fecha_vencimiento})`,
      lineas: [{ item: { tipo: p.insumo_id ? 'insumo' : 'producto', id: p.insumo_id ?? p.producto_id }, cantidad: p.saldo, lote: p.codigo }] }, { userId: req.usuario?.sub });
    resultados.push({ lote: p.codigo, deposito: p.deposito, cantidad: p.saldo, documento: r.documento });
  }
  await auditar(req, { modulo: 'stock', accion: 'merma_fin_dia', entidad: 'lote', entidad_id: 'varios', detalle: `${resultados.length} lote(s)` });
  res.status(201).json({ mermas: resultados });
}));

module.exports = router;
