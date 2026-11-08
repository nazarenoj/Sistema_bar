// Ayudas de las pruebas de Ventas Online. Un pedido pagado se factura por el servicio de Ventas: sin ARCA simulado cada prueba intentaría salir a internet y esperar su tiempo máximo.
const wsfe = require('../src/afip/wsfeClient');

// ARCA simulado que autoriza todo con números correlativos.
const simularArca = () => {
  let ultimo = 0;
  wsfe.compUltimoAutorizado = async () => ultimo;
  wsfe.compConsultar = async () => null;
  wsfe.solicitarCAE = async ({ item }) => { ultimo = item.CbteDesde; return { FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CAE: `7000000000${String(ultimo).padStart(4, '0')}`, CAEFchVto: '20261231' }] } }; };
};

module.exports = { simularArca };
