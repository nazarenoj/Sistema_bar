const { Router } = require('express');
const c = require('../controllers/moduloController');
const soloAdministrador = require('../middleware/soloAdministrador');

const router = Router();
router.use(soloAdministrador);

router.get('/', c.listar);
router.post('/:codigo/instalar', c.instalar);
router.post('/:codigo/desinstalar', c.desinstalar);

module.exports = router;
