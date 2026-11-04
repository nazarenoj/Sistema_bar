// Pantallas de los módulos: una por entrada del menú (id = id de Menu.jsx y de utils/vistas.js).
import RegistroVentas from './ventas/RegistroVentas'
import Facturacion from './ventas/Facturacion'
import Existencias from './stock/Existencias'
import Clientes from './clientes/Clientes'
import { Produccion, Inventario, Calidad, Proveedores } from './modulos/stockOperativo'
import { Reservas, Comisiones, Carta } from './modulos/ventasExtra'
import { Cobranzas, Fidelizacion } from './modulos/clientesExtra'
import Inicio from './Inicio'
import Cocina from './ventas/Cocina'
import ConfigVentas from './ventas/ConfigVentas'

export const PANTALLAS = {
  ventas: RegistroVentas,
  facturacion: Facturacion,
  stock: Existencias,
  clientes: Clientes,
  inicio: Inicio,
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
  'config-ventas': ConfigVentas,
}
