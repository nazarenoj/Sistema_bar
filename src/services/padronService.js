const padronClient = require('../afip/padronClient');
const Parametro = require('../models/parametroModel');
const logger = require('../utils/logger');

// Consulta al padrón de ARCA (Ventas RF23, RN29, EX19). Solo consulta: no modifica clientes ni proveedores. La
// falta de respuesta nunca bloquea el alta ni la venta: devuelve el motivo y el dato queda "no verificado".
const PREFIJOS = [20, 23, 24, 27, 30, 33, 34];

// CUIT/CUIL de 11 dígitos con prefijo válido y dígito verificador (módulo 11).
const cuitValido = (cuit) => {
  if (!/^\d{11}$/.test(String(cuit)) || !PREFIJOS.includes(Number(String(cuit).slice(0, 2)))) return false;
  const d = String(cuit).split('').map(Number);
  const suma = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2].reduce((a, p, i) => a + p * d[i], 0);
  const verif = 11 - (suma % 11);
  return d[10] === (verif === 11 ? 0 : verif === 10 ? 9 : verif);
};

const lista = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

// Condición frente al IVA con el código que ARCA espera del receptor (CondicionIVAReceptorId).
const condicionDe = (p) => {
  if (p.datosMonotributo) return { condicion_iva: 'Monotributo', condicion_iva_receptor_id: 6 };
  const impuestos = lista(p.datosRegimenGeneral?.impuesto).map((i) => Number(i.idImpuesto));
  if (impuestos.includes(30)) return { condicion_iva: 'Responsable Inscripto', condicion_iva_receptor_id: 1 };
  if (impuestos.includes(32)) return { condicion_iva: 'Exento', condicion_iva_receptor_id: 4 };
  return { condicion_iva: 'No determinada', condicion_iva_receptor_id: null };
};

const interpretar = (p) => {
  const g = p?.datosGenerales;
  if (!g) return null;
  const d = g.domicilioFiscal;
  return {
    razon_social: g.razonSocial || [g.apellido, g.nombre].filter(Boolean).join(' ') || null,
    tipo_persona: g.tipoPersona ?? null,
    ...condicionDe(p),
    domicilio: d ? [d.direccion, d.localidad, d.descripcionProvincia, d.codPostal].filter(Boolean).join(', ') : null,
  };
};

const conTiempo = (promesa, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(Object.assign(new Error('tiempo agotado'), { tiempo: true })), ms);
  promesa.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

// { estado: 'ok' | 'no_encontrado' | 'sin_conexion' | 'servicio_no_disponible' | 'cuit_invalido', ...datos, consultado_en }
const consultar = async (cuit) => {
  const consultado_en = new Date().toISOString();
  if (!cuitValido(cuit)) return { estado: 'cuit_invalido', consultado_en };
  const segundos = (await Parametro.todos()).padron_timeout_seg ?? 15;
  try {
    const datos = interpretar(await conTiempo(padronClient.consultar(cuit), segundos * 1000));
    return datos ? { estado: 'ok', cuit: String(cuit), ...datos, consultado_en } : { estado: 'no_encontrado', consultado_en };
  } catch (err) {
    if (err.tiempo || ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err.code)) return { estado: 'sin_conexion', consultado_en };
    if (/no existe|no se encuentra|inexistente/i.test(err.message)) return { estado: 'no_encontrado', consultado_en };
    logger.warn(`[padron] consulta de ${cuit} falló: ${err.message}`);
    return { estado: 'servicio_no_disponible', consultado_en };
  }
};

module.exports = { consultar, cuitValido };
