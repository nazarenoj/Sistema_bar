const llamar = require('../modulos/llamar');
const Consultas = require('../modulos/consultas');
const Modulos = require('../modulos/registro');

// Consultas de Contable hacia los módulos de abajo (llamada n.º 18): saldos iniciales, controles cruzados y navegación al documento de origen. Un módulo que no responde (o no ofrece la
// consulta) devuelve «no disponible» y la contabilidad sigue: la política de la llamada es degradar.
const consultar = async (modulo, nombre, args) => {
  if (!(await Modulos.estaInstalado(modulo))) return { disponible: false, instalado: false, motivo: `El módulo ${modulo} no está instalado.` };
  if (!Consultas.existe(modulo, nombre)) return { disponible: false, instalado: true, motivo: `${modulo} no ofrece la consulta ${nombre}.` };
  const r = await llamar(18, 'contable', () => Consultas.invocar(modulo, nombre, args));
  if (r.fallo) return { disponible: false, instalado: true, motivo: `${modulo} no respondió: ${r.motivo}.` };
  return { disponible: true, instalado: true, valor: r.valor };
};

module.exports = { consultar };
