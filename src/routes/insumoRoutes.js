const { Router } = require('express');
const {
  getAll,
  getOne,
  create,
  update,
  remove,
} = require('../controllers/insumoController');

const { requierePermiso } = require('../middleware/requierePermiso');
const pool = require('../config/db');
const Deposito = require('../models/depositoModel');
const router = Router();

router.get('/', requierePermiso('stock.insumos.ver'), getAll);
router.get('/:identifier', requierePermiso('stock.insumos.ver'), getOne);   // resuelve ID (numérico) o nombre (texto)
router.post('/', requierePermiso('stock.insumos.editar'), create);
router.put('/:id', requierePermiso('stock.insumos.editar'), update);
router.delete('/:id', requierePermiso('stock.insumos.editar'), remove);

// Configuración de un ítem (Stock RF01): si controla stock, si es de control estricto, si admite stock negativo, y
// su stock mínimo y punto de reposición en cada depósito.
router.get('/:id/configuracion', requierePermiso('stock.insumos.ver'), async (req, res, next) => {
  try {
    const [[i]] = await pool.query('SELECT id, nombre, unidad, controla_stock, control_estricto, permite_negativo FROM insumos WHERE id = ?', [req.params.id]);
    if (!i) return res.status(404).json({ error: 'Insumo no encontrado.' });
    res.json({ ...i, depositos: await Deposito.configItem(i.id) });
  } catch (err) { next(err); }
});
router.put('/:id/configuracion', requierePermiso('stock.insumos.editar'), async (req, res, next) => {
  const b = req.body;
  for (const c of ['controla_stock', 'control_estricto', 'permite_negativo'])
    if (b[c] !== undefined && typeof b[c] !== 'boolean') return res.status(400).json({ error: `"${c}" debe ser true o false.` });
  for (const d of b.depositos ?? [])
    if (!Number.isInteger(d.deposito_id) || !(Number(d.stock_minimo) >= 0) || !(Number(d.punto_reposicion) >= 0))
      return res.status(400).json({ error: 'Cada depósito necesita deposito_id, stock_minimo y punto_reposicion (≥ 0).' });
  try {
    const [[i]] = await pool.query('SELECT id FROM insumos WHERE id = ?', [req.params.id]);
    if (!i) return res.status(404).json({ error: 'Insumo no encontrado.' });
    for (const d of b.depositos ?? []) if (!(await Deposito.getById(d.deposito_id))) return res.status(400).json({ error: `El depósito ${d.deposito_id} no existe.` });
    for (const c of ['controla_stock', 'control_estricto', 'permite_negativo'])
      if (b[c] !== undefined) await pool.query(`UPDATE insumos SET ${c} = ? WHERE id = ?`, [b[c] ? 1 : 0, i.id]);
    for (const d of b.depositos ?? []) await Deposito.setConfigItem(i.id, d.deposito_id, d);
    const [[act]] = await pool.query('SELECT id, nombre, unidad, controla_stock, control_estricto, permite_negativo FROM insumos WHERE id = ?', [i.id]);
    res.json({ ...act, depositos: await Deposito.configItem(i.id) });
  } catch (err) { next(err); }
});

module.exports = router;
