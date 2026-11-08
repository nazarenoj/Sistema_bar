const { Router } = require('express');
const Libros = require('../contable/libroService');
const requiereModulo = require('../middleware/requiereModulo');
const { requierePermiso } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const { enviarReporte, FORMATOS_VALIDOS } = require('../servicios/reporteService');
const { manejar } = require('../contable/comun');

// Libro diario, libro mayor y balance de sumas y saldos (Contable RF06, RF07, RF08), con exportación.
const router = Router();
router.use(requiereModulo('contable'));
const VER = requierePermiso('contable.ver'), EXPORTAR = requierePermiso('contable.exportar');

// Con `formato` exporta (PDF, Excel, CSV...) y además exige el permiso de exportar; sin él, responde el JSON.
const SI_EXPORTA = (req, res, next) => (req.query.formato ? EXPORTAR(req, res, next) : next());
const responder = (consulta, exportar, nombre) => manejar(async (req, res) => {
  const datos = await consulta(req.query);
  if (!req.query.formato) return res.json(datos);
  if (!FORMATOS_VALIDOS.includes(req.query.formato)) return res.status(400).json({ error: `"formato" debe ser uno de: ${FORMATOS_VALIDOS.join(', ')}.` });
  await auditar(req, { modulo: 'contable', accion: 'exportar', entidad: 'libro', entidad_id: nombre, detalle: req.query.formato });
  await enviarReporte(res, exportar(datos), req.query.formato, nombre);
});

router.get('/libros/diario', VER, SI_EXPORTA, responder(Libros.diario, Libros.exportarDiario, 'libro-diario'));
router.get('/libros/mayor', VER, SI_EXPORTA, responder(Libros.mayor, Libros.exportarMayor, 'libro-mayor'));
router.get('/libros/balance', VER, SI_EXPORTA, responder(Libros.balance, Libros.exportarBalance, 'sumas-y-saldos'));

module.exports = router;
