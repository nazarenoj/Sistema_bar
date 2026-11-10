const registro = require('../instancias/registro');
const logger = require('../utils/logger');
const pool = require('../config/db');
const Notificacion = require('../models/notificacionModel');
const Manual = require('./manualService');
const { fechaLocal } = require('./comun');

// Trabajo periódico de Contable (cada hora, por instancia): genera los asientos recurrentes que vencieron (RF05) y escala al Administrador los pendientes de imputar que vencieron su plazo
// (Usuarios RN85, Contable RN08). Tolera cualquier falla.
const escalar = async () => {
  const [vencidos] = await pool.query("SELECT id, tipo_evento, id_documento, plazo FROM con_pendientes WHERE estado = 'abierto' AND plazo < ? AND escalado_ms IS NULL", [fechaLocal()]);
  for (const p of vencidos) {
    await Notificacion.crear({ modulo: 'contable', tipo: 'pendiente_vencido', severidad: 'alta', roles: ['administrador'], clave: `pendiente-vencido:${p.id}`,
      mensaje: `El pendiente de imputar ${p.tipo_evento} ${p.id_documento} venció su plazo sin resolverse.` }).catch(() => {});
    await pool.query('UPDATE con_pendientes SET escalado_ms = ? WHERE id = ?', [Date.now(), p.id]);
  }
  return vencidos.length;
};

const vuelta = async () => {
  for (const inst of registro.listar()) {
    await registro.dentroDe(inst, async () => {
      try {
        if (!(await require('../modulos/registro').estaInstalado('contable'))) return;
        const [[cfg]] = await pool.query('SELECT fecha_inicio FROM con_config WHERE id = 1');
        if (!cfg.fecha_inicio) return;
        await Manual.generarRecurrentes({}, null);
        await escalar();
      } catch (err) {
        logger.error(`[contable] instancia ${inst.codigo}: ${err.message}`);
      }
    });
  }
};

const iniciar = () => {
  const timer = setInterval(() => vuelta().catch((e) => logger.error(`[contable] ${e.message}`)), 3600000);
  timer.unref();
  return () => clearInterval(timer);
};

module.exports = { iniciar, vuelta, escalar };
