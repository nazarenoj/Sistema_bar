const { Router } = require('express');
const c = require('../controllers/rolController');
const { requierePermiso } = require('../middleware/requierePermiso');

const router = Router();
const leer = requierePermiso('usuarios.gestionar');
const escribir = requierePermiso('usuarios.roles.gestionar');

router.get('/', leer, c.listar);
router.get('/permisos', leer, c.catalogo);
router.post('/', escribir, c.crear);
router.put('/:id', escribir, c.actualizar);
router.delete('/:id', escribir, c.borrar);
router.get('/usuarios/:id', leer, c.accesos);
router.put('/usuarios/:id', escribir, c.guardarAccesos);

module.exports = router;
