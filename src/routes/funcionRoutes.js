const { Router } = require('express');
const c = require('../controllers/funcionController');
const soloAdministrador = require('../middleware/soloAdministrador');

const router = Router();

// Ver el estado de las funciones lo puede cualquier usuario (la pantalla oculta lo que no está activo);
// cambiarlo es exclusivo del Administrador (RN24) y no se asigna a otros roles.
router.get('/', c.listar);
router.get('/historial', soloAdministrador, c.historial);
router.post('/cambiar', soloAdministrador, c.cambiar);
router.post('/perfil', soloAdministrador, c.aplicarPerfil);

module.exports = router;
