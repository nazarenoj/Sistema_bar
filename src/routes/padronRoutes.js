const { Router } = require('express');
const Padron = require('../services/padronService');
const { requierePermiso } = require('../middleware/requierePermiso');

const router = Router();

// Consulta un CUIT o CUIL al padrón de ARCA (RF23). Siempre responde 200 con el estado de la consulta
// (ok, no_encontrado, sin_conexion, servicio_no_disponible): quien consulta carga el dato a mano y lo marca
// "no verificado" (EX19). Un CUIT mal formado sí es un error de quien llama.
router.get('/:cuit', requierePermiso('ventas.cuenta.cobrar'), async (req, res, next) => {
  try {
    const r = await Padron.consultar(req.params.cuit);
    if (r.estado === 'cuit_invalido') return res.status(400).json({ error: 'El CUIT/CUIL no es válido (11 dígitos y dígito verificador).', ...r });
    res.json(r);
  } catch (err) { next(err); }
});

module.exports = router;
