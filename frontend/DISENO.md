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

## Componentes y clases
- `DataTable` (`components/layout/DataTable.jsx`): todo listado largo lo usa. Trae «Mostrar N registros», buscador, orden por columna y paginado en el navegador. Las columnas se declaran con `key`, `titulo`, `render`, `valor`, `align`; las acciones por fila, con `acciones`.
- Clases en `index.css`: `btn` + `btn-azul` (principal, marrón) / `btn-verde` (oliva) / `btn-rojo`; `btn-chico` para botones de fila; `campo` para entradas y selects; `etiqueta` para estados; `paginador`.
- Esquinas redondeadas en botones, campos y tablas; sin cebrado en las filas; encabezado de tabla gris muy claro.

## Reglas
- Los permisos del usuario deciden qué ítems del menú se ven; el servidor vuelve a validarlos en cada llamada.
- Sin conexión no se opera: el aviso rojo de la parte superior y la capa `api` ya lo resuelven; las pantallas no guardan nada en el navegador.
- Toda operación con efecto pasa por `api/index.js` (clave `X-ID-Solicitud`, pedido de autorización a un supervisor). Una pantalla nunca llama a `fetch` directo.
- Los textos van en español rioplatense, sin tecnicismos de la base de datos.
