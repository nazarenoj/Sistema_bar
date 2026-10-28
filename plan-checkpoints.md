# Plan de checkpoints: Ventas, Usuarios, Stock y Clientes

Base: `SPECS/00-indice-y-decisiones.md` (anexos A, B y C), `SPECS/04-usuarios-auditoria.md` (28 RF, 88 RN, 59 EX), `SPECS/01-ventas.md` (51 RF, 87 RN, 62 EX), `SPECS/02-stock-insumos.md` (42 RF, 88 RN, 63 EX) y `SPECS/03-clientes-cuentas-corrientes.md` (31 RF, 43 RN, 34 EX). Parte del código actual (v3.4.0, MySQL, Express + React) y de `CLAUDE.md`.

## Decisiones tomadas

- **Alcance**: Ventas, Usuarios, Stock y Clientes **en su totalidad**, en ese orden de importancia. Se ignora todo lo que solo puede funcionar con un módulo que no existe (Financiero, Compras, Contable, Ventas Online).
- **Datos**: arranque **limpio**. Esquema nuevo desde cero (migración `001`), sin migrar pedidos ni facturas del cliente actual. Los scripts viejos de `database/` pasaron a `database/legacy/` y no se usan; el esquema vive en `database/migraciones/`.
- **Mensajería**: bandeja de salida en la misma base, con un trabajador dentro de la misma app, sin broker externo.
- **Arquitectura** (de `CLAUDE.md`): evolutivo sobre el código actual, MySQL, una base por instancia (ver pendiente 1), una sola app para todos.
- **Decisiones fundacionales del índice (F1 a F4)**: servidor en la nube por cliente y sistema puramente online, `ID_Global` para todo documento, intento/efecto con `Reemplaza_A`, y reservar–confirmar–vencer. Ya están reflejadas en A1, A3, A9, A10 y A11.
- **Fuera de alcance**: Financiero, Compras, Contable y Ventas Online no existen. Se tratan como piden los SPECS: **puertos con implementación nula** (Ventas RN01). La venta funciona igual sin ellos.

## Decisiones técnicas cerradas

Las tres quedaban a validar en el índice (puntos 32 y 31 de "Para confirmar" y las filas con * de B.5). Quedan decididas así.

### 1. Formato del `ID_Global` (Usuarios RN81)

`<CODIGO_INSTANCIA>-<ULID>`, por ejemplo `CHP01-01JBX4M9Q3TZ8R2V6N5KDW7YHE`.

- **Código de instancia**: 2 a 10 caracteres `A-Z0-9`, único entre las instancias del mismo cliente, fijado en el alta (A2) y que no se cambia.
- **ULID**: 26 caracteres en base 32 (Crockford). 48 bits de milisegundos con la hora **del servidor** (RN21) más 80 bits aleatorios. Ordenable por fecha de creación; dentro del mismo milisegundo se incrementa el aleatorio para que siga ordenando.
- **Por qué no se repite tras restaurar**: la unicidad sale de la hora más el azar, no de un contador que pueda volver atrás (RN81). Un documento nuevo posterior a la restauración nunca coincide con uno anterior.
- **Almacenamiento**: columna `id_global` `VARCHAR(40)` ascii binario, con índice único, en cada tabla de documentos. Cada tabla conserva además una clave interna autoincremental solo para joins locales: **ninguna integración, mensaje, vínculo ni clave de idempotencia la usa**.
- **Implementación**: una función de unas 20 líneas con `crypto.randomBytes`, sin dependencia nueva. Vive en A3 y la usan todos los módulos.
- **Número visible**: el número de venta, de pedido o de comprobante que ve la persona es otro campo y puede repetirse tras restaurar. Los comprobantes fiscales conservan además su número de ARCA.

### 2. Periféricos desde el navegador (índice, punto 31)

Se respeta RN79: no se instala nada en el local. Solo se usa lo que trae el navegador, con HTTPS y Chrome o Edge en las terminales que lo necesitan.

| Dispositivo | Solución | Si no funciona |
|-------------|----------|----------------|
| **Lector de códigos** | USB que se comporta como teclado (modo HID): escribe en el campo enfocado. No hay que programar nada | |
| **Impresora de tickets y de comandas** | Cada impresora pertenece a una **terminal** (Usuarios RF07). El servidor mantiene una **cola de impresión**; la página de esa terminal la consume y imprime en el equipo. Dos vías, en este orden: (1) WebUSB / Web Serial con comandos ESC/POS, sin diálogo; (2) impresión del navegador con hoja de 80 mm y el modo "impresión silenciosa" de Chrome, que es una opción del acceso directo y no un programa | Los trabajos quedan en cola, se avisa a la terminal y se puede reimprimir, redirigir a otra impresora o bajar un PDF (Ventas EX08, EX14) |
| **Cajón de dinero** | Conectado a la impresora (puerto RJ11): se abre con el comando de pulso ESC/POS que va en el mismo ticket. Sin API aparte | Se abre a mano; no bloquea la venta |
| **Balanza** | Web Serial (USB o serie) en las terminales con Chrome o Edge. Un adaptador por protocolo de balanza, empezando por el de línea ASCII continua. Solo se acepta una lectura **estable** (Ventas RN04) | Ingreso manual con permiso y motivo obligatorio (RN04, EX55), o etiqueta propia con el peso (`STK-ETIQUETAS`, Ventas RN71) |

Consecuencias:
- Las tablets y celulares del mozo (`VEN-MOVIL`) no necesitan periféricos: solo cargan pedidos y la comanda sale por la cola de la terminal de destino.
- Safari y iPhone no tienen Web Serial ni WebUSB: imprimen por el diálogo del sistema y no leen balanza.
- Lo que no se puede resolver con esto (por ejemplo una balanza sin puerto serie) obliga a reabrir RN79 con un programa puente local. Se decide recién después de la prueba B0.

### 3. Políticas de falla de las llamadas con * (Anexo B.5)

Las tres que están en alcance. Confirman la propuesta del índice y le agregan el detalle de implementación. (Las de las filas 15, 16, 18 y 19 son de módulos que no se construyen.)

| # | Llamada | Política | Detalle |
|---|---------|----------|---------|
| 4 | Ventas → Stock: validar etiqueta propia y lotes disponibles | **Degradar** (3 s) | Etiqueta propia: si Stock no responde, **no se acepta el peso embebido**; el producto se pesa en balanza (Ventas RN71). Lotes: el campo "lote indicado" no se ofrece y Stock asigna por FEFO. Nunca bloquea la venta |
| 12 | Clientes → Ventas: emitir ND/NC y consultar padrón | **Degradar** (el timeout de la emisión de Ventas, 15 s) | La nota queda **"Pendiente de emisión"** y visible en la cuenta; se reintenta sola con la **misma `ID_Solicitud`** (5 s, 30 s, 2 min, 10 min, luego cada 10 min hasta 24 h). Si se agota, pasa a la bandeja de pendientes. El saldo de la cuenta cambia solo cuando el comprobante queda autorizado. Las notas internas no fiscales no usan esta llamada. Padrón: carga manual |
| 17 | Stock → Ventas: ventas del período | **Degradar** (3 s) | Es de solo lectura. El informe de diferencias de integración muestra "no disponible", se reintenta en la corrida diaria y a pedido, y **no bloquea** la toma de inventario ni ningún cierre |

---

## Pendientes que bloquean

1. **Aclaración de "una base por cliente"**: el SPEC de Usuarios (RN22, RN79) define que **cada sucursal es una instancia independiente** (sus propios usuarios, roles, auditoría, cajas y copias). Por eso la unidad es la **instancia**: un cliente de una sola sucursal tiene una base; uno con tres sucursales, tres bases (más la Casa Central si usa consolidación).
2. **Faltan los Anexos D (matriz de cobertura) y E (matriz de pruebas y escenarios), `cambios-aplicados.md` y `herramientas/generar-matriz-pares.py`.** Los Anexos A (catálogo y perfiles), B (capas, puertos, eventos y llamadas inmediatas) y C (costos) sí están, en `SPECS/00-indice-y-decisiones.md`. Sin el Anexo E, las pruebas de aceptación salen de las RN/EX de cada módulo y no de los 37 + 28 escenarios del SPEC. Los SPECS 05 a 08 (Financiero, Contable, Compras, Ventas Online) tampoco están y no hacen falta.
3. **Cliente piloto**: el sistema actual (v3.x) sigue en producción hasta que el nuevo llegue al primer corte (B6 + C3). Con arranque limpio no hay puente entre ambos.
4. **Prueba de campo de periféricos**: la decisión 2 de arriba está tomada, pero hay que probarla con la impresora y la balanza reales del cliente piloto (B0). Si la balanza no habla por puerto serie, se reabre.

## Relevamiento del código actual (26/10/2026, v3.4.0)

Salido de leer `src/` (4.651 líneas, 10 controladores, 9 modelos, 5 servicios), `database/`, el `App.jsx` del frontend y el historial de git. Los estados de la columna "Estado" de las tablas de abajo están actualizados con esto.

- **Qué hay**: 4 vistas en el frontend (mesas, productos, insumos, historial); API con 13 tablas; salones, mesas, sillas, estructuras y unión de mesas; pedidos por silla; cierre de cuenta transaccional; productos con receta de insumos y descuento de stock; facturación ARCA con CAE (A/B/C), PDF con QR y reintento manual; historial paginado con filtros, gráficos y reportes en 4 formatos; ticket y comanda por impresión del navegador; versión leída de `package.json` y expuesta en `/api` y `/health`; logging estructurado.
- **Qué no hay**: pantalla de permisos ni de clientes; auditoría; mensajería; idempotencia; anulación o devolución. Desde la v5.0.0 hay pruebas automáticas (`npm test`, 17 pruebas que cubren A2 y A4) y pantalla de usuarios, terminales y sesiones. El resto del código sigue sin pruebas.
- **Corregido en la v4.0.0 (B4)**: `cerrarCuenta` exigía `metodo_pago` pero lo guardaba solo en `facturas`, así que una cuenta cerrada sin facturar lo perdía. Ahora se guarda en `pedidos` (migración `002_pedidos_metodo_pago.sql`, que además copia el método de las cuentas ya facturadas). Sigue pendiente: `cerrarPedido` (cierre de una silla) no pide método de pago.
- **Riesgo conocido (C2)**: el stock se descuenta con `GREATEST(stock - x, 0)`: nunca queda negativo, así que un descuadre no se ve.
- **Estado de git** (28/10/2026): rama `nuevo-bar`, subida a `origin`. La Fase A y B1 están en el commit `35b251d` (v7.0.0); B5 y B4 (v9.0.0) en `1c6c291`; B6 (v10.0.0) está en el árbol de trabajo sin confirmar. `.env.test_prod*` y `graphify-out/` quedan sin versionar a propósito.
- **Secretos**: `.env*` (salvo `.env.example`), `certs/`, `*.key` y `cert_prod.crt` están en `.gitignore` y no figuran como versionados.

---

## Reglas para todos los checkpoints

Un checkpoint se cierra solo si:
1. Cumple su criterio de aceptación, con una prueba automática por cada RN/EX listada (nombre con el ID, ej. `Ventas.RN12`).
2. Si toca la base de datos, lo hace con una migración numerada que corre sobre todas las bases (A2).
3. Sube la versión en `package.json` según `CLAUDE.md` (base de datos: MAJOR).
4. Actualiza la tabla de trazabilidad del final.
5. Avanza en pasos chicos, cada uno con su commit.

## Orden de ejecución (según prioridad: Ventas, Usuarios, Stock, Clientes)

| Etapa | Contenido | Por qué en ese lugar |
|-------|-----------|----------------------|
| 1 | **Fase A**: plataforma mínima | Ventas la necesita para funcionar (permisos, auditoría, idempotencia, mensajería, funciones activables) |
| 2 | **Fase B**: Ventas núcleo y robustez | Prioridad 1 |
| 3 | **Fase D**: Ventas activables | Completa Ventas |
| 4 | **Fase F**: resto de Usuarios | Prioridad 2 |
| 5 | **Fase C**: Stock | Prioridad 3. Cierra los requisitos de Ventas que dependen de Stock |
| 6 | **Fase E**: Clientes y CC | Prioridad 4. Cierra los requisitos de Ventas que dependen de Clientes |

Ventas "en su totalidad" se termina recién al cerrar C y E: algunos requisitos suyos exigen esos módulos (tabla al final).

---

## Fase A: Plataforma mínima (Usuarios y Auditoría, lo que Ventas necesita para arrancar)

| CP | Qué se construye | Referencias | Estado | Criterio de aceptación |
|----|------------------|-------------|--------|------------------------|
| **A1** | **Instancia y multi-cliente**: resolver la instancia en cada request, pool de conexiones por instancia, `Configuracion_Instancia` (código de instancia, razón social, CUIT, sucursal, zona horaria, moneda local), certificados ARCA por instancia (salen de `certs/` global) | Usuarios RF13, RN22, RN79; `CLAUDE.md` | ✅ v6.0.0. Registro de instancias (`instancias.json` o una sola `DEFAULT` con el `.env`), resolución por cabecera `X-Instancia` o por dirección web, un pool por instancia (`src/instancias/registro.js`), token atado a su instancia, ARCA por instancia (CUIT, certificados y entorno en el registro), migraciones sobre todas las bases al arrancar y `npm run alta -- --registrar`. Pendiente: no hay pantalla para dar de alta instancias (es por línea de comandos); falta probar con más de un servidor MySQL | Dos instancias con bases distintas operan a la vez sin verse los datos; una prueba intenta leer los de la otra y falla |
| **A2** | **Migraciones y alta de instancia**: ejecutor de `database/migraciones/NNN_*.sql` sobre todas las bases, con `schema_migrations` e idempotente. Migración `001` con el esquema nuevo. Script de alta (base, migraciones, Administrador, configuración, perfil de rubro) | Plan técnico §7 | ✅ v5.0.0. `src/db/migrador.js` (`npm run migrar`): registro en `schema_migrations` con huella, candado por base, baseline para bases anteriores y migraciones re-ejecutables. `npm run alta` crea base, instancia y Administrador. Pendiente: aplicar a *todas* las bases cuando A1 tenga el registro de instancias, y aplicar el perfil de rubro (A8; hoy solo se guarda) | Alta con un comando; correr las migraciones dos veces no cambia nada |
| **A3** | **ID_Global y hora oficial**: `<CODIGO_INSTANCIA>-<ULID>` (ver decisión 1), generado por el módulo que crea el documento; nunca se reutiliza. La hora la fija siempre el servidor; alerta y evento "Desvío de hora del equipo" | Usuarios RN81, RN21, EX14 | ✅ v6.0.0. `<CODIGO>-<ULID>` (`src/utils/idGlobal.js`, sin dependencias) en `pedidos`, `facturas`, auditoría y mensajes; el desvío del reloj de la terminal se detecta y alerta (`X-Hora-Cliente`) y nunca se usa para guardar. Pendiente: `id_global` en los documentos nuevos de Ventas (B) y los pedidos anteriores quedan sin ID (arranque limpio) | Dos documentos nunca comparten ID; el reloj del navegador no se usa en ningún documento |
| **A4** | **Usuarios, autenticación, sesiones y terminales**: alta, edición y baja lógica; contraseña (mín. 8, irreversible, cambio en el primer ingreso), PIN único, tarjeta; bloqueo tras 5 intentos; cambio rápido de usuario por PIN; vencimiento por inactividad configurable por rol y terminal; sesiones activas y cierre forzado; terminales con estado de conexión; pantalla "Sin conexión" que bloquea operaciones nuevas | Usuarios RF01, RF04, RF06, RF07, RF28, RN01 a RN06, RN80, EX01, EX02, EX05, EX54 | ✅ v5.0.0 (rol: solo admin/empleado hasta A5). Usuarios con alta, edición y baja lógica (y baja programada), contraseña con cambio obligatorio, PIN y tarjeta únicos, bloqueo a los 5 intentos, cambio rápido de usuario, sesiones en el servidor con vencimiento por inactividad (por rol o terminal), cierre forzado, terminales con estado de conexión y pantalla "Sin conexión". Pendiente: los intentos rechazados van al log hasta que exista la auditoría (A6) | Siempre queda un Administrador activo; el PIN repetido se bloquea; sin conexión no se guarda nada en el navegador |
| **A5** | **Roles, permisos, alcances y autorización de supervisor**: roles predefinidos editables (Administrador, Gerente, Encargado de turno, Cajero, Barista, Mozo, Producción/Obrador, Depósito, Administrativo, Contador), tres niveles por permiso, excepciones por usuario, alcances (propias, turno, caja, depósito, sector), registro de permisos por módulo, supervisor distinto del que actúa. Middleware `requierePermiso(accion)` | Usuarios RF02, RF03, RF05, RN07 a RN10, RN23, EX03, EX04; Ventas RN18 | ✅ v6.0.0. Roles de referencia editables, permisos en 3 niveles, excepciones por usuario, alcances (se guardan; los aplica cada módulo cuando los declare), `requierePermiso(accion)` en todas las rutas, autorización de supervisor (PIN, tarjeta o usuario y contraseña) y regla RN07. Pantalla de roles y de usuarios con roles. Pendiente: pantalla de excepciones y alcances por usuario (solo API); los permisos de Stock y Clientes se suman con esos módulos | Sin permiso → 403 y queda registrado; "requiere autorización" pide a otro usuario con la acción permitida; un usuario no se autoriza a sí mismo |
| **A6** | **Auditoría de solo agregar y encadenada**: sesiones, acciones con permiso, accesos denegados, cambios de configuración y de permisos con valor anterior y nuevo; cadena criptográfica y control de integridad; consulta con filtros y exportación; historial desde la ficha de un registro. Nunca guarda contraseñas ni PIN | Usuarios RF08 a RF10, RN11, RN12, RN23, EX10 | ✅ v6.0.0. Tabla de solo agregar con triggers y cadena HMAC, control de integridad, consulta con filtros y cursor, exportación CSV, pantalla. Pendiente: medir con 5.000.000 de eventos (no se probó el volumen); si falla el registro, la operación sigue y queda en el log hasta que la auditoría pase por la bandeja de salida | Ningún endpoint ni SQL modifica o borra eventos; alterar una fila rompe la cadena y el control lo detecta; primera página < 3 s con 5.000.000 de eventos |
| **A7** | **Registro de módulos, puertos y capas**: capas N0 a N4, puertos con implementación nula por defecto, dependencias declaradas, bloqueo de ciclos y de llamadas hacia capas superiores, **registro único de las llamadas inmediatas permitidas (Anexo B.5)** y una prueba de arquitectura que compara el código real contra ese registro; una llamada que no esté en la lista no pasa. Los publicadores consultan el registro de módulos: si el receptor no está instalado, no generan el mensaje | Usuarios RF13, RF26, RN61, RN62, EX41; Índice B.1, B.2, B.5 | ✅ v6.0.0. Catálogo de módulos y capas, 21 llamadas de B.5 como datos, `llamar()` con tiempo y política de falla, 7 puertos con implementación nula, instalación validada (ciclos, hacia arriba, mismo nivel) y prueba de arquitectura contra el código real. Deuda declarada: Ventas lee recetas de Stock en `productoController` (se salda en C) | Instalar un módulo que crea un ciclo o una llamada hacia arriba se bloquea y deja el estado anterior |
| **A8** | **Funciones activables y perfiles de rubro**: registro de funcionalidades (ID `PREFIJO-NOMBRE`, requisitos, requisito condicional, datos vigentes, tipos de documento afectados, peso sanitario), pantalla única, validación de dependencias, cascadas, `Version_Configuracion`, instantánea por documento, catálogo cargado como datos desde el Anexo A.1 (ver tabla abajo), perfiles (Cafetería, Producción de alimentos, Cafetería con producción propia, Personalizado) según Anexo A.2, aviso reforzado de funciones sanitarias, bloqueo durante una restauración | Usuarios RF18, RN24 a RN30, Índice A.1 y A.2, RN32, RN33, RN46, RN47, RN74 a RN78, RN86, EX15 a EX18, EX28 a EX30, EX51 a EX53; Ventas RN28, RN65 | ✅ v6.0.0. 61 funciones del Anexo A.1 como datos, 4 perfiles, pantalla única, requisitos y condicionales, cascada, pendientes, peso sanitario con autorización de otro Administrador, `Version_Configuracion`, instantánea por pedido, bloqueo durante restauración. Pendiente: las funciones todavía no cambian el comportamiento de Ventas (se cablean en B/D); la propagación a las terminales es por la cabecera `X-Config-Version`, no en menos de 5 s si la terminal está quieta | Un pedido abierto sigue con las funciones con que se abrió; activar una función con su requisito es todo o nada; solo el Administrador cambia funciones |
| **A9** | **Idempotencia de solicitudes**: `ID_Solicitud` generada antes del primer envío, huella del contenido, `Solicitud_Procesada` (retención 90 días), "conflicto de idempotencia", "preguntar antes de reenviar", token de formulario de un solo uso | Usuarios RF25, RN69 a RN73, EX47 a EX49; Ventas RN64 | ✅ v6.0.0. `X-ID-Solicitud` en toda operación con efecto, huella, resultado original, conflicto, "en proceso", consulta de estado antes de reenviar, retención de 90 días; obligatoria en cobro y reintento de factura; el cierre de cuenta usa una clave por formulario | Reenviar 5 veces el mismo cierre produce un solo efecto; misma clave con otro contenido se rechaza y alerta; el doble clic produce un solo efecto |
| **A10** | **Mensajería interna**: bandeja de salida en la misma transacción del documento, `ID_Operacion`, trabajador, bandeja de entrada idempotente (`Operacion_Procesada`, 90 días), reintentos (5 s, 30 s, 2 min, 10 min, cada 10 min hasta 24 h), Rechazado / Fallido, bandeja de pendientes con responsable, plazo y escalada, reintento y descarte con supervisor, orden "una reversa nunca antes que su original", estado de integración Completa / Parcial, conciliación diaria y bajo demanda, retención 30 días y reenvío desde una fecha | Usuarios RF25, RN48 a RN60, RN85, EX31 a EX40, EX50; Ventas RN58, EX43 | ✅ v6.0.0. Bandeja de salida en la transacción del documento, receptores idempotentes, reintentos 5 s/30 s/2 min/10 min/10 min hasta 24 h, rechazo y fallo, orden de reversas, bandeja de pendientes con responsable/plazo/escalada, reintento y descarte con autorización, reenvío, conciliación, trabajador en la misma app. Pendiente: todavía no hay un módulo que la use (se usa desde B/C); un solo proceso | Un duplicado se aplica una vez; una anulación que llega antes que su venta queda "Retenida por orden"; el rechazo de negocio no se reintenta y va a pendientes; mensaje confirmado en < 2 s |
| **A11** | **Reservas con vencimiento** (reservar / confirmar / vencer, `Reemplaza_A`, renovaciones, vigencias parametrizables) | Usuarios RN82, RN83, EX56 | ✅ v6.0.0. `reservar` / `renovar` / `consumir` / `vencer` con `Reemplaza_A` atómico, candado por recurso y vigencias parametrizables. Pendiente: sin usuarios reales hasta Stock (C3) y Clientes (E) | Una reserva no confirmada se libera sola; pedir de nuevo con otra cantidad reemplaza la anterior en una sola operación |
| **A12** | **Centro de notificaciones**: alertas con severidad, destinatarios por rol, estados Nueva / Leída / Resuelta; alimentado por la mensajería y la conciliación | Usuarios RF17, RN60, EX13 | ✅ v6.0.0. Alertas con severidad, destinatarios por rol, deduplicadas por clave y resueltas solas (mensaje fallido, rechazos, conciliación, pendiente vencido, conflicto, desvío de hora, disco). Pantalla con contador. Pendiente: aviso por correo (USU-CORREO) | Un mensaje Fallido genera una alerta crítica que se resuelve sola al confirmarse o descartarse |

---

## Anexos en alcance: funciones, perfiles, llamadas y eventos

Datos que el código debe leer (no hardcodear), tomados de `SPECS/00-indice-y-decisiones.md`.

**Funciones activables de los cuatro módulos (35 de las 61 del catálogo) y su valor Base**

| Módulo | Activas por defecto (Sí) | Desactivadas por defecto (No) |
|--------|--------------------------|-------------------------------|
| Ventas (14) | `VEN-SALON`, `VEN-MODIF`, `VEN-ALERGENOS` | `VEN-FRANJA`, `VEN-SERIE`, `VEN-CC`, `VEN-PRECIO-COSTO`*, `VEN-DIVISA`, `VEN-LISTAS`, `VEN-PROMOS`, `VEN-KDS`, `VEN-MOVIL`, `VEN-COMISIONES`, `VEN-RESERVAS` |
| Stock (9) | `STK-LOTES`, `STK-TRAZA`, `STK-ALERGENOS`, `STK-PRODUCCION` | `STK-TEMP`, `STK-SERIE`, `STK-ETIQUETAS`, `STK-APP`, `STK-REPO-AUTO` |
| Clientes y CC (5) | — | `CLI-FIDEL`, `CLI-MORA`, `CLI-RETENCIONES`, `CLI-FACT-AGRUPADA`, `CLI-MONEDA-EXT` |
| Usuarios (7) | — | `USU-TABLERO`, `USU-CONSOL`, `USU-2FA`, `USU-FOTO`, `USU-COTIZ-AUTO`, `USU-NUBE`, `USU-CORREO` |

\* Requiere Compras: queda deshabilitada ("Requiere: Compras").

**Perfiles de rubro (Anexo A.2)**: solo cambian estas funciones respecto de la columna Base. "Personalizado" parte igual que Cafetería.

| Función | Cafetería | Producción de alimentos | Cafetería con producción propia |
|---------|-----------|-------------------------|---------------------------------|
| `VEN-SALON` | Sí | **No** | Sí |
| `VEN-CC` | No | **Sí** | **Sí** |
| `CLI-FACT-AGRUPADA` | No | **Sí** | **Sí** |
| `CLI-RETENCIONES` | No | **Sí** | **Sí** |

Las mejoras P1 a P13 arrancan desactivadas en los cuatro perfiles.

**Requisitos entre funciones que se validan al activar (RN25)**: `STK-TRAZA` → `STK-LOTES`; `STK-SERIE` → `VEN-SERIE`; `STK-ETIQUETAS` → `STK-LOTES` y `STK-ALERGENOS`; `CLI-FACT-AGRUPADA` → `VEN-CC`; `VEN-CC` → módulo Clientes; `VEN-RESERVAS` → `VEN-SALON` y Clientes; `VEN-PROMOS` para socios → `CLI-FIDEL`; `VEN-COMISIONES` por margen y `VEN-KDS` con agotado automático → Stock. Los requisitos hacia Contable, Financiero y Compras se ignoran (el SPEC los marca "solo para ...").

**Llamadas inmediatas entre módulos en alcance (Anexo B.5, de 21)**

| # | Llama → a | Para qué | Espera / si no responde | CP |
|---|-----------|----------|-------------------------|----|
| 1 | Ventas → Clientes | Veredicto y reserva de crédito | 3 s / cerrar (o supervisor) | E3 |
| 2 | Ventas → Clientes | Retención de saldo de vales y puntos | 3 s / cerrar | E7 |
| 3 | Ventas → Stock | Compromiso de venta | 3 s / abrir con autorización | C5 |
| 4* | Ventas → Stock | Validar etiquetas propias y lotes | 3 s / degradar | C7, C13 |
| 6 | Ventas → ARCA | Emisión y padrón | 15 s / CAEA o no fiscal | B6, B7, B12 |
| 10 | Stock → Usuarios | Reservar clave de comprobante | 3 s / cerrar | F6 |
| 11 | Todos → Usuarios | Permisos y supervisor | 3 s / cerrar | A5 |
| 12* | Clientes → Ventas | Emitir ND/NC y padrón | el de Ventas / reintentar con la misma clave | E2 |
| 13 | Clientes → Stock | Alcance de un retiro de lote | 3 s / degradar | E9 |
| 17* | Stock → Ventas | Ventas del período (diferencias de integración) | 3 s / degradar | C6 |

\* La política no estaba en los módulos; el índice la proponía y quedó confirmada en la decisión 3. Quedan fuera las llamadas 5, 16 y 20 (Financiero), 7, 8, 9, 19 y 21 (Ventas Online), 14 y 15 (Compras) y 18 (Contable).

**Eventos en alcance (Anexo B.3)**: Venta confirmada / anulada / devuelta (→ Stock, Clientes; B5, B10); Descuento confirmado con el costo de la venta (Stock → Ventas; C3, C4); Costo de inventario y de receta actualizado (Stock → copia local de Ventas; C4); Remito emitido (→ Clientes; E2); Venta regularizada (B8); Emisión de gift card y de vale por devolución, y Canje confirmado (→ Clientes; E7); Cliente actualizado (Clientes → copia local de Ventas; E1); Clientes unificados (→ Ventas y Stock; E1); Confirmar clave de comprobante (→ Usuarios; F6); Desvío de hora del equipo (Usuarios → Ventas; A3). Los eventos cuyo único suscriptor es Contable, Financiero, Compras o Ventas Online no se generan.

**Costos (Anexo C)**: cuatro tipos con orden fijo de uso (CR, CI, CP, CV). Sin Compras no hay CR: el control de venta bajo costo usa CI o CP, y el margen realizado usa CV. Es la base de B5, B11 y C4.

---

## Fase B: Ventas (núcleo y robustez)

| CP | Nivel | Qué se construye | Referencias | Estado | Criterio de aceptación |
|----|-------|------------------|-------------|--------|------------------------|
| **B0** | Riesgo | **Prueba de periféricos con el equipo real**: ticket y comanda por la cola de impresión (Web Serial/WebUSB y respaldo por impresión del navegador), apertura de cajón, lectura de balanza, lector de códigos | Decisión 2; Ventas RN04, EX08, EX55 | 🟡 hay ticket y comanda por impresión del navegador (`imprimirTicket`); no hay cola de impresión, balanza ni cajón | Se imprime una comanda en una terminal remota, se abre el cajón, se lee un peso estable y se rechaza uno inestable. Si algo falla, se reabre la decisión 2 antes de B1 |
| **B1** | Núcleo | **Catálogo**: estándar, variantes, pesable, fraccionable, combo, elaborado y servicio; categorías; IVA; SKU y códigos únicos; sector de comanda; agotado manual. Pesables con tara, mínimo y máximo | RF01, RF02, RN02 a RN04, RN69, RN78, EX01, EX53, EX55 | ✅ v7.0.0. Tipos (estándar, variante, pesable, fraccionable, combo, elaborado, servicio), categorías, sectores de comanda, IVA por artículo, SKU y código de barras únicos, agotado manual (bloquea cargarlo a un pedido), pesables con tara/mínimo/máximo y validación de peso, combos sin ciclos y de hasta 3 niveles. Pendiente: pantalla del frontend para los campos nuevos; los pedidos siguen con cantidad entera (el peso decimal entra con B0/B2); variante, elaborado y fraccionable solo se guardan como tipo | SKU duplicado bloqueado; combo con ciclo o profundidad > 3 rechazado; peso cero o inestable rechazado |
| **B2** | Núcleo | **Pedido y salón**: modalidades (mostrador, para llevar, delivery, retiro, salón), origen, mozo, estados, mover/unir mesa, dividir cuenta por silla o ítem | RF04 a RF06, RN09 a RN11 | 🟡 salones, mesas, sillas, estructuras, unir y separar mesas, un pedido por silla. Sin modalidades (solo salón), origen, mozo ni dividir por ítem | Una silla con un solo pedido abierto; un pedido no cierra con ítems sin cobrar; anular un ítem enviado exige permiso (A5) |
| **B3** | Núcleo | **Comandas** por sector, reimpresión y anulación con motivo | RF07, EX08 | 🟡 comanda de cocina por mesa (`/mesas/:id/comanda`) y marca `entregado` por ítem; sin sectores, estados ni anulación con motivo | Una comanda por envío, ruteada al sector de cada artículo; reimpresión auditada |
| **B4** | Núcleo | **Formas de pago configurables** (reemplaza el `ENUM metodo_pago`), pago mixto, vuelto, referencia obligatoria | RF09, RN16, EX11, EX13 | ✅ v9.0.0. Tabla `formas_pago` (código, nombre, activa, requiere referencia, admite vuelto, orden) con las 5 de siempre sembradas; `/api/formas-pago` para crear y editar (no se borran, se desactivan). El cierre acepta `pagos: [{ forma, importe, referencia?, recibido? }]` (o el `metodo_pago` de siempre): la suma debe ser el total, la referencia se exige si la forma la pide, el vuelto solo en formas que lo admiten. Cada pago queda en `pago_venta`; `pedidos` y `facturas` guardan el código o `mixto` (dejaron de ser ENUM). `GET /api/ventas/por-forma-pago`. Pendiente: pantalla de cierre con pago mixto y de configuración de formas (el frontend sigue mandando una sola forma); recargo/descuento y moneda por forma (RF09, con VEN-DIVISA); el historial viejo sigue filtrando por una sola forma (una venta mixta se busca como "mixto"); las sillas que se cierran una por una siguen sin método | Pago mixto cuya suma ≠ total se bloquea; reporte por forma de pago |
| **B5** | Núcleo | **Cierre de venta**: `ventas` y `pago_venta`, datos congelados del comprobante, `ID_Solicitud` (A9), estado de integración Completa/Parcial, efectos por la bandeja de salida (A10), orden de consultas con presupuesto de 8 s | RF08, RN19, RN21, RN58, RN85, EX09, EX49 | ✅ v8.0.0. Cada cierre de cuenta crea una `venta` (con `id_global`) y su `pago_venta` en la misma transacción, con copia fija de los ítems y precios, solo lectura (triggers), `ID_Solicitud` guardada y mensajes de sus efectos en la bandeja de salida (`src/services/ventaService.js`); `GET /api/ventas/:idGlobal` devuelve la venta con su estado de integración Completa/Parcial. Hoy los efectos son hacia Financiero (cobro) y Contable (venta confirmada), que no existen: no se generan. Pendiente: el descuento de stock sigue directo en el cierre (pasa a mensaje en C3); el cierre de una silla suelta (`cerrarPedido`) no crea venta; un solo pago por venta (pago mixto es B4); el presupuesto de 8 s del cierre (RN85) se mide con las llamadas síncronas que aparezcan (B6, C5, E3) | El doble clic no cierra dos veces; si falla un efecto la venta no se revierte y queda Parcial; reinicio con pedidos abiertos los recupera |
| **B6** | Núcleo | **Facturación CAE como servicio único**: `comprobantes` + `intento_emision` + secuenciador por clave (punto de venta, tipo, modalidad) con candado en una tabla con arrendamiento de 60 s renovable (Ventas RN50), en lugar del `GET_LOCK` actual: el candado de sesión no tiene vencimiento propio ni se puede listar, bloquear o liberar desde la pantalla de claves en "Resolviendo" (RF47). Tipo A/B/C según IVA, tope de consumidor final | RF10, RF17, RF26, RN12 a RN14, RN49, RN50, RN52, RN56, EX03 | ✅ v10.0.0. `afipService.emitirFactura` es la única vía de numeración: el número sale de "último autorizado + 1" dentro de un candado por clave `punto de venta:tipo:modalidad` (`secuenciadorService`, tabla `secuenciador_claves` con arrendamiento de 60 s que se renueva cada 20 s, espera máxima de 10 s y `CLAVE_OCUPADA` si vence). Cada solicitud es un intento idempotente (`intento_emision`, con la ID_Solicitud del cierre o del reintento): repetir uno autorizado no vuelve a ARCA; un corte después de enviar lo deja Indeterminado. Reglas del receptor: la Factura A exige RI con CUIT y el consumidor final no pasa el tope (`tope_consumidor_final`, 0 = sin control: hay que cargar el vigente), validado antes de cerrar la cuenta. Pendiente: tipo A/B automático (el frontend lo sigue eligiendo), solo Concepto 1, la espera no es FIFO estricto, y al vencer un arrendamiento ajeno no se consulta a ARCA antes de seguir (eso es B7); la tabla `facturas` hace de `comprobantes` | 5 emisiones simultáneas sobre la misma clave salen correlativas; un rechazo libera el número |
| **B7** | Robustez | **ARCA caído o lento**: intento Indeterminado, consulta a ARCA (5, 15, 30, 60 s y cada 5 min), validar numeración al iniciar el día y tras reinicio, alerta a los 10 min, resolución manual con supervisor | RF47, RN51, RN53, RN54, RN57, EX02, EX07, EX37 a EX42 | 🟡 si ARCA falla la cuenta queda cerrada y la factura en `error`, con reintento manual. No hay estado Indeterminado ni consulta del comprobante por número (a verificar si reintentar tras un timeout puede duplicar) | Timeout después de enviar: el número queda bloqueado, la respuesta tardía completa el comprobante y avisa; no hay duplicados |
| **B8** | Robustez | **CAEA y no fiscales**: solicitar y guardar CAEA, numeración local atómica, informe a ARCA; ticket, presupuesto y remito; "no fiscal pendiente de facturación" y su regularización | RF11, RF12, RN15, RN55, RN84, EX04 a EX06 | ⬜ no hay CAEA ni comprobantes no fiscales formales (sí se puede cerrar sin facturar) | Sin ARCA y con CAEA vigente se factura; sin CAEA se ofrece no fiscal; al regularizar no se duplica descuento ni cobro |
| **B9** | Núcleo | **Registro de ventas**: filtros, totales, exportación, reimpresión con registro, ventas inmutables | RF19 a RF22, RN19 a RN26, EX14 a EX18 | ✅ historial paginado, filtros (fecha, mesa, método, estado y existencia de comprobante), orden, gráficos y reporte en CSV, Excel, PDF y JSON. Faltan reimpresión registrada y varios filtros del SPEC | Reimprimir no genera numeración ni CAE; no existe borrado de ventas; primera página < 3 s con 100.000 ventas |
| **B10** | Robustez | **Anulación, devolución y cambio**: nota de crédito (servicio de B6), reingreso o merma, forma de reintegro, supervisor si cambia la forma, devolución con cambio | RF15, RF49, RF50, RN34, RN76, EX58, EX61 | ⬜ solo se puede eliminar un pedido activo; no hay anulación de venta, devolución ni nota de crédito | Devolución parcial reintegra lo cobrado; el movimiento original nunca se borra; reintentar usa la misma clave |
| **B11** | Núcleo | **Actualización de precios** con vista previa, vigencia programada y reversión | RF14, RN17, EX12 | 🟡 precio editable a mano por producto; sin vista previa, vigencia ni reversión | Importación inválida se rechaza entera; un pedido abierto conserva su precio |
| **B12** | Robustez | **Libro IVA Digital**, control contra ARCA, consulta al padrón y constatación | RF13, RF23, RF24, RN29, EX19, EX20 | ⬜ | El control lista diferencias entre lo local y lo de ARCA |

---

## Fase D: Ventas, funciones activables

Cada una es un checkpoint propio. Nacen con el valor Base del Anexo A.1 (ver tabla de la Fase A): `VEN-SALON`, `VEN-MODIF` y `VEN-ALERGENOS` nacen activas; el resto, desactivadas.

| CP | Función | Referencias | Notas |
|----|---------|-------------|-------|
| **D1** | Modificadores y opciones (`VEN-MODIF`) | RF30, RN41, EX31 | El insumo alternativo se cierra en C |
| **D2** | Alérgenos (`VEN-ALERGENOS`) | RF31, RN42 | La derivación por receta se cierra en C9 |
| **D3** | Listas de precios (`VEN-LISTAS`) | RF34, RF35, RN32, EX23 | La lista por cliente se cierra en E |
| **D4** | Promociones (`VEN-PROMOS`) | RF36, RF37, RN33, RN34, EX24 | Las de socios se cierran en E7 |
| **D5** | Pantalla de cocina (`VEN-KDS`) | RF38, RN35, RN36, EX25, EX27 | Agotados automáticos en C16 |
| **D6** | Franja horaria del menú (`VEN-FRANJA`) | RF29, RN45 | |
| **D7** | Toma de pedidos móvil (`VEN-MOVIL`) | RF39, RN37, RN66, EX26, EX50 | Usa A9; versiones por pedido e ítem |
| **D8** | Reservas y turnos (`VEN-RESERVAS`) | RF43, RF44, RN40, EX30 | Recordatorio por correo requiere internet |
| **D9** | Comisiones (`VEN-COMISIONES`) | RF40, RF41, RN38, EX28 | Por porcentaje y metas ya; por margen se cierra en C4 |
| **D10** | Series (`VEN-SERIE`) | RF33, RN05, RN79, EX33 | Historial por serie se cierra en C12 |
| **D11** | Cobro en divisa (`VEN-DIVISA`) | RF28, RN44, EX32, EX44 | Requiere F2 (cotizaciones) |

**Quedan bloqueadas** por falta de módulos que no se van a construir ahora: `VEN-PRECIO-COSTO` (RF32, RN46: requiere Compras, el SPEC dice que sin Compras no se puede activar), pedidos de origen externo y online (RF25, RN30, RN60, RN67, RN68, EX21, EX46, EX51, EX52: Ventas Online) y el cobro por plataforma.

---

## Fase F: Usuarios y Auditoría (el resto)

Todo lo de esta fase pertenece al SPEC de Usuarios; se hace después de Ventas porque ninguna parte bloquea la venta.

| CP | Qué se construye | Referencias | Lo usan |
|----|------------------|-------------|---------|
| **F1** | **Copias de seguridad y restauración**: copias completas, cifradas y verificadas, automáticas y manuales, retención configurable, restauración de la instancia completa con copia previa, versión compatible, confirmación escrita y cierre de sesiones. Tras restaurar, la emisión fiscal queda bloqueada hasta que Ventas valide la numeración con ARCA y se resuelvan los efectos sin origen | Usuarios RF11, RF12, RN13 a RN16, RN14, RN57, RN58, EX07 a EX09, EX13, EX39 | Ventas B7 (numeración fiscal, RN14) |
| **F2** | **Monedas y cotizaciones**: moneda local y extranjeras, cotización manual con permiso, servicio de cotización vigente, antigüedad máxima. Opcional: actualización automática (`USU-COTIZ-AUTO`) | Usuarios RF14, RF22, RN17, EX12 | D11, E8 |
| **F3** | **Tablero de indicadores** (`USU-TABLERO`): registro de indicadores por módulo, tablero por usuario, comparación con el período anterior, alcances, actualización < 60 s | Usuarios RF19, RN34 a RN37, RN23, EX19; Ventas RF45, RN47; Stock RF33; Clientes RF25 | Los tres módulos |
| **F4** | **Consolidación de sucursales** (`USU-CONSOL`): marca Sucursal / Casa Central, paquetes firmados e idempotentes, registro de sucursales, control de faltantes, informes consolidados | Usuarios RF20, RN38 a RN44, EX20 a EX25, EX35; Ventas RF46, RN48; Stock RF34 | (Clientes no publica paquete) |
| **F5** | **Segundo factor TOTP** (`USU-2FA`) con códigos de recuperación | Usuarios RF21, RN45, EX26, EX27 | |
| **F6** | **Identificación de comprobantes de terceros**: clave unívoca normalizada, reserva y confirmación, duplicado exacto, casi duplicado con confirmación y motivo, regla del CAE, vínculos remito–factura, proveedor sin CUIT | Usuarios RF27, RN63 a RN68, RN84, EX42 a EX46, EX57 | Stock C2 |
| **F7** | **Lectura de comprobantes por foto** (`USU-FOTO`, requiere servicio externo) y **diccionario de equivalencias de terceros** (destino: presentación de Stock) | Usuarios RF15, RF16, RN18 a RN20, EX11 | Stock C16 |
| **F8** | **Copia en destino externo** (`USU-NUBE`) y **notificaciones por correo** (`USU-CORREO`) | Usuarios RF23, RF24, EX06 | |
| **F9** | **Desinstalación de módulos** (En desinstalación → resolver pendientes → desinstalado) y requisito condicional al instalar | Usuarios RN87, RN25, EX30, EX59 | |

Se ignoran los puntos de Usuarios que requieren módulos que no se construyen: reabrir turno de caja y vencimientos de pagos (Financiero), balance consolidado y permisos contables (Contable), pausa de publicación (Ventas Online), constatación de compras y listas de proveedor (Compras), y el registro de Contable en la puesta en marcha (RN31).

---

## Fase C: Stock e Insumos

| CP | Nivel | Qué se construye | Referencias | Estado | Criterio de aceptación |
|----|-------|------------------|-------------|--------|------------------------|
| **C1** | Núcleo | **Ítems, unidades, presentaciones y depósitos** | RF01 a RF03, RN61, EX46 | 🟡 `insumos` con unidad libre, costo opcional y disponible; sin presentaciones ni depósitos | Una presentación con movimientos no se edita (se crea otra versión) |
| **C2** | Núcleo | **Movimientos y kardex**: el saldo sale solo de movimientos, ingreso manual (con comprobante de origen y su clave de F6), egresos por motivo, transferencias, consultas | RF04, RF12, RF13, RF18 | ⬜ el stock es un campo que se descuenta con `GREATEST(stock - x, 0)`: no hay movimientos ni kardex, y el piso en cero tapa descuadres | Saldo = suma de movimientos; no hay forma de cambiar stock sin movimiento |
| **C3** | Núcleo | **Recetas y descuento por venta**: recetas versionadas, sub-recetas, modo de descuento (Propio / Componentes), expansión de combos solo en Stock, descuento idempotente por (`ID_Operacion`, línea), momento configurable, reingreso por anulación | RF07 a RF09, RN50, RN51, RN64 a RN66; Ventas RN06, RN69, RN82 | 🟡 receta simple `producto_insumos` y descuento al cerrar la cuenta; sin versiones, sub-recetas, combos, idempotencia ni reingreso | El mismo mensaje dos veces descuenta una vez; la anulación antes que la venta espera; un combo no descuenta sus componentes además de sí mismo |
| **C4** | Núcleo | **Valuación y costos**: promedio, PEPS o último costo; costo congelado en cada movimiento; puerto de costos hacia Ventas (`Costo_Aplicado`, `Origen_Costo`, provisorio); copia local en Ventas | RF17, RN62, RN63, RN75, RN81; Ventas RN62, RN75, EX47 | 🟡 `costo_unitario` del insumo se guarda pero no se usa | La venta guarda el costo con que salió; sin costo no se bloquea; cierra el margen y la comisión por margen (D9) |
| **C5** | Robustez | **Compromiso de venta** (última unidad: candado por ítem y depósito, todo o nada, vence a los 2 min) y disponible = físico − reservado | RF36, RN59, RN60, EX10, EX48; Ventas RN63 | ⬜ | Dos terminales sobre la última unidad: una compromete y la otra recibe "Sin disponible" |
| **C6** | Robustez | **Alertas, toma de inventario y diferencias de integración** | RF14, RF16, RF35, RN20, RN67, RN68, EX50 a EX52 | ⬜ | Un conteo aprobado dos veces se rechaza; el ajuste es un delta y no pisa movimientos posteriores |
| **C7** | Activable | Lotes y vencimiento, FEFO, merma de fin de día, lote indicado en la línea (`STK-LOTES`) | RF20, RN06, RN73, RN74, RN80; Ventas RF48, EX57 | ⬜ | FEFO salvo lote indicado; lote vencido no vuelve al stock disponible |
| **C8** | Activable | Producción: órdenes por tanda, rendimiento, merma, ficha técnica y margen teórico (`STK-PRODUCCION`) | RF10, RF11, RF23, RF24, RN72 | ⬜ | Confirmar una orden descuenta insumos e ingresa el terminado con su costo |
| **C9** | Activable | Alérgenos por receta y de una línea (`STK-ALERGENOS`) | RF22, RF39, RN77; Ventas RN42 | ⬜ | La unión de alérgenos de una línea incluye opciones, componentes y origen de la porción |
| **C10** | Activable | Trazabilidad y retiro de lote (`STK-TRAZA`) | RF21, RF42, RN83 | ⬜ | Un retiro bloquea el lote y lista las líneas alcanzadas; las de FEFO figuran "no confirmado" |
| **C11** | Activable | Temperaturas e inocuidad (`STK-TEMP`) | RF25 | ⬜ | Una lectura fuera de rango alerta y exige acción correctiva |
| **C12** | Activable | Series (`STK-SERIE`), baja y conversión, historial y garantía | RF26, RF37, RF41, RN71, RN79 | ⬜ | Una serie pasa Disponible → Comprometida → Vendida de forma atómica |
| **C13** | Activable | Etiquetas y etiqueta propia de peso (`STK-ETIQUETAS`) | RF27, RN82; Ventas RN71 | ⬜ | Una etiqueta de otro origen o con verificador inválido se rechaza |
| **C14** | Activable | App móvil de inventario (`STK-APP`) y reposición automática (`STK-REPO-AUTO`) | RF28, RF29 | ⬜ | La sugerencia se calcula por consumo promedio |
| **C15** | Núcleo | Venta por porción, envase por modalidad, modificadores que cambian el insumo, agotados automáticos | RF30, RF31, RF32, RF38; Ventas RN72, RN86 | ⬜ | La devolución de una porción siempre es merma; el agotado llega a Ventas en < 5 s |
| **C16** | Robustez | Ingreso por foto y devolución a proveedor (el vínculo con la nota de crédito del proveedor queda para cuando exista Compras) | RF05, RF40 | ⬜ | El borrador de la foto no impacta stock hasta que un usuario lo confirma |

Orden dentro de la fase por requisitos de funciones: C7 antes de C10 y C13; C9 antes de C13; D10 antes de C12.

No se hace: reservas para tiendas online (RF15, RN52 a RN55, EX36 a EX38) ni la vinculación con facturas de Compras (RF06).

---

## Fase E: Clientes y Cuentas Corrientes

| CP | Qué se construye | Referencias | Criterio de aceptación |
|----|------------------|-------------|------------------------|
| **E1** | **Maestro de clientes**: ficha completa, padrón de ARCA (B12), Consumidor Final genérico, tipo Mayorista con domicilios y franjas de entrega, unificación con alias. Implementa el puerto "Control de crédito y maestro de clientes" (búsqueda por documento, nombre, teléfono o QR) | RF01, RF02, RF18, RF19, RF21, RN01, RN02, RN43, EX03 | Documento duplicado bloqueado; CUIT con verificador inválido rechazado; un ID_Cliente alias resuelve a la ficha resultante |
| **E2** | **Cuenta corriente**: apertura (límite, plazo, umbrales de mora), saldo derivado de movimientos, débito por venta idempotente, remito asignado a la cuenta, notas de débito y crédito (por B6) | RF03, RF04, RF05 (remitos), RF09, RN05, RN06, RN09 | El saldo nunca se edita; un mensaje duplicado no duplica la deuda; una NC no supera el comprobante |
| **E3** | **Crédito**: veredicto único (Permitida / Requiere autorización / Bloqueada con motivo), reserva de crédito, bloqueo manual y por mora, contingencia con supervisor, estado de procesamiento. Cierra `VEN-CC` en Ventas | RF12, RF13, RF26, RF27, RF28, RN03, RN04, RN33, RN41; Ventas RF16, RN27, RN73, RN87, EX22 | Una cuenta bloqueada nunca admite autorización; dos terminales no superan el límite a la vez; Clientes caído y venta en contingencia alerta el exceso |
| **E4** | **Recibos e imputación**: formas de pago, cheque como dato propio, numeración correlativa, imputación automática y manual, saldo a favor, anulación | RF06, RF07, RF17, RN07, RN08 | Recibo idempotente por `ID_Operacion`; un recibo anulado conserva su número |
| **E5** | **Informes**: estado de cuenta, antigüedad de saldos, deudores, cobranzas, proyección, recordatorios por correo | RF14, RF15, RF16, RF25 | El estado de cuenta cuadra con el saldo; la antigüedad usa los tramos configurados |
| **E6** | **Facturación agrupada de remitos** (`CLI-FACT-AGRUPADA`) y ciclo de facturación del mayorista | Clientes RF05, RF21, RN10; Ventas RF27, RN31, RN74, EX36 | Un remito facturado no vuelve a facturarse; la factura reemplaza al remito sin duplicar deuda |
| **E7** | **Fidelización** (`CLI-FIDEL`): sellos, puntos, saldo a favor, gift cards, vales por devolución, retención de saldo para canje. Cierra en Ventas: forma de pago "Vale / Gift card / Puntos", reintegro con vale, venta de gift cards, promociones para socios | Clientes RF22 a RF24, RF29, RF31, EX14, EX16, EX33, EX34; Ventas RF49, RF51, RN77, EX59, EX62 | Dos terminales sobre el mismo vale no retienen más que su saldo; sin respuesta la forma de pago no se ofrece |
| **E8** | **Mora, moneda extranjera y retenciones** (`CLI-MORA`, `CLI-MONEDA-EXT`, `CLI-RETENCIONES`) | RF08, RF10, RF11, RN11 | La mora propone la ND y un usuario la confirma; la diferencia de cambio se documenta con ND/NC (requiere F2) |
| **E9** | **Clientes alcanzados por un retiro de lote** | RF30, EX32 | Requiere C10; sin Stock o sin `STK-TRAZA` la opción se oculta |

Cheques en cartera, reversión del ingreso y cheque rechazado (RF06, RF17, RF19) dependen de Financiero: los recibos quedan como datos propios.

---

## Requisitos de Ventas que se cierran después

| Requisito de Ventas | Se cierra en |
|---------------------|--------------|
| Compromiso de venta, disponible y reservas (RN59, RN63, EX10, EX45, EX48) | C5 |
| Costo de la venta, margen realizado, bajo costo (RN08, RN62, RN75, EX47) | C4 |
| Descuento y reingreso de stock, combos, kits, envases (RF03, RN06, RN69, RN72, RN82) | C3, C15 |
| Lote indicado, series, etiquetas propias, alérgenos derivados (RF48, RN71, RN79, RN80, RN42) | C7, C12, C13, C9 |
| Cuenta corriente, remitos a cuenta, facturación agrupada, moneda de la cuenta (RF16, RF27, RN27, RN73 a RN74, RN87) | E3, E6 |
| Gift cards, vales, forma de pago con puntos, promociones para socios (RF49, RF51, RN76, RN77) | E7 |
| Lista por cliente y condición de socio en la copia local (RN81, RN83) | E1, E7 |
| Indicadores y consolidación (RF45, RF46) | F3, F4 |

## Orden y dependencias

```
A1 → A2 → A3 → A4 → A5 → A6 → A7 → A8 → A9 → A10 → A11 → A12
                                  ↓
B0 → B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8 → B9 → B10 → B11 → B12
                                  ↓
                          D1 … D11 (D11 necesita F2)
                                  ↓
                          F1 … F9
                                  ↓
C1 → C2 → C3 → C4 → C5 → C6 → C7 … C16     (C2 usa F6; C16 usa F7 y F6)
                                  ↓
E1 → E2 → E3 → E4 → E5 → E6 → E7 → E8 → E9  (E8 usa F2; E9 necesita C10)
```

Primer corte vendible: **B6 + C3** (vende, factura con CAE y descuenta stock). Con este orden queda después de Ventas, Usuarios y buena parte de Stock. Si el cliente piloto necesita pasar antes al sistema nuevo, hay que adelantar C1 a C4 delante de la Fase D.

## Trazabilidad

Se completa a medida que se cierran los checkpoints (una fila por regla cubierta, con el nombre de la prueba).

| Regla | Checkpoint | Prueba | Estado |
|-------|------------|--------|--------|
| Plan técnico §7 (migraciones idempotentes) | A2 | `migrador.test.js`: una base nueva recibe todas las migraciones y correrlo de nuevo no cambia nada | ✅ |
| Plan técnico §7 (bases anteriores) | A2 | `migrador.test.js`: una base anterior al ejecutor se toma como si ya tuviera la 001 | ✅ |
| Plan técnico §7 (migración aplicada inmutable) | A2 | `migrador.test.js`: una migración ya aplicada no se puede editar | ✅ |
| Plan técnico §7 (re-ejecución de la 002) | A2 | `migrador.test.js`: 002 se puede volver a correr | ✅ |
| Usuarios RF13, RN22 (alta de instancia) | A2 | `migrador.test.js`: alta-instancia crea la base, la instancia y el administrador; es idempotente | ✅ |
| Usuarios RF01, RN01 (mensaje único de login) | A4 | `auth.test.js`: login con credenciales correctas e incorrectas | ✅ |
| Usuarios RN02 (bloqueo a los 5 intentos) | A4 | `auth.test.js`: 5 contraseñas incorrectas bloquean y el Administrador desbloquea; un ingreso correcto reinicia el contador | ✅ |
| Usuarios RN03 (cambio en el primer ingreso) | A4 | `auth.test.js`: contraseña por cambiar | ✅ |
| Usuarios RF06, EX05 (inactividad) | A4 | `auth.test.js`: la sesión vence, los latidos no la renuevan y la actividad sí | ✅ |
| Usuarios RF07 (cierre de sesión) | A4 | `auth.test.js`: logout cierra la sesión | ✅ |
| Usuarios RN04 a RN06 (PIN único, último Administrador) | A4 | `auth.test.js`: solo el Administrador gestiona; el PIN es único; siempre queda un Administrador | ✅ |
| Usuarios RN80 (baja lógica y programada) | A4 | `auth.test.js`: desactivar cierra sesiones y la baja programada vencida impide ingresar | ✅ |
| Usuarios EX01, EX02 (restablecer clave, cambio rápido) | A4 | `auth.test.js`: restablecer contraseña; cambio rápido de usuario por PIN o tarjeta | ✅ |
| Usuarios EX54 (terminales y conexión) | A4 | `auth.test.js`: terminales y sesiones: latido, estado de conexión y cierre forzado | ✅ |
| Usuarios RN81 (ID_Global) | A3 | `idglobal.test.js`: el ULID tiene 26 caracteres, nunca se repite y ordena; cada pedido nace con `<CODIGO>-<ULID>` único | ✅ |
| Usuarios EX14 / RN21 (hora) | A3 | `hora.test.js`: reloj desviado alerta y audita; ningún documento toma la hora del navegador | ✅ |
| Usuarios RF13, RN22 (aislamiento) | A1 | `instancias.test.js`: dos instancias operan a la vez sin verse los datos; un token no sirve en otra | ✅ |
| Usuarios RF08 a RF10, RN11, RN12 | A6 | `auditoria.test.js`: eventos con valor anterior y nuevo, sin secretos, solo agregar, cadena que detecta la alteración, consulta y exportación | ✅ |
| Usuarios EX03, EX04, RF05, RN06 a RN09 | A5 | `permisos.test.js`: 403 registrado, autorización de supervisor distinto, RN07, RN09, último Administrador | ✅ |
| Usuarios RF26, RN61, RN62, Índice B.1, B.2, B.5 | A7 | `arquitectura.test.js` y `modulos.test.js`: capas, 21 llamadas, políticas de falla, puertos nulos, instalación validada | ✅ |
| Usuarios RN24 a RN30, RN46, RN74 a RN78, RN86, EX15 a EX18, EX28 a EX30, EX51 a EX53 | A8 | `funciones.test.js`: catálogo, requisitos, cascada, pendientes, sanitarias, versión, instantánea, perfiles, restauración, rollback | ✅ |
| Usuarios RN69 a RN73, EX47 a EX49 | A9 | `idempotencia.test.js`: reintento devuelve el original, doble envío, conflicto, consulta de estado, purga | ✅ |
| Usuarios RN48 a RN60, RN85, EX31 a EX40, EX50 | A10 | `mensajeria.test.js`: bandeja transaccional, duplicados, rechazo, reintentos, fallido, reversas, descarte, escalada, conciliación, reenvío, archivo | ✅ |
| Usuarios RN82, RN83, EX56 | A11 | `reservas.test.js`: vencimiento, reemplazo atómico, carrera, renovación, confirmación con reserva vencida | ✅ |
| Usuarios RF17, RN60, EX13 | A12 | `mensajeria.test.js` y `hora.test.js`: alertas por rol, resolución automática, disco | ✅ |
| Ventas RN02, RF01 (SKU y código únicos, tipo, IVA, categoría, sector) | B1 | `catalogo.test.js`: SKU y código de barras duplicados se bloquean; tipo, IVA y pesos inválidos se rechazan | ✅ |
| Ventas RN03 (combos sin ciclo, profundidad ≤ 3) | B1 | `catalogo.test.js`: un combo con ciclo o con más de 3 niveles se rechaza y no cambia nada | ✅ |
| Ventas RN04, EX55 (peso estable, mayor que cero, en rango) | B1 | `catalogo.test.js`: peso cero, inestable o fuera de rango se rechaza | ✅ |
| Ventas RF01 (agotado manual) | B1 | `catalogo.test.js`: un producto agotado no se puede cargar a un pedido | ✅ |
| Ventas RF08, RN21 (venta con ID_Global y copia fija) | B5 | `ventas.test.js`: cerrar la cuenta crea la venta con ID_Global, su pago y una copia fija de los ítems | ✅ |
| Ventas RN19 (ventas de solo lectura) | B5 | `ventas.test.js`: la venta es de solo lectura, ni con SQL se modifica o borra | ✅ |
| Ventas RN64, EX49 (doble cierre) | B5 | `ventas.test.js`: reenviar el mismo cierre varias veces produce una sola venta | ✅ |
| Ventas RN58, EX43 (efecto fallido, estado de integración) | B5 | `ventas.test.js`: si falla un efecto la venta no se revierte y queda Parcial; al confirmarse vuelve a Completa | ✅ |
| Ventas RN58 (mensaje en la transacción del documento) | B5 | `ventas.test.js`: si el cierre falla, no queda venta ni mensajes | ✅ |
| Ventas RN16, EX11 (suma de pagos = total) | B4 | `ventas.test.js`: un pago mixto cuya suma no es el total se bloquea y la cuenta sigue abierta | ✅ |
| Ventas RF09 (pago mixto, vuelto, resumen "mixto") | B4 | `ventas.test.js`: pago mixto con vuelto; se guarda cada pago y el resumen es "mixto" | ✅ |
| Ventas RN16, EX13 (vuelto solo donde se admite) | B4 | `ventas.test.js`: el vuelto solo se admite en formas configuradas para ello | ✅ |
| Ventas RF09 (formas configurables, referencia obligatoria) | B4 | `ventas.test.js`: una forma nueva con referencia obligatoria exige la referencia; desactivada no se acepta | ✅ |
| Ventas RF09 (reporte por forma de pago) | B4 | `ventas.test.js`: el reporte discrimina lo cobrado por cada forma de pago | ✅ |
| Ventas RN12, RN49, RN56 (numeración correlativa, una en vuelo por clave) | B6 | `facturacion.test.js`: 5 emisiones simultáneas sobre la misma clave salen correlativas, una en vuelo a la vez | ✅ |
| Ventas EX03 (el rechazo libera el número) | B6 | `facturacion.test.js`: un rechazo de ARCA libera el número: el próximo comprobante lo usa | ✅ |
| Ventas RN52 (intento idempotente) | B6 | `facturacion.test.js`: repetir un intento ya autorizado devuelve el mismo comprobante sin volver a ARCA | ✅ |
| Ventas RN52 (intento indeterminado) | B6 | `facturacion.test.js`: un corte después de enviar deja el intento Indeterminado y la clave libre | ✅ |
| Ventas RN50 (arrendamiento vencido, espera, renovación) | B6 | `facturacion.test.js`: el arrendamiento vencido de otro se toma; el vigente hace esperar y vence la espera / se renueva mientras sigue en curso | ✅ |
| Ventas RN14 (Factura A, tope de consumidor final) | B6 | `facturacion.test.js`: la Factura A exige receptor Responsable Inscripto con CUIT; el consumidor final no pasa el tope | ✅ |
