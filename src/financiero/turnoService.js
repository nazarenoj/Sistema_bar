// Turnos de caja (se completa en G3). Por ahora un cobro o una devolución no se asocia a ningún turno.
const paraCobro = async () => ({ turnoId: null, enEspera: false, ajuste: false });
const paraContramovimiento = async () => ({ turnoId: null, enEspera: false });

module.exports = { paraCobro, paraContramovimiento };
