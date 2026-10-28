// Puertos (Índice B.2): interfaces que define el módulo de la capa inferior y que implementa el de
// la superior. Sin el módulo implementador, `obtener` devuelve la implementación nula, con el
// comportamiento definido en el SPEC: la función se oculta o se degrada, nunca se rompe la venta.
const PUERTOS = {
  // Ventas define; Clientes y CC implementa.
  credito: {
    define: 'ventas', implementa: 'clientes',
    nula: { disponible: false, veredicto: async () => ({ ofrecido: false }), retenerSaldo: async () => ({ ofrecido: false }) },
  },
  // Ventas define; Compras implementa. Sin Compras los precios son manuales.
  costoReposicion: { define: 'ventas', implementa: 'compras', nula: { costo: async () => null } },
  // Ventas define; Stock implementa. Sin Stock, la venta no tiene costo.
  costoInventario: { define: 'ventas', implementa: 'stock', nula: { costo: async () => null } },
  // Ventas define; Stock implementa. La venta nunca se bloquea por falta de existencias.
  stock: {
    define: 'ventas', implementa: 'stock',
    nula: { disponibilidad: async () => ({ bloqueado: false }), descontarPorVenta: async () => {} },
  },
  // Ventas define; Financiero implementa. Ventas discrimina por forma de pago sin afectar cajas.
  cobros: { define: 'ventas', implementa: 'financiero', nula: { registrarCobro: async () => null } },
  // Stock define; Compras implementa. El plazo se define por ítem.
  plazosEntrega: { define: 'stock', implementa: 'compras', nula: { plazo: async () => null } },
  // Usuarios define; cada módulo implementa. El módulo no aporta indicadores ni paquetes.
  indicadores: { define: 'usuarios', implementa: '*', nula: { indicadores: async () => [] } },
};

const registrados = new Map(); // nombre -> implementación (las registran los módulos al arrancar)

const registrar = (nombre, implementacion) => {
  if (!PUERTOS[nombre]) throw new Error(`El puerto "${nombre}" no existe (Índice B.2).`);
  registrados.set(nombre, implementacion);
};

// Lo que hay que usar desde el módulo que define el puerto. `instalado` = el módulo implementador
// está instalado en la instancia de la request.
const obtener = async (nombre) => {
  const p = PUERTOS[nombre];
  if (!p) throw new Error(`El puerto "${nombre}" no existe (Índice B.2).`);
  const impl = registrados.get(nombre);
  if (!impl) return p.nula;
  const { estaInstalado } = require('./registro');
  return p.implementa === '*' || (await estaInstalado(p.implementa)) ? impl : p.nula;
};

module.exports = { PUERTOS, registrar, obtener };
