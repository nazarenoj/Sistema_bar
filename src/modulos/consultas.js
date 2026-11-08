// Consultas de lectura que los módulos de abajo ofrecen a Contable (llamada n.º 18 del registro B.5): saldos iniciales, controles cruzados y navegación al documento de origen. Cada módulo
// registra las suyas sin conocer a quien las pide (Contable RN31); Contable las invoca con `llamar(18, 'contable', ...)`, que aplica el tiempo máximo y degrada si el módulo no responde.
const proveedores = new Map(); // `${modulo}.${nombre}` -> fn(args)

const registrar = (modulo, nombre, fn) => { proveedores.set(`${modulo}.${nombre}`, fn); };
const obtener = (modulo, nombre) => proveedores.get(`${modulo}.${nombre}`);
const existe = (modulo, nombre) => proveedores.has(`${modulo}.${nombre}`);
const invocar = async (modulo, nombre, args = {}) => {
  const fn = proveedores.get(`${modulo}.${nombre}`);
  if (!fn) throw new Error(`${modulo} no ofrece la consulta ${nombre}.`);
  return fn(args);
};

module.exports = { registrar, obtener, existe, invocar };
