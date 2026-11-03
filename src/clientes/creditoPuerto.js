const puertos = require('../modulos/puertos');
const Clientes = require('./clienteService');

// Clientes implementa el puerto "Control de crédito y maestro de clientes" que define Ventas (Clientes RF19): búsqueda por documento, nombre,
// teléfono o QR. El veredicto y la reserva de crédito se suman en E3. Sin Clientes instalado el puerto es nulo y Ventas no ofrece cuenta corriente.
const impl = {
  disponible: true,
  buscarCliente: (q) => Clientes.buscar(q),
  resolverCliente: async (id) => { const c = await Clientes.resolver(id); return c ? { id: c.id, razon_social: c.razon_social, lista_precio_id: c.lista_precio_id } : null; },
};
puertos.registrar('credito', impl);
module.exports = impl;
