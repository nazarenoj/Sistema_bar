const soap = require('soap');
const config = require('../config/afipConfig');
const taCache = require('./taCache');

// El cliente SOAP se arma una sola vez (contra el WSDL publicado) y se reutiliza entre llamadas.
// Es por WSDL (homologación o producción), no por instancia: el cliente no guarda credenciales.
const clientes = new Map();
const getClient = () => {
  const url = config.wsfeWsdl;
  if (!clientes.has(url)) clientes.set(url, soap.createClientAsync(url));
  return clientes.get(url);
};

const _listarErrores = (errors) => {
  const lista = Array.isArray(errors.Err) ? errors.Err : [errors.Err];
  return lista.map((e) => `[${e.Code}] ${e.Msg}`).join(' | ');
};

const authHeader = async () => {
  const { token, sign } = await taCache.getTA('wsfe');
  return { Token: token, Sign: sign, Cuit: config.cuit };
};

// Chequeo de conectividad/salud de ARCA, no requiere autenticación.
const dummy = async () => {
  const client = await getClient();
  const [result] = await client.FEDummyAsync({});
  return result.FEDummyResult;
};

// Último número de comprobante autorizado para un punto de venta + tipo de comprobante dado
// (el próximo número a facturar es este valor + 1).
const compUltimoAutorizado = async (ptoVta, cbteTipo) => {
  const client = await getClient();
  const [result] = await client.FECompUltimoAutorizadoAsync({
    Auth: await authHeader(),
    PtoVta: ptoVta,
    CbteTipo: cbteTipo,
  });
  const res = result.FECompUltimoAutorizadoResult;
  if (res.Errors) throw new Error(_listarErrores(res.Errors));
  return Number(res.CbteNro);
};

// Pide el CAE para un único comprobante. `detalle` ya viene armado por afipService con el número
// de comprobante, importes e IVA calculados.
const solicitarCAE = async (detalle) => {
  const client = await getClient();
  const [result] = await client.FECAESolicitarAsync({
    Auth: await authHeader(),
    FeCAEReq: {
      FeCabReq: { CantReg: 1, PtoVta: detalle.PtoVta, CbteTipo: detalle.CbteTipo },
      FeDetReq: { FECAEDetRequest: [detalle.item] },
    },
  });
  return result.FECAESolicitarResult;
};

// Consulta un comprobante por número (para resolver un intento indeterminado). Devuelve null si ARCA no lo
// tiene (código 602, "no existen datos") o { resultado, cae, caeVencimiento } si existe.
const compConsultar = async (ptoVta, cbteTipo, cbteNro) => {
  const client = await getClient();
  const [result] = await client.FECompConsultarAsync({
    Auth: await authHeader(),
    FeCompConsReq: { CbteTipo: cbteTipo, CbteNro: cbteNro, PtoVta: ptoVta },
  });
  const res = result.FECompConsultarResult;
  if (res.Errors) {
    const lista = Array.isArray(res.Errors.Err) ? res.Errors.Err : [res.Errors.Err];
    if (lista.some((e) => Number(e.Code) === 602)) return null;
    throw new Error(_listarErrores(res.Errors));
  }
  const g = res.ResultGet;
  const f = String(g.FchVto || '');
  return { resultado: g.Resultado, cae: g.CodAutorizacion, caeVencimiento: f.length === 8 ? `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}` : null };
};

module.exports = { dummy, compUltimoAutorizado, solicitarCAE, compConsultar };
