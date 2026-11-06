# Reporte de pruebas del frontend contra el backend real

Fecha: 06/11/2026 · Versión probada: 63.0.17 · Instancia CHP01 (base `sistema_eclipse`) · Navegador: Chrome, usuario `prueba`.

## Cómo se probó
1. **Navegador:** se recorrieron las 29 entradas del menú y todas sus pestañas (88 vistas), registrando pantallas rotas, errores de consola y respuestas HTTP con error. Se miraron a mano Stock → Valorizado, el cuadro de alérgenos y el formulario de Productos.
2. **API desde la página** (con la sesión del usuario): pedido y cierre, devolución parcial, stock, alérgenos, etiquetas, ingreso por foto, comprobantes de terceros, clientes, cuenta corriente y remitos. Se usaron los mismos datos que manda cada pantalla.

## Resultado general
- **Ninguna pantalla se rompe** (0 cuadros de «tuvo un problema»). **Valorizado ya no queda en blanco.**
- Los flujos de venta, stock, alérgenos, etiquetas, ingreso por foto, clientes y remitos funcionan de punta a punta.
- Hay **4 fallos** y **3 huecos de diseño**, listados abajo.

## Fallos encontrados (corregidos en la v63.1.0)
| # | Dónde | Qué pasa | Causa | Gravedad |
|---|-------|----------|-------|----------|
| 1 | Recibos y remitos → «Remitos por facturar» | `GET /cuentas-corrientes/remitos-pendientes` da **500** (`Unknown column 'NaN'`) | La pestaña llama sin cliente y el servidor no lo valida (debería responder 400). La pantalla tiene que pedir el cliente antes | Media |
| 2 | Backend (probado por API) | `GET /cuentas-corrientes` sin `cliente_id` da el mismo **500**; la pestaña «Cuentas corrientes» no lo disparó en el recorrido | Misma causa en el backend | Baja |
| 3 | Comisiones → «Mis comisiones» | **400** «Las fechas van como AAAA-MM-DD» al abrir | La pestaña no manda fechas por defecto | Baja |
| 4 | Sucursales → «Ventas consolidadas» y «Stock consolidado» | **400** «Indicá desde y hasta» al abrir | Igual: faltan fechas por defecto (el motor de pantallas necesita filtros con valor inicial) | Baja |

## Huecos de diseño
- **Corregido en la v63.1.0:** el formulario de Productos ahora tiene «Tipo» (estándar, elaborado o servicio) e IVA. Los fallos 1 a 4 también: el servidor responde 400 sin `cliente_id`, «Remitos por facturar» pide el cliente, y Comisiones y Sucursales traen el mes en curso. No lo probé con clics en el navegador.
- **El formulario de Productos no tiene «Tipo».** Solo pide nombre, precio, stock y descripción. Un producto queda siempre «estándar» y **la venta no descuenta los insumos de su receta**: se probó y descontó el producto, no el insumo. Con el tipo en «elaborado» (cambiado por API) sí descontó 18 g. Tampoco hay IVA, código de barras ni tipos pesable/combo/serializado. Es el hueco más importante.
- **«Registrar comprobante» (Proveedores)** crea una reserva de 15 minutos. «Vincular a factura» exige claves **vigentes**, y una clave solo pasa a vigente al confirmar un ingreso. Para vincular un remito hay que cargar los dos comprobantes por un ingreso, no con ese botón.
- **Funciones apagadas:** con el perfil `cafeteria`, 18 funciones vienen apagadas y esas pantallas muestran el aviso del servidor (409). Está bien, pero el menú no las oculta. Con `USU-TABLERO` apagada, el tablero de Inicio da 409; no verifiqué cómo se ve en pantalla.

## Comprobado y funcionando
- Pedido: abrir, agregar productos, cerrar en efectivo, confirmar el ticket y liberar la mesa. El 500 de `POST /pedidos` quedó resuelto con el alta de la instancia.
- Registro de ventas, detalle, devolución parcial (reintegro de $3.500) y listado de devoluciones.
- Stock: ingreso, existencias, kardex, valorizado ($27.000), vencimientos y reposición.
- Alérgenos: declarar «Contiene», se marca «Revisado» y se deriva a la receta. El cuadro muestra lo declarado.
- Etiquetas: peso, góndola y listado de desactualizadas.
- Ingreso por foto: subir PNG → «Sin leer» → cargar datos → asociar línea → confirmar (el servidor valida el CUIT). La imagen se descarga con la sesión.
- Clientes: alta, ficha y búsqueda. Cuenta corriente, remito a cuenta (stock descontado), facturación previa ($7.000 sin diferencias), mora, recibos, fidelización y deudores.
- Inicio: indicadores con datos reales (ventas, ticket promedio, margen).

## No se pudo probar
- **ARCA real** (CAE, libro IVA con datos, control contra ARCA): no hay certificado de homologación.
- **Lectura automática de comprobantes** (la foto quedó «Sin leer»), **balanza, impresora, cajón** y **correo/copias externas**.
- **Interacción fina de la interfaz:** arrastre de mesas en el plano, formularios completos de cada modal, descargas de archivos y el selector de archivo real. Esos casos se probaron por API, no con clics.
- Cocina, reservas y comisiones se probaron sin datos (listas vacías, sin errores).

## Cambios que dejó la prueba en tu base (`sistema_eclipse`)
- **Usuario nuevo `prueba`** (administrador). Conviene borrarlo o cambiarle la contraseña. `admin2` no se tocó (la contraseña CHP01 no funcionó).
- **Módulo Clientes y CC instalado** y **25 funciones activadas** (todas las que no dependen de Compras).
- **Datos de prueba:** salón «Salon QA», mesa 901, producto «Cafe doble QA» (ahora «elaborado»), insumo «Cafe QA», 2 ventas, 1 devolución, 1 ingreso por foto, 1 cliente con cuenta y 1 remito.

## Sugerencia de próximos pasos
1. Repetir el recorrido con clics en los formularios de cada modal.
