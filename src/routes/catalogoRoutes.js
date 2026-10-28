const { Router } = require('express');
const pool = require('../config/db');
const { requierePermiso } = require('../middleware/requierePermiso');

// ABM mínimo de las listas del catálogo (categorías y sectores de comanda): misma forma, otra tabla.
// `tabla` y `activo` vienen del código, nunca del request.
const listaSimple = (tabla, activo, referencia) => {
  const router = Router();
  const nombreValido = (b) => typeof b.nombre === 'string' && b.nombre.trim() !== '';

  router.get('/', requierePermiso('ventas.catalogo.ver'), async (req, res, next) => {
    try {
      res.json((await pool.query(`SELECT * FROM ${tabla} ORDER BY nombre`))[0]);
    } catch (err) { next(err); }
  });

  router.post('/', requierePermiso('ventas.catalogo.editar'), async (req, res, next) => {
    if (!nombreValido(req.body)) return res.status(400).json({ error: 'El campo "nombre" es obligatorio.' });
    try {
      const [r] = await pool.query(`INSERT INTO ${tabla} (nombre) VALUES (?)`, [req.body.nombre.trim()]);
      res.status(201).json((await pool.query(`SELECT * FROM ${tabla} WHERE id = ?`, [r.insertId]))[0][0]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya existe uno con ese nombre.' });
      next(err);
    }
  });

  router.put('/:id', requierePermiso('ventas.catalogo.editar'), async (req, res, next) => {
    if (!nombreValido(req.body)) return res.status(400).json({ error: 'El campo "nombre" es obligatorio.' });
    try {
      const [r] = await pool.query(`UPDATE ${tabla} SET nombre = ?, ${activo} = ? WHERE id = ?`,
        [req.body.nombre.trim(), req.body[activo] === false || req.body[activo] === 0 ? 0 : 1, req.params.id]);
      if (!r.affectedRows) return res.status(404).json({ error: 'No encontrado.' });
      res.json((await pool.query(`SELECT * FROM ${tabla} WHERE id = ?`, [req.params.id]))[0][0]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya existe uno con ese nombre.' });
      next(err);
    }
  });

  router.delete('/:id', requierePermiso('ventas.catalogo.editar'), async (req, res, next) => {
    try {
      const [[{ n }]] = await pool.query(`SELECT COUNT(*) n FROM productos WHERE ${referencia} = ?`, [req.params.id]);
      if (n) return res.status(409).json({ error: `Lo usan ${n} producto(s): desactivalo en lugar de borrarlo.` });
      const [r] = await pool.query(`DELETE FROM ${tabla} WHERE id = ?`, [req.params.id]);
      if (!r.affectedRows) return res.status(404).json({ error: 'No encontrado.' });
      res.json({ message: 'Eliminado.' });
    } catch (err) { next(err); }
  });

  return router;
};

module.exports = {
  categorias: listaSimple('categorias_producto', 'activa', 'categoria_id'),
  sectores: listaSimple('sectores_comanda', 'activo', 'sector_id'),
};
