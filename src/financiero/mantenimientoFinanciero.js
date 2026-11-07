const registro = require('../instancias/registro');
const logger = require('../utils/logger');
const Recurrentes = require('./gastoRecurrenteService');

// Trabajo periódico de Financiero (cada hora, por instancia): los recordatorios de gastos recurrentes (RF12). Tolera cualquier falla.
const vuelta = async () => {
  for (const inst of registro.listar()) {
    await registro.dentroDe(inst, async () => {
      try {
        if (!(await require('../modulos/registro').estaInstalado('financiero'))) return;
        await Recurrentes.recordatorios();
      } catch (err) {
        logger.error(`[financiero] instancia ${inst.codigo}: ${err.message}`);
      }
    });
  }
};

const iniciar = () => {
  const timer = setInterval(() => vuelta().catch((e) => logger.error(`[financiero] ${e.message}`)), 3600000);
  timer.unref();
  return () => clearInterval(timer);
};

module.exports = { iniciar, vuelta };
