const { Router } = require('express');
const pool = require('../config/db');
const { requierePermiso } = require('../middleware/requierePermiso');

// Formas de pago configurables (Ventas RF09). No se borran: una forma usada en ventas solo se desactiva.
const router = Router();
const FORMA = 'SELECT * FROM formas_pago WHERE id = ?';

const validar = (b) => {
  if (typeof b.codigo !== 'string' || !/^[a-z0-9_]{2,50}$/.test(b.codigo)) return 'El "codigo" debe tener 2 a 50 caracteres: minúsculas, números o guion bajo.';
  if (b.codigo === 'mixto') return '"mixto" está reservado.';
  if (typeof b.nombre !== 'string' || !b.nombre.trim()) return 'El campo "nombre" es obligatorio.';
  return null;
};
const flag = (v) => (v ? 1 : 0);

router.get('/', requierePermiso('ventas.cuenta.cobrar'), async (req, res, next) => {
  try {
    res.json((await pool.query('SELECT * FROM formas_pago ORDER BY orden, id'))[0]);
  } catch (err) { next(err); }
});

router.post('/', requierePermiso('ventas.catalogo.editar'), async (req, res, next) => {
  const error = validar(req.body);
  if (error) return res.status(400).json({ error });
  const b = req.body;
  try {
    const [r] = await pool.query(
      'INSERT INTO formas_pago (codigo, nombre, requiere_referencia, admite_vuelto, orden) VALUES (?, ?, ?, ?, ?)',
      [b.codigo, b.nombre.trim(), flag(b.requiere_referencia), flag(b.admite_vuelto), Number.isInteger(b.orden) ? b.orden : 0]);
    res.status(201).json((await pool.query(FORMA, [r.insertId]))[0][0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya existe una forma de pago con ese código.' });
    next(err);
  }
});

// El código no cambia (las ventas ya cobradas lo guardan): solo nombre, atributos, orden y si está activa.
router.put('/:id', requierePermiso('ventas.catalogo.editar'), async (req, res, next) => {
  const b = req.body;
  if (typeof b.nombre !== 'string' || !b.nombre.trim()) return res.status(400).json({ error: 'El campo "nombre" es obligatorio.' });
  try {
    const [r] = await pool.query(
      'UPDATE formas_pago SET nombre = ?, activa = ?, requiere_referencia = ?, admite_vuelto = ?, orden = ? WHERE id = ?',
      [b.nombre.trim(), b.activa === false || b.activa === 0 ? 0 : 1, flag(b.requiere_referencia), flag(b.admite_vuelto), Number.isInteger(b.orden) ? b.orden : 0, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Forma de pago no encontrada.' });
    res.json((await pool.query(FORMA, [req.params.id]))[0][0]);
  } catch (err) { next(err); }
});

module.exports = router;
