const registro = require('../instancias/registro');
const Modulos = require('../modulos/registro');
const Funciones = require('../funciones/servicio');
const Credito = require('./creditoService');
const Informes = require('./informesService');
const logger = require('../utils/logger');

// Trabajo periódico de Clientes (por instancia): una vez por día evalúa el bloqueo automático por mora (RF13) y genera los recordatorios de vencimiento (RF16). Tolera cualquier falla.
const hecho = new Map();
const vuelta = async () => {
  for (const inst of registro.listar()) {
    await registro.dentroDe(inst, async () => {
      try {
        if (!(await Modulos.estaInstalado('clientes'))) return;
        const hoy = new Date().toDateString();
        if (hecho.get(inst.codigo) === hoy) return;
        hecho.set(inst.codigo, hoy);
        if (await Funciones.estaActiva('VEN-CC')) await Credito.revisarDiario();
        await Informes.recordatorios(); // alertas y avisos de vencimientos próximos o vencidos (RF16)
      } catch (err) {
        logger.error(`[clientes] instancia ${inst.codigo}: ${err.message}`);
      }
    });
  }
};

const iniciar = () => {
  const timer = setInterval(() => vuelta().catch((e) => logger.error(`[clientes] ${e.message}`)), 60000);
  timer.unref();
  return () => clearInterval(timer);
};

module.exports = { iniciar, vuelta };
