const registro = require('../instancias/registro');
const logger = require('../utils/logger');
const Vencimientos = require('./vencimientoService');
const Ordenes = require('./ordenPagoService');

// Trabajo periódico de Compras (cada hora, por instancia): los avisos de vencimientos y la foto de los vencimientos a pagar para el flujo de fondos de Financiero. Tolera cualquier falla.
const vuelta = async () => {
  for (const inst of registro.listar()) {
    await registro.dentroDe(inst, async () => {
      try {
        if (!(await require('../modulos/registro').estaInstalado('compras'))) return;
        await Vencimientos.avisos();
        await Ordenes.avisarProgramadas();
        await Vencimientos.publicar();
        if (await require('../funciones/servicio').estaActiva('CMP-CONTROL-ARCA')) await require('./arcaService').constatarPendientes(null); // reintenta la constatación del CAE (H8)
      } catch (err) {
        logger.error(`[compras] instancia ${inst.codigo}: ${err.message}`);
      }
    });
  }
};

const iniciar = () => {
  const timer = setInterval(() => vuelta().catch((e) => logger.error(`[compras] ${e.message}`)), 3600000);
  timer.unref();
  return () => clearInterval(timer);
};

module.exports = { iniciar, vuelta };
