const Parametro = require('../models/parametroModel');
const Notificacion = require('../models/notificacionModel');
const { auditar } = require('../utils/auditar');
const logger = require('../utils/logger');

// La hora oficial es SIEMPRE la del servidor (Usuarios RN21, RN81): ningún documento usa el reloj del
// navegador. Las pantallas igual mandan su hora en cada pedido (X-Hora-Cliente) para detectar un equipo
// con el reloj mal puesto: si se desvía más de lo permitido se alerta y se audita (EX14), sin cambiar
// nada de lo que se guarda.
const MAX_SEG_POR_DEFECTO = 300;
const AVISAR_CADA_MS = 3600000;
const ultimoAviso = new Map(); // instancia:terminal -> ms del último aviso

module.exports = async (req, res, next) => {
  const hora = Number(req.get('x-hora-cliente'));
  if (!Number.isFinite(hora) || hora <= 0) return next();
  try {
    const desvioSeg = Math.round((hora - Date.now()) / 1000);
    const max = (await Parametro.todos()).desvio_hora_max_seg ?? MAX_SEG_POR_DEFECTO;
    const origen = req.usuario?.terminal_id ? `terminal ${req.usuario.terminal_id}` : `equipo ${req.ip}`;
    const clave = `desvio-hora:${req.instancia.codigo}:${origen}`;
    if (Math.abs(desvioSeg) > max) {
      if (Date.now() - (ultimoAviso.get(clave) || 0) > AVISAR_CADA_MS) {
        ultimoAviso.set(clave, Date.now());
        await auditar(req, { modulo: 'hora', accion: 'desvio_hora_equipo', resultado: 'denegado', entidad: 'terminal', entidad_id: req.usuario?.terminal_id, detalle: `el reloj del ${origen} difiere ${desvioSeg} s de la hora del servidor` });
        await Notificacion.crear({ modulo: 'usuarios', tipo: 'desvio_hora', severidad: 'media', mensaje: `El reloj del ${origen} está desviado ${Math.abs(desvioSeg)} s. Los documentos usan la hora del servidor.`, roles: ['administrador', 'gerente'], clave });
      }
    } else if (ultimoAviso.delete(clave)) {
      await Notificacion.resolverPorClave(clave, 'El reloj volvió a estar en hora');
    }
  } catch (err) {
    logger.error(`[hora] ${err.message}`); // la detección nunca frena la operación
  }
  next();
};
