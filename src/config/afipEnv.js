// Arma la configuración de ARCA (ex AFIP) de una instancia: parte de las AFIP_* del entorno y la
// pisa con lo que declare la instancia en instancias.json (clave "afip", con los nombres de abajo).
const WSAA_URLS = {
  homologacion: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms?wsdl',
  produccion: 'https://wsaa.afip.gov.ar/ws/services/LoginCms?wsdl',
};

const WSFE_URLS = {
  homologacion: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx?WSDL',
  produccion: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx?WSDL',
};

const PADRON_URLS = {
  homologacion: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5?WSDL',
  produccion: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5?WSDL',
};

module.exports = (o = {}) => {
  const e = process.env;
  const entorno = (o.entorno || e.AFIP_ENTORNO) === 'produccion' ? 'produccion' : 'homologacion';
  return {
    entorno,
    condicionIvaEmisor: (o.condicionIvaEmisor || e.AFIP_CONDICION_IVA_EMISOR) === 'responsable_inscripto'
      ? 'responsable_inscripto' : 'monotributista',
    cuit: o.cuit ?? e.AFIP_CUIT,
    puntoVenta: Number(o.puntoVenta ?? e.AFIP_PUNTO_VENTA) || 1,
    certPath: o.certPath ?? e.AFIP_CERT_PATH,
    keyPath: o.keyPath ?? e.AFIP_KEY_PATH,
    ivaAlicuotaId: Number(o.ivaAlicuotaId ?? e.AFIP_IVA_ALICUOTA_ID) || 5,
    ivaAlicuotaPorcentaje: Number(o.ivaAlicuotaPorcentaje ?? e.AFIP_IVA_ALICUOTA_PORCENTAJE) || 21,
    razonSocial: o.razonSocial ?? e.AFIP_RAZON_SOCIAL ?? '',
    domicilioComercial: o.domicilioComercial ?? e.AFIP_DOMICILIO_COMERCIAL ?? '',
    inicioActividades: o.inicioActividades ?? e.AFIP_INICIO_ACTIVIDADES ?? '',
    ingresosBrutos: o.ingresosBrutos ?? e.AFIP_INGRESOS_BRUTOS ?? '',
    wsaaWsdl: WSAA_URLS[entorno],
    wsfeWsdl: WSFE_URLS[entorno],
    padronWsdl: PADRON_URLS[entorno],
  };
};
