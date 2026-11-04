// Pantallas de los módulos: una por entrada del menú (id = id de Menu.jsx y de utils/vistas.js).
import RegistroVentas from './ventas/RegistroVentas'
import Facturacion from './ventas/Facturacion'
import Existencias from './stock/Existencias'
import Clientes from './clientes/Clientes'

export const PANTALLAS = {
  ventas: RegistroVentas,
  facturacion: Facturacion,
  stock: Existencias,
  clientes: Clientes,
}
