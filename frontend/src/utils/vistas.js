// Permiso que hace falta para ver cada pantalla (el servidor valida lo mismo en cada llamada).
export const PERMISO_VISTA = {
  mesas: 'ventas.pedidos.operar',
  productos: 'ventas.catalogo.ver',
  insumos: 'stock.insumos.ver',
  historial: 'ventas.historial.ver',
  usuarios: 'usuarios.gestionar',
  ventas: 'ventas.historial.ver',
  facturacion: 'facturacion.ver',
  stock: 'stock.movimientos.ver',
  produccion: 'stock.produccion.gestionar',
  inventario: 'stock.movimientos.ver',
  calidad: 'stock.trazabilidad.ver',
  proveedores: 'stock.movimientos.ver',
  clientes: 'clientes.ver',
  cocina: 'ventas.pedidos.operar',
  'config-ventas': 'ventas.catalogo.ver',
}
