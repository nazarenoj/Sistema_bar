const pool = require('../config/db');
const config = require('../config/afipConfig');
const registro = require('../instancias/registro');
const wsaaClient = require('./wsaaClient');

// Evita que dos requests casi simultáneos disparen dos logins a la vez: WSAA rechaza pedir un TA
// nuevo mientras el anterior siga vigente (fault "ya posee un TA valido"). A este volumen (2
// usuarios, sillas cerrándose de a una) alcanza con una promesa en curso a nivel de módulo.
const loginsEnCurso = new Map(); // codigo de instancia -> promesa

const MARGEN_MINUTOS = 10;

const leerCache = async (servicio) => {
  const [rows] = await pool.query(
    'SELECT * FROM afip_token_cache WHERE servicio = ? AND entorno = ?',
    [servicio, config.entorno]
  );
  return rows[0] || null;
};

const guardarCache = async (servicio, { token, sign, expira_en }) => {
  await pool.query(
    `INSERT INTO afip_token_cache (servicio, entorno, token, sign, generado_en, expira_en)
     VALUES (?, ?, ?, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE token = VALUES(token), sign = VALUES(sign),
       generado_en = VALUES(generado_en), expira_en = VALUES(expira_en)`,
    [servicio, config.entorno, token, sign, expira_en]
  );
};

// Devuelve { token, sign } vigentes para el servicio indicado, reutilizando el TA cacheado en DB
// si todavía le queda margen antes de vencer (el TA de WSAA dura ~12hs). Persistido en tabla (no
// en memoria) para sobrevivir reinicios del proceso Node.
const getTA = async (servicio = 'wsfe') => {
  const cacheado = await leerCache(servicio);
  if (cacheado && new Date(cacheado.expira_en).getTime() - Date.now() > MARGEN_MINUTOS * 60 * 1000) {
    return { token: cacheado.token, sign: cacheado.sign };
  }

  const { codigo } = registro.actual();
  if (!loginsEnCurso.has(codigo)) {
    loginsEnCurso.set(codigo, wsaaClient
      .login(servicio)
      .then(async (resultado) => {
        await guardarCache(servicio, {
          token: resultado.token,
          sign: resultado.sign,
          expira_en: new Date(resultado.expirationTime),
        });
        return resultado;
      })
      .finally(() => {
        loginsEnCurso.delete(codigo);
      }));
  }

  const { token, sign } = await loginsEnCurso.get(codigo);
  return { token, sign };
};

module.exports = { getTA };
