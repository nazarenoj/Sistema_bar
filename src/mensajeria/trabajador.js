const registro = require('../instancias/registro');
const Mensajeria = require('./servicio');
const { purgarVencidas } = require('../middleware/idempotencia');
const pool = require('../config/db');
const Reservas = require('../reservas/servicio');
const Parametro = require('../models/parametroModel');
const Notificacion = require('../models/notificacionModel');
const fs = require('fs');
const logger = require('../utils/logger');

// Trabajador de la mensajería: corre dentro de la misma app, sin broker externo. Cada vuelta entrega los
// mensajes que ya les toca en cada instancia; una vez por minuto hace el mantenimiento (escalada de
// pendientes, archivo de confirmados, purga de retenciones) y, a la hora configurada, la conciliación diaria.
// shortcut: un solo proceso. Con dos procesos a la vez la reserva de cada mensaje (UPDATE condicional)
// evita entregarlo dos veces, pero el mantenimiento correría duplicado; pasar a un candado en tabla.
const VUELTA_MS = 2000;
const MANTENIMIENTO_CADA = 30; // vueltas

let vueltas = 0;

// Espacio en disco por encima del umbral (85 % por defecto): alerta crítica anticipada, antes de que fallen
// las copias o el registro de auditoría (Usuarios EX13). `statfs` se inyecta para poder probarlo.
const revisarDisco = async (statfs = fs.promises.statfs) => {
  try {
    const s = await statfs(process.cwd());
    const usado = Math.round((1 - s.bavail / s.blocks) * 100);
    const limite = (await Parametro.todos()).disco_alerta_porcentaje ?? 85;
    if (usado > limite)
      await Notificacion.crear({ modulo: 'usuarios', tipo: 'disco_lleno', severidad: 'critica', mensaje: `El disco está al ${usado} %: liberá espacio antes de que fallen las copias o la auditoría.`, roles: ['administrador'], clave: 'disco-lleno' });
    else await Notificacion.resolverPorClave('disco-lleno', 'El espacio en disco volvió a un nivel normal');
    return usado;
  } catch (err) {
    logger.error(`[disco] no se pudo medir el espacio: ${err.message}`);
    return null;
  }
};

const mantenimiento = async () => {
  await revisarDisco();
  await Mensajeria.escalarVencidos();
  await Mensajeria.archivarConfirmados();
  await purgarVencidas();
  await Reservas.vencer();
  const hora = (await Parametro.todos()).conciliacion_hora ?? 3;
  if (new Date().getHours() === hora) {
    const [[ultima]] = await pool.query("SELECT MAX(ts_ms) AS ts FROM conciliaciones WHERE tipo_ejecucion = 'diaria'");
    if (!ultima.ts || Date.now() - Number(ultima.ts) > 20 * 3600000) await Mensajeria.conciliar('diaria', null);
  }
};

const vuelta = async () => {
  vueltas += 1;
  for (const inst of registro.listar()) {
    await registro.dentroDe(inst, async () => {
      try {
        await Mensajeria.procesarPendientes();
        if (vueltas % MANTENIMIENTO_CADA === 0) await mantenimiento();
      } catch (err) {
        logger.error(`[mensajeria] instancia ${inst.codigo}: ${err.message}`);
      }
    });
  }
};

const iniciar = () => {
  const timer = setInterval(() => vuelta().catch((e) => logger.error(`[mensajeria] ${e.message}`)), VUELTA_MS);
  timer.unref();
  return () => clearInterval(timer);
};

module.exports = { iniciar, vuelta, mantenimiento, revisarDisco };
