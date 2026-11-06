# Decisiones de diseño del frontend

Referencia visual: panel de administración clásico (barra lateral, título con migas de pan, contenido en tarjeta, tablas con buscador y paginado), llevado a un tono cálido y relajado sin perder la estructura.

## Armazón
- **Barra lateral** marrón (`cafe-800`), con el bloque del usuario (estado En línea / Sin conexión) y el menú en secciones. El ítem activo es una píldora arena. Se oculta con el botón de la barra superior.
- **Barra superior** clara, con una línea fina abajo. El menú de usuario (cambiar de usuario, cambiar contraseña, cerrar sesión) cuelga de ahí.
- **Título de cada pantalla** con migas de pan a la derecha; el contenido va dentro de una tarjeta blanca con borde fino, esquinas redondeadas (`rounded-2xl`) y sombra suave. El pie muestra la versión (sale de `package.json`).
- Un solo lugar define el menú, el título y las migas: `components/layout/Menu.jsx`. El armazón está en `Layout.jsx`. Una pantalla nueva se suma ahí y en `App.jsx`, con su permiso en `utils/vistas.js`.

## Paleta (`tailwind.config.js`)
| Nombre | Valor | Uso |
|--------|-------|-----|
| `crema` | `#F5F0E6` | Fondo general |
| `cafe` 700 / 800 / 900 | `#5a4030` / `#46301f` / `#352316` | Barra lateral, botones principales, foco, enlaces |
| `arena` 300 | `#C8B48A` | Ítem activo del menú, avatar, bordes de botones secundarios |
| `marca` 50…700 | oliva `#7F8C6A` (500) y variantes | Hover suave, etiquetas, página actual del paginado |
| `stone` | neutros cálidos de Tailwind | Textos, bordes y fondos (no se usa `gray` ni `slate`) |

Los colores con significado no se tocan: verde / rojo / ámbar para estados (libre, ocupado, error, advertencia) y los colores de ventana y mostrador del dibujo del salón.

## Tipografía y movimiento
- **Texto:** Source Sans 3 (clara y legible). **Títulos** (`h1`, `h2`): Lora, serif, para un tono tradicional. Se cargan de Google Fonts desde `index.html`; sin conexión caen a la fuente del sistema y a Georgia.
- **Movimiento:** contenido. Las ventanas entran en 0,15 s, los avisos se deslizan y se van solos, y no hay animaciones decorativas. Con «reducir movimiento» activado en el sistema, todo se apaga.
- **Tablas automáticas:** los títulos de columna salen en español (diccionario en `TablaAuto.jsx`) y nunca se muestran los ID globales ni los `algo_id` que ya traen el nombre.

## Componentes y clases
- `DataTable` (`components/layout/DataTable.jsx`): todo listado largo lo usa. Trae «Mostrar N registros», buscador, orden por columna y paginado en el navegador. Las columnas se declaran con `key`, `titulo`, `render`, `valor`, `align`; las acciones por fila, con `acciones`.
- Clases en `index.css`: `btn` + `btn-azul` (principal, marrón) / `btn-verde` (oliva) / `btn-rojo`; `btn-chico` para botones de fila; `campo` para entradas y selects; `etiqueta` para estados; `paginador`.
- Esquinas redondeadas en botones, campos y tablas; sin cebrado en las filas; encabezado de tabla gris muy claro.

## Reglas
- Los permisos del usuario deciden qué ítems del menú se ven; el servidor vuelve a validarlos en cada llamada.
- Sin conexión no se opera: el aviso rojo de la parte superior y la capa `api` ya lo resuelven; las pantallas no guardan nada en el navegador.
- Toda operación con efecto pasa por `api/index.js` (clave `X-ID-Solicitud`, pedido de autorización a un supervisor). Una pantalla nunca llama a `fetch` directo.
- Los textos van en español rioplatense, sin tecnicismos de la base de datos.

## Pantallas hechas (por permiso)
| Pantalla | Archivo | Permiso |
|----------|---------|---------|
| Inicio (indicadores por período) | `components/Inicio.jsx` | todos |
| Panel de Mesas, Historial, Productos, Insumos, Usuarios, Notificaciones | los de antes, dentro del armazón nuevo | los de antes |
| Registro de ventas (filtros, totales, exportar, detalle) | `ventas/RegistroVentas.jsx` | `ventas.historial.ver` |
| Facturación (comprobantes, libro IVA, estado de ARCA) | `ventas/Facturacion.jsx` | `facturacion.ver` |
| Cocina (tablero de comandas, se renueva cada 10 s) | `ventas/Cocina.jsx` | `ventas.pedidos.operar` |
| Precios y pagos (formas de pago, listas, promociones, monedas) | `ventas/ConfigVentas.jsx` | `ventas.catalogo.ver` |
| Stock (existencias, kardex, ingresos y egresos, valorizado, vencimientos, reposición, depósitos) | `stock/Existencias.jsx` | `stock.movimientos.ver` |
| Ingreso por foto, Alérgenos por artículo | `stock/IngresoFoto.jsx`, `stock/Alergenos.jsx` | `stock.movimientos.ver` |
| Clientes y cuentas (búsqueda, ficha, movimientos, informes de deuda) | `clientes/Clientes.jsx` | `clientes.ver` |

| Producción (órdenes, informe), Inventario (tomas y diferencias), Proveedores (devoluciones, claves y vínculo de remitos), Calidad y trazabilidad (alérgenos, temperaturas, series, etiquetas) | `modulos/stockOperativo.jsx` | los de cada pestaña |
| Reservas, Comisiones, Carta y modificadores | `modulos/ventasExtra.jsx` | `ventas.pedidos.operar` / `ventas.catalogo.ver` |
| Recibos y remitos, Fidelización | `modulos/clientesExtra.jsx` | `clientes.ver` |
| Copias, Correo, Consulta de CUIT, Sucursales, Verificación en dos pasos | `modulos/sistema.jsx` | los de cada pestaña |
| Devolución total de una venta | dentro del detalle de `ventas/RegistroVentas.jsx` | `ventas.devoluciones.crear` |

## Pantallas por configuración
Las pantallas de `components/modulos/` son archivos de configuración sobre `layout/Modulo.jsx`: cada pestaña declara su ruta, filtros, alta, acciones por fila y detalle. Si una respuesta no tiene un formato propio, `TablaAuto` arma las columnas con las claves. Una pantalla nueva de este tipo es una entrada en esos archivos más su registro en `pantallas.jsx`, `vistas.js` y `Menu.jsx`.

Un tipo de pestaña se puede ampliar sin tocar el motor: `mensaje` de una acción puede ser una función de la respuesta (así se muestra el código de una etiqueta recién generada).

## Pantallas a medida
Cuando una operación no cabe en el motor (subir un archivo, revisar línea por línea) va en su propio componente:
- `stock/Existencias.jsx`: stock, kardex, ingresos y egresos, valorizado, vencimientos, reposición y depósitos.
- `stock/Alergenos.jsx`: declaración de alérgenos por producto o insumo (Contiene / Trazas / No tiene).
- `stock/IngresoFoto.jsx`: sube la foto o el PDF de un comprobante de proveedor (`api.llamar(..., { archivo })` lo envía tal cual), permite cargar los datos a mano si no se pudo leer, asociar cada línea a un artículo y confirmar el ingreso.
- `layout/Contencion.jsx`: si una pantalla falla al dibujarse, muestra un cuadro con el detalle en vez de dejar la página en blanco; se renueva al cambiar de pantalla.

## Operaciones sin interfaz
Ya tienen pantalla todas las operaciones de la API salvo el mantenimiento del padrón de ARCA, que no existe como operación: el padrón solo se consulta (Consulta de CUIT). El peso de las etiquetas, el prefijo propio, el vínculo de remitos con facturas de proveedor y el ingreso por foto se hacen desde Calidad y trazabilidad, Proveedores e Ingreso por foto.
