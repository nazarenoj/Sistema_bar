const puertos = require('../modulos/puertos');
const Clientes = require('./clienteService');
const Credito = require('./creditoService');
const Fid = require('./fidelizacionService');

// Clientes implementa el puerto "Control de crédito y maestro de clientes" que define Ventas (Clientes RF19): búsqueda por documento, nombre,
// teléfono o QR. El veredicto y la reserva de crédito se suman en E3. Sin Clientes instalado el puerto es nulo y Ventas no ofrece cuenta corriente.
const impl = {
  disponible: true,
  fidelizacion: true,
  esSocio: (id) => Fid.esSocio(id),
  retenerSaldo: (d) => Fid.retener(d),
  liberarRetencion: (id) => Fid.liberar(id),
  premio: (clienteId, reglaId) => Fid.premio(clienteId, reglaId),
  buscarCliente: (q) => Clientes.buscar(q),
  veredicto: (d) => Credito.veredicto(d),
  reservar: (d) => Credito.reservar(d),
  liberarReserva: (id) => Credito.liberar(id),
  renovarReserva: (id) => Credito.renovar(id),
  // Lo que Ventas necesita del cliente para facturarle: documento con el código de ARCA y condición frente al IVA.
  resolverCliente: async (id) => {
    const c = await Clientes.resolver(id);
    if (!c) return null;
    const doc = { CUIT: 80, CUIL: 86, DNI: 96, PASAPORTE: 94, CF: 99 }[c.tipo_documento];
    return { id: c.id, razon_social: c.razon_social, lista_precio_id: c.lista_precio_id, doc_tipo: doc, nro_documento: c.nro_documento, condicion_iva_receptor_id: c.condicion_iva_receptor_id ?? 5, domicilio_fiscal: c.domicilio_fiscal };
  },
};
puertos.registrar('credito', impl);
module.exports = impl;
