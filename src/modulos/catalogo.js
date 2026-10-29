// Módulos del sistema, sus capas (Índice B.1) y de quién dependen. Una capa solo puede llamar a las
// inferiores; los de una misma capa N3 no se llaman entre sí. Lo que un módulo necesita saber de
// otro de arriba se recibe por eventos o por un puerto (src/modulos/puertos.js), nunca por llamada.
//
// `archivos` dice a qué módulo pertenece cada archivo de src/: lo usa la prueba de arquitectura
// (test/arquitectura.test.js) para comparar los require reales contra estas reglas.
const MODULOS = {
  usuarios: {
    nombre: 'Usuarios y Auditoría', capa: 0, dependeDe: [], obligatorio: true,
    archivos: [
      /^(config|db|instancias|permisos|modulos|funciones|mensajeria|reservas)\//, /^server\.js$/,
      /^middleware\/(auth|instancia|requiere|solo|idempotencia|hora|errorHandler|requestLogger)/,
      /^utils\//,
      /^(controllers|routes)\/(auth|usuario|terminal|sesion|rol|auditoria|modulo|funcion|notificacion|integracion|mensaj)/,
      /^models\/(user|sesion|terminal|parametro|permiso|auditoria|instancia|modulo|funcion|notificacion|mensaj)/,
      /^(servicios|trabajadores)\//,
    ],
  },
  ventas: {
    nombre: 'Ventas', capa: 1, dependeDe: ['usuarios'],
    archivos: [
      /^(controllers|routes)\/(estructura|factura|mesa|pedido|producto|catalogo|salon|silla|ticket|venta|formaPago|devolucion|registroVentas)/,
      /^models\/(estructura|factura|mesa|pedido|producto|salon|silla)/,
      /^afip\//, /^services\//,
    ],
  },
  stock: {
    nombre: 'Stock e Insumos', capa: 2, dependeDe: ['usuarios', 'ventas'],
    archivos: [/^(controllers|routes)\/insumo/, /^models\/insumo/],
  },
  financiero: { nombre: 'Financiero', capa: 2, dependeDe: ['usuarios', 'ventas'], archivos: [], noConstruido: true },
  clientes: { nombre: 'Clientes y CC', capa: 3, dependeDe: ['usuarios', 'ventas', 'stock'], archivos: [], noConstruido: true }, // se quita al construir la Fase E
  compras: { nombre: 'Compras', capa: 3, dependeDe: ['usuarios', 'ventas', 'stock'], archivos: [], noConstruido: true },
  contable: { nombre: 'Contable', capa: 4, dependeDe: ['usuarios', 'ventas', 'stock', 'clientes'], archivos: [], noConstruido: true },
  ventas_online: { nombre: 'Ventas Online', capa: 4, dependeDe: ['usuarios', 'ventas', 'stock', 'clientes'], archivos: [], noConstruido: true },
};

module.exports = { MODULOS };
