const puertos = require('../modulos/puertos');
const pool = require('../config/db');
const Turnos = require('./turnoService');
const Destinos = require('./destinoService');

// Financiero implementa el puerto «Registro de cobros» que define Ventas (Financiero RF17). Ventas pregunta por él antes de cobrar (llamadas n.º 5 y n.º 20);
// el registro del cobro en sí llega por mensaje (cobroReceptor).
puertos.registrar('cobros', {
  registrarCobro: async () => null, // los cobros viajan por la bandeja de salida (cobro_registrado)
  turnoAbierto: ({ terminalId }) => Turnos.turnoDeTerminal(terminalId),
  saldoCaja: async () => null, // llamada n.º 20, se completa en G9
  destinoDe: async (forma, terminalId) => { try { await Destinos.resolver(pool, forma, terminalId); return { asignado: true }; } catch { return { asignado: false }; } },
});
