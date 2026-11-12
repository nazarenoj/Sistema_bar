// Pantallas de los módulos: una por entrada del menú (id = id de Menu.jsx y de utils/vistas.js).
import RegistroVentas from './ventas/RegistroVentas'
import Facturacion from './ventas/Facturacion'
import Existencias from './stock/Existencias'
import Clientes from './clientes/Clientes'
import { Produccion, Inventario, Calidad, Proveedores } from './modulos/stockOperativo'
import { Reservas, Comisiones, Carta } from './modulos/ventasExtra'
import { Cobranzas, Fidelizacion } from './modulos/clientesExtra'
import { Copias, Correo, Padron, Consolidacion, Seguridad } from './modulos/sistema'
import { Contable } from './modulos/contable'
import { FinCajas, FinPagos, FinCobros, FinInformes } from './modulos/financiero'
import { ComProveedores, ComComprobantes, ComPagos, ComAbastecimiento } from './modulos/compras'
import { VentasOnline } from './modulos/ventasOnline'
import Alergenos from './stock/Alergenos'
import IngresoFoto from './stock/IngresoFoto'
import Inicio from './Inicio'
import Cocina from './ventas/Cocina'
import ConfigVentas from './ventas/ConfigVentas'

export const PANTALLAS = {
  ventas: RegistroVentas,
  facturacion: Facturacion,
  stock: Existencias,
  clientes: Clientes,
  inicio: Inicio,
  alergenos: Alergenos,
  'ingreso-foto': IngresoFoto,
  copias: Copias,
  correo: Correo,
  padron: Padron,
  consolidacion: Consolidacion,
  seguridad: Seguridad,
  reservas: Reservas,
  comisiones: Comisiones,
  carta: Carta,
  cobranzas: Cobranzas,
  fidelizacion: Fidelizacion,
  produccion: Produccion,
  inventario: Inventario,
  calidad: Calidad,
  proveedores: Proveedores,
  cocina: Cocina,
  contable: Contable,
  'fin-cajas': FinCajas, 'fin-pagos': FinPagos, 'fin-cobros': FinCobros, 'fin-informes': FinInformes,
  'com-proveedores': ComProveedores, 'com-comprobantes': ComComprobantes, 'com-pagos': ComPagos, 'com-abastecimiento': ComAbastecimiento,
  'ventas-online': VentasOnline,
  'config-ventas': ConfigVentas,
}
