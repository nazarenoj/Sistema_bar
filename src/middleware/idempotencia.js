const crypto = require('crypto');
const pool = require('../config/db');
const Parametro = require('../models/parametroModel');
const { auditar } = require('../utils/auditar');
const logger = require('../utils/logger');
const Notificacion = require('../models/notificacionModel');

// Idempotencia de solicitudes (Usuarios RF25, RN69 a RN73). La pantalla genera una ID_Solicitud antes
// del primer envío (cabecera X-ID-Solicitud) y la reutiliza en los reintentos de la misma operación:
//   - misma clave y mismo contenido  → devuelve el resultado original, sin repetir el efecto (EX49)
//   - misma clave, otro contenido    → "conflicto de idempotencia": no ejecuta, alerta y audita (EX48)
//   - primera ejecución todavía en curso → "en proceso", no ejecuta un segundo efecto
// Las operaciones de lectura no la necesitan. Los resultados 401/403/423/429 y los errores 5xx no se
// guardan: la operación no llegó a ejecutarse (o se puede reintentar), y la clave queda libre.

// Operaciones que no se aceptan sin clave (las que mueven plata o comprobantes).
const OBLIGATORIAS = [
  /^POST \/api\/mesas\/:n\/cerrar$/,
  /^POST \/api\/pedidos\/:n\/cerrar$/,
  /^POST \/api\/facturas\/:n\/reintentar$/,
];

const TOPE_ID = 64;
const tipoDe = (req) => `${req.method} ${req.originalUrl.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:n')}`;

const canonico = (v) => (v && typeof v === 'object'
  ? Array.isArray(v) ? v.map(canonico) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonico(v[k])]))
  : v);

// La autorización de supervisor no es parte de la operación: reintentar con otro supervisor sigue siendo lo mismo.
const huellaDe = (req, tipo) => {
  const { autorizacion, ...cuerpo } = req.body || {}; // eslint-disable-line no-unused-vars
  return crypto.createHash('sha256').update(tipo + JSON.stringify(canonico(cuerpo))).digest('hex');
};

const NO_SE_GUARDA = (status) => status >= 500 || [401, 403, 423, 429].includes(status);


const middleware = async (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const tipo = tipoDe(req);
  const id = req.get('x-id-solicitud');

  if (!id) {
    if (OBLIGATORIAS.some((re) => re.test(tipo)))
      return res.status(400).json({ error: 'Falta la clave de la solicitud (X-ID-Solicitud).', codigo: 'FALTA_ID_SOLICITUD' });
    return next();
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id) || id.length > TOPE_ID)
    return res.status(400).json({ error: 'La clave de la solicitud no es válida.', codigo: 'ID_SOLICITUD_INVALIDA' });

  try {
    const huella = huellaDe(req, tipo);
    const dias = (await Parametro.todos()).retencion_solicitudes_dias ?? 90;
    const ahora = Date.now();
    const [ins] = await pool.query(
      `INSERT IGNORE INTO solicitudes_procesadas (id_solicitud, tipo_operacion, huella, estado, user_id, terminal_id, creada_ms, vence_ms)
       VALUES (?, ?, ?, 'en_proceso', ?, ?, ?, ?)`,
      [id, tipo, huella, req.usuario?.sub ?? null, req.usuario?.terminal_id ?? null, ahora, ahora + dias * 86400000]
    );

    if (!ins.affectedRows) {
      const [[previa]] = await pool.query('SELECT * FROM solicitudes_procesadas WHERE id_solicitud = ?', [id]);
      if (!previa) return next(); // la borró otro request en este instante: se trata como nueva
      if (previa.huella !== huella || previa.tipo_operacion !== tipo) {
        await auditar(req, { modulo: 'idempotencia', accion: 'conflicto', resultado: 'denegado', entidad: 'solicitud', entidad_id: id, detalle: `${tipo} con contenido distinto al original (${previa.tipo_operacion})` });
        await Notificacion.crear({ modulo: 'usuarios', tipo: 'conflicto_idempotencia', severidad: 'alta', mensaje: `Conflicto de idempotencia: la clave ${id} se reutilizó con otro contenido (${tipo}).`, roles: ['administrador'], clave: `conflicto-idem:${id}` });
        return res.status(409).json({ error: 'Conflicto de idempotencia: esa clave ya se usó con otro contenido.', codigo: 'CONFLICTO_IDEMPOTENCIA' });
      }
      // Una "en proceso" de hace más de 2 minutos es de un request que murió: la clave se libera y corre de nuevo.
      if (previa.estado === 'en_proceso' && ahora - Number(previa.creada_ms) > 120000) {
        await pool.query("DELETE FROM solicitudes_procesadas WHERE id_solicitud = ? AND estado = 'en_proceso'", [id]);
        return middleware(req, res, next);
      }
      if (previa.estado === 'en_proceso')
        return res.status(409).set('Retry-After', '2').json({ error: 'La operación sigue en proceso.', codigo: 'EN_PROCESO' });
      res.set('Idempotency-Replayed', 'true');
      return res.status(previa.status_http).type('application/json').send(previa.resultado);
    }

    // Primera ejecución: se guarda el resultado antes de responder, así un reintento inmediato lo encuentra.
    const json = res.json.bind(res);
    let guardado = false;
    res.json = (cuerpo) => {
      guardado = true;
      const status = res.statusCode;
      const guardar = NO_SE_GUARDA(status)
        ? pool.query('DELETE FROM solicitudes_procesadas WHERE id_solicitud = ?', [id])
        : pool.query('UPDATE solicitudes_procesadas SET estado = ?, status_http = ?, resultado = ? WHERE id_solicitud = ?',
          [status < 400 ? 'procesada' : 'rechazada', status, JSON.stringify(cuerpo), id]);
      guardar.catch((err) => logger.error(`[idempotencia] no se pudo guardar ${id}: ${err.message}`)).finally(() => json(cuerpo));
      return res;
    };
    // Respuestas que no son JSON (PDF, CSV): no hay resultado que repetir, la clave queda libre.
    res.on('finish', () => {
      if (!guardado) pool.query('DELETE FROM solicitudes_procesadas WHERE id_solicitud = ?', [id]).catch(() => {});
    });
    next();
  } catch (err) {
    logger.error(`[idempotencia] ${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Estado de una solicitud por su clave: lo que consulta el origen antes de reenviar (RN71, EX47).
const estado = async (req, res) => {
  try {
    const [[s]] = await pool.query('SELECT estado, status_http, resultado FROM solicitudes_procesadas WHERE id_solicitud = ?', [req.params.id]);
    if (!s) return res.json({ estado: 'desconocida' });
    res.json({ estado: s.estado, status: s.status_http, resultado: s.resultado ? JSON.parse(s.resultado) : null });
  } catch (err) {
    logger.error(`[idempotencia] ${err.message}`);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Borra las solicitudes cuya retención venció (la corre el trabajador, A10).
const purgarVencidas = async () => {
  const [r] = await pool.query('DELETE FROM solicitudes_procesadas WHERE vence_ms < ?', [Date.now()]);
  return r.affectedRows;
};

module.exports = Object.assign(middleware, { estado, purgarVencidas });
