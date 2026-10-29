// Catálogo de acciones sujetas a permiso (Usuarios RF02): cada módulo registra las suyas. Un permiso
// con `funcion` solo se muestra mientras esa funcionalidad está Activa (RN33, A8); con `modulo`
// distinto de los instalados, tampoco (RN10).
// Permisos que NO están acá a propósito: activar o desactivar funcionalidades es exclusivo del
// Administrador (RN24) y no se puede asignar.
const PERMISOS = [
  { id: 'ventas.pedidos.operar', modulo: 'ventas', descripcion: 'Abrir pedidos, cargar ítems, enviar comandas y ver tickets' },
  { id: 'ventas.cuenta.cobrar', modulo: 'ventas', descripcion: 'Cobrar y cerrar la cuenta de una mesa o silla' },
  { id: 'ventas.pedidos.anular', modulo: 'ventas', descripcion: 'Anular pedidos o ítems cargados' },
  { id: 'ventas.salon.configurar', modulo: 'ventas', descripcion: 'Salones, mesas, sillas y estructuras' },
  { id: 'ventas.catalogo.ver', modulo: 'ventas', descripcion: 'Ver la carta de productos' },
  { id: 'ventas.catalogo.editar', modulo: 'ventas', descripcion: 'Crear y modificar productos, precios y recetas' },
  { id: 'ventas.devoluciones.crear', modulo: 'ventas', descripcion: 'Anular o devolver una venta (con nota de crédito)' },
  { id: 'ventas.reimprimir', modulo: 'ventas', descripcion: 'Reimprimir comprobantes desde el registro de ventas' },
  { id: 'ventas.historial.ver', modulo: 'ventas', descripcion: 'Ver el historial y los gráficos de ventas', admiteAlcance: true },
  { id: 'ventas.historial.exportar', modulo: 'ventas', descripcion: 'Exportar reportes de ventas' },
  { id: 'facturacion.ver', modulo: 'ventas', descripcion: 'Ver comprobantes electrónicos' },
  { id: 'facturacion.claves.ver', modulo: 'ventas', descripcion: 'Ver las claves del secuenciador de comprobantes y sus intentos pendientes' },
  { id: 'facturacion.claves.resolver', modulo: 'ventas', descripcion: 'Liberar una clave bloqueada o validar la numeración contra ARCA' },
  { id: 'facturacion.reintentar', modulo: 'ventas', descripcion: 'Reintentar la emisión de un comprobante' },
  { id: 'stock.insumos.ver', modulo: 'stock', descripcion: 'Ver insumos' },
  { id: 'stock.insumos.editar', modulo: 'stock', descripcion: 'Crear y modificar insumos' },
  { id: 'usuarios.gestionar', modulo: 'usuarios', descripcion: 'Usuarios, terminales y sesiones abiertas' },
  { id: 'usuarios.roles.gestionar', modulo: 'usuarios', descripcion: 'Roles, permisos, excepciones y alcances' },
  { id: 'auditoria.ver', modulo: 'usuarios', descripcion: 'Consultar la auditoría y verificar su integridad' },
  { id: 'integracion.pendientes.ver', modulo: 'usuarios', descripcion: 'Ver la bandeja de pendientes de integración' },
  { id: 'integracion.pendientes.reintentar', modulo: 'usuarios', descripcion: 'Reintentar mensajes rechazados o fallidos' },
  { id: 'integracion.pendientes.descartar', modulo: 'usuarios', descripcion: 'Descartar mensajes con motivo (con autorización de un supervisor)' },
  { id: 'integracion.conciliar', modulo: 'usuarios', descripcion: 'Ejecutar la conciliación de integración bajo demanda' },
  { id: 'auditoria.exportar', modulo: 'usuarios', descripcion: 'Exportar la auditoría' },
];

const NIVELES = ['permitido', 'requiere_autorizacion', 'denegado'];
const TIPOS_ALCANCE = ['propias', 'turno', 'caja', 'deposito', 'sector', 'otro'];

const ids = new Set(PERMISOS.map((p) => p.id));
const existe = (id) => ids.has(id);

module.exports = { PERMISOS, NIVELES, TIPOS_ALCANCE, existe };
