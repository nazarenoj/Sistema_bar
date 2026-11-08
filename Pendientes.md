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
