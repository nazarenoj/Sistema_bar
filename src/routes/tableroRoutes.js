const { Router } = require('express');
const Tablero = require('../servicios/tableroService');
const requiereFuncion = require('../middleware/requiereFuncion');
const { permisosDe } = require('../middleware/requierePermiso');

// Tablero de indicadores (Usuarios RF19). Cualquier usuario con sesión ve el suyo; qué indicadores le salen lo decide su rol (RN34).
const router = Router();
router.use(requiereFuncion('USU-TABLERO'));

const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res, await permisosDe(req)); } catch (err) {
    if (err instanceof Tablero.TableroInvalido) return res.status(err.status ?? 400).json({ error: err.message });
    next(err);
  }
};

router.get('/', manejar(async (req, res, p) => res.json(await Tablero.tablero(req.usuario.sub, p, { periodo: req.query.periodo }))));
router.get('/indicadores', manejar(async (req, res, p) => res.json(await Tablero.catalogo(req.usuario.sub, p))));
router.put('/', manejar(async (req, res, p) => { await Tablero.configurar(req.usuario.sub, p, req.body); res.json(await Tablero.tablero(req.usuario.sub, p)); }));

module.exports = router;
