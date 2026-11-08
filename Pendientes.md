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

- **Constatación del CAE en ARCA (H8)**: el servicio queda enchufable (`src/services/constatacionService.js`, `usarTransporte`) pero sin cliente real del servicio de ARCA para comprobantes recibidos. Sin él, todo comprobante queda "pendiente de constatar". Los tests usan un transporte simulado.
- **Constatación automática**: solo la reintenta el endpoint `POST /api/compras/arca/constatar-pendientes`; no la corre el trabajo horario de Compras.
- **Nota de crédito por bonificación (H9)**: para que baje el costo de reposición hay que cargarla con `ajuste_costo: true`. Sin esa marca se trata como devolución de cantidades y no cambia el costo.
- **Nota de crédito con mercadería sin vínculo (H9, RN38)**: el vínculo con la devolución de Stock no es obligatorio al registrar la nota; la devolución queda como reclamo pendiente hasta que se vincule.
- **Devolución sin efecto (H9, EX24)**: no está el caso de un egreso anulado en Stock antes del vínculo (Stock no anula egresos hoy).
- **Desvincular un ingreso (H7)**: desvincular un ingreso de una factura no revierte lo ya contado como recibido en el pedido.
- **Listas de proveedor (H6)**: se probó la importación con el texto del CSV por API; no hay carga de archivo Excel ni prueba con un archivo real subido desde una pantalla.
- **Funciones que nacen desactivadas** (según la especificación): `CMP-PEDIDO-SUGERIDO`, `CMP-PAGOS-PROGRAMADOS`, `CMP-RETENCIONES`. Los informes de retenciones y percepciones solo responden con `CMP-RETENCIONES` activa.
- **Pedido sugerido (H7)**: el proveedor de cada ítem es su proveedor principal (el último que fijó su costo de reposición); un ítem sin proveedor principal queda fuera del pedido hasta que se le asigne uno.

## Pendiente de documentación

- Los números de versión y el detalle de cada checkpoint están en `plan-checkpoints-opcionales.md`.

## Ventas Online (Fase I)

- **I1, aislamiento entre instancias**: la prueba automática usa una sola instancia; que una ruta pública no lea datos de otra se garantiza porque cada instancia tiene su base y el código resuelve la instancia, pero no hay una prueba con dos instancias reales.
- **I1, límites por IP**: los contadores están en memoria de este proceso (se pierden al reiniciar); alcanza con una sola app. El tope de pedidos por hora ya sale de la configuración de la tienda, pero lo usará el checkout (I5).
- **I1, sin pantallas**: ni la administración de la tienda ni la tienda pública tienen todavía frontend; por ahora son API.

### Cierre de la Fase I (I2 a I11)

- **Sin pantallas**: toda la Fase I (tienda pública, carrito, checkout, panel de pedidos, plataformas, reservas, informes) está hecha por API y probada por API. Falta el frontend de la tienda y del panel.
- **Aislamiento entre instancias** (I1): sigue sin haber una prueba con dos instancias reales; se sostiene por el diseño (una base por instancia).
- **Pasarela** (I6): Mercado Pago está implementado detrás de una interfaz (Checkout Pro, consulta, reintegros y firma HMAC) y las pruebas usan una pasarela simulada; falta probarlo contra las credenciales de prueba reales de Mercado Pago. Las credenciales se guardan en la base de la instancia sin cifrar.
- **Promociones de Ventas** (I4, RF21): el carrito no aplica las promociones automáticas de VEN-PROMOS (solo precios de lista, ajuste online y cupones); las promociones de Ventas trabajan sobre pedidos de la caja.
- **Tope por pedidos sin pago** (I5, RN56): no se limita el porcentaje del disponible que pueden reservar los pedidos sin pago aprobado (transferencia, pago al retirar).
- **Elaborados sin reserva** (I5, RN07): los elaborados de producción en venta se reservan como cualquier ítem con receta que controla stock.
- **Tope de consumidor final** (I5, RN10): el checkout no exige identificar al comprador cuando el pedido supera el tope de consumidor final; ARCA lo rechaza al facturar y el pedido queda pendiente de facturación.
- **Pesables** (I9): en Ventas viajan como una línea de cantidad 1 por su importe estimado (la cantidad de la línea es entera) y el descuento de Stock usa esa cantidad; el ajuste del descuento al peso real (RN51 j) queda pendiente.
- **Pago al retirar y efectivo contra entrega** (I8): Ventas registra la venta como cobrada en efectivo al aceptar el pedido, sin pasar por el turno de caja de Financiero.
- **Cuenta corriente y vales** (I5, I8, I10): se probaron la reserva de crédito y la retención de vales; la venta a cuenta corriente y el canje de vales por la entrega a Ventas y la cancelación no tienen una prueba propia de punta a punta.
- **Transportistas** (I7): ONL-ENVIOS-TRANSPORTISTA queda apagada y sin implementación (decisión de proyecto); solo retiro y delivery propio.
- **Plataformas** (I11): el envío del menú y de los estados a cada plataforma es un punto de enchufe (`usarTransporte`) sin cliente real de ninguna plataforma; sin él el conector figura desconectado y los estados quedan en cola. Financiero registra las comisiones y concilia las liquidaciones, pero no genera movimientos de fondos (gasto ni ingreso a la cuenta de pasarela).
- **Reservas desde la tienda** (I11): se valida contra los cupos de Ventas al instante (no hay una validación diferida a los 5 minutos); el recordatorio por correo sale por el trabajo de recordatorios de Ventas.
- **Visitas** (I11): se cuenta cada carga de la portada, sin distinguir visitantes únicos.

## Pruebas

- **Tests que dependen de la hora del día**: dos pruebas de Financiero (`financiero_informes`: balance de actividad y paquete de consolidación) fallan cuando se corren después de las 21:00 hora de Argentina, porque comparan fechas UTC con fechas locales. Con `TZ=UTC` pasan.
- **ARCA en los tests de la tienda**: las pruebas de Ventas Online simulan ARCA (`test/ayudas_online.js`); sin la simulación cada pedido pagado intenta salir a internet y espera su tiempo máximo.
