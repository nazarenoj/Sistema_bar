const { Router } = require('express');
const { login, logout, sesionActual, cambiarPassword, cambiarUsuario } = require('../controllers/authController');
const requireAuth = require('../middleware/authMiddleware');

const router = Router();

router.post('/login', login);
router.post('/logout', requireAuth, logout);
router.get('/sesion', requireAuth.pasivo, sesionActual);
router.post('/cambiar-password', requireAuth, cambiarPassword);
router.post('/cambiar-usuario', requireAuth, cambiarUsuario);

module.exports = router;
