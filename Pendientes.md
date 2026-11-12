# Pendientes

Solo lo que falta de verdad. Lo resuelto está en el historial de commits y en `plan-checkpoints-opcionales.md`.

## Bloqueado por algo externo

- **Pantallas (React)**: Financiero, Compras, Ventas Online (panel de administración) y Contable tienen pantallas armadas con la configuración de `Modulo`; no hay pantallas propias para la tienda pública `/tienda/<código>` (la usan los clientes finales), ni cargas guiadas de líneas (asientos manuales, apertura) ni de documentos con foto/archivo. Falta probarlas con datos reales en el navegador.
- **Cliente de ARCA para constatar comprobantes recibidos** (Compras): el servicio es enchufable (`src/services/constatacionService.js`, `usarTransporte`) pero no hay cliente real; hace falta el certificado y las credenciales de producción. Mientras, todo comprobante queda «pendiente de constatar» (se reintenta solo cada hora cuando haya cliente).
- **Mercado Pago** (Ventas Online): está implementado detrás de una interfaz y probado con una pasarela simulada; falta probarlo con las credenciales de prueba reales. Las credenciales se guardan en la base de la instancia sin cifrar.
- **Clientes de las plataformas de delivery** (Ventas Online): no existe el cliente que habla con cada plataforma (menú, precios, disponibilidad y estados). Sin él el conector figura desconectado y los envíos quedan en cola; el error lo dice: «Falta la conexión con la plataforma de delivery: no hay un cliente de integración (API y credenciales de la plataforma)». Hace falta la API, las credenciales y un comercio dado de alta en cada plataforma.
- **Prueba de periféricos con el equipo real** (checkpoint B0) y **versión exacta de MySQL/MariaDB** del plan de Hostinger.

## Límites que se aceptaron

- **Límites por IP de la tienda**: los contadores viven en la memoria del proceso y se pierden al reiniciar; alcanza con una sola app y llevarlos a la base sumaría una escritura por visita pública. Habría que cambiarlo si algún día corren varias instancias de la app.
- **Cupón no acumulable con una promoción**: el ítem conserva su promoción y queda fuera del cupón, en vez de elegir el menor precio final entre ambos.
- **Pesables**: el ajuste de Stock al peso real parte de que el pesable se descuenta en kilos en la unidad de Stock (la venta lo descuenta como 1 y el pesaje corrige la diferencia).
- **Transportistas** (ONL-ENVIOS-TRANSPORTISTA): apagada y sin implementación por decisión de proyecto; solo retiro y delivery propio.
- **Devolución sin efecto** (Compras EX24): un egreso anulado en Stock antes del vínculo no existe porque Stock no anula egresos.

## Contable: lo que no se informa o se aproxima

- **Cheques rechazados y gastos bancarios** de Financiero: no se informan a Contable.
- **Ingresos de stock** con motivo «otra» (ajustes positivos): no se informan; solo los egresos.
- **Órdenes de pago en moneda extranjera**: el evento no trae cotización; se imputan como pesos. Los gastos o cobros en divisa que no son compra o venta de moneda tampoco se informan.
- **Criterio por categoría de artículo** en ventas y costo: las líneas lo traen pero las reglas predeterminadas no lo usan.
- **Cierre de ejercicio**: el ejercicio siguiente es de año calendario.
- **Revaluación**: se registra a pedido y, si falta la cotización de cierre, el cierre del período no se bloquea.
- **Controles cruzados**: el de existencias compara el total, no por depósito.
- **Consolidación**: el paquete contable es mensual y viaja por el mecanismo diario de Usuarios, cuyo control de «paquetes faltantes» no distingue períodos contables; el faltante se resuelve en el propio balance consolidado.
- **Módulos instalados después de iniciar**: hay que correr `POST /api/contable/plan/actualizar` para sumar sus cuentas y reglas (no se corre solo).

## Para correr las pruebas

- Con la misma zona horaria que la base: sin `TZ=UTC` si MySQL corre en hora local. Después de las 21:00 hora de Argentina conviene volver a correr la suite.
- El servicio `MySQL80` de esta máquina no arranca sin administrador; se levanta un `mysqld` descartable (`--initialize-insecure`, puerto 3306) en una carpeta temporal.
- Las pruebas de Ventas Online simulan ARCA (`test/ayudas_online.js`); sin eso cada pedido pagado espera su tiempo máximo.
