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
  { id: 'ventas.promociones.gestionar', modulo: 'ventas', funcion: 'VEN-PROMOS', descripcion: 'Crear, editar y pausar promociones' },
  { id: 'ventas.promociones.bajo_costo', modulo: 'ventas', funcion: 'VEN-PROMOS', descripcion: 'Confirmar una promoción que deja un artículo por debajo del costo' },
  { id: 'ventas.cocina.retroceder', modulo: 'ventas', funcion: 'VEN-KDS', descripcion: 'Retroceder el estado de una comanda en la pantalla de cocina' },
  { id: 'ventas.agotados.marcar', modulo: 'ventas', funcion: 'VEN-KDS', descripcion: 'Marcar y quitar artículos agotados' },
  { id: 'ventas.agotados.vender', modulo: 'ventas', funcion: 'VEN-KDS', descripcion: 'Vender un artículo agotado (con el modo "advertir")' },
  { id: 'ventas.movil.supervisar', modulo: 'ventas', funcion: 'VEN-MOVIL', descripcion: 'Ver los conflictos de sincronización de todos los dispositivos' },
  { id: 'ventas.comisiones.gestionar', modulo: 'ventas', funcion: 'VEN-COMISIONES', descripcion: 'Definir reglas de comisión, liquidarlas y marcarlas como pagadas' },
  { id: 'ventas.precios.actualizar', modulo: 'ventas', descripcion: 'Actualizar precios del catálogo (por porcentaje, monto o lista), programarlos y revertirlos' },
  { id: 'ventas.historial.ver', modulo: 'ventas', descripcion: 'Ver el historial y los gráficos de ventas', admiteAlcance: true },
  { id: 'ventas.historial.exportar', modulo: 'ventas', descripcion: 'Exportar reportes de ventas' },
  { id: 'facturacion.ver', modulo: 'ventas', descripcion: 'Ver comprobantes electrónicos' },
  { id: 'facturacion.claves.ver', modulo: 'ventas', descripcion: 'Ver las claves del secuenciador de comprobantes y sus intentos pendientes' },
  { id: 'facturacion.claves.resolver', modulo: 'ventas', descripcion: 'Liberar una clave bloqueada o validar la numeración contra ARCA' },
  { id: 'facturacion.reintentar', modulo: 'ventas', descripcion: 'Reintentar la emisión de un comprobante' },
  { id: 'stock.movimientos.ver', modulo: 'stock', descripcion: 'Ver existencias, kardex y mermas' },
  { id: 'stock.movimientos.registrar', modulo: 'stock', descripcion: 'Registrar ingresos, egresos, transferencias y correcciones de stock' },
  { id: 'stock.inventario.aprobar', modulo: 'stock', descripcion: 'Aprobar una toma de inventario y sus ajustes' },
  { id: 'stock.produccion.gestionar', modulo: 'stock', funcion: 'STK-PRODUCCION', descripcion: 'Crear, ajustar y confirmar órdenes de producción y ver la ficha técnica' },
  { id: 'stock.alergenos.gestionar', modulo: 'stock', funcion: 'STK-ALERGENOS', descripcion: 'Administrar el catálogo de alérgenos y declararlos en insumos y artículos' },
  { id: 'stock.alergenos.quitar', modulo: 'stock', funcion: 'STK-ALERGENOS', descripcion: 'Quitar un alérgeno derivado de un artículo (con motivo auditado)' },
  { id: 'stock.trazabilidad.ver', modulo: 'stock', funcion: 'STK-TRAZA', descripcion: 'Consultar la trazabilidad de un lote y los retiros' },
  { id: 'stock.trazabilidad.retirar', modulo: 'stock', funcion: 'STK-TRAZA', descripcion: 'Retirar y liberar un lote (con supervisor)' },
  { id: 'stock.temperaturas.registrar', modulo: 'stock', funcion: 'STK-TEMP', descripcion: 'Registrar temperaturas, acciones correctivas y listas de verificación' },
  { id: 'stock.temperaturas.configurar', modulo: 'stock', funcion: 'STK-TEMP', descripcion: 'Definir puntos de control, rangos, frecuencias y listas de verificación' },
  { id: 'stock.series.gestionar', modulo: 'stock', funcion: 'STK-SERIE', descripcion: 'Ingresar, comprometer, vender y devolver series y consultar su historial' },
  { id: 'stock.series.baja', modulo: 'stock', descripcion: 'Dar de baja o convertir series (con supervisor)' },
  { id: 'stock.etiquetas.gestionar', modulo: 'stock', funcion: 'STK-ETIQUETAS', descripcion: 'Imprimir etiquetas, definir plantillas y códigos de peso' },
  { id: 'stock.insumos.ver', modulo: 'stock', descripcion: 'Ver insumos' },
  { id: 'stock.insumos.editar', modulo: 'stock', descripcion: 'Crear y modificar insumos' },
  { id: 'usuarios.cotizaciones.cargar', modulo: 'usuarios', descripcion: 'Cargar cotizaciones de monedas extranjeras a mano' },
  { id: 'usuarios.copias.gestionar', modulo: 'usuarios', descripcion: 'Copias de seguridad: configurar la clave, generar, descargar y restaurar' },
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
