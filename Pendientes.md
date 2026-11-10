# Pendientes y límites conocidos

Lista de lo que quedó diferido o limitado al cerrar las Fases G (Financiero) y H (Compras). Se actualiza al cerrar cada fase.

## General

- **Sin pantallas para Financiero ni Compras**: están hechos por API y probados por API. Falta el frontend (React) de ambos módulos.
- **Suite completa**: la última corrida completa de `npm test` fue después de G9 (504 de 507 pasaban). Desde entonces solo se corrieron los tests nuevos y los vecinos de cada checkpoint, en tandas chicas. Conviene volver a correr todo.
- **Tests que ya fallaban antes** (no son de G ni H): Usuarios.RF11, Usuarios.RF22 y Usuarios.EX12.
- **`X-ID-Solicitud`**: el encabezado de idempotencia funciona en todo el sistema, pero no es obligatorio en las rutas nuevas de Financiero y Compras (por ejemplo pedidos, listas, devoluciones).
- **Pruebas de campo**: sigue pendiente el checkpoint B0 (periféricos con el equipo real del cliente piloto) y la versión exacta de MySQL/MariaDB del plan de Hostinger.

## Financiero (Fase G)

- **G9, RF24 (pasarelas y plataformas de cobro)**: diferido a la Fase I (Ventas Online), que es donde aparece Mercado Pago.

## Compras (Fase H)

Resuelto: la constatación del CAE se reintenta sola en el trabajo horario (con CMP-CONTROL-ARCA), desvincular un ingreso descuenta lo que había contado como recibido en el pedido, las listas de proveedor se importan también desde Excel (`xlsx_base64`) y el gasto con comprobante fiscal de Financiero entra al Libro IVA (sin deuda; si el CUIT no es un proveedor queda rechazado en la bandeja hasta darlo de alta). Por especificación (no son defectos): la nota de crédito por bonificación baja el costo de reposición solo con la marca `ajuste_costo` (sin ella es devolución de cantidades, Compras RN38), el vínculo con la devolución de Stock se hace al cargar o después y la devolución queda como reclamo pendiente (EX24), las funciones `CMP-PEDIDO-SUGERIDO`, `CMP-PAGOS-PROGRAMADOS` y `CMP-RETENCIONES` nacen desactivadas y un ítem sin proveedor principal queda fuera del pedido sugerido. Queda:

- **Constatación del CAE en ARCA (H8)** [externo]: el servicio queda enchufable (`src/services/constatacionService.js`, `usarTransporte`) pero sin cliente real del servicio de ARCA para comprobantes recibidos (hace falta el certificado y las credenciales de producción). Sin él, todo comprobante queda «pendiente de constatar»; los tests usan un transporte simulado.
- **Devolución sin efecto (EX24)**: el caso de un egreso anulado en Stock antes del vínculo no existe porque Stock no anula egresos.

## Pendiente de documentación

- Los números de versión y el detalle de cada checkpoint están en `plan-checkpoints-opcionales.md`.

## Ventas Online (Fase I)

Resuelto: prueba con dos instancias reales (la tienda de una no ve datos de la otra), promociones automáticas de Ventas en el carrito y el pedido (se muestran junto al ítem, el cupón respeta su acumulabilidad y la venta registra las promociones aplicadas), y el checkout exige DNI por encima del tope de consumidor final. Queda:

- **Sin pantallas** [decisión: fase aparte]: toda la Fase I está hecha por API; falta el frontend de la tienda y del panel.
- **Límites por IP** (I1): los contadores están en memoria de este proceso (se pierden al reiniciar); alcanza con una sola app.
- **Pasarela** (I6) [externo]: Mercado Pago está implementado detrás de una interfaz (Checkout Pro, consulta, reintegros y firma HMAC) y las pruebas usan una pasarela simulada; falta probarlo con las credenciales de prueba reales. Las credenciales se guardan en la base de la instancia sin cifrar.
- **Promociones** (RF21): las promociones para socios no se aplican en la tienda (haría falta identificar al socio por la cuenta); un cupón no acumulable deja el ítem con su promoción en vez de elegir el menor precio final entre ambos.
- **Tope por pedidos sin pago** (I5, RN56): no se limita el porcentaje del disponible que pueden reservar los pedidos sin pago aprobado (transferencia, pago al retirar).
- **Elaborados sin reserva** (I5, RN07): los elaborados de producción en venta se reservan como cualquier ítem con receta que controla stock.
- **Pesables** (I9): en Ventas viajan como una línea de cantidad 1 por su importe estimado (la cantidad de la línea es entera) y el descuento de Stock usa esa cantidad; el ajuste del descuento al peso real (RN51 j) queda pendiente.
- **Pago al retirar y efectivo contra entrega** (I8): Ventas registra la venta como cobrada en efectivo al aceptar el pedido, sin pasar por el turno de caja de Financiero.
- **Cuenta corriente y vales** (I5, I8, I10): la venta a cuenta corriente y el canje de vales por la entrega a Ventas y la cancelación no tienen una prueba propia de punta a punta.
- **Transportistas** (I7): ONL-ENVIOS-TRANSPORTISTA queda apagada y sin implementación (decisión de proyecto); solo retiro y delivery propio.
- **Plataformas** (I11) [externo]: el envío del menú y de los estados a cada plataforma es un punto de enchufe (`usarTransporte`) sin cliente real de ninguna plataforma; sin él el conector figura desconectado y los estados quedan en cola.
- **Reservas desde la tienda** (I11): se valida contra los cupos de Ventas al instante (no hay una validación diferida a los 5 minutos).
- **Visitas** (I11): se cuenta cada carga de la portada, sin distinguir visitantes únicos.

## Contable (Fase J)

Todo Contable (J1 a J9) está por API; **no hay pantallas**. Lo que sigue quedó fuera o con límites conocidos.

### Fuentes que todavía no publican a Contable

Resueltos: recibos de cuenta corriente, gastos y su anulación, pago de comisiones, transferencias entre caja y banco, liquidaciones de tarjeta, comisión y liquidación de plataformas con su diferencia de conciliación, factura y anulación de remitos, vencimiento de gift cards y vales, producción valorizada, egresos de stock «otra», packaging en el costo de ventas, costo de una venta no fiscal al regularizarse, mercadería e insumos de las compras, medios de pago de las órdenes, compras en moneda extranjera y canje por vale o gift card. Queda:

- **Operaciones de divisa** (compra y venta de moneda de Financiero) y **cuentas en divisa**: el plan no tiene cuentas de caja o banco en moneda extranjera por clave; hace falta decidir cómo se modelan (ver Dudas).
- **Cheques rechazados y gastos bancarios** de Financiero: no se informan a Contable.
- **Ingresos de stock** con motivo «otra» (ajustes positivos): no se informan; solo los egresos.
- **Órdenes de pago en moneda extranjera**: el evento no trae cotización; se imputan como pesos.
- **Gasto con comprobante fiscal → Compras**: Compras no tiene receptor del evento (el Libro IVA no incorpora esos gastos todavía).
- **Criterio por categoría de artículo** en ventas y costo: las líneas lo traen pero las reglas predeterminadas no lo usan.

### Reglas y asientos

Resueltos: conflicto de idempotencia (EX18), plazo de conservación informado (los libros nunca se purgan), adjuntos de asientos manuales, recurrentes y escalada al Administrador por un trabajo horario, confirmación al anular un resumido, propuesta de inicio (primer día del período abierto más cercano), revaluación propuesta al cerrar un período, historial de controles, plantilla también para el plan de cuentas, y actualización del plan y las reglas cuando se instala un módulo después (`POST /api/contable/plan/actualizar`). Por especificación no hay reapertura de un ejercicio cerrado (Contable RN12). Queda:

- **Cierre de ejercicio**: el ejercicio siguiente es de año calendario (se crea solo si no existe).
- **Revaluación**: solo revalúa cuentas con importe en divisa cargado a mano (ningún flujo automático lo trae todavía) y se registra a pedido; si falta la cotización de cierre el cierre del período no se bloquea.
- **Controles cruzados**: no comparan cuentas en moneda extranjera; el de existencias compara el total, no por depósito.

### Consolidación (J9)

- El paquete contable es mensual (balance del mes hasta el día publicado) y viaja por el mecanismo diario de Usuarios: el control de «paquetes faltantes» de Usuarios no distingue períodos contables, así que el faltante contable se resuelve en el propio balance consolidado.
- Medido: el paquete y el balance de un plan de 2.000 cuentas y el consolidado de 20 sucursales salen en menos de 10 segundos (`test/contable_rendimiento.test.js`).

### Instalación y dependencias

- Contable depende de Usuarios y Ventas; Stock, Clientes, Compras y Financiero son opcionales. Si un módulo se instala o una función se activa **después** de iniciar la contabilidad hay que correr `POST /api/contable/plan/actualizar`, que suma las cuentas y reglas que faltan (no se corre solo).

## Pruebas

- **Tests que dependen de la hora del día**: dos pruebas de Financiero (`financiero_informes`: balance de actividad y paquete de consolidación) fallan cuando se corren después de las 21:00 hora de Argentina, porque comparan fechas UTC con fechas locales. Con `TZ=UTC` pasan.
- **ARCA en los tests de la tienda**: las pruebas de Ventas Online simulan ARCA (`test/ayudas_online.js`); sin la simulación cada pedido pagado intenta salir a internet y espera su tiempo máximo.
- **MySQL local para las pruebas**: el servicio `MySQL80` de esta máquina no arranca sin permisos de administrador; para correr las pruebas se levantó un `mysqld` descartable (`--initialize-insecure`, puerto 3306) en una carpeta temporal.
- **Pruebas que fallan en domingo** (corrida completa del 2026-11-08, 733 de 744 en verde): Usuarios (cotización automática por día hábil, retención de copias, cola de correo), Ventas (reservas, pedido especial, `EX40` clave sin resolver) y Financiero (gastos recurrentes). No tocan Contable; los mensajes apuntan a fechas y días hábiles, pero no se verificó que fallen igual sin los cambios de la Fase J. Volver a correrlas en un día hábil o en el commit anterior a J1.
