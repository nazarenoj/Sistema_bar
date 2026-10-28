const pool = require('../config/db');
const config = require('../config/afipConfig');
const wsfeClient = require('../afip/wsfeClient');
const Secuenciador = require('./secuenciadorService');
const Parametro = require('../models/parametroModel');
const Resolucion = require('./resolucionService');

const TIPOS_VALIDOS_POR_CONDICION = {
  monotributista: [11], // Factura C únicamente, nunca discrimina IVA
  responsable_inscripto: [1, 6], // Factura A (a otros RI) y Factura B (consumidor final)
};

const TIPOS_COMPROBANTE = { 1: 'Factura A', 6: 'Factura B', 11: 'Factura C' };

const formatFechaAfip = (fecha = new Date()) => {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, '0');
  const d = String(fecha.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
};

const parseFechaAfip = (yyyymmdd) => {
  if (!yyyymmdd || yyyymmdd.length !== 8) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
};

const _asArray = (campo) => (Array.isArray(campo) ? campo : [campo]);
const _listarObservaciones = (campo) =>
  _asArray(campo)
    .map((e) => `[${e.Code}] ${e.Msg}`)
    .join('; ');

// Valida que el tipo de comprobante pedido sea legal para la condición IVA configurada del
// emisor (ver AFIP_CONDICION_IVA_EMISOR). Lanza un error con .status = 400 para que el
// controller lo devuelva como tal, sin llegar a tocar ARCA.
const validarTipoComprobante = (tipoComprobante) => {
  const validos = TIPOS_VALIDOS_POR_CONDICION[config.condicionIvaEmisor];
  if (!validos.includes(tipoComprobante)) {
    const err = new Error(
      `Con la condición IVA configurada (${config.condicionIvaEmisor}) no se puede emitir ` +
        `${TIPOS_COMPROBANTE[tipoComprobante] || `tipo ${tipoComprobante}`}.`
    );
    err.status = 400;
    throw err;
  }
};

// Factura C (monotributista) nunca discrimina IVA: neto = total. Factura A/B (responsable
// inscripto) discrimina la alícuota general configurada a partir del total (los precios de la
// carta ya se cargan con IVA incluido).
const calcularImportes = (tipoComprobante, importeTotal) => {
  if (tipoComprobante === 11) {
    return { impNeto: importeTotal, impIva: 0, impTotal: importeTotal };
  }
  const alicuota = config.ivaAlicuotaPorcentaje / 100;
  const impNeto = Math.round((importeTotal / (1 + alicuota)) * 100) / 100;
  const impIva = Math.round((importeTotal - impNeto) * 100) / 100;
  return { impNeto, impIva, impTotal: importeTotal };
};

const _normalizarResultado = (resultado, { numero, impNeto, impIva, impTotal }) => {
  const detalles = resultado.FeDetResp ? _asArray(resultado.FeDetResp.FECAEDetResponse) : [];
  const det = detalles[0];

  const observaciones =
    [
      resultado.Errors ? _listarObservaciones(resultado.Errors.Err) : null,
      det?.Observaciones ? _listarObservaciones(det.Observaciones.Obs) : null,
    ]
      .filter(Boolean)
      .join(' | ') || null;

  if (!det || det.Resultado !== 'A') {
    return { estado: 'rechazada', numero, cae: null, caeVencimiento: null, observaciones, importeNeto: impNeto, importeIva: impIva, importeTotal: impTotal };
  }

  return {
    estado: 'aprobada',
    numero,
    cae: det.CAE,
    caeVencimiento: parseFechaAfip(det.CAEFchVto),
    observaciones,
    importeNeto: impNeto,
    importeIva: impIva,
    importeTotal: impTotal,
  };
};

// Reglas del receptor (Ventas RN14): la Factura A exige un receptor Responsable Inscripto identificado
// con CUIT, y el consumidor final sin identificar no puede pasar el tope vigente (parámetro
// tope_consumidor_final, 0 = sin control). Lanza con .status = 400 sin tocar ARCA.
const validarReceptor = async ({ tipoComprobante, docTipo, condicionIvaReceptorId, importeTotal }) => {
  const rechazar = (m) => Object.assign(new Error(m), { status: 400 });
  if (tipoComprobante === 1 && (condicionIvaReceptorId !== 1 || docTipo !== 80))
    throw rechazar('La Factura A exige un receptor Responsable Inscripto identificado con CUIT.');
  const { tope_consumidor_final: tope = 0 } = await Parametro.todos();
  if (docTipo === 99 && tope > 0 && importeTotal > tope)
    throw rechazar(`El importe supera el tope de consumidor final ($${tope}): identificá al receptor.`);
};

const guardarIntento = (idIntento, clave, numero, estado, resultado = null, facturaId = null) => pool.query(
  `INSERT INTO intento_emision (id_intento, clave, numero, estado, resultado, factura_id) VALUES (?, ?, ?, ?, ?, ?)
   ON DUPLICATE KEY UPDATE clave = VALUES(clave), numero = VALUES(numero), estado = VALUES(estado), resultado = VALUES(resultado),
     factura_id = COALESCE(VALUES(factura_id), factura_id)`,
  [idIntento, clave, numero, estado, resultado && JSON.stringify(resultado), facturaId]
);

// Emite un comprobante para una cuenta ya cerrada. No toca la tabla `facturas`: el controller es
// quien persiste el resultado devuelto acá (este módulo solo sabe hablar con ARCA).
// Es la única vía de numeración y emisión (RN49): el número lo asigna el secuenciador, con una sola
// solicitud en vuelo por punto de venta + tipo + modalidad. `idIntento` (la ID_Solicitud) hace al
// intento idempotente: repetir uno ya autorizado devuelve el comprobante sin volver a ARCA (RN52).
const emitirFactura = async ({ tipoComprobante, docTipo, docNro, condicionIvaReceptorId, importeTotal, idIntento, facturaId }) => {
  validarTipoComprobante(tipoComprobante);
  await validarReceptor({ tipoComprobante, docTipo, condicionIvaReceptorId, importeTotal });
  const { impNeto, impIva, impTotal } = calcularImportes(tipoComprobante, importeTotal);

  if (idIntento) {
    const [[previo]] = await pool.query("SELECT resultado FROM intento_emision WHERE id_intento = ? AND estado = 'autorizado'", [idIntento]);
    if (previo) return JSON.parse(previo.resultado);
  }

  const clave = { puntoVenta: config.puntoVenta, tipo: tipoComprobante };
  return Secuenciador.conClave(clave, async () => {
    const ultimoAutorizado = await wsfeClient.compUltimoAutorizado(config.puntoVenta, tipoComprobante);
    const numero = ultimoAutorizado + 1;
    const claveTexto = Secuenciador.claveDe(clave);
    if (idIntento) await guardarIntento(idIntento, claveTexto, numero, 'solicitado', null, facturaId);

    const item = {
      Concepto: 1, // Productos (consumo en el momento, no un servicio facturado por período)
      DocTipo: docTipo,
      DocNro: Number(docNro),
      CbteDesde: numero,
      CbteHasta: numero,
      CbteFch: formatFechaAfip(),
      ImpTotal: impTotal,
      ImpTotConc: 0,
      ImpNeto: impNeto,
      ImpOpEx: 0,
      ImpIVA: impIva,
      ImpTrib: 0,
      MonId: 'PES',
      MonCotiz: 1,
      CondicionIVAReceptorId: condicionIvaReceptorId,
      ...(tipoComprobante !== 11 && {
        Iva: { AlicIva: [{ Id: config.ivaAlicuotaId, BaseImp: impNeto, Importe: impIva }] },
      }),
    };

    let respuesta;
    try {
      respuesta = await wsfeClient.solicitarCAE({ PtoVta: config.puntoVenta, CbteTipo: tipoComprobante, item });
    } catch (err) {
      // Se cortó después de enviar: no se sabe si ARCA lo autorizó. Queda indeterminado (B7 lo resuelve).
      if (idIntento) await Resolucion.abrir({ idIntento, clave: claveTexto, numero, facturaId });
      throw err;
    }
    const resultado = _normalizarResultado(respuesta, { numero, impNeto, impIva, impTotal });
    // Un rechazo no consume el número: el próximo sale otra vez de "último autorizado + 1" (EX03).
    if (idIntento) await guardarIntento(idIntento, claveTexto, numero, resultado.estado === 'aprobada' ? 'autorizado' : 'rechazado', resultado);
    return resultado;
  });
};

const estadoServicio = () => wsfeClient.dummy();

module.exports = { emitirFactura, validarReceptor, estadoServicio, TIPOS_VALIDOS_POR_CONDICION, TIPOS_COMPROBANTE };
