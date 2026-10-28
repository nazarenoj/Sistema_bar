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

module.exports = { dummy, compUltimoAutorizado, solicitarCAE };
