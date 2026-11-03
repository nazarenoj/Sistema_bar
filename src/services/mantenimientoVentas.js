const registro = require('../instancias/registro');
const Funciones = require('../funciones/servicio');
const Reservas = require('./reservaService');
const logger = require('../utils/logger');

// Trabajo periódico de Ventas (cada minuto, por instancia): con VEN-RESERVAS vence las reservas que superaron la tolerancia (RN40), manda los
// recordatorios que toquen y genera la comanda de los pedidos especiales que llegan a su fecha (RF44). Tolera cualquier falla.
const vuelta = async () => {
  for (const inst of registro.listar()) {
    await registro.dentroDe(inst, async () => {
      try {
        if (!(await Funciones.estaActiva('VEN-RESERVAS'))) return;
        await Reservas.vencer();
        await Reservas.enviarRecordatorios();
        await Reservas.generarVencidos();
      } catch (err) {
        logger.error(`[ventas] instancia ${inst.codigo}: ${err.message}`);
      }
    });
  }
};

const iniciar = () => {
  const timer = setInterval(() => vuelta().catch((e) => logger.error(`[ventas] ${e.message}`)), 60000);
  timer.unref();
  return () => clearInterval(timer);
};

module.exports = { iniciar, vuelta };
