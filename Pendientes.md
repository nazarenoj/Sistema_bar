# Pendientes y límites conocidos

Lista de lo que quedó diferido o limitado al cerrar las Fases G (Financiero) y H (Compras). Se actualiza al cerrar cada fase.

## General

- **Sin pantallas** [decisión: fase aparte]: Financiero, Compras, Ventas Online y Contable están hechos por API y probados por API. Falta el frontend (React) de los cuatro.
- **Suite completa**: la corrida completa de `npm test` del 2026-11-10 dio 775 de 775 en verde.
- **`X-ID-Solicitud`**: el encabezado de idempotencia es obligatorio en las operaciones que mueven dinero o asientos (gastos, transferencias, liquidaciones, divisas, comprobantes y órdenes de compras, y las de Contable); las demás rutas lo aceptan pero no lo exigen.
- **Pruebas de campo** [externo]: sigue pendiente el checkpoint B0 (periféricos con el equipo real del cliente piloto) y la versión exacta de MySQL/MariaDB del plan de Hostinger.

## Financiero (Fase G)

- **RF24 (pasarelas y plataformas de cobro)**: resuelto en la Fase I (Ventas Online): comisiones, liquidaciones y diferencias de conciliación, que además llegan a Contable.
- **Operaciones de divisa**: resuelto, llegan a Contable (compra, venta y diferencia de cambio).

## Compras (Fase H)

Resuelto: la constatación del CAE se reintenta sola en el trabajo horario (con CMP-CONTROL-ARCA), desvincular un ingreso descuenta lo que había contado como recibido en el pedido, las listas de proveedor se importan también desde Excel (`xlsx_base64`) y el gasto con comprobante fiscal de Financiero entra al Libro IVA (sin deuda; si el CUIT no es un proveedor queda rechazado en la bandeja hasta darlo de alta). Por especificación (no son defectos): la nota de crédito por bonificación baja el costo de reposición solo con la marca `ajuste_costo` (sin ella es devolución de cantidades, Compras RN38), el vínculo con la devolución de Stock se hace al cargar o después y la devolución queda como reclamo pendiente (EX24), las funciones `CMP-PEDIDO-SUGERIDO`, `CMP-PAGOS-PROGRAMADOS` y `CMP-RETENCIONES` nacen desactivadas y un ítem sin proveedor principal queda fuera del pedido sugerido. Queda:

- **Constatación del CAE en ARCA (H8)** [externo]: el servicio queda enchufable (`src/services/constatacionService.js`, `usarTransporte`) pero sin cliente real del servicio de ARCA para comprobantes recibidos (hace falta el certificado y las credenciales de producción). Sin él, todo comprobante queda «pendiente de constatar»; los tests usan un transporte simulado.
- **Devolución sin efecto (EX24)**: el caso de un egreso anulado en Stock antes del vínculo no existe porque Stock no anula egresos.

## Pendiente de documentación

- Los números de versión y el detalle de cada checkpoint están en `plan-checkpoints-opcionales.md`.

## Ventas Online (Fase I)

Resuelto: los elaborados que se producen al venderse no se reservan, el efectivo de los pedidos (pago al retirar, contra entrega) se asienta en la caja y el turno del local que entrega (terminal de cobro configurable en la tienda), visitantes únicos en el informe de conversión, pruebas de punta a punta del canje de vales y de la cuenta corriente (venta, deuda y liberación de la reserva al cancelar), tope de reserva para pedidos sin pago (30 % del disponible por artículo; por encima el pedido queda pendiente de autorización de un supervisor, con motivo, y se cancela como cualquier impago si nadie lo autoriza), prueba con dos instancias reales (la tienda de una no ve datos de la otra), promociones automáticas de Ventas en el carrito y el pedido (se muestran junto al ítem, el cupón respeta su acumulabilidad y la venta registra las promociones aplicadas), y el checkout exige DNI por encima del tope de consumidor final. Queda:

- **Sin pantallas** [decisión: fase aparte]: toda la Fase I está hecha por API; falta el frontend de la tienda y del panel.
- **Límites por IP** (I1) [decisión]: los contadores están en memoria de este proceso (se pierden al reiniciar); alcanza con una sola app y llevarlos a la base sumaría una escritura por cada visita pública.
- **Pasarela** (I6) [externo]: Mercado Pago está implementado detrás de una interfaz (Checkout Pro, consulta, reintegros y firma HMAC) y las pruebas usan una pasarela simulada; falta probarlo con las credenciales de prueba reales. Las credenciales se guardan en la base de la instancia sin cifrar.
- **Promociones** (RF21): las promociones para socios no se aplican en la tienda (haría falta identificar al socio por la cuenta); un cupón no acumulable deja el ítem con su promoción en vez de elegir el menor precio final entre ambos.
- **Pesables** (I9, RN51 j): en Ventas viajan como una línea de cantidad 1 por su importe estimado y el descuento de Stock usa esa cantidad. El ajuste al peso real hay que hacerlo con un descuento adicional o un reingreso en Stock por la diferencia, y se cruza con la devolución que Ventas registra al reintegrar (se podría contar dos veces): no se tocó sin probarlo con Stock y Ventas juntos.
- **Transportistas** (I7): ONL-ENVIOS-TRANSPORTISTA queda apagada y sin implementación (decisión de proyecto); solo retiro y delivery propio.
- **Plataformas** (I11) [externo]: el envío del menú y de los estados a cada plataforma es un punto de enchufe (`usarTransporte`) sin cliente real de ninguna plataforma; sin él el conector figura desconectado y los estados quedan en cola.

## Contable (Fase J)

Todo Contable (J1 a J9) está por API; **no hay pantallas**. Lo que sigue quedó fuera o con límites conocidos.

### Fuentes que todavía no publican a Contable

Resueltos: operaciones y cuentas en divisa (una cuenta contable por cada caja o cuenta en moneda extranjera de Financiero, con importe en divisa y cotización, apertura, control cruzado y revaluación), recibos de cuenta corriente, gastos y su anulación, pago de comisiones, transferencias entre caja y banco, liquidaciones de tarjeta, comisión y liquidación de plataformas con su diferencia de conciliación, factura y anulación de remitos, vencimiento de gift cards y vales, producción valorizada, egresos de stock «otra», packaging en el costo de ventas, costo de una venta no fiscal al regularizarse, mercadería e insumos de las compras, medios de pago de las órdenes, compras en moneda extranjera y canje por vale o gift card. Queda:

- **Cheques rechazados y gastos bancarios** de Financiero: no se informan a Contable.
- **Ingresos de stock** con motivo «otra» (ajustes positivos): no se informan; solo los egresos.
- **Órdenes de pago en moneda extranjera**: el evento no trae cotización; se imputan como pesos.
- **Gasto con comprobante fiscal → Compras**: Compras no tiene receptor del evento (el Libro IVA no incorpora esos gastos todavía).
- **Criterio por categoría de artículo** en ventas y costo: las líneas lo traen pero las reglas predeterminadas no lo usan.

### Reglas y asientos

Resueltos: conflicto de idempotencia (EX18), plazo de conservación informado (los libros nunca se purgan), adjuntos de asientos manuales, recurrentes y escalada al Administrador por un trabajo horario, confirmación al anular un resumido, propuesta de inicio (primer día del período abierto más cercano), revaluación propuesta al cerrar un período, historial de controles, plantilla también para el plan de cuentas, y actualización del plan y las reglas cuando se instala un módulo después (`POST /api/contable/plan/actualizar`). Por especificación no hay reapertura de un ejercicio cerrado (Contable RN12). Queda:

- **Cierre de ejercicio**: el ejercicio siguiente es de año calendario (se crea solo si no existe).
- **Revaluación**: revalúa las cuentas en divisa de Financiero y las que tengan importe en divisa cargado a mano; se registra a pedido; si falta la cotización de cierre el cierre del período no se bloquea.
- **Controles cruzados**: el de existencias compara el total, no por depósito. Los movimientos de Financiero en divisa que no son compra o venta de moneda (gastos o cobros en dólares) no se informan a Contable.

### Consolidación (J9)

- El paquete contable es mensual (balance del mes hasta el día publicado) y viaja por el mecanismo diario de Usuarios: el control de «paquetes faltantes» de Usuarios no distingue períodos contables, así que el faltante contable se resuelve en el propio balance consolidado.
- Medido: el paquete y el balance de un plan de 2.000 cuentas y el consolidado de 20 sucursales salen en menos de 10 segundos (`test/contable_rendimiento.test.js`).

### Instalación y dependencias

- Contable depende de Usuarios y Ventas; Stock, Clientes, Compras y Financiero son opcionales. Si un módulo se instala o una función se activa **después** de iniciar la contabilidad hay que correr `POST /api/contable/plan/actualizar`, que suma las cuentas y reglas que faltan (no se corre solo).

## Pruebas

- **Hora local y UTC**: las pruebas deben correr con la misma zona horaria que la base (sin `TZ=UTC` si el servidor de MySQL corre en hora local); con `TZ=UTC` fallan las que comparan con `NOW()` de MySQL. Las de franjas de Ventas Online usaban la fecha UTC y se corrigieron a fecha local; después de las 21:00 hora de Argentina conviene volver a correr la suite.
- **ARCA en los tests de la tienda**: las pruebas de Ventas Online simulan ARCA (`test/ayudas_online.js`); sin la simulación cada pedido pagado intenta salir a internet y espera su tiempo máximo.
- **MySQL local para las pruebas**: el servicio `MySQL80` de esta máquina no arranca sin permisos de administrador; para correr las pruebas se levanta un `mysqld` descartable (`--initialize-insecure`, puerto 3306) en una carpeta temporal.
