const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const { PERFILES } = require('../funciones/catalogo');
const { validarAutorizacion } = require('../middleware/requierePermiso');
const { auditar } = require('../utils/auditar');
const Notificacion = require('../models/notificacionModel');
const logger = require('../utils/logger');

const falla500 = (req, res, err) => {
  logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Error interno del servidor', detail: err.message });
};

const actorDe = (req) => ({ id: req.usuario.sub, username: req.usuario.username });

const listar = async (req, res) => {
  try {
    res.json({ ...(await Funciones.estado()), perfiles: Object.entries(PERFILES).map(([id, p]) => ({ id, nombre: p.nombre })) });
  } catch (err) {
    falla500(req, res, err);
  }
};

// Cambio de activación (solo Administrador). Si desactiva una función sanitaria, la autorización de otro
// Administrador viaja en `body.autorizacion` (RN86). Un cambio bloqueado o rechazado queda auditado (EX15).
const cambiar = async (req, res) => {
  const { activar, desactivar, confirmar, motivo } = req.body;
  const lista = (v) => (v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null);
  if (lista(activar) === null || lista(desactivar) === null)
    return res.status(400).json({ error: '"activar" y "desactivar" deben ser listas de IDs de funciones.' });

  try {
    let autorizacionOk = false;
    let supervisor = null;
    if (req.body.autorizacion) {
      const r = await validarAutorizacion(req, 'funciones.sanitarias', { exigirAdmin: true });
      if (!r.ok) return res.status(r.status).json({ error: r.error, codigo: r.codigo });
      autorizacionOk = true; supervisor = r.supervisor;
    }
    const r = await Funciones.cambiar(pool, { activar: lista(activar), desactivar: lista(desactivar), confirmar, motivo, autorizacionOk }, actorDe(req));
    const ids = [...lista(activar), ...lista(desactivar)].join(', ');
    if (!r.ok) {
      if (r.codigo !== 'REQUIERE_CONFIRMACION' && r.codigo !== 'REQUIERE_AUTORIZACION_SANITARIA' && r.codigo !== 'MOTIVO_REQUERIDO')
        await auditar(req, { modulo: 'funciones', accion: 'cambio_rechazado', resultado: 'denegado', entidad: 'funcion', entidad_id: ids, detalle: r.error });
      return res.status(r.status).json({ error: r.error, codigo: r.codigo, cascada: r.cascada, pendientes: r.pendientes, datos: r.datos, dependientes: r.dependientes, sanitarias: r.sanitarias });
    }
    if (Object.keys(r.cambios).length) {
      await auditar(req, {
        modulo: 'funciones', accion: 'cambiar', entidad: 'configuracion', entidad_id: r.version,
        valor_anterior: Object.fromEntries(Object.entries(r.cambios).map(([k, v]) => [k, v.antes])),
        valor_nuevo: Object.fromEntries(Object.entries(r.cambios).map(([k, v]) => [k, v.despues])),
        detalle: [r.sanitarias.length && `peso sanitario: ${motivo}`, supervisor && `autorizó ${supervisor.username}`].filter(Boolean).join('; ') || undefined,
      });
    }
    if (r.sanitarias.length)
      await Notificacion.crear({ modulo: 'usuarios', tipo: 'funcion_sanitaria_desactivada', severidad: 'alta', mensaje: `${req.usuario.username} desactivó ${r.sanitarias.join(', ')} (peso sanitario): ${motivo}`, roles: ['administrador', 'gerente'] });
    res.json({ version: r.version, cambios: r.cambios, cascada: r.cascada });
  } catch (err) {
    falla500(req, res, err);
  }
};

const aplicarPerfil = async (req, res) => {
  try {
    const r = await Funciones.aplicarPerfil(pool, req.body.perfil, actorDe(req));
    if (!r.ok) {
      await auditar(req, { modulo: 'funciones', accion: 'perfil_rechazado', resultado: 'denegado', entidad: 'perfil', entidad_id: req.body.perfil, detalle: r.error });
      return res.status(r.status).json({ error: r.error, codigo: r.codigo });
    }
    await auditar(req, { modulo: 'funciones', accion: 'aplicar_perfil', entidad: 'perfil', entidad_id: req.body.perfil, valor_nuevo: Object.fromEntries(Object.entries(r.cambios).map(([k, v]) => [k, v.despues])) });
    res.json({ version: r.version, cambios: r.cambios });
  } catch (err) {
    falla500(req, res, err);
  }
};

const historial = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT version, ts_ms, username, origen, cambios FROM version_configuracion ORDER BY version DESC LIMIT 100');
    res.json(rows.map((r) => ({ ...r, cambios: JSON.parse(r.cambios) })));
  } catch (err) {
    falla500(req, res, err);
  }
};

module.exports = { listar, cambiar, aplicarPerfil, historial };
