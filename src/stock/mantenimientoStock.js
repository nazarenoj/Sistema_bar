const registro = require('../instancias/registro');
const Parametro = require('../models/parametroModel');
const Alertas = require('./alertasService');
const Diferencias = require('./diferenciasService');
const logger = require('../utils/logger');

// Trabajo periódico de Stock (Stock RF16, RF35): cada minuto revisa las alertas de saldo y, a la hora de la conciliación, corre
// el informe de diferencias de integración del día. Tolera cualquier falla: nunca frena la operación.
const ultimaDiaria = new Map();
let vueltas = 0;

const vuelta = async () => {
  vueltas++;
  for (const inst of registro.listar()) {
    await registro.dentroDe(inst, async () => {
      try {
        await Alertas.evaluar();
        const hora = (await Parametro.todos()).conciliacion_hora ?? 3;
        const hoy = new Date().toDateString();
        if (new Date().getHours() === hora && ultimaDiaria.get(inst.codigo) !== hoy) {
          ultimaDiaria.set(inst.codigo, hoy);
          await Diferencias.ejecutar({ desde: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10) });
        }
      } catch (err) {
        logger.error(`[stock] instancia ${inst.codigo}: ${err.message}`);
      }
    });
  }
  return vueltas;
};

const iniciar = () => {
  const timer = setInterval(() => vuelta().catch((e) => logger.error(`[stock] ${e.message}`)), 60000);
  timer.unref();
  return () => clearInterval(timer);
};

module.exports = { iniciar, vuelta };
