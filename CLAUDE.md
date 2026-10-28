# Proyecto: Sistema de Gestión para Cafetería

## Contexto del negocio
Producto para **vender a múltiples clientes** del rubro cafetería y producción de alimentos, de
distintos tamaños (incluye empresas más grandes, con varias sucursales y varios usuarios con
permisos distintos). Ya no es un sistema a medida para una sola cafetería: el código se diseña para
que dar de alta un cliente nuevo sea fácil y no requiera tocar código.

Origen: el sistema nació para una cafetería local (2 usuarios, una sucursal). Esa operación sigue
siendo el primer cliente y el piloto.

## Estado actual (qué existe hoy)
Mesas/salones/sillas, pedidos y cierre de cuenta con método de pago, carta de productos, insumos y
recetas (descuento de stock al cerrar), facturación electrónica ARCA/AFIP con CAE (A/B/C, PDF y QR),
tickets, historial paginado con gráficos y reportes (CSV/Excel/PDF/JSON), usuarios con sesiones, terminales, roles y
permisos reales, auditoría, funciones activables y varias instancias en la misma app (plataforma de la
Fase A completa, v6.0.0).

## Dirección del producto
- **Plan de referencia**: `plan-tecnico-desarrollo.md` (basado en los SPECS 00 a 08 y Anexos). Es la
  visión a largo plazo; no todo se implementa de golpe. Se avanza por fases y lo que ya existe se
  evoluciona, no se tira.
- **Cada cliente es una instancia independiente** (su propia base de datos, usuarios, configuración
  y credenciales ARCA). Nada de datos de varios clientes mezclados en las mismas tablas.
- **Funciones activables por cliente**: lo que no todos usan (facturación, insumos/recetas, etc.) se
  prende o apaga por configuración, no con ramas de código por cliente.
- **Sin código específico de un cliente**: diferencias de precios, rubros, puntos de venta, textos o
  logos van en configuración/datos, nunca hardcodeadas.
- **Permisos reales por rol** pasan a ser necesarios (clientes grandes). El campo `rol` ya existe.
- **Multi-sucursal** pasa a estar en alcance (antes estaba descartado).
- Agregar un cliente debería ser un proceso repetible (script/comando de alta), no manual.

## Decisiones técnicas tomadas
- **Hosting**: Hostinger.
- **Aislamiento**: una base de datos por **instancia**. El SPEC de Usuarios (RN22, RN79) define que
  cada sucursal es una instancia independiente (usuarios, roles, auditoría, cajas y copias propios):
  un cliente de una sola sucursal tiene una base; uno con varias sucursales, una por sucursal.
- **Motor**: se queda en **MySQL** (Hostinger no ofrece PostgreSQL fuera de un VPS). Mantener el SQL
  simple y concentrado en `src/models` para poder migrar a PostgreSQL más adelante. Dinero siempre
  `DECIMAL`, nunca flotantes. Los scripts de migración deben ser idempotentes (`IF NOT EXISTS`),
  porque el DDL de MySQL no es transaccional.
- **Evolutivo, no reescritura**: se evoluciona el código actual en lugar de rehacerlo según el plan
  (TypeScript/NestJS). TypeScript, si se usa, se suma de a poco. Se reconsidera solo si un módulo
  se vuelve inmanejable.
- **Una sola app para todos los clientes**: la app resuelve a qué base conectarse según el cliente
  de cada request (pool de conexiones por cliente), en vez de desplegar una app por cliente.

- **ID_Global** de todo documento: `<CODIGO_INSTANCIA>-<ULID>`, con la hora del servidor, columna
  `id_global` única. Ninguna integración, mensaje ni clave de idempotencia usa el id interno
  autoincremental ni el número visible (que puede repetirse tras restaurar una copia).
- **Periféricos desde el navegador** (sin instalar nada en el local): lector de códigos como
  teclado USB; impresoras de tickets y comandas por una cola de impresión que consume la terminal
  a la que pertenecen (Web Serial/WebUSB con ESC/POS, o impresión silenciosa del navegador de
  respaldo); cajón por el pulso de la impresora; balanza por Web Serial con lectura estable, y
  peso manual con permiso como respaldo. Detalle en `plan-checkpoints.md`.
- **Llamadas entre módulos que fallan**: la lista cerrada y la política de falla de cada una
  (cerrar, abrir con autorización o degradar) están en el Anexo B.5 del índice de SPECS y en
  `plan-checkpoints.md`; una llamada que no figura ahí no puede existir.
- **Migraciones**: el esquema vive en `database/migraciones/NNN_*.sql` y lo aplica
  `src/db/migrador.js` (al arrancar la app, con `npm run migrar` o con `npm run alta` para una
  instancia nueva). Una migración ya aplicada no se edita: los cambios van en una migración nueva,
  y como el DDL de MySQL no es transaccional, cada archivo tiene que poder re-ejecutarse (ver el
  patrón de la 002). `database/legacy/` es solo historia.
- **Pruebas**: `npm test` (node:test) corre contra un MySQL/MariaDB local descartable, con las
  variables `DB_HOST`, `DB_USER`, `DB_PASSWORD` y `DB_PORT`; crea y borra su propia base y se niega a
  correr contra un servidor remoto salvo `TEST_PERMITIR_REMOTO=1`.
- **Instancias**: cada cliente o sucursal es una instancia (su propia base). `instancias.json` (no se
  versiona; ejemplo en `instancias.example.json`) las lista con su código, base, direcciones web y datos de
  ARCA; sin archivo hay una sola instancia `DEFAULT` con el `.env`. La app resuelve la instancia de cada
  request (cabecera `X-Instancia` o dirección web) y los modelos usan `pool` sin saber de instancias
  (`src/instancias/registro.js`). Alta: `npm run alta -- ... --registrar`.
- **Plataforma (Fase A)**: permisos por rol con `requierePermiso(accion)` (catálogo en
  `src/permisos/catalogo.js`; las acciones nuevas de cada módulo se suman ahí y en una migración con
  los niveles de cada rol), auditoría encadenada con `auditar(req, ...)`, funciones activables
  (`src/funciones/catalogo.js`, estado en la base), módulos y llamadas entre módulos
  (`src/modulos/`: solo por `llamar(n, ...)` o por un puerto), mensajería entre módulos
  (`src/mensajeria/`: `publicar` dentro de la transacción del documento y un receptor idempotente),
  reservas con vencimiento (`src/reservas/`), idempotencia por `X-ID-Solicitud` y notificaciones. La
  prueba `test/arquitectura.test.js` rechaza cruces de capas que no estén en el registro.
- **Arranque limpio de datos**: esquema nuevo desde cero (migración `001`), sin migrar pedidos ni
  facturas del cliente actual. Los scripts viejos de `database/` pasan a `database/legacy/`.
- **Mensajería entre módulos**: bandeja de salida en la misma base, con un trabajador dentro de la
  misma app, sin broker externo.

## Alcance y prioridad
Se desarrollan **en su totalidad**, según `SPECS/`, estos módulos y en este orden de importancia:
**Ventas, Usuarios y Auditoría, Stock, Clientes y CC**. Financiero, Compras, Contable y Ventas
Online no se construyen por ahora: se tratan como puertos con implementación nula (la venta
funciona igual sin ellos). El plan de trabajo, con checkpoints y criterios de aceptación, está en
`plan-checkpoints.md`; es la referencia para saber qué sigue. Los SPECS están en `SPECS/`
(`00-indice-y-decisiones.md` trae el catálogo de funciones, los perfiles de rubro, las capas, los
puertos, los eventos y la lista cerrada de llamadas entre módulos). Los números RF/RN/EX nunca se
renumeran: se citan siempre por módulo y número (ej. `Ventas RN12`).

## Decisiones técnicas pendientes (no asumir, consultar antes)
- Límites del plan de Hostinger: cantidad de bases de datos y de apps Node permitidas, y versión
  exacta de MySQL/MariaDB. Confirmar antes de comprometer un número de clientes.
- Prueba de campo de los periféricos con el equipo real del cliente piloto (checkpoint B0): si la
  balanza no habla por puerto serie, se reabre la decisión de periféricos.

## Stack tecnológico (actual)
- **Backend**: Node.js
- **Frontend**: React
- **Base de datos**: MySQL
- **Hosting**: Hostinger
- Desarrollo asistido por Claude Code (sin equipo adicional)

## Versionado del sistema
El sistema usa un único número de versión `MAJOR.MINOR.PATCH`, arrancando en **1.0.0**. No es
semver estándar (no indica compatibilidad hacia atrás): cada posición identifica qué capa cambió.

- **MAJOR** (primer número): cambios en la base de datos — esquema, migraciones, cualquier script
  en `database/*.sql` (`ALTER TABLE`, tabla nueva, columna nueva, índice nuevo, etc.).
- **MINOR** (segundo número): cambios en el backend (Node.js: `src/controllers`, `src/models`,
  `src/services`, `src/routes`, `src/middleware`) que NO tocan el esquema de la base de datos.
- **PATCH** (tercer número): cambios en el frontend (React, `frontend/src`) que no tocan backend
  ni base de datos.

Reglas:
- Subir un número más significativo reinicia los de la derecha a 0 (ej: un cambio de base de
  datos lleva 1.3.7 → 2.0.0, no 2.3.7).
- Si un cambio toca más de una capa a la vez (ej: una migración nueva + el endpoint que la usa),
  se sube el número de la capa más significativa involucrada — en ese ejemplo, MAJOR, porque
  incluye base de datos.
- La versión vive en el campo `"version"` de `package.json` (raíz del repo); `frontend/package.json`
  se mantiene igual a ese mismo número por consistencia, aunque no se lee de ahí en tiempo de
  ejecución. El backend expone ese valor en `GET /api` y `GET /health` (leído directo de
  `package.json`, no hardcodeado).
- Cada vez que se haga un cambio que corresponda a una de estas categorías, hay que actualizar
  `package.json` (raíz) como parte del mismo commit.
