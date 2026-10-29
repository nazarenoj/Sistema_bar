const soap = require('soap');
const config = require('../config/afipConfig');
const taCache = require('./taCache');

// Padrón de ARCA (constancia de inscripción, servicio "ws_sr_constancia_inscripcion", A5). Solo consulta.
const SERVICIO = 'ws_sr_constancia_inscripcion';
const clientes = new Map();
const getClient = () => {
  const url = config.padronWsdl;
  if (!clientes.has(url)) clientes.set(url, soap.createClientAsync(url));
  return clientes.get(url);
};

// Devuelve el `personaReturn` de ARCA para un CUIT o CUIL, o lanza el error SOAP (por ejemplo "No existe persona").
const consultar = async (cuit) => {
  const { token, sign } = await taCache.getTA(SERVICIO);
  const client = await getClient();
  const [result] = await client.getPersona_v2Async({ token, sign, cuitRepresentada: config.cuit, idPersona: Number(cuit) });
  return result.personaReturn;
};

module.exports = { consultar };
