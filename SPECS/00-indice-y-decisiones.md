# Sistema Modular para Cafeterías y Producción de Alimentos — Índice de SPECS

Versión del 22/10/2026 (incorpora las decisiones fundacionales F1 a F4). Los SPECS están redactados para cafeterías y producción de alimentos (panadería, pastelería, viandas, catering y venta mayorista a otros comercios). Lo que no aplica al rubro queda como función activable en "No", no se elimina.

| # | Módulo | Archivo | Tipo |
|---|--------|---------|------|
| 01 | Ventas | `01-ventas.md` | Base (obligatorio) |
| 02 | Stock e Insumos | `02-stock-insumos.md` | Opcional |
| 03 | Clientes y Cuentas Corrientes | `03-clientes-cuentas-corrientes.md` | Opcional |
| 04 | Usuarios y Auditoría (+ Servicios de Plataforma) | `04-usuarios-auditoria.md` | Base (obligatorio) |
| 05 | Financiero | `05-financiero.md` | Opcional |
| 06 | Contable | `06-contable.md` | Opcional, **se vende aparte** y solo en la puesta en marcha |
| 07 | Compras | `07-compras.md` | Opcional |
| 08 | Ventas Online | `08-ventas-online.md` | Opcional |
| D | Matriz de cobertura por tipo de artículo y rubro | `anexo-d-matriz-de-cobertura.md` | Anexo |
| E | Matriz de pruebas de combinaciones y activaciones | `anexo-e-matriz-de-pruebas.md` | Anexo |

---

## Convenciones de los SPECS

- **Estructura:** secciones 1, 2, 4, 5, 6 y 7 (sin sección 3), según la plantilla.
- **Numeración estable:** RF, RN y EX nunca se renumeran. Lo nuevo se agrega al final de cada lista, por eso las referencias entre módulos siguen siendo válidas. Una regla retirada del alcance queda con su número y la marca "(Eliminada)".
- **`[Activable: ID — por defecto: Sí|No]`:** funcionalidad que se activa o desactiva por instancia. El catálogo completo está en el Anexo A.
- **`[Requiere: <Módulo>]`:** marca cada punto (RF, RN, EX o entidad) que depende de otro módulo. Variantes: `Stock + Compras` (ambos), `Stock o Compras` (cualquiera), `[Requiere función: ID]` y `[Requiere conexión a internet]`. Desde la decisión F1, `[Requiere conexión a internet]` significa que el servidor de la instancia necesita llegar a un servicio externo (correo, pasarela, ARCA, plataformas, almacenamiento externo); la conexión entre las terminales y el servidor es requisito de toda la operación y no se marca, y su falta la regula el Modo sin conexión (Usuarios RN80). El texto siempre dice qué pasa cuando falta el requisito.
- **Reglas de activación** (definidas una vez en Usuarios y Auditoría, RN24 a RN30):
  1. Un Administrador activa o desactiva las funciones en cualquier momento, mientras usa el sistema, sin reiniciar ni reinstalar y sin intervención del proveedor. Los demás roles no pueden hacerlo. Cada cambio queda auditado y rige de inmediato (Usuarios RN24 y RN46).
  2. No se activa una función cuyo módulo o función requerida no esté disponible.
  3. Desactivar oculta la función y bloquea operaciones nuevas, pero no borra datos ni documentos emitidos.
  4. Con operaciones pendientes (ej. reservas futuras, pedidos de plataforma abiertos), el sistema exige resolverlas o confirmarlas.
  5. Desactivar una función de la que otras dependen avisa y las desactiva en cascada con confirmación.
  6. Los perfiles de rubro solo pre-cargan valores iniciales.
  7. Las mejoras opcionales forman parte del producto, nacen desactivadas y las activa un Administrador cuando las necesita (Usuarios RN47).

---

## Decisiones fundacionales

Cuatro decisiones valen para todos los módulos y las demás reglas las dan por sentadas. El texto normativo está en Usuarios y Auditoría (RF28 y RN79 a RN83); los demás módulos solo agregan lo propio.

| # | Decisión | Qué establece | Dónde se aplica |
|---|----------|---------------|-----------------|
| F1 | Servidor en la nube por cliente | Cada cliente (comercio) tiene asignado un servidor en la nube donde funcionan todos sus módulos, cada uno con su espacio de datos propio. El cliente accede desde una página web, desde cualquier navegador y dispositivo: no se instala software en el local y no hay servidor local ni red local. El servidor es el único lugar donde se confirman documentos, se numera, se guardan bandejas, candados y reservas, y se toma la hora oficial. El sistema es puramente online: sin conexión con el servidor no se opera. Las copias y la restauración son siempre de la instancia completa. La tienda online corre en el mismo servidor | Usuarios RF28, RN79, RN80, RN21, RF11, RF12, RN58; Ventas RF18, RF38, RF39, RN66; Stock RF28; Ventas Online (sección 1, RF04, RN02, RN04, RN36, RN40) |
| F2 | Identificador único | Todo documento recibe al crearse un ID_Global único, ordenable por fecha y prefijado con el código de la instancia, que nunca se reutiliza, ni siquiera después de restaurar una copia. El número que ven las personas es otro dato y nunca se usa como clave entre módulos | Usuarios RN81 y RN49; ID_Operacion y Documento_Origen en todos los módulos |
| F3 | Intento y efecto | La ID_Operacion identifica el efecto final de un documento. Las reservas con vigencia (compromiso de stock, reserva de stock, reserva de crédito, retención de saldo, reserva de clave) se identifican por intento, con su propia ID_Solicitud y su propio identificador. Pedir de nuevo es un intento nuevo con Reemplaza_A: el receptor libera el anterior y toma el nuevo en una sola operación. Las reservas se pueden renovar mientras la operación sigue en curso | Usuarios RN82; Ventas RN27, RN63, RN64, EX48; Stock RF36, RN22, RN58, RN59, RN69; Clientes RF26, RN34, RN39, EX21; Ventas Online RN07, RN19, RN45, RN48 |
| F4 | Reservar, confirmar y vencer | Todo recurso compartido se toma en tres pasos: reservar (llamada inmediata, con vencimiento), confirmar (mensaje grabado en la misma transacción que el documento) y vencer solo si el documento no se confirma. Para la clave de un comprobante y el saldo de un vale, la política ante falla es siempre cerrar, sin contingencia con supervisor | Usuarios RN83, RF27, RN64, EX56, EX57; Clientes RF31, EX33, EX34; Ventas RF09; Stock RN09; Financiero RN13; Compras RN03; Ventas Online RN35 |

El detalle de lo que cambió en cada SPEC está en `cambios-aplicados.md`.

---

## Decisiones tomadas

| Tema | Decisión | Impacto principal |
|------|----------|-------------------|
| Ingreso de mercadería comprada | Una sola carga, que se vincula: el ingreso físico se registra una vez (en Stock o desde Compras) y la factura se vincula a ese ingreso | Stock RN07, Compras RF04 y RF15 |
| Ubicaciones de stock | Varios depósitos dentro de la instancia, sin transferencias entre sucursales | Stock RF03, RF13 y RN23 |
| Valuación de inventario | Método configurable por instancia: Promedio Ponderado, PEPS o Último Costo | Stock RF17, RN16 y RN17 |
| Sucursales | Independientes: cada instancia tiene sus propios clientes, proveedores, cajas, usuarios y contabilidad. La consolidación en Casa Central es una función opcional de solo lectura (USU-CONSOL) | Todos los módulos, Usuarios RF20 |
| Moneda | Pesos y moneda extranjera (cajas, cuentas corrientes y costos). Ventas factura siempre en pesos | Usuarios RF14, CC RF11, Financiero RN09, Compras RN07 |
| Alcance contable | Contabilidad completa con exportación, sin estados contables formales ni ajuste por inflación | Contable |
| Canal online | Tienda propia que corre en el mismo servidor de la instancia, con pasarela de pago y transportistas integrados. Marketplaces y plataformas de delivery como función opcional | Ventas Online |
| Turno de caja cerrado | **Se puede reabrir con autorización de un supervisor**, con motivo y auditoría. Lo ya informado a otros módulos se corrige con ajustes en la fecha actual | Financiero RN07, RF18 y EX13 |
| Instalación de Contable | **Se vende aparte y no admite instalación posterior ni generación retroactiva.** Debe contratarse en la puesta en marcha y la contabilidad arranca con un asiento de apertura | Contable RF13, RN01 y RN18, Usuarios RN31 |
| Permisos de Administrador | **Los Administradores pueden darse permisos a sí mismos** y a otros, incluso permisos que no tengan. Los demás usuarios no. Todo cambio queda auditado | Usuarios RN07 |
| Mejoras opcionales | Las 12 mejoras forman parte del producto y están incluidas en los SPECS como funciones activables. Nacen desactivadas y **las activa o desactiva un Administrador en cualquier momento**, sin reinstalar | Anexo A, Usuarios RF18, RN24, RN46 y RN47 |
| Integración entre módulos (1.1) | Un protocolo único: cada efecto sobre otro módulo es un mensaje con clave de idempotencia, grabado en la misma transacción que el documento de origen, con reintentos escalonados, bandeja de pendientes y conciliación diaria. La venta no se revierte si falla un efecto | Usuarios RF25 y RN48 a RN60; todos los módulos |
| Reserva antes del cobro online (1.2) | Ventas Online reserva el stock al presionar "Pagar", antes de abrir la pasarela, con vigencia de 15 min. Una venta presencial no puede consumir lo reservado | Ventas Online RN06, RN07 y RN45; Stock RF15 y RN22 |
| Crédito y mora (1.3) | Clientes y CC es la única fuente de reglas. Devuelve un veredicto (Permitida, Requiere autorización o Bloqueada) y Ventas y Ventas Online solo lo cumplen. Hay reserva de crédito y contingencia con supervisor | Clientes RN04, RF12, RF13, RF26 y RF27; Ventas RN27 |
| Moneda extranjera (1.4) | VEN-DIVISA exige FIN-MONEDA-EXT cuando Financiero está instalado. Cada forma de pago en divisa necesita una caja en esa moneda y Ventas fija la cotización | Usuarios RN25 y RN28; Ventas RF28; Financiero RF02 y RF15 |
| Dependencias (1.5) | Grafo sin ciclos, en cinco capas. Un módulo solo llama a los de su capa o inferiores; hacia arriba usa puertos y eventos | Anexo B; Usuarios RF26 |
| Cobro del pedido online (1.6) | Lo registra únicamente Ventas. Ventas Online conserva el registro técnico del pago y entrega solo liquidaciones y comisiones a Financiero | Ventas RN60; Ventas Online RN44; Financiero RN33 |
| Emisión en ARCA (1.7) | Un secuenciador por punto de venta y tipo, con una solicitud en vuelo por clave, estado "Resolviendo" para respuestas tardías y consulta automática a ARCA | Ventas RF47 y RN49 a RN57; Usuarios RN14 |
| Unidades y factores (2.1) | Stock es el dueño único de las presentaciones y sus factores, con versiones y vigencia. Compras, las listas de proveedor, la lectura por foto y las equivalencias solo apuntan a una presentación | Stock RF02 y RN61; Compras RF18; Usuarios RF16 |
| Costos (2.2) | Cuatro tipos con un orden de uso fijo: reposición para decidir precios, inventario y receta como costo de la venta, congelado en el movimiento de Stock | Anexo C; Ventas RN62; Stock RN62 y RN63; Compras RF11 y RF21 |
| Facturación agrupada (2.3) | CLI-FACT-AGRUPADA requiere VEN-CC y Ventas RF27 depende de ella; desactivar VEN-CC la desactiva en cascada | Ventas RF27 y RN28; Clientes RN20 |
| Lista del cliente y lista del canal (2.4) | Plataformas siempre con la lista del conector. En la tienda manda la lista Online salvo que el parámetro de la tienda dé prioridad a la del cliente. En el POS manda la del cliente | Ventas RN32; Ventas Online RN47 |
| Comprobantes de terceros (2.5) | Una clave única (emisor, clase, tipo con letra, punto de venta y número) en un servicio de plataforma. Duplicado exacto o mismo CAE bloquea; los casi duplicados advierten; el CAEA no bloquea por sí solo. Una clave tiene un dueño y varios vínculos: el módulo que recibe un comprobante ya cargado por otro lo vincula en lugar de bloquearlo | Usuarios RF27 y RN63 a RN68, RN84 |
| Última unidad (3.1) | Para ítems que no permiten stock negativo, Ventas pide a Stock un compromiso atómico antes de confirmar la venta | Stock RF36 y RN58 a RN60; Ventas RN63 y EX10 |
| Toma de inventario (3.2) | El ajuste es un delta sobre el saldo vigente, nunca "fijar el saldo"; se controlan movimientos posteriores, antigüedad y mensajes pendientes | Stock RN20, RN67 y RN68 |
| Respuesta perdida (3.3) | Toda operación con efecto lleva una clave de solicitud; se pregunta el estado antes de reenviar; la misma clave con otro contenido se rechaza | Usuarios RN69 a RN73 |
| Activación en operación (3.4) | Cada documento conserva la instantánea de funciones con que se abrió; los cambios son atómicos y llevan una versión de configuración | Usuarios RN46 y RN74 a RN78 |
| Mozo móvil (3.5) | Cada operación lleva la versión base; lo que llega tarde sobre un pedido cobrado, anulado o modificado se rechaza con el estado actual. Nunca gana el último. Sin conexión, el dispositivo no guarda operaciones | Ventas RF39, RN37 y RN66 |
| Peso y reintegros online (3.6) | Ventas Online orquesta el ajuste del pedido y calcula el invariante cobrado, reintegrado y facturado con los totales que le informa Ventas; Ventas solo ofrece operaciones elementales. Con pesables se factura después del pesaje; la diferencia sigue reglas de tolerancia y aceptación expresa | Ventas Online RF29 y RN50 a RN52; Ventas RN67 y RN68 |
| Combos y kits (4.1) | Stock es el único que expande los componentes, según el modo de descuento del artículo, que Stock deriva del tipo de artículo y de su modo de producción (Ventas no lo carga); Ventas decide el momento del descuento (cierre de venta o envío de comanda) por sector y modalidad; el precio del combo se prorratea para las devoluciones | Stock RF10, RN64 a RN66; Ventas RN69, RN70 y RN82 |
| Series (4.2) | STK-SERIE requiere VEN-SERIE y esta no se puede desactivar mientras haya serializados activos o series disponibles | Usuarios RN27 y EX53; Stock RN71 |
| Pesables (4.3) | Rangos por artículo, lectura estable de la balanza, ingreso manual con permiso y, online, tolerancia con aceptación expresa | Ventas RN04; Ventas Online RN51 |
| Propinas y señas | **Fuera del alcance.** El sistema no maneja propinas, cargo por servicio ni señas o cobros anticipados. Los pedidos especiales y las reservas se cobran al entregarse o al consumir. Los números de las reglas retiradas se conservan como "(Eliminada)" | Todos los módulos |
| Acceso al sistema | Página web, desde cualquier navegador. El sistema es puramente online: sin conexión con el servidor no se opera y no hay modo sin conexión | Usuarios RF28, RN79 y RN80 |
| Llamadas entre módulos (1.9) | Lista cerrada de llamadas inmediatas con tiempo máximo y política de falla (Anexo B.5). Costos, lista de precios del cliente y condición de socio llegan por eventos a una copia local de Ventas; el turno de caja se consulta en el momento | Índice B.5; Ventas RN43 y RN81; Compras RN40; Stock RN85; Clientes RN42 |
| Restauración (1.11) | Siempre de la instancia completa. Después de restaurar, la conciliación lista los efectos sin documento de origen y la emisión fiscal queda bloqueada hasta resolverlos o aceptarlos | Usuarios RF12, RN14 y RN57 |
| Descuento de ingredientes (2.1 y 2.2) | Stock deriva el modo de descuento del tipo de artículo y de su modo de producción; Ventas decide el momento (cierre de venta o envío de comanda) por sector y modalidad | Ventas RN69 y RN82; Stock RF10 y RN64 |
| Clientes unificados (2.3) | La ficha absorbida queda como alias de la resultante; los demás módulos guardan el mapa de alias | Clientes RF18 y RN43; Ventas RN83; Stock RN86; Ventas Online RN55 |
| Ventas sin comprobante fiscal (2.4) | Contable no registra las ventas no fiscales ni sus cobros ni los remitos sin cuenta; sí figuran en los reportes, las cajas de Financiero y las cuentas de Clientes. Se contabilizan al emitirse la factura que las regulariza. La venta solo de gift cards se confirma sin asiento | Contable RF26 y RN38; Ventas RN73, RN77 y RN84; Financiero RN46 |
| Pendientes de integración (2.5) | Cada pendiente tiene responsable, plazo y escalada directa al Administrador; los cierres admiten "pendiente aceptado" con motivo y supervisor | Usuarios RF25 y RN85; Contable RN08; Financiero RF28; Stock EX51 |
| Pedido online y su alineación (2.6) | Ventas Online orquesta el ajuste y calcula la alineación; Ventas ofrece operaciones elementales | Ventas RN67 y RN68; Ventas Online RN50 a RN52 |

## Decisiones de arquitectura (propuestas por el analista)

1. **Servicios de Plataforma en Usuarios y Auditoría.** Es el único módulo siempre presente junto con Ventas, así que concentra los servicios que usan varios módulos:
   - Registro de módulos y funcionalidades activables, y perfiles de rubro.
   - Monedas y cotizaciones.
   - Lectura de comprobantes por foto (Stock, Compras y Financiero).
   - Diccionario de equivalencias de terceros.
   - Centro de Notificaciones.
   - Tablero de indicadores: cada módulo registra los suyos.
   - Consolidación de sucursales: cada módulo publica su paquete.
2. **Fuente única por dato:**
   - Recetas, ficha técnica y costeo de producción → Stock.
   - Costo de reposición → Compras.
   - Costo de inventario → Stock.
   - Comprobantes de compra y Libro IVA Compras → Compras.
   - Emisión fiscal, padrón y constatación de comprobantes en ARCA → Ventas.
   - Saldos de clientes, fidelización y vales → Clientes y CC.
   - Dinero → Financiero.
3. **Criterios contables distintos según el módulo:** Financiero usa lo percibido (Balance de Actividad) y Contable usa lo devengado.
4. **Ningún módulo opcional bloquea la venta.** Solo puede frenarla una configuración explícita: un ítem que no permite stock negativo, un límite de crédito o la exigencia de turno de caja abierto.
5. **Los módulos se comunican por servicios internos y por función, no por número de punto.** Los puntos nuevos se citan por el nombre o el ID de la función, así un SPEC puede crecer sin romper a los demás.
6. **Grafo de dependencias sin ciclos.** Cinco capas (N0 Usuarios y Auditoría, N1 Ventas, N2 Stock y Financiero, N3 Clientes y CC y Compras, N4 Contable y Ventas Online). Un módulo llama de forma sincrónica solo a su capa o a las inferiores. Lo que necesita de una capa superior lo define como puerto, que el módulo superior implementa al instalarse (Anexo B).
7. **Los efectos entre módulos son mensajes, no transacciones distribuidas.** Cada módulo puede reiniciarse o restaurarse sin arrastrar a los demás: al volver se reprocesan los mensajes pendientes y la conciliación de integración marca lo que falte.

---

## Anexo A: catálogo de funcionalidades activables y perfiles de rubro

### A.1 Catálogo

"Base" es el valor por defecto de la función en el SPEC. Los perfiles lo ajustan (A.2). **P1 a P13** indica las propuestas incorporadas (la P5, propinas, se retiró del alcance).

| ID | Módulo | Función | Requiere | Base |
|----|--------|---------|----------|------|
| VEN-SALON | Ventas | Modo Salón (mesas y sillas) | — | Sí |
| VEN-FRANJA | Ventas | Menú por franja horaria | — | No |
| VEN-MODIF | Ventas | Modificadores y opciones del producto | Stock (solo para cambiar el insumo descontado) | Sí |
| VEN-ALERGENOS | Ventas | Alérgenos en menú, comanda y ticket | STK-ALERGENOS (solo para derivarlos de las recetas) | Sí |
| VEN-SERIE | Ventas | Artículos con número de serie | — (no se puede desactivar mientras STK-SERIE esté activa o existan artículos serializados activos o series disponibles) | No |
| VEN-CC | Ventas | Venta a cuenta corriente | Clientes y CC | No |
| VEN-PRECIO-COSTO | Ventas | Precios por costo con margen | Compras | No |
| VEN-DIVISA | Ventas | Cobro en moneda extranjera | FIN-MONEDA-EXT si Financiero está instalado (con una caja en esa moneda); cotizaciones de Usuarios y Auditoría | No |
| VEN-LISTAS | Ventas | **P1** Listas de precios múltiples | Clientes y CC (lista por cliente), Compras (margen por costo) | No |
| VEN-PROMOS | Ventas | **P2** Promociones automáticas | Compras o Stock (aviso de precio bajo costo), CLI-FIDEL (promociones para socios) | No |
| VEN-KDS | Ventas | **P3** Pantalla de cocina y barra | Stock (marca de agotado automática) | No |
| VEN-MOVIL | Ventas | **P3** Pedidos desde tablet o celular del mozo | — | No |
| VEN-COMISIONES | Ventas | **P4** Comisiones de vendedores | Compras o Stock (comisión por margen), Financiero (pago) | No |
| VEN-RESERVAS | Ventas | **P6** Reservas de mesa, turnos y pedidos especiales | VEN-SALON (mesas), Clientes y CC (ficha), internet (recordatorios) | No |
| STK-LOTES | Stock | Lotes y vencimiento | — | Sí |
| STK-TRAZA | Stock | Trazabilidad y retiro de lote | STK-LOTES | Sí |
| STK-ALERGENOS | Stock | Alérgenos derivados por receta | — | Sí |
| STK-PRODUCCION | Stock | Tandas, rendimiento, ficha técnica y costeo | — | Sí |
| STK-TEMP | Stock | Registro de temperaturas y controles de inocuidad | — | No |
| STK-SERIE | Stock | Control de números de serie | VEN-SERIE | No |
| STK-ETIQUETAS | Stock | **P8** Etiquetas de vitrina y de productos elaborados (la de balanza lleva el peso) | STK-LOTES y STK-ALERGENOS (para esos campos) | No |
| STK-APP | Stock | **P9** App móvil de inventario | — | No |
| STK-REPO-AUTO | Stock | **P13** Reposición automática sugerida | Compras (plazo del proveedor y generación del pedido) | No |
| CLI-FIDEL | Clientes y CC | **P10** Fidelización y vales (sellos, puntos, gift cards) | Contable (pasivo), VEN-PROMOS (promociones para socios) | No |
| CLI-MORA | Clientes y CC | Intereses por mora | — | No |
| CLI-RETENCIONES | Clientes y CC | Retenciones sufridas | Contable (para informarlas) | No |
| CLI-FACT-AGRUPADA | Clientes y CC | Facturación agrupada de remitos | VEN-CC | No |
| CLI-MONEDA-EXT | Clientes y CC | Cuentas en moneda extranjera | Cotizaciones de Usuarios y Auditoría | No |
| CMP-PEDIDOS | Compras | Pedidos a proveedores | Internet (solo para enviarlos por correo) | Sí |
| CMP-LISTAS-PROVEEDOR | Compras | Listas de precios de proveedor | — | Sí |
| CMP-FOTO | Compras | Carga de facturas por foto | Internet (el QR fiscal funciona sin conexión) | Sí |
| CMP-CONTROL-ARCA | Compras | Controles contra ARCA | Internet (constatación del CAE) | Sí |
| CMP-UNIDADES-COMPRA | Compras | Unidades de compra y conversión | Stock | Sí |
| CMP-RECEPCION-LOTES | Compras | Lotes y vencimientos en la recepción (si se desactiva, Stock crea un lote automático) | Stock + STK-LOTES | Sí |
| CMP-PAGOS-PROGRAMADOS | Compras | Pagos programados | Financiero (solo para el flujo de fondos) | No |
| CMP-RETENCIONES | Compras | Retenciones practicadas (agentes de retención) | — | No |
| CMP-PEDIDO-SUGERIDO | Compras | **P13** Pedido a partir de la reposición sugerida | Stock + STK-REPO-AUTO + CMP-PEDIDOS | No |
| FIN-CIERRE-CIEGO | Financiero | Cierre de caja ciego | — | No |
| FIN-CHEQUES | Financiero | Cartera de cheques y e-cheq | — | No |
| FIN-CONCILIACION | Financiero | Conciliación bancaria | — | No |
| FIN-GASTOS-REC | Financiero | Gastos recurrentes | — | No |
| FIN-MONEDA-EXT | Financiero | Moneda extranjera y diferencia de cambio | Cotizaciones de Usuarios y Auditoría | No |
| FIN-FOTO-GASTOS | Financiero | Carga de gastos por foto | Internet | No |
| CON-ASIENTOS-RESUMIDOS | Contable | Asientos resumidos por día | — | Sí |
| CON-CONTROLES-CRUZADOS | Contable | Controles cruzados con los demás módulos | Cada control exige su módulo | Sí |
| CON-REVALUACION | Contable | Revaluación de moneda extranjera | Cotizaciones de Usuarios y Auditoría | No |
| CON-EXPORT-PLANTILLAS | Contable | Plantillas de exportación al estudio contable | — | No |
| CON-CONSOL | Contable | **P11** Balance consolidado en Casa Central | USU-CONSOL | No |
| ONL-CUPONES | Ventas Online | Cupones y envío gratis | — | Sí |
| ONL-CUENTA-CLIENTE | Ventas Online | Cuentas de cliente | — | Sí |
| ONL-PASARELA | Ventas Online | Pasarela de pago | Internet | Sí |
| ONL-ENVIOS-TRANSPORTISTA | Ventas Online | Transportistas integrados | Internet | Sí |
| ONL-MARKETPLACES | Ventas Online | **P12** Marketplaces y plataformas de delivery | Internet; Financiero (comisiones y liquidaciones); VEN-LISTAS y Stock (opcionales) | No |
| ONL-RESERVAS | Ventas Online | **P6** Reservas y pedidos especiales desde la tienda | VEN-RESERVAS | No |
| USU-TABLERO | Usuarios y Auditoría | **P7** Tablero de indicadores | Cada indicador exige el módulo que lo origina | No |
| USU-CONSOL | Usuarios y Auditoría | **P11** Consolidación de sucursales (Casa Central) | Internet (solo para el envío automático) | No |
| USU-2FA | Usuarios y Auditoría | Segundo factor de autenticación | — | No |
| USU-FOTO | Usuarios y Auditoría | Servicio de lectura de comprobantes por foto | Internet | No |
| USU-COTIZ-AUTO | Usuarios y Auditoría | Actualización automática de cotizaciones | Internet | No |
| USU-NUBE | Usuarios y Auditoría | Copia adicional de las copias de seguridad en un almacenamiento externo del cliente (la plataforma siempre guarda las copias de la instancia) | Internet | No |
| USU-CORREO | Usuarios y Auditoría | Notificaciones por correo | Internet | No |

La propuesta **P7** es el tablero USU-TABLERO, la **P8** son las etiquetas STK-ETIQUETAS y la **P9** la app STK-APP. Quedan fuera de la tabla las reglas de arrepentimiento y de conexión con ARCA, que son obligaciones y no opciones.

### A.2 Perfiles de rubro

Al poner en marcha la instancia, el asistente ofrece cuatro perfiles. El perfil solo pre-carga valores y después se cambian uno a uno. La tabla muestra solo lo que cambia respecto de la columna "Base" del catálogo.

| Función | Cafetería | Producción de alimentos | Cafetería con producción propia | Personalizado |
|---------|-----------|-------------------------|---------------------------------|---------------|
| VEN-SALON (Modo Salón) | Sí | **No** | Sí | Como Cafetería |
| VEN-CC (cuenta corriente) | No | **Sí** | **Sí** | Como Cafetería |
| CLI-FACT-AGRUPADA | No | **Sí** | **Sí** | Como Cafetería |
| CLI-RETENCIONES | No | **Sí** | **Sí** | Como Cafetería |
| FIN-CHEQUES | No | **Sí** | **Sí** | Como Cafetería |
| CMP-RECEPCION-LOTES | Sí | Sí | Sí | Como Cafetería |

STK-LOTES, STK-TRAZA y STK-ALERGENOS están activas en los cuatro perfiles. CMP-RECEPCION-LOTES también está activa en los cuatro (se pide el lote al recibir); desactivarla cambia a lote automático (Stock RN84).

Todas las mejoras (P1 a P13, sin la P5 retirada) están incluidas y arrancan desactivadas en los cuatro perfiles; un Administrador las activa cuando las necesita, sin esperar a ninguna actualización. Según el caso, estas son las que conviene probar primero:

- **Cafetería con salón:** VEN-KDS, VEN-MOVIL, VEN-PROMOS y CLI-FIDEL.
- **Producción de alimentos:** VEN-LISTAS (precio mayorista), STK-ETIQUETAS, STK-REPO-AUTO y STK-TEMP.
- **Cafetería con producción propia:** una combinación de las dos anteriores.

---

## Anexo B: capas, puertos y eventos

### B.1 Capas

| Capa | Módulos | Puede llamar de forma sincrónica a |
|------|---------|------------------------------------|
| N0 | Usuarios y Auditoría | Nadie (hacia arriba usa puertos) |
| N1 | Ventas | N0 |
| N2 | Stock, Financiero | N0, N1 |
| N3 | Clientes y CC, Compras | N0, N1, N2. No se llaman entre sí |
| N4 | Contable, Ventas Online | N0 a N3. Ninguno de ellos llama a Ventas Online ni a Contable |

### B.2 Puertos

Un puerto es una interfaz que define el módulo de la capa inferior y que implementa el de la capa superior. Sin el módulo superior, el puerto tiene una implementación nula con comportamiento definido y la función se oculta o se degrada.

| Puerto | Lo define | Lo implementa | Sin el módulo implementador |
|--------|-----------|---------------|-----------------------------|
| Control de crédito y maestro de clientes (incluye veredicto, reserva de crédito y retención de saldo de vales; la lista de precios y la condición de socio llegan por eventos a la copia local de Ventas) | Ventas | Clientes y CC | No existe la venta a cuenta corriente, el canje de vales, gift cards y puntos, ni la selección del receptor desde el maestro |
| Costo de reposición (se entrega por eventos a la copia local de Ventas) | Ventas | Compras | Los precios son manuales y el control de venta bajo costo usa el costo de inventario si hay Stock |
| Costo de inventario y de receta (se entrega por eventos a la copia local de Ventas) | Ventas | Stock | Sin costo de la venta: las comisiones por margen usan el costo de reposición congelado o no se calculan |
| Disponibilidad y descuento de stock | Ventas | Stock | La venta nunca se bloquea por falta de existencias |
| Registro de cobros | Ventas | Financiero | Ventas discrimina por forma de pago, sin afectar cajas |
| Plazos de entrega del proveedor | Stock | Compras | El plazo se define por ítem |
| Indicadores, paquetes de consolidación, numeración fiscal, recepción de mensajes y conciliación | Usuarios y Auditoría | Cada módulo | El módulo no aporta indicadores ni paquetes |

### B.3 Eventos principales

| Evento | Lo publica | Se suscriben |
|--------|------------|--------------|
| Venta confirmada, anulada o devuelta | Ventas | Stock, Financiero, Clientes y CC, Contable |
| Cheque rechazado | Financiero | Clientes y CC, Compras |
| Cierre y reapertura de turno | Financiero | Contable |
| Gasto con comprobante fiscal | Financiero | Compras, Contable |
| Ingreso con comprobante | Stock | Compras |
| Movimientos valorizados | Stock | Contable |
| Reserva comprometida | Stock | Ventas Online |
| Descuento confirmado, con el costo de la venta | Stock | Ventas, Contable |
| Remito emitido | Ventas | Clientes y CC, Contable |
| Venta regularizada (factura que regulariza una venta no fiscal o un remito sin cuenta; trae la venta y su cobro) | Ventas | Contable |
| Emisión de gift card y emisión de vale por devolución | Ventas | Clientes y CC |
| Canje confirmado (cita la retención de saldo) | Ventas, Ventas Online | Clientes y CC |
| Costo de reposición actualizado | Compras | Ventas (copia local) |
| Costo de inventario y de receta actualizado | Stock | Ventas (copia local) |
| Cliente actualizado (lista de precios asignada y condición de socio) | Clientes y CC | Ventas (copia local) |
| Clientes unificados (el cliente absorbido pasa a ser alias del resultante) | Clientes y CC | Ventas, Stock, Ventas Online |
| Confirmar clave de comprobante (cita la reserva de la clave) | Stock, Compras, Financiero | Usuarios y Auditoría (Identificación de comprobantes de terceros) |
| Devolución a proveedor | Stock | Compras |
| Merma de producción (desvío fuera de tolerancia, desperdicio y vencimientos) | Stock | Contable |
| Ajuste de pedido resuelto (peso, nota de crédito, reintegro) | Ventas | Ventas Online |
| Vencimientos por cobrar y por pagar | Clientes y CC, Compras | Financiero (Proyección de fondos) |

### B.3b Servicios que se llaman hacia abajo

| Servicio | Lo expone | Lo llama |
|----------|-----------|----------|
| Alcance de un retiro de lote (clientes y entregas alcanzados) | Stock | Clientes y CC |
| Emisión de comprobantes, padrón y constatación | Ventas | Clientes y CC, Compras, Ventas Online |
| Identificación de comprobantes de terceros | Usuarios y Auditoría | Stock, Compras, Financiero |

### B.4 Ciclos que había y cómo se resolvieron

| Ciclo | Cómo se resolvió |
|-------|------------------|
| Ventas ↔ Clientes y CC | Ventas define el puerto de crédito y Clientes lo implementa. Clientes llama hacia abajo a Ventas para emitir notas de débito y crédito |
| Ventas ↔ Compras | Ventas define el puerto de costo y Compras lo implementa. Compras llama hacia abajo a Ventas para el padrón y la constatación de comprobantes |
| Stock ↔ Compras | Stock define el puerto de plazos de entrega y Compras lo implementa. Compras no llama a Stock para los ingresos: los envía por mensajes (Compras RF04) y solo lo consulta en línea para elegir presentaciones (B.5 n.º 15) |
| Financiero ↔ Ventas Online | Ventas Online ya no registra cobros: los registra Ventas. Online solo entrega liquidaciones y comisiones a Financiero |

### B.5 Registro de llamadas inmediatas entre módulos

Es la lista cerrada de las llamadas que un módulo hace a otro y que esperan respuesta. Una llamada que no figura aquí no puede existir: lo que se necesita saber de otro módulo se recibe por eventos y se guarda en una copia local, y lo que se avisa a una capa superior es siempre un evento y nunca una llamada. Cada fila dice quién llama, a quién, cuánto espera y qué pasa si no hay respuesta (Usuarios RN56). Las filas marcadas con * no tenían política escrita en los módulos: se proponen aquí y están a validar.

| # | Llama | A quién | Para qué | Espera | Si no responde |
|---|-------|---------|----------|--------|----------------|
| 1 | Ventas | Clientes y CC | Veredicto y reserva de crédito (Ventas RN27) | 3 s | Cerrar: la venta a cuenta no se cierra, salvo autorización de un supervisor con motivo |
| 2 | Ventas | Clientes y CC | Retención de saldo de vales, gift cards y puntos (Clientes RF31) | 3 s | Cerrar: la forma de pago no se ofrece, sin contingencia |
| 3 | Ventas | Stock | Compromiso de venta (Stock RF36) | 3 s | Abrir con autorización: los ítems con bloqueo piden supervisor y los demás continúan |
| 4 | Ventas | Stock | Validación de etiquetas propias y lotes disponibles de un ítem (Ventas RF48) * | 3 s | Degradar: sin validación, o el campo no se ofrece |
| 5 | Ventas | Financiero | Turno de caja abierto (Ventas RN43) | 3 s | Abrir con autorización: el cobro en efectivo pide supervisor y queda marcado "turno no verificado" |
| 6 | Ventas | ARCA (servicio externo) | Emisión de comprobantes y consulta al padrón (Ventas RF47, RF23) | El de Ventas (15 s por defecto) | Degradar: CAEA o comprobante no fiscal; padrón con carga manual |
| 7 | Ventas Online | Stock | Reserva de stock (Ventas Online RN07) | 5 s | Degradar: el pedido se acepta contra la disponibilidad publicada y queda "Reserva pendiente de confirmación" |
| 8 | Ventas Online | Clientes y CC | Veredicto y reserva de crédito (Ventas Online RN19) | 3 s | Cerrar: no se ofrece la cuenta corriente |
| 9 | Ventas Online | Clientes y CC | Retención de saldo de vales (Ventas Online RN35) | 3 s | Cerrar: la forma de pago no se ofrece |
| 10 | Stock, Compras, Financiero | Usuarios y Auditoría | Reservar la clave de un comprobante (Usuarios RF27) | 3 s | Cerrar: el comprobante queda en borrador |
| 11 | Todos los módulos | Usuarios y Auditoría | Validar permisos y autorización de supervisor (Usuarios RF05) | 3 s | Cerrar: la acción no se ejecuta |
| 12 | Clientes y CC | Ventas | Emisión de notas de débito y de crédito y consulta al padrón (Clientes RN38) * | El de Ventas | Degradar: la nota queda pendiente y se reintenta con la misma clave |
| 13 | Clientes y CC | Stock | Alcance de un retiro de lote (Clientes RF30) | 3 s | Degradar: informa "no disponible" y se puede reintentar (Clientes EX32) |
| 14 | Compras | Ventas | Padrón y constatación de comprobantes en ARCA (Compras RF01, RF14) | 15 s | Degradar: carga manual y "pendiente de constatar" |
| 15 | Compras | Stock | Presentaciones vigentes de un ítem (Stock RF02) * | 3 s | Cerrar: la línea queda sin confirmar hasta poder elegir la presentación |
| 16 | Financiero | Ventas | Cobros del turno con integración pendiente, al cerrar el turno (Financiero RF28) * | 3 s | Abrir con autorización: el cierre sigue con motivo y supervisor y el turno queda marcado "cobros sin verificar" |
| 17 | Stock | Ventas | Ventas del período, para el informe de diferencias de integración (Stock RF35) * | 3 s | Degradar: el informe indica que no está disponible y se reintenta |
| 18 | Contable | Módulos de capas inferiores | Saldos iniciales, controles cruzados y navegación al documento de origen (Contable RF11, RF13) * | 3 s | Degradar: el control o la navegación indican "no disponible" y no frenan la contabilización |
| 19 | Ventas Online | Ventas | Totales cobrado, reintegrado y facturado neto de un pedido, para calcular su alineación (Ventas RN67, Ventas Online RN50) * | 3 s | Degradar: la alineación queda "No verificado" y se reintenta |
| 20 | Ventas | Financiero | Saldo de caja antes de entregar una devolución en efectivo (Financiero RN45, Ventas RN76) | 3 s | Abrir con autorización: el efectivo solo se entrega con supervisor y queda marcado "saldo no verificado" |
| 21 | Ventas Online | Stock | Disponibilidad de elaborados de preparación inmediata al aceptar un pedido (Ventas Online RN04) | 3 s | Cerrar: esos productos se pausan |

Los costos, la lista de precios del cliente y la condición de socio no se consultan en línea: Ventas los guarda en una copia local que Compras, Stock y Clientes y CC actualizan por eventos (Ventas RN81).


## Anexo C: jerarquía de costos

Todos los costos son netos de IVA computable. Los consume Ventas a través de sus puertos; ningún módulo decide por su cuenta qué costo usar.

### C.1 Tipos de costo

| Sigla | Costo | Dueño | Qué es |
|-------|-------|-------|--------|
| CR | Costo de reposición | Compras | Cuánto cuesta reponer el ítem hoy, según la última factura o la lista del proveedor |
| CI | Costo de inventario | Stock | El que surge del método de valuación (promedio ponderado, PEPS o último costo) |
| CP | Costo de producción o de receta | Stock (STK-PRODUCCION) | Elaborado = suma de los insumos a CI más el costo adicional; sin la función, solo la suma de insumos |
| CV | Costo de la venta | Stock | El costo del movimiento de Stock que descontó la venta (CI o CP), congelado en ese movimiento |

### C.2 Qué costo se usa en cada caso

| Uso | Primero | Si falta | Si no hay ninguno |
|-----|---------|----------|-------------------|
| Precio por costo (VEN-PRECIO-COSTO) y margen por lista | CR | CI o CP, marcado "costo de inventario" | Precio manual |
| Control de venta bajo costo y aviso de promociones | CR | CI o CP | Sin control |
| Margen realizado, comisiones por margen y tablero | CV | Sin Stock: CR vigente, congelado en la línea de venta | Sin costo: no se calcula la comisión por margen, se alerta y el tablero marca "margen parcial" |
| Costeo del menú y ficha técnica | CP con los CI de los insumos | CR del insumo, marcado "parcial" | Costo parcial, sin margen |
| Costo de ventas contable | CV | — | Sin Stock no hay costo de ventas contable |

### C.3 Reglas

1. Cada línea de venta guarda el costo aplicado, su origen (movimiento de Stock, reposición o sin costo) y la fecha. Los informes siempre muestran el origen.
2. El CV llega con el evento de confirmación del descuento. Las ventas que todavía no lo tienen quedan "pendientes de costo" y entran en la liquidación de comisiones siguiente.
3. Un ajuste de valuación posterior no cambia el CV ya congelado.
4. Los costos en moneda extranjera se convierten con la cotización del momento de uso (precios y controles) o del congelamiento (CV).
5. El CR no es el costo de la venta cuando hay Stock.

### C.4 Dos márgenes con nombre propio

| Indicador | Lo registra | Costo que usa | Cuándo es "parcial" |
|-----------|-------------|---------------|---------------------|
| Margen realizado | Ventas | CV, o el costo de reposición congelado si no hay Stock | Falta costo, hay costo provisorio o se mezclan orígenes en el período. Se marca, no se corrige |
| Margen teórico de receta | Stock (STK-PRODUCCION) | CP | Un insumo sin costo de inventario usa su costo de reposición y se marca "parcial" |

## Cambios aplicados al SPEC de Ventas

Se creó `01-ventas.md` a partir del documento original, que no se modificó. Conserva RF01 a RF22, RN01 a RN26 y EX01 a EX18, y agrega RF23 a RF46, RN27 a RN48 y EX19 a EX36.

1. **RF03:** la receta pasa a Stock. Con Stock presente, la ficha del elaborado da acceso a su receta.
2. **RN05:** con Stock presente, la serie además debe estar "Disponible".
3. **EX10:** advertir o bloquear se configura en el ítem de stock.
4. **Modelo de datos:** las entidades Venta y Comprobante quedaron unificadas.
5. **Formas de pago:** atributo Moneda y función VEN-DIVISA.
6. **ARCA:** Ventas expone la consulta al padrón (RF23) y la constatación de comprobantes (RF24), además de la emisión (RF17).
7. **Origen del pedido (RF25):** admite pedidos de Ventas Online y de plataformas, que generan comanda.
8. **Receptor (RF26):** con Clientes y CC, se elige del maestro. Los remitos alimentan la facturación agrupada (RF27).
9. **Listas de precios múltiples:** dejó de ser una sugerencia y es la función VEN-LISTAS.

## Para confirmar

1. **Contable (directiva de instalación).** Interpreté "no instalación posterior, vendido aparte" así: licencia independiente, contratada en la puesta en marcha, sin generación retroactiva. Si lo que se busca es que pueda instalarse más adelante pero solo con asientos desde esa fecha, hay que cambiar Contable RF13, RN01 y RN18, y Usuarios RN31.
2. **Reapertura de turno.** Un turno solo se puede reabrir dentro de los 7 días (parametrizable, Antiguedad_Maxima_Reapertura); pasado ese plazo el ajuste se registra en el turno actual.
3. **Promociones y descuentos.** Las promociones aprobadas se aplican sin el permiso de "aplicar descuentos". El permiso se exige al crearlas y para los descuentos manuales sobre un ítem con promoción.
4. **Gift cards.** El tratamiento fiscal y contable queda parametrizable y a validar con el contador. Propinas y señas quedan fuera del alcance: el sistema no las maneja.
5. (Retirado: el sistema no maneja propinas.)
6. **Funciones que se sumaron sin estar en el pedido:** VEN-DIVISA, VEN-FRANJA, USU-2FA, USU-NUBE, USU-CORREO, CMP-UNIDADES-COMPRA, CMP-RECEPCION-LOTES, STK-TEMP y los modificadores y alérgenos. Se pueden quitar sin afectar al resto.
7. **Valores propuestos.** Umbrales como la demora del KDS (10 min), la tolerancia de rendimiento (10%), la ventana de reposición (8 semanas) o el código 2FA (6 dígitos, 30 s) son parametrizables y están a validar.
8. **Normativa.** Rotulado, arrepentimiento y retención de datos remiten a "normativa vigente, parametrizable". Conviene validarlos con asesoría legal antes de cerrar el alcance.

9. **Reserva y stock negativo.** Una reserva nunca supera el disponible, aunque el ítem permita stock negativo. Solo un supervisor, con motivo, puede forzar lo reservado.
10. **Pago online aprobado.** Con el pago aprobado la reserva queda firme hasta que Ventas registra la venta. Si el stock falta, el pedido espera 24 horas (parametrizable) antes de cancelarse con reintegro.
11. **Crédito.** Las causas duras (cuenta bloqueada o cerrada, sin cuenta en la moneda, Consumidor Final) bloquean siempre, incluso en el modo "Solo advertir". Los umbrales de mora por defecto (5 y 30 días) son propuestos. Online no ofrece la cuenta corriente cuando el veredicto es "Requiere autorización" porque no hay supervisor presente.
12. **ARCA.** Los plazos de espera de la cola (10 s), el arrendamiento del candado (60 s) y el tiempo máximo antes de la alerta (10 min) son propuestos. Si la numeración local y la de ARCA difieren, la clave queda en "Resolviendo" y se alerta.
13. **Venta cuando Stock no responde.** Los ítems con bloqueo no se venden sin autorización de un supervisor con motivo; los ítems sin bloqueo continúan sin validar existencias y el descuento queda en la bandeja de pendientes (Ventas EX10).
14. **Activación al instalar un módulo.** Si se instala Financiero con VEN-DIVISA activa y FIN-MONEDA-EXT inactiva, el Administrador debe activar la segunda o confirmar la desactivación de la primera (Usuarios EX30).
15. **Disponible en Stock.** Disponible = físico − reservado − comprometido. Una diferencia de inventario por debajo de lo reservado exige confirmación de un supervisor.
16. **Toma de inventario.** La tolerancia de movimientos posteriores es 0 en los ítems de control estricto y parametrizable en el resto; el conteo de más de 24 horas exige recontar o confirmar.
17. **Kits.** Armar un kit requiere STK-PRODUCCION; sin ella solo existen combos virtuales.
18. **Pedido online con pesables.** Se factura completo después del pesaje, también cuando el pedido mezcla pesables con otros ítems. El reintegro espera a la nota de crédito emitida; la única excepción es el cobro adicional por peso, que se aprueba antes de facturar.
19. **Presentaciones.** El ID de una presentación identifica la presentación; el factor vigente se toma al usarla y el aplicado se guarda en cada documento.
20. **Móvil sin conexión.** El dispositivo no guarda operaciones sin conexión: las bloquea y avisa (Ventas RN66).
21. **Anulación de recibo y desimputación.** Llevan clave de solicitud como el resto de las operaciones de usuario.
22. **Funciones que la auditoría de cobertura obligó a agregar.** Garantía de productos serializados (plazo, fecha de fin y consulta por serie), devolución con cambio de mercadería, tipo de artículo Gift card y vale por devolución. Si no corresponden al producto, se pueden quitar sin afectar al resto.
23. **Devoluciones.** Elegir una forma de reintegro distinta de la original, o un vale, exige un supervisor mientras el parámetro Reintegro_Otra_Forma_Requiere_Supervisor esté activo (por defecto Sí). Un vale por devolución sin cliente identificado queda al portador, como una gift card anónima.
24. **Gift cards.** No integran el comprobante fiscal: una venta solo de gift cards emite un ticket no fiscal de emisión. Contable las registra como deuda hasta el canje (tratamiento a validar con el contador).
25. **Etiqueta de peso.** La etiqueta de balanza guarda el peso y el sistema calcula el importe con el precio vigente; no hay etiquetas con importe embebido (Stock RN82).
26. **Alérgenos.** Cuando una opción sustituye un insumo, el artículo conserva los alérgenos del artículo base (criterio conservador, Stock RN77): un café con leche vegetal muestra los de la leche vegetal y también los lácteos hasta que el comercio ajuste la declaración. Es el criterio que protege la inocuidad; si se prefiere excluir el insumo sustituido, hay que cambiar Stock RN77 y RF31.
27. **Merma de producción.** La fórmula del desvío fuera de tolerancia (Stock RN72) es una propuesta a validar.
28. **Cierre de turno con cobros pendientes.** Se puede cerrar con motivo; la tolerancia de diferencia no cuenta el importe que explican los cobros pendientes, y el cobro tardío lo compensa en el turno actual.
29. **Ingreso sin lote (Stock RN84).** Por defecto se pide el lote al recibir (CMP-RECEPCION-LOTES activa en todos los perfiles). Si el comercio la desactiva, Stock crea un lote automático con vencimiento por vida útil; solo si el ítem no tiene vida útil queda "Pendiente de lote" (alerta a las 24 horas, parametrizable).

30. **Servidor en la nube (F1).** Se interpretó que cada cliente tiene un único servidor asignado y que cada sucursal es una instancia independiente dentro de él, con sus propios usuarios, clientes, cajas y contabilidad. Si una sola instancia debe atender varias sucursales, hay que revisar Usuarios RN79 y la consolidación (RF20).
31. **Sistema puramente online (F1).** Sin internet en el local no se vende: las pantallas muestran "Sin conexión" y bloquean las operaciones nuevas, y no hay comprobantes con CAEA por falta de internet (el CAEA solo cubre una caída de ARCA). Si el comercio necesita un respaldo para esos casos, hay que definirlo fuera del sistema o reabrir esta decisión. Queda pendiente definir cómo se conectan la impresora, la balanza y el lector de códigos a una página web.
32. **Identificador único (F2).** El formato del ID_Global (ordenable por fecha y prefijado con el código de la instancia) es una decisión de diseño a validar con el equipo de desarrollo; el SPEC fija solo sus propiedades (Usuarios RN81).
33. **Vigencias de las reservas (F3 y F4).** Compromiso de venta 2 minutos, reserva online 15 minutos, reserva de crédito 5 minutos, retención de saldo 5 minutos y reserva de clave de comprobante 15 minutos, con hasta 3 renovaciones; la reserva de crédito de un pedido online confirmado dura hasta 24 horas. Todas son propuestas y parametrizables (Usuarios RN83, Clientes RF26).
34. **Políticas de falla propuestas (Anexo B.5).** Las filas marcadas con * en la lista de llamadas inmediatas no tenían política escrita en los módulos y se proponen allí; hay que validarlas.
35. **Propinas y señas fuera del alcance.** Los pedidos especiales (tortas por encargo, catering) y las reservas no tienen cobro anticipado. Si el comercio lo necesita más adelante, hay que reabrir la decisión; los números de las reglas retiradas se conservan.
36. **Ventas sin comprobante fiscal (Contable RF26).** Contable no registra las ventas no fiscales ni sus cobros ni los remitos sin cuenta, y los reconoce al emitirse la factura que las regulariza. El costo se registra por defecto con el movimiento de Stock; el parámetro Momento_Costo_Ventas_No_Fiscales permite diferirlo a la regularización, y los informes pueden filtrar esos movimientos. La venta de gift cards sigue generando su deuda (RF25). Ambos puntos están a validar con el contador. La alerta de 30 días pasó a Ventas.
37. **Pendientes de integración (Usuarios RN85).** Los responsables por tipo (Stock: Depósito; el resto: Gerente) y los plazos de 24 y 72 horas son propuestos. Al vencer el plazo, el pendiente pasa directo al rol Administrador.
38. **Copia local de Ventas (Ventas RN81).** Se acepta que costos, lista de precios del cliente y condición de socio estén atrasados unos segundos respecto de su módulo dueño.
39. **Restauración y emisión fiscal (Usuarios RN57).** Mientras haya efectos sin origen sin resolver, la emisión fiscal sigue bloqueada y la venta continúa como no fiscal; solo un Administrador puede aceptar el pendiente. Si se prefiere no bloquear, hay que cambiar RN14 y RN57.
40. **Funciones con peso sanitario (Usuarios RN86).** Se pueden desactivar con aviso reforzado y la autorización de otro Administrador (parámetro, por defecto Sí). La lista (STK-LOTES, STK-TRAZA, STK-ALERGENOS, VEN-ALERGENOS y STK-TEMP) es propuesta.
41. **Permisos del Administrador (Usuarios RN07).** Los Administradores pueden darse permisos a sí mismos y hacer lo que consideren; el único control es que todo queda registrado. Se mantiene la regla de que un Administrador no autoriza su propia acción cuando un permiso pide autorización de otra persona (RN08).
42. **Orden y presupuesto del cierre de venta (Ventas RN85).** El presupuesto de 8 segundos para las consultas previas es configurable; el orden de las consultas es propuesto.
43. **Facturación agrupada (Ventas RN31).** El comprobante agrupado se emite con los precios y la condición de IVA del día de la factura; el usuario ve y acepta la diferencia contra los remitos antes de emitir.
44. **Reservas sin pago (Ventas Online RN56).** El tope del 30 % del disponible es propuesto; por encima requiere supervisor.
45. **Desinstalación de módulos (Usuarios RN87).** Usuarios y Ventas no se pueden desinstalar. Los datos del módulo desinstalado quedan conservados sin uso; si se prefiere borrarlos, hay que definirlo.
46. **Gift cards con código de Ventas (Ventas RF51, Clientes RF29).** Ventas genera el código y Clientes lo activa; hasta entonces figura "Pendiente de activación".
47. **Fuera del alcance de esta etapa.** Otros impuestos (percepciones de ingresos brutos y similares), la factura de crédito electrónica para PyMEs y los cobros por cuenta de terceros. El sistema maneja solo IVA y no tiene un tipo de ítem para cobrar por terceros.
48. **Anexo E.** Se incorporó el Anexo E y se agregó la sección E.7 con un caso de prueba por cada regla nueva. Las configuraciones de la matriz de pares (E.3) hay que regenerarlas con el generador, porque el catálogo cambió.
