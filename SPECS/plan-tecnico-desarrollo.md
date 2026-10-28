# Plan técnico de desarrollo

Versión del 26/10/2026. Se basa en los SPECS actuales (00 a 08, Anexos D y E). Todo lo que no sale de los SPECS está marcado como **propuesta** y las decisiones que hay que tomar están en la sección 11.

## 1. Qué se construye, en una página

- Un sistema modular para cafeterías y producción de alimentos en Argentina, con facturación electrónica por ARCA.
- Ocho módulos: Usuarios y Auditoría (N0), Ventas (N1), Stock y Financiero (N2), Clientes y CC y Compras (N3), Contable y Ventas Online (N4). Tamaño de los SPECS: unas 260 funciones (RF), 480 reglas (RN) y 280 excepciones (EX).
- Cada cliente tiene un servidor en la nube. Se usa desde un navegador, sin software en el local. Es puramente online: sin conexión no se opera.
- Cada sucursal es una instancia independiente, con su propia base, usuarios, cajas y contabilidad. La consolidación es de solo lectura.
- Los módulos se instalan por separado y los de capas superiores se pueden desinstalar. Usuarios y Ventas son obligatorios.
- Los módulos no leen datos de otros: se hablan por puertos, por una lista cerrada de 21 llamadas inmediatas (Anexo B.5) y por mensajes con bandeja de salida.

Estas cinco ideas mandan sobre todo el diseño técnico: **instancia aislada, módulos aislados, mensajes idempotentes, reservas con vencimiento y funciones activables**.

## 2. Arquitectura propuesta

### 2.1 Monolito modular, no microservicios

Una sola aplicación por servidor de cliente, organizada en ocho módulos con fronteras estrictas.

| Motivo | Detalle |
|--------|---------|
| Es lo que piden los SPECS | Un servidor por cliente, módulos instalables, sin transacciones entre módulos. Esto se logra con fronteras dentro de un proceso, sin red de por medio |
| Operación | Un servidor por cliente con 8 microservicios multiplica el costo de operar, desplegar y monitorear sin que el negocio lo necesite |
| Rendimiento | Los 21 llamados inmediatos tienen 3 segundos de límite y el cierre de venta 8. Dentro del proceso casi no gastan ese presupuesto |
| Camino abierto | Si un módulo debe separarse, las fronteras (puertos y mensajes) ya están definidas |

Las fronteras se hacen cumplir con herramientas, no con acuerdos (ver 2.3).

### 2.2 Datos

| Decisión | Propuesta | Origen en los SPECS |
|----------|-----------|---------------------|
| Base de datos | PostgreSQL | Transacciones, bloqueos, restricciones únicas, JSON para instantáneas |
| Aislamiento por instancia | Una **base de datos por instancia** (sucursal) | RN79; la restauración es siempre de la instancia completa (RF12, RN57) |
| Espacio de datos por módulo | Un **esquema por módulo** dentro de la base de la instancia | "Cada módulo guarda sus datos en un espacio propio" (RN79) |
| Acceso entre módulos | Prohibido leer o escribir tablas de otro esquema. Cada módulo usa un usuario de base con permisos solo sobre su esquema | RN79 |
| Identificadores | ID_Global ordenable por fecha, con el código de la instancia como prefijo (propuesta: UUIDv7 o ULID con prefijo). Lo genera el módulo que crea el documento | F2, RN81 |
| Dinero | Enteros en centavos o decimal exacto, nunca coma flotante. Moneda guardada con cada importe | Todos |
| Hora | Siempre la del servidor (UTC guardado, zona de la instancia al mostrar) | RN21 |
| Versionado de configuración | Cada cambio de activación incrementa Version_Configuracion; cada documento guarda su instantánea de funciones | RN65, RN75 |

### 2.3 Cómo se hacen cumplir las capas (N0 a N4)

1. **Estructura de código:** un paquete por módulo, con carpeta pública (`api`: puertos, eventos y tipos) y carpeta privada (todo lo demás).
2. **Verificación en CI:** una regla de dependencias que falla el build si un módulo importa algo privado de otro, o si una capa baja importa una alta (tabla B.1). Las llamadas inmediatas permitidas se declaran en un registro único que replica el Anexo B.5; una llamada que no esté en el registro no compila.
3. **Puertos con implementación nula:** cada puerto (B.2) tiene una implementación vacía con el comportamiento "sin el módulo" que describen los SPECS.
4. **Pruebas de arquitectura:** una prueba automática que recorre el código y compara las llamadas reales con el Anexo B.5.

### 2.4 Plataforma (la base que construye Usuarios y Auditoría)

Esto se construye primero porque todos los módulos dependen de ello.

| Servicio de plataforma | Qué hace | SPECS |
|------------------------|----------|-------|
| Instancia y módulos | Registro de módulos instalados y su versión, instalación, actualización y desinstalación en 4 pasos | RF13, RN87 |
| Funciones activables | Pantalla única, dependencias, cascadas, aviso reforzado de funciones sanitarias, instantánea por documento | RF18, RN24 a RN28, RN75, RN86 |
| Identidad y permisos | Usuarios, roles, tres niveles (Permitido, Requiere autorización, Denegado), autorización de supervisor, 2FA opcional | RF01 a RF05, RF21 |
| Auditoría | Registro inmutable (solo se agrega) de cambios, intentos y acciones manuales. Nunca guarda contraseñas ni PIN | RF08, RN12 |
| Mensajería | Bandeja de salida transaccional, bandeja de entrada idempotente, reintentos, estados, pendientes con responsable y plazo, conciliación diaria | RF25, RN49 a RN60, RN85 |
| Idempotencia de solicitudes | ID_Solicitud, huella del contenido, "preguntar antes de reenviar", token de formulario | RN69 a RN73 |
| Reservas con vencimiento | Biblioteca común del patrón reservar, confirmar y vencer | RN82, RN83 |
| Claves de comprobantes de terceros | Reserva, dueño, vínculos, duplicados | RF27, RN64, RN84 |
| Numeración fiscal | Secuenciador único con candado y arrendamiento | Ventas RN49 a RN55 |
| Centro de notificaciones | Alertas a roles, escalada al Administrador | RF17 |
| Copias y restauración | Copia de la instancia completa, restauración, reenvío desde la bandeja | RF12, RN14, RN57 |
| Monedas y cotizaciones | Servicio de cotización del día | RF14 |
| Acceso web | Sesiones, vencimiento por inactividad, estado "Sin conexión" | RF28, RN80 |

### 2.5 Mensajería: la pieza más delicada

Cada módulo emisor escribe el mensaje en su bandeja de salida **dentro de la misma transacción** que el documento. Un proceso aparte lo entrega al receptor. El receptor guarda la ID_Operacion procesada y responde "ya procesado" ante un duplicado.

| Pieza | Propuesta técnica |
|-------|-------------------|
| Bandeja de salida | Tabla en el esquema de cada módulo emisor; un trabajador por módulo la consume con `SELECT ... FOR UPDATE SKIP LOCKED` |
| Bandeja de entrada | Tabla `operacion_procesada` con clave única en la ID_Operacion y retención de 90 días |
| Orden | Secuencia por documento. Una anulación espera a su original (RN54) |
| Reintentos | 5 s, 30 s, 2 min, 10 min y cada 10 min hasta 24 h (RN52). Rechazo de negocio no se reintenta |
| Bus interno | En proceso, sin broker externo. Si se necesitara uno más adelante, se cambia solo el transporte |
| Estado de integración de cada documento | Calculado a partir de sus mensajes (Completa o Parcial) |

### 2.6 Funciones activables

- Un registro central de funciones (el catálogo del Anexo A: 61 funciones) con dependencias, valor por defecto y marca de peso sanitario.
- El código de cada módulo pregunta por una función con una sola llamada (`funciones.estaActiva(id, documento)`), que respeta la instantánea del documento.
- Desactivar una función conserva sus datos. Los documentos abiertos siguen con su instantánea hasta cerrarse.
- Hay una prueba por cada dependencia de la tabla E.4.

### 2.7 Frontend y dispositivos

| Tema | Propuesta |
|------|-----------|
| Cliente | Aplicación web de una sola página, instalable como PWA, para caja, tablet, celular y pantalla de cocina (KDS) |
| Estado local | El navegador **no guarda datos del negocio** (RN79, RN80). Solo estado de pantalla |
| Pérdida de conexión | Pantalla "Sin conexión", bloqueo de operaciones nuevas, y al volver consulta por ID_Solicitud |
| Tiempo real | WebSocket o eventos del servidor para KDS, mesas, disponibilidad y notificaciones |
| Periféricos | **Sin resolver** (ver D-05): impresora de tickets, balanza, lector de códigos, cajón de dinero |

## 3. Pila tecnológica propuesta

Esta propuesta depende del equipo con que se cuente (decisión D-01). Se elige por tres razones: un solo lenguaje de punta a punta, buena librería para ARCA, y facilidad para hacer cumplir las fronteras entre módulos.

| Capa | Propuesta | Alternativa razonable |
|------|-----------|-----------------------|
| Lenguaje | TypeScript en backend y frontend | Kotlin con Spring, o C# con .NET (si el equipo ya las domina) |
| Backend | NestJS (módulos con inyección de dependencias) | Spring Modulith o .NET con módulos |
| Base de datos | PostgreSQL 16 | — |
| Frontend | React con Vite, PWA | Vue |
| Contratos entre módulos | Esquemas versionados (JSON Schema o Zod), un tipo por mensaje | Protobuf |
| Colas | Bandeja de salida en PostgreSQL | Broker solo si hace falta |
| Nube | Un proveedor en región cercana a Argentina (por latencia) | — |
| Despliegue | Contenedores; un servidor (o grupo) por cliente, con la infraestructura definida como código | — |
| Observabilidad | Trazas, métricas y logs estructurados con la ID_Operacion y la ID_Solicitud en cada línea | — |
| Secretos | Gestor de secretos del proveedor; los certificados de ARCA nunca en el repositorio | — |

## 4. Fases de desarrollo

Estimación **de orden de magnitud**, con un equipo de unas 7 personas (4 de backend, 2 de frontend, 1 de calidad) más arquitecto y responsable de producto. Debe recalcularse al terminar la Fase 0.

| Fase | Contenido | Duración orientativa |
|------|-----------|----------------------|
| 0 | Cimientos y pruebas de riesgo | 4 semanas |
| 1 | Plataforma (Usuarios y Auditoría) | 10 semanas |
| 2 | Ventas, núcleo con facturación | 12 semanas |
| 3 | Stock y Financiero | 12 semanas (en paralelo con el final de la 2) |
| 4 | Producto mínimo vendible: cafetería | 4 semanas de integración y piloto |
| 5 | Clientes y CC, Compras | 12 semanas |
| 6 | Contable y Ventas Online | 14 semanas |
| 7 | Funciones restantes y endurecimiento | 8 semanas |

Con esa estimación, la cafetería completa con Usuarios, Ventas, Stock y Financiero estaría en 7 a 9 meses; el sistema completo en 14 a 18 meses.

### Fase 0: Cimientos y pruebas de riesgo (4 semanas)

Objetivo: eliminar las tres incertidumbres que pueden cambiar el plan.

| Tarea | Resultado |
|-------|-----------|
| Repositorio, integración continua, entornos y despliegue de una instancia vacía | Se despliega una instancia nueva con un comando |
| Esqueleto del monolito modular con los 8 paquetes y la verificación de dependencias | El build falla si se viola una capa |
| Generador de ID_Global y biblioteca de dinero | Con pruebas |
| **Prueba de riesgo 1: ARCA.** Homologación de factura electrónica (autenticación, solicitud de CAE, consulta del último comprobante, CAEA) y numeración con candado entre procesos | Se emite un comprobante de prueba y se prueba la caída y la respuesta tardía (Ventas RN53 a RN55) |
| **Prueba de riesgo 2: periféricos.** Impresión de tickets, lectura de balanza y cajón desde el navegador | Decisión D-05 tomada con evidencia |
| **Prueba de riesgo 3: mensajería.** Bandeja de salida, bandeja de entrada, reintentos y duplicados entre dos módulos de juguete, con inyección de fallas | Pasa el escenario T05 a T10 de ejemplo |
| Decisiones D-01 a D-06 cerradas | Pila definitiva |

Salida: pila elegida, estimación recalculada y riesgos técnicos confirmados o descartados.

### Fase 1: Plataforma (10 semanas)

Todo lo de la sección 2.4. Orden interno:

1. Instancia, módulos y registro (RF13), usuarios, sesiones y acceso web (RF01, RF04, RF28).
2. Roles, permisos, autorización de supervisor (RF02, RF05) y auditoría (RF08).
3. Funciones activables con dependencias, cascadas e instantáneas (RF18, RN24 a RN28, RN65, RN75, RN77).
4. Mensajería completa (RF25) con pendientes, responsables y escalada (RN85).
5. Idempotencia de solicitudes (RN69 a RN73) y biblioteca de reservas (RN82, RN83).
6. Claves de comprobantes de terceros (RF27).
7. Centro de notificaciones, monedas y cotizaciones, copias y restauración (RF12, RF14, RF17).
8. Desinstalación de módulos (RN87).

Salida: la plataforma pasa los casos T05 a T10, T37 a T42, T49 y T55 a T59 del Anexo E con módulos de prueba.

### Fase 2: Ventas, núcleo (12 semanas)

Alcance: catálogo, pedido, cierre de venta, formas de pago, comprobantes fiscales y no fiscales, anulación y devolución.

| Bloque | Referencias |
|--------|-------------|
| Catálogo y artículos (tipos estándar, pesable, fraccionable, combo, elaborado) | RF01, RN04 |
| Pedido y cierre de venta con el orden y presupuesto de 8 segundos | RF08, RN85 |
| Formas de pago, pago mixto, vuelto | RF09, RN16 |
| Facturación fiscal por ARCA con CAE y CAEA, emisión concurrente y respuestas tardías | RF10, RF47, RN49 a RN55, EX02 a EX05, EX37 a EX42 |
| Comprobantes no fiscales y su regularización | RF12, RN84 |
| Anulación, devolución, nota de crédito | RF15, RN34, RN76 |
| Registro de ventas, filtros, reimpresión | RF19 a RF22 |
| Copia local de costos, listas y condición de socio (se llena por eventos) | RN81 |
| Puertos hacia Stock, Financiero y Clientes con implementación nula | B.2 |

Fuera de esta fase: Modo Salón, KDS, móvil, promociones, listas de precios, cuenta corriente, gift cards. Se agregan en la Fase 7 o con sus módulos.

### Fase 3: Stock y Financiero (12 semanas, en paralelo)

**Stock:** unidades y presentaciones (RF02, RN87), movimientos, depósitos, compromiso y reserva (RF36, RN58, RN59), descuento por modo (RF10, RN64), valuación (RF17), toma de inventario (RN20, RN67, RN68), lotes y vencimientos (STK-LOTES, RN84 con lote automático).

**Financiero:** cajas y turnos, cobros desde Ventas (puerto de cobros), cierre de turno con pendientes (RN41), reapertura (RN43), devolución en efectivo con consulta de saldo (RN42, RN45, RN46), gastos.

Salida: venta completa de cafetería con descuento de stock y caja que cuadra; conciliación diaria sin diferencias.

### Fase 4: Producto mínimo vendible (4 semanas)

- Perfil de rubro "Cafetería" completo (Anexo A.2) sobre Usuarios, Ventas, Stock y Financiero.
- Pruebas de las 24 configuraciones del Anexo E.3 que no exigen otros módulos.
- Piloto en un local con acompañamiento. Medir tiempos de cierre, tasa de pendientes de integración y diferencias de caja.

### Fase 5: Clientes y CC, Compras (12 semanas)

- **Clientes y CC:** maestro de clientes, cuentas corrientes en varias monedas (Ventas RN87), veredicto y reserva de crédito (RF26, RN04, RN34), remitos y facturación agrupada (RF05, RF27 de Ventas, RN31), gift cards y vales (RF29, EX62), fidelización.
- **Compras:** proveedores, facturas de compra con ingreso vinculado, lotes en la recepción (RF19), costos de reposición por eventos, identificación de comprobantes (RF27 de Usuarios).

### Fase 6: Contable y Ventas Online (14 semanas)

- **Contable:** plan de cuentas, reglas de imputación por formulario (RF03), asientos, controles cruzados (RF11), cierres de período, sin ventas no fiscales (RF26), parámetro de costo (Momento_Costo_Ventas_No_Fiscales).
- **Ventas Online:** tienda, reservas de stock con vencimiento (RN06, RN07, RN56), pasarela de pago, pedidos programados e inmediatos (RN04), ajuste por peso (RN50 a RN52), cuentas de cliente, marketplaces (ONL-MARKETPLACES).

### Fase 7: Funciones restantes y endurecimiento (8 semanas)

Modo Salón, KDS, móvil, promociones, listas de precios, producción y recetas, trazabilidad, alérgenos, etiquetas, consolidación de sucursales (USU-CONSOL), pruebas de carga, pruebas de seguridad y plan de recuperación.

## 5. Cómo se prueba

Los SPECS ya traen la estrategia (Anexo E). El plan técnico la automatiza.

| Nivel | Qué cubre | Origen |
|-------|-----------|--------|
| Unitarias | Reglas de negocio (RN) y excepciones (EX), una prueba por regla | Módulos |
| Contrato | Cada puerto, cada mensaje y cada llamada inmediata, con su esquema versionado y su política de falla | B.2, B.3, B.5 |
| Arquitectura | Capas, aislamiento de esquemas, llamadas fuera del registro | Sección 2.3 |
| Propiedades | Idempotencia: aplicar el mismo mensaje N veces da el mismo estado; orden: anulación antes de venta | RN51, RN54 |
| Concurrencia | Última unidad vendida desde dos terminales (T01), cinco emisiones simultáneas (T11), dos Administradores (T37) | E.5 |
| Inyección de fallas | Módulo caído, respuesta perdida, reinicio a mitad de transacción, ARCA lento | T02, T05, T10, T12 |
| Matriz de configuraciones | Las 24 configuraciones del E.3 se despliegan en integración continua y pasan la lista de humo (E.2) | E.2, E.3 |
| Escenarios | Los 37 de E.5 y los 28 de E.7 como pruebas de aceptación automatizadas | E.5, E.7 |
| Trazabilidad | Cada prueba lleva en su nombre el ID de la regla (por ejemplo `Ventas.RN85`); un informe lista las reglas sin prueba | Anexo D |

Regla de calidad: **ninguna fase se cierra con una regla sin prueba**. El informe de trazabilidad forma parte de la salida de cada fase.

La matriz se regenera con `herramientas/generar-matriz-pares.py` cada vez que cambie el catálogo de funciones.

## 6. Seguridad y cumplimiento

| Tema | Propuesta |
|------|-----------|
| Autenticación | Contraseña de al menos 8 caracteres, guardada con función lenta (Argon2 o bcrypt); PIN igual; 2FA con TOTP opcional |
| Autorización | Cada acción pasa por el servicio de permisos; los tres niveles se evalúan en el servidor, nunca en el navegador |
| Auditoría | Solo se agrega; sin contraseñas ni PIN (RN12); retención parametrizable |
| Aislamiento | Una base por instancia; usuarios de base por módulo; sin acceso cruzado entre clientes |
| Certificados de ARCA | En el gestor de secretos, con rotación y alerta de vencimiento |
| Datos personales | Cumplir la ley argentina de protección de datos personales; definir con asesoría legal los plazos de retención (Para confirmar 8) |
| Copias | Diarias y cifradas, con prueba periódica de restauración |
| Navegador | Sin datos del negocio guardados; cookies seguras; protección contra solicitudes falsificadas |
| Pasarela | Nunca se guardan datos de tarjeta; solo identificadores de transacción |

## 7. Operación

- **Una instancia nueva** se crea con un comando: base, esquemas, módulos contratados, perfil de rubro y usuario Administrador.
- **Actualizaciones** por módulo, con migraciones versionadas y reversibles. Un módulo no puede actualizarse si rompe un puerto que otro usa (RF13).
- **Monitoreo:** bandejas de salida con antigüedad, pendientes vencidos, tiempo de cierre de venta, latencia de ARCA, diferencias de la conciliación diaria.
- **Alertas técnicas** hacia el equipo; las alertas de negocio van al Centro de Notificaciones.
- **Copias y restauración** probadas en cada versión (RF12, RN14, RN57).

## 8. Equipo propuesto

| Rol | Cantidad | Responsabilidad principal |
|-----|----------|---------------------------|
| Arquitecto | 1 | Fronteras entre módulos, mensajería, decisiones técnicas |
| Backend | 4 | Plataforma y módulos, con un dueño por módulo |
| Frontend | 2 | Caja, KDS, tienda, administración |
| Calidad | 1 | Matriz, escenarios, inyección de fallas |
| Producto | 1 | Dueño de los SPECS; resuelve las dudas de negocio |
| Contador y asesoría legal | Consulta | Contable, ventas no fiscales, normativa |

## 9. Riesgos principales

| Riesgo | Efecto | Mitigación |
|--------|--------|------------|
| ARCA lento, caído o con respuestas tardías | No se puede facturar | Prueba en Fase 0; cola de numeración con candado; CAEA; comprobante no fiscal como último recurso |
| Periféricos desde el navegador | Imprimir, pesar y abrir el cajón puede no funcionar en algunos equipos | Prueba en Fase 0 y decisión D-05 antes de seguir |
| Complejidad de la mensajería | Duplicados, orden o pérdida de efectos | Construirla primero, con inyección de fallas y conciliación diaria |
| Alcance muy grande | Plazos | Entregar por fases con piloto en la Fase 4; las funciones activables permiten salir sin todo |
| Dependencia de internet del local | Sin conexión no se vende | Decisión de negocio ya tomada; mostrar claramente el estado y medir la disponibilidad |
| Validaciones pendientes del contador | Retrabajo en Contable | Fase 6 recién empieza después de la validación |
| Reglas que se contradicen al crecer | Errores sutiles | Prueba de coherencia de referencias en CI y revisión de los SPECS en cada fase |

## 10. Qué se hace en las dos primeras semanas

1. Elegir pila y repositorio (D-01 y D-02).
2. Armar el esqueleto con los 8 paquetes, la verificación de capas y el registro de llamadas inmediatas.
3. Montar integración continua con una base PostgreSQL por prueba.
4. Escribir el generador de ID_Global, la biblioteca de dinero y la biblioteca de hora.
5. Pedir las credenciales de homologación de ARCA y el certificado de prueba.
6. Conseguir una impresora de tickets, una balanza con salida USB o serie, un lector de códigos y un cajón para las pruebas de periféricos.
7. Convertir el catálogo del Anexo A y las tablas del Anexo B en datos que el código lea (funciones, dependencias, puertos, llamadas inmediatas).
8. Armar el informe de trazabilidad: una lista con todas las reglas (RF, RN, EX) como casillas vacías.

## 11. Decisiones que hay que tomar

| # | Decisión | Propuesta | Cuándo |
|---|----------|-----------|--------|
| D-01 | Lenguaje y marco | TypeScript y NestJS, si el equipo lo permite | Semana 1 |
| D-02 | Proveedor de nube y región | El que ya use el equipo, en la región más cercana | Semana 1 |
| D-03 | Una base por instancia en un servidor por cliente | Sí | Semana 1 |
| D-04 | Monolito modular | Sí | Semana 1 |
| D-05 | Cómo se conectan impresora, balanza, lector y cajón a una página web. Hoy el SPEC dice que no se instala software en el local (RN79). Opciones: (a) APIs del navegador (WebUSB, WebSerial) sin instalar nada, solo en Chrome o Edge; (b) un programa pequeño en el local que sirve de puente, que contradice RN79 y habría que ajustarlo; (c) impresoras de red con servicio de impresión en la nube | Probar (a) en Fase 0 y decidir con evidencia; dejar (b) como respaldo | Fase 0 |
| D-06 | Formato de los esquemas de mensajes | Esquemas versionados en el mismo repositorio | Semana 2 |
| D-07 | Qué módulos van en el producto mínimo | Usuarios, Ventas, Stock y Financiero | Semana 2 |
| D-08 | Piloto: qué local y cuándo | A definir con el negocio | Fase 2 |
| D-09 | Validación contable de las ventas sin comprobante, gift cards y costo | Antes de empezar la Fase 6 | Fase 5 |
| D-10 | Valores propuestos de los SPECS (vigencias de reservas, tope de reservas sin pago, plazos de pendientes, presupuesto del cierre) | Usarlos como valores por defecto y medirlos en el piloto | Fase 4 |

## 12. Trazabilidad con los SPECS

| Documento | Para qué sirve en el desarrollo |
|-----------|---------------------------------|
| 00 Índice | Catálogo de funciones, perfiles, capas, puertos, eventos y llamadas inmediatas: se convierten en datos del código |
| 01 a 08 | Una carpeta de módulo cada uno; las RN y EX son los criterios de aceptación |
| Anexo D | Lista de verificación de cobertura; se mantiene junto al informe de trazabilidad |
| Anexo E | Base de las pruebas automatizadas y de la matriz de configuraciones |
| `herramientas/generar-matriz-pares.py` | Se ejecuta en integración continua cuando cambia el catálogo |
| `cambios-aplicados.md` | Historial de decisiones; sirve para entender por qué cada regla es como es |
