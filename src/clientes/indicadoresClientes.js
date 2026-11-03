const Tablero = require('../servicios/tableroService');
const Informes = require('./informesService');

// Indicador de deuda de clientes para el tablero (Clientes y CC RF25, RN32): deuda total, vencida, porcentaje vencido y los cinco mayores deudores.
// Solo para roles con permiso sobre Clientes y CC (no expone datos personales a otros, RN17); se calcula con los datos de la instancia, en pesos.
Tablero.registrar([
  { id: 'clientes.deuda', nombre: 'Deuda de clientes', modulo: 'clientes', permiso: 'clientes.ver', unidad: '$', calcular: () => Informes.indicadorDeuda() },
]);
