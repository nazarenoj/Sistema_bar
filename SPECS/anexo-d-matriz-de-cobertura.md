# Anexo D: matriz de cobertura funcional por tipo de ítem y flujo, y escenarios de punta a punta

Auditoría funcional independiente de los SPECS 01 a 08, con el índice 00 como guía. Los SPECS no se modificaron. Nota de numeración: este archivo es el Anexo D del índice (`anexo-d-matriz-de-cobertura.md`; el Anexo C es la jerarquía de costos y el Anexo E la matriz de pruebas). Las Partes 1 a 3 conservan el análisis original; la Parte 3 (tabla "Estado de las brechas"), la Parte 3B y la Parte 4 recogen la verificación posterior a la ronda de correcciones 3, hecha leyendo los SPECS vigentes y comparándolos con las copias previas.

## Criterio y abreviaturas

- **C** (Cubierto): se encontró la regla concreta y se cita. **P(Gn)** (Parcial): la regla existe pero omite un caso o choca con otra; `Gn` remite a la Parte 3. **B(Gn)** (BRECHA): no hay regla. **N/A**: no aplica, con el motivo.
- Las brechas que afectan a todos los tipos de ítem se cuentan una sola vez, en la fila Estándar (G10 y G11). G2 se cuenta en Perecedero y en Etiqueta propia, donde se manifiesta de forma distinta. G1 y G14 se cuentan por faceta.
- Las ausencias se verificaron con búsquedas de texto sobre los ocho archivos (ver el final del documento).
- Módulos: **Ven** 01 Ventas, **Stk** 02 Stock, **Cli** 03 Clientes y CC, **Usu** 04 Usuarios y Auditoría, **Fin** 05 Financiero, **Con** 06 Contable, **Cmp** 07 Compras, **Onl** 08 Ventas Online, **Idx** 00 Índice.
- Flujos: F1 Alta y catálogo; F2 Precio, listas y promociones; F3 Venta presencial (POS y mozo móvil); F4 Venta online y plataformas; F5 Compromiso y descuento de stock; F6 Anulación, devolución y nota de crédito; F7 Compra e ingreso; F8 Costeo y margen; F9 Inventario, mermas y vencimientos; F10 Trazabilidad, alérgenos y etiquetas; F11 Contabilización; F12 Tablero y consolidación.

---

## Parte 1. Matriz tipo de ítem por flujo

| # | Tipo de ítem | F1 Alta y catálogo | F2 Precio, listas, promos | F3 Venta presencial | F4 Online y plataformas | F5 Stock | F6 Anulación, devolución, NC | F7 Compra e ingreso | F8 Costeo y margen | F9 Inventario, mermas, venc. | F10 Traza, alérgenos, etiquetas | F11 Contabilización | F12 Tablero y consolidación |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Estándar | C: Ven RF01, RN02; Stk RF01, RN24 | C: Ven RF14, RF34, RF36, RN17, RN32 | C: Ven RF05 a RF08, RF39, RN37 | C: Onl RF02, RF03, RF09, RF19; Ven RF25 | C: Ven RN06, RN63; Stk RF07, RF36, RN58 | C: Ven RF15, RN13, RF49, RN76, EX58; Stk RF08, RN51; Fin RN31, EX13, RN08, RN42, EX04, EX31; Cli RF29, RN31 (vale); Con RN20 | C: Cmp RF03, RF04, RN03; Stk RF04, RN07, RN09 | C: Ven RN62; Stk RF17, RN62, RN63; Cmp RF11, RF21 | C: Stk RF12, RF14, RF16, RF18, RN20 | C: Ven RF31; Stk RF20 a RF22, RF27 (según el ítem controle lote o alérgenos) | C: Con RF03, RN11, RF20, RN25 | C: Ven RF45, RF46, RN62(c), RN75; Stk RF24, RF33, RN76; Usu RF19, RF20; Idx C.4 (dos indicadores con nombre propio) |
| 2 | Con variantes (tamaño, talla, color) | C: Ven RF01, RN02, RN03; entidades Variante y Codigo_Articulo | C: Ven RN03 (precio base o por variante), Precio_Lista por variante, RF14 | C: Ven RN03 (se vende a nivel de variante), RF02 | C: Onl RF02 (selector de atributos), RF05, Publicacion por variante | C: Stk RN03 (saldo por variante; el artículo base no tiene stock), RF01 | C: Ven RF15, RF50 (devolución con cambio de talle o color); Stk RF08 por variante | C: Cmp RF03 (línea por variante), RF11; Stk RF04 | C: Cmp RF11 (CR por variante); Stk RF17; Ven RN62 | C: Stk RN03, RF14 (conteo por ítem-variante) | C: Stk RF27 (etiqueta por ítem), RF21; Ven RF31 (alérgenos por artículo; por variante con Stk RF22) | C: Con RF03 (criterio categoría de artículo) | C: Ven RF45, RF46 |
| 3 | Pesable a granel | C: Ven RF01, RN04 (Peso_Minimo_Venta, Peso_Maximo_Venta, Tara, decimales) | C: Ven RF01 (por kg o 100 g), RN04 (redondeo), RF14, RF34 | C: Ven RN04, EX55 (lectura estable; manual con permiso y motivo) | C: Onl RN11, RN51, RF27, RF29; Ven RN68 | C: Stk RF07 (Modo Propio), RN04; Onl RN51(j) (peso real) | C: Ven RF15, RN68(5); Stk RF08 (en unidad base) | C: Cmp RN23 (3 decimales), RN24, EX06; Stk RF02 | C: Stk RF17, RN62; Cmp RF11 (CR por unidad base); Ven RN62 | C: Stk RF12 (merma), RF14, RN04 | C: Stk RF20, RF21 (lote FEFO); Onl RN39 | C: Con RF03, RF20 | C: Ven RF45; Stk RF33 |
| 4 | Peso variable envasado con etiqueta propia | C: Ven RN04, RN71, Articulo.Etiqueta_Propia; Stk RF27, RN82 (prefijo propio y verificador EAN-13), Configuracion_Stock | C: Ven RN71 (peso o importe embebido), RN04 (redondeo), RN17 | C: Ven RN71, RN04, EX55 | N/A: la etiqueta propia se lee en el POS; online se vende como pesable (Onl RN11, RN51) | C: Stk RF07 (Propio, en kg); Ven RN71 (Origen_Peso Etiqueta propia) | C: Ven RF15; Stk RF08 | N/A: se elabora o envasa en el obrador (Stk RF11, RF23) | C: Ven RN62; Stk RN63 (costo unitario por el peso) | C: Stk RF20, RF27 (lote y vencimiento en la etiqueta), RF12 | C: Stk RF20, RF21, RF27 (QR de lote), RN73, RN82; Ven RF48, RN80 (el código no lleva lote: se elige a mano o queda "Lote no confirmado") | C: Con RF03, RF20 | C: Ven RF45; Stk RF33 |
| 5 | Serializado | C: Ven RF01, RF33, RN05; Stk RF26, RN71; Usu RN25 | C: Ven RF14, RF34, RF36 (como estándar) | C: Ven RN05, EX33 | C: Onl RN12, RF12 (serie al preparar) | C: Stk RN05, RF36 (Disponible, Comprometida y Vendida de forma atómica); Ven RN05, RN63 | C: Ven RN05, RN79(3); Stk RF08, RN05, RN79, EX60 (sin falla: Disponible; con falla: Baja con motivo) | C: Cmp RF24, RN37, EX23 (series al generar el ingreso); Stk RF06, EX06 | C: Stk RN17, RN62 (el costo es del ítem; la serie no lo cambia) | C: Stk RF14 (conteo por serie), RN79, RF37 | C: Stk RF41, RN79, Historial_Serie; Ven RF33, RF20 (filtro por serie), RN79 (Fecha_Fin_Garantia) | C: Con RF03, RF20 | C: Ven RF45, RF46 |
| 6 | Servicio | C: Ven RF01; Stk RN04 | C: Ven RF14, RF34, RF36 | C: Ven RF05 a RF08 (comanda solo si tiene sector, RF07) | C: Onl RN13 (sin envío), RF20 (talleres y catas) | N/A: no controla stock (Stk RN04) | C: Ven RF15 (NC sin movimiento de existencias); Stk RN04 | N/A: no se compra para revender; los servicios comprados son gastos (Cmp RF03 por concepto) | C: Ven RN62, RN78, EX47 (Sin costo asociado o costo manual; fuera de la alerta y del margen parcial) | N/A: sin existencias | N/A: sin lote ni alérgenos | C: Con RF03 (formulario de venta sin componente costo) | C: Ven RF45, RF46 |
| 7 | Elaborado de producción en venta | C: Ven RF01, RF03; Stk RF09, RF10, RN13 | C: Ven RF14, RF32, RN46 (CP si no hay CR), RN41 | C: Ven RF07, RF38 (comanda y KDS) | C: Onl RF16, RF26, RN04, RN38, RN54 | C: Stk RF07 (Modo Componentes), RN54, RN64, EX08; Ven RN69 | C: Ven RF15 (merma por defecto); Stk RF08, RN12 | N/A: se compran los insumos y no el elaborado (fila 11) | C: Stk RF17 (CP), RF24, RN37, RN63, EX25; Ven RN62(d) | C: Stk RF12, RF14, RF18 (consumo teórico contra real) | C: Stk RF22, RN33, RN34, EX22, RF27; Ven RN42 | C: Con RF20 (costo de ventas = CV), RN25 | C: Ven RF45; Stk RF33 |
| 8 | Elaborado de producción previa | C: Stk RF10, RF11; Ven RN69 (Modo Propio) | C: Ven RF14, RN46, RN62 (CP) | C: Ven RF07 (sector vitrina o depósito), RN69 | C: Onl RN54 (sí se reserva), RN38, RN07 | C: Stk RN14, RF07 (Propio), RF36 | C: Ven RF15 (merma por defecto); Stk RF08 | N/A: se produce (Stk RF11, RF23); se compran los insumos | C: Stk RN15, RN36, RN62, RN63 | C: Stk RF20 (merma de fin de día), RN44, RF23 | C: Stk RF21, RN30, RN31, RF22, RF27 | C: Con RF20, RN25; Stk RN15, RN36, RN72 (la merma de cocción queda en el costo del terminado; solo el desvío fuera de tolerancia es "Merma de producción") | C: Stk RF23, RF33 (rendimiento) |
| 9 | Combo virtual | C: Ven RF01, RN69, EX53, Combo_Componente; Stk RN65, EX48 | C: Ven RN33, RN34, RN70, RF36 (descuento prorrateado y guardado por línea, Importe_Descuento) | C: Ven RF07 (comanda por componente), RN69 | C: Onl RF27, RN03, RN53, EX38; Stk RF15, RN22, RN81 (reserva expandida a los componentes, todo o nada) | C: Ven RN69; Stk RF09, RN64, RN58 (todo o nada) | C: Ven RF15, RN70; Stk RN66, EX49 | N/A: sin stock propio; se compran los componentes | C: Ven RN62, RN69 (suma de CV); Stk RN63, RN65 | N/A: sin stock propio (ver componentes) | C: lote por componente (Stk RN31, Consumo_Lote); alérgenos: Ven RN42(c); Stk RN77(c) | C: Con RF03, RF20; Stk RN63 (detalle por componente) | C: Ven RF45, RF46 |
| 10 | Kit armado | C: Ven RF01, RN69, Articulo; Stk RF09, RF11, RN65; Onl RF27, RN53; Idx Para confirmar 17 (Stock + STK-PRODUCCION en todos los SPEC) | C: Ven RF14, RF34, RF36 | C: Ven RF01, RN69 | C: Onl RF27 (artículos compuestos), RN07 | C: Stk RF09, RN64 (Modo Propio), RF36 | C: Ven RF15 (se reingresa como kit); Stk RN66 | N/A: se arma (Stk RF11 tipo Armado); se compran los componentes | C: Stk RF11, RN15, RN65 (costo = suma de componentes); Ven RN62 | C: Stk RF11, RF14, RF20, RN30; el desarmado no es automático (RN66) | C: trazabilidad (Stk RN31, Consumo_Lote); alérgenos: Ven RN42(c); Stk RN77(c) | C: Con RF20 | C: Ven RF45, RF46 |
| 11 | Insumo no vendible | C: Stk RF01, RN24 | N/A: no se vende | N/A: no se vende; el consumo interno es un egreso (Stk RF12) | N/A: no se publica | C: Stk RF07 (receta y modificadores), RF11, RF12, RF38, RN75 (envase por modalidad); Ven RN06, RN72 | N/A: no se vende | C: Cmp RF03, RF10, RF18, RF19; Stk RF02, RF04 | C: Stk RF17, EX45; Cmp RF11, RF21 | C: Stk RF12, RF14, RF16, RF20 | C: Stk RF22 (alérgenos por insumo), RF21, RN32 | C: Con RF20, RF11 | C: Stk RF33, RF34 |
| 12 | Porción de una pieza entera | C: Ven RF01 (ID_Articulo_Origen, Cantidad_Porciones); Stk RF02 (uso Fraccionamiento), RF30 | C: Ven RF14, RF34, RF36 (artículo propio) | C: Ven RF07, RF08; Stk EX30 | C: Onl RN38 (disponibilidad en porciones) | C: Stk RF30, RN44, EX30 | C: Ven RF15; Stk RF08 (la devolución de una porción es siempre merma), RN74, RN78 | C: Stk RF02 (se compra la torta entera), RF11; Cmp RF18 | C: Stk RN63; RF30, RN78 (costo de la porción = costo de la pieza dividido por las porciones) | C: Stk RN44, RN78 (lote y vencimiento de la pieza); RN04 (unidad base "porción", sin decimales) | C: Ven RN42(c) (alérgenos del origen); Stk RN77(d), RN78; el retiro del lote de la pieza alcanza a las porciones (RF21) | C: Con RF03, RF20 | C: Usu RF19 (tortas por porción); Ven RF45 |
| 13 | Perecedero con lote y vencimiento | C: Stk RF01, RF20, RN28, RN29; Item_Stock.Vida_Util_Dias | C: Ven RF14, RF36 (franja u horario). Sin regla de liquidación por vencimiento (no es requisito) | C: Stk RN06, EX11 (FEFO; bloquea o advierte lote vencido); Ven RN63 | C: Onl RN39 (lote FEFO al preparar), RN54 | C: Stk RN58 (compromiso con lote FEFO), RF36, RN31 | C: Ven RF15; Stk RF08, RN74, RN28, EX18, EX56 (conserva el lote; bloqueado o vencido: solo merma) | C: Cmp RF19, RN25, RN39, EX14, EX15, RF25; Stk RN28, RN84, EX18, EX63, RF40, RN80 (Pendiente de lote y devolución a proveedor) | C: Stk RN17 (PEPS por capas), RN63; Con RF20 (vencimientos) | C: Stk RF20, RF16, RF18, EX11 | C: Stk RF21, RN31, RN32, RN73, EX20, EX21; Ven RF48, RN80 (lote indicado o asignado por FEFO) | C: Con RF20 (mermas por vencimiento) | C: Stk RF33 (vencimientos próximos); Usu RF19 |
| 14 | Artículo con modificadores (leche, extra shot) | C: Ven RF30, Grupo_Modificador; Stk RF31, Mapeo_Modificador_Insumo | C: Ven RN41 (ajuste de precio por opción) | C: Ven RF06, RF07, RF30, RF38, EX31 | C: Onl RF22, RN33, EX23 | C: Stk RF31, RF07, RN45, RN64, EX31; Ven RN06 | C: Ven RF15; Stk RF08 (Movimiento_Linea.ID_Opcion_Modificador) | N/A: las opciones no se compran; sus insumos sí (fila 11) | C: Stk RF07, RN63 (el CV usa el insumo realmente descontado) | N/A: sin stock propio (fila 11) | C: Ven RF30, RN42(b); Stk RF31, RF39, RN77; Onl RN32 | C: Con RF03 (venta), RF20 (costo) | N/A: no se define indicador por opción |

Tipo de ítem no catalogado detectado en la auditoría original: la gift card (Cli RF23). Ya está catalogado en Ven RF01, RF51, RN77 y en la entidad Articulo (G12 cerrada); no se agrega fila a la matriz para no alterar sus conteos.

---

## Parte 2. Escenarios de punta a punta

### E1. Café con leche vegetal en mesa, con pago mixto

| # | Paso | Regla que lo cubre | Estado |
|---|---|---|---|
| 1 | Abrir el pedido en mesa o silla con el mozo (también desde tablet) | Ven RF05, RF06, RN10; RF39, RN37 | Cubierto |
| 2 | Elegir la bebida y su tamaño (variante) | Ven RF01, RN03 | Cubierto |
| 3 | Elegir "leche vegetal" y "extra shot": precio y grupo obligatorio | Ven RF30, RN41, EX31 | Cubierto |
| 4 | Lista de precios y promociones vigentes | Ven RN32, RF36, RN33 | Cubierto |
| 5 | Comanda a barra con opciones y alérgenos | Ven RF07, RF38, RF31, RN42; Stk RF39, RN77 | Cubierto (ver R6) |
| 6 | Compromiso de venta si el ítem no admite stock negativo | Ven RN63, EX48; Stk RF36, RN58 | Cubierto |
| 7 | Descuento con el insumo sustituido (vegetal por entera) y el extra shot | Stk RF31, RF07, RN45, RN64, EX31; Ven RN06, RN41 | Cubierto |
| 8 | (Paso retirado: el sistema no maneja propinas) | — | — |
| 9 | Pago mixto (efectivo y tarjeta): el total pagado iguala el comprobante | Ven RF09, RN16, EX11, EX13 | Cubierto |
| 10 | (Paso retirado: el sistema no maneja propinas) | — | — |
| 11 | Turno de caja y destino por forma de pago | Ven RN43; Fin RN04, RF02 | Cubierto |
| 12 | Factura a consumidor final con CAE | Ven RF10, RN14, RF26, RF47 | Cubierto |
| 13 | Cobro hacia Financiero y crédito a acreditar de la tarjeta | Ven RN58; Fin RF27 | Cubierto |
| 14 | Costo de la venta con el insumo realmente descontado | Stk RN63, RF07; Ven RN62 | Cubierto |
| 15 | Contabilización: venta y costo | Con RF03, RN11, RF20 | Cubierto |

### E2. Torta vendida por porción y devolución de una porción

| # | Paso | Regla que lo cubre | Estado |
|---|---|---|---|
| 1 | Alta de la porción como artículo vinculado a la torta (1 torta = 8) | Ven RF01 (ID_Articulo_Origen, Cantidad_Porciones); Stk RF02 (uso Fraccionamiento), RF30 | Cubierto |
| 2 | Ingreso de la torta entera con lote y vencimiento (compra o producción previa) | Stk RF02, RF04, RF20, RN28, RN29, RF10, RF11, RF23; Cmp RF18, RF19 | Cubierto |
| 3 | Fraccionar (opcional) o descontar proporcionalmente | Stk RF30, RN44, RN78, EX30; RN04 (unidad base "porción", sin decimales) | Cubierto |
| 4 | Vender la porción con comanda a vitrina o mostrador | Ven RF01, RF07, RF08 | Cubierto |
| 5 | Descuento y costo de la porción vendida | Stk RF30, RN44, RN63; Ven RN62 | Cubierto |
| 6 | Alérgenos y etiqueta de la porción | Ven RF31, RN42(c); Stk RF22, RF27, RF39, RN77(d) | Cubierto (ver R6) |
| 7 | Devolución de una porción: nota de crédito parcial | Ven RF15, RN13, RN34, RF47 | Cubierto |
| 8 | Destino de la porción devuelta (merma por defecto) | Ven RF15; Stk RF08, RN74, RN78 (porción: siempre merma, con ingreso al costo original más egreso "Devolución a merma") | Cubierto (ver R1) |
| 9 | Forma de reintegro: efectivo, tarjeta o vale por devolución (Cli RF23 cita "una torta devuelta") | Ven RF15, RF49, RN76, RN58, EX58; Cli RF23, RF29, RN31 | Cubierto |
| 10 | Contramovimiento en caja (turno cerrado o caja sin saldo) | Fin RN31, EX13, RN08, RN42, EX04, EX31; Ven RN76(5) | Cubierto |
| 11 | Reversa de promociones y comisión | Ven RF15, RN34, RN38 | Cubierto |
| 12 | Porciones sobrantes al cierre | Stk RN44, RF20 | Cubierto |
| 13 | Contabilización: nota de crédito, costo y merma | Con RN20, RN25, RF20 | Cubierto |

### E3. Combo café + medialuna con promoción y devolución parcial

Se evalúan las dos lecturas: combo virtual (artículo a precio cerrado) y promoción tipo combo.

| # | Paso | Regla que lo cubre | Estado |
|---|---|---|---|
| 1 | Alta: combo virtual o promoción tipo combo | Ven RF01, RF36, RN69, EX53; Stk RF09, RN65 | Cubierto |
| 2 | Venta del combo con comanda por componente | Ven RF07, RN69 | Cubierto |
| 3 | Promoción adicional sobre el combo virtual (por ejemplo por forma de pago) | Ven RN33 (la promoción se aplica sobre la línea del combo antes del prorrateo), RN34, RN70 | Cubierto |
| 4 | Promoción tipo combo: precio y descuento de cada ítem | Ven RF36, RN33 (descuento prorrateado y guardado por línea, Importe_Descuento), RN34, RN70 | Cubierto |
| 5 | Descuento de stock sin duplicar movimientos | Ven RN69, RN06; Stk RF09, RN64, RN58 | Cubierto |
| 6 | Costo del combo igual a la suma de los CV | Ven RN62, RN69; Stk RN63, RN65 | Cubierto |
| 7 | Devolución parcial del combo virtual (solo la medialuna): NC por su parte prorrateada | Ven RF15, RN70; Stk RN66 | Cubierto |
| 8 | Devolución parcial con promoción tipo combo: precio efectivamente cobrado | Ven RN34 (precio efectivamente cobrado: importe de la línea menos su Importe_Descuento), RN70 | Cubierto |
| 9 | Reingreso o merma del componente, con tope por lo vendido | Stk RF08, RN66, EX49; Ven RF15 | Cubierto |
| 10 | Reversa de sellos o puntos y comisión | Ven RF15, RN38; Cli RN24, EX17 | Cubierto |
| 11 | Contabilización de la nota de crédito y del costo | Con RN20, RN25, RF20 | Cubierto |
| 12 | El mismo combo en la tienda online (reserva y disponibilidad) | Onl RF27, RN03, RN53, EX38; Stk RF15, RN22, RN81 (reserva expandida a los componentes, todo o nada; disponibilidad = mínimo) | Cubierto |

### E4. Producción por tanda con rinde menor al teórico y venta del lote

| # | Paso | Regla que lo cubre | Estado |
|---|---|---|---|
| 1 | Receta, ficha técnica y rendimiento esperado | Stk RF09, RF24, RN13 | Cubierto |
| 2 | Orden por tanda (usuario, turno, cantidad teórica, peso crudo y final) | Stk RF10, RF11, RF23 | Cubierto |
| 3 | Consumo de insumos por FEFO e insumos insuficientes | Stk RF11, RN06, RN31, EX24 | Cubierto |
| 4 | Rendimiento real menor: tolerancia, observación y permiso | Stk RN35, EX23, RN21 | Cubierto |
| 5 | Merma de cocción y costo unitario real | Stk RN15, RN36, RF23 | Cubierto |
| 6 | Lote de elaboración con vencimiento por vida útil | Stk RN30, RN29, RF20, RF23 | Cubierto |
| 7 | Etiqueta del lote | Stk RF27, RN39, EX27 | Cubierto |
| 8 | Venta del producto terminado (Modo Propio, FEFO) | Ven RN69; Stk RN14, RF07, RN06 | Cubierto |
| 9 | Costo de la venta igual al costo real de la tanda | Stk RN63, RN62, RN15; Ven RN62 | Cubierto |
| 10 | Disponibilidad online del lote (se reserva) | Onl RN54, RN38; Stk RN22 | Cubierto |
| 11 | Indicadores de rendimiento y mermas | Stk RF33, RF23, RF18 | Cubierto |
| 12 | Contabilización: consumo a productos en proceso y elaborados al costo real | Con RF20 | Cubierto |
| 13 | Contabilización de la merma de cocción y de la diferencia de rendimiento | Con RF20, RN25 (solo la "Merma de producción" va a resultado); Stk RN15, RN36, RN72 | Cubierto |

### E5. Retiro de un lote contaminado hasta los clientes mayoristas alcanzados

| # | Paso | Regla que lo cubre | Estado |
|---|---|---|---|
| 1 | Ubicar el lote del insumo y su proveedor | Stk RF21 (ascendente), RN28; Cmp RF19 | Cubierto |
| 2 | Trazabilidad descendente hasta los lotes elaborados | Stk RF21, RF23, RN30, RN31, Consumo_Lote | Cubierto |
| 3 | Retiro: bloquear el lote y, a elección, los derivados | Stk RF21, RN32, RN21 | Cubierto |
| 4 | Bloqueo inmediato para ventas y consumos | Stk RN32, EX11 | Cubierto |
| 5 | Saber qué lote salió en cada venta o remito | Stk RN31, RN73, RF21 (lote indicado o "Asignado por FEFO" = "Lote no confirmado"); Ven RF48, RN80 | Cubierto |
| 6 | Lista de alcance: comprobante, fecha, sector, cantidad y cliente | Stk RF21, Retiro_Lote_Alcance, EX21 | Cubierto |
| 7 | Datos de contacto de los mayoristas alcanzados | Stk RF21, RF42, RN83 (servicio "Alcance de un retiro de lote"); Cli RF19, RF30, RN38, EX32 (llama hacia abajo) | Cubierto (ver R10) |
| 8 | La venta mayorista identifica al cliente del maestro | Ven RF26, RF12; Stk sección 2 (ID_Cliente en el mensaje) | Cubierto |
| 9 | Pedidos online que llevan el lote | Onl RN39, RN18, Pedido_Item.ID_Lote | Cubierto |
| 10 | Exportar la lista a CSV o PDF | Stk RF21 | Cubierto |
| 11 | Seguimiento: aviso a cada cliente, producto recuperado y su destino | Stk RF21, RF42, RN83, EX61 (Pendiente de aviso, Avisado, Recuperado; el producto devuelto entra como merma del lote bloqueado) | Cubierto (ver R10) |
| 12 | Reclamo al proveedor del insumo contaminado | Cmp RF25, RN38, EX06, EX15, EX24; Stk RF40, RN80, EX58 | Cubierto (ver R1) |
| 13 | Auditoría del retiro y de la liberación | Stk RN21, RN32; Usu RF08 | Cubierto |

### E6. Venta mayorista con remito, cuenta corriente, factura agrupada y cheque rechazado

| # | Paso | Regla que lo cubre | Estado |
|---|---|---|---|
| 1 | Alta del mayorista: CUIT validado, domicilios, límite, plazo y umbrales de mora | Cli RF01, RF03, RF21, RN02, RN22 | Cubierto |
| 2 | Lista Mayorista del cliente en el POS | Cli RF20, RN21; Ven RN32, RF34, RF35 | Cubierto |
| 3 | Pedido mayorista con comanda al obrador | Ven RF05, RF07 | Cubierto |
| 4 | Veredicto y reserva de crédito de la venta a cuenta | Ven RF16, RN27, EX22; Cli RF12, RN04, RF26 | Cubierto |
| 5 | Veredicto de crédito al asignar un remito a la cuenta | Ven RF12, RN73, RN27, EX22; Cli RF05, RF12, RF26, RN41, EX29 | Cubierto |
| 6 | Remito no fiscal con numeración propia, asignado a la cuenta | Ven RF12; Cli RF05, RF28 | Cubierto |
| 7 | Descuento de stock del remito con el lote entregado | Stk RF07, RN31, RN73; Ven RF48, RN80 (el remito imprime el lote indicado) | Cubierto |
| 8 | Cobro contra entrega en la caja de reparto | Fin RF01, RN28 | Cubierto |
| 9 | Ciclo de facturación y lista de remitos pendientes | Cli RF21; Ven RF20 | Cubierto |
| 10 | Factura agrupada de los remitos, sin duplicar la deuda | Cli RF05, RN10; Ven RF27, RN31, EX36, RF17, RF47 | Cubierto |
| 11 | Contabilización del remito y de la factura agrupada | Con RF24, RF03, RF11, RN11, RN35, EX22 (Remito a facturar y Factura de remitos); Ven RN73, RN58; Cli RN22 | Cubierto (ver R8, R9) |
| 12 | Devolución o NC sobre mercadería ya incluida en la factura agrupada | Ven RF15, RF27, RN74; Cli RN09, RN10 | Cubierto |
| 13 | Recibo con cheque y retenciones sufridas, e imputación | Cli RF06, RF07, RF08; Fin RF07 | Cubierto |
| 14 | Depósito del cheque y plazo de presentación | Fin RF07, RN10, EX09 | Cubierto |
| 15 | Cheque rechazado: evento y nota de débito | Fin RF08, RN11; Cli RN14, RF09 | Cubierto |
| 16 | Reapertura de la deuda, mora y bloqueo | Cli RF10, RF13, RN33 | Cubierto |
| 17 | Estado de cuenta, antigüedad y proyección de cobros | Cli RF14, RF15; Fin RF13 | Cubierto |
| 18 | Contabilización de recibos, retenciones y notas | Con sección 2 (Clientes y CC), RF03, RF11 | Cubierto |

### E7. Café en grano online con diferencia de peso y reintegro

| # | Paso | Regla que lo cubre | Estado |
|---|---|---|---|
| 1 | Publicación como pesable con rango y presentación estimada | Onl RF27, RN11, RN51(a); Ven RN04 | Cubierto |
| 2 | Reserva por el peso estimado antes del cobro | Onl RF09, RN07; Stk RF15, RN22 | Cubierto |
| 3 | Pago por pasarela | Onl RF10, RN09 | Cubierto |
| 4 | Pedido a Ventas con pesaje pendiente; el cobro lo registra Ventas | Ven RF25, RN60 | Cubierto |
| 5 | Pesaje real con las reglas de balanza | Onl RF29, RN51(b); Ven RN04, EX55 | Cubierto |
| 6 | Diferencia a favor del cliente: reintegro de la diferencia | Ven RN68(2); Onl RN51(d) | Cubierto |
| 7 | Diferencia mayor que la tolerancia: aceptación expresa (2 horas) o ajuste al máximo | Onl RN51(f), EX34; Ven RN68(2), EX51 | Cubierto |
| 8 | Factura después del pesaje | Onl RF14; Ven RN68(1) | Cubierto |
| 9 | Nota de crédito primero y reintegro después | Onl RN52; Ven RN68(3), RF15, EX35 | Cubierto |
| 10 | Reintegro rechazado por la pasarela | Onl EX11; Ven EX52, RN68(4) | Cubierto |
| 11 | Descuento del peso real y ajuste de la reserva | Onl RN51(j); Stk RN52 | Cubierto |
| 12 | Lote por FEFO en el ítem del pedido | Onl RN39, Pedido_Item.ID_Lote | Cubierto |
| 13 | Contramovimiento en Financiero solo después de la devolución de Ventas | Fin RN33, RN40, EX28 | Cubierto |
| 14 | Estado de alineación cobrado, reintegrado y facturado | Ven RN67; Onl RN50, EX36 | Cubierto |
| 15 | Contabilización: nota de crédito y reintegro | Con RN32, RN20 | Cubierto |

### E8. Pedido de delivery por plataforma con comisión y liquidación

| # | Paso | Regla que lo cubre | Estado |
|---|---|---|---|
| 1 | Conector con artículos publicados y lista propia de la plataforma | Onl RF18, RN25; Ven RN32(1) | Cubierto |
| 2 | Disponibilidad, pausa y desconexión | Onl RN26, RN04, EX15 | Cubierto |
| 3 | Descarga del pedido con ID externo único | Onl RF19, RN27; Ven RN30, RF25 | Cubierto |
| 4 | Aceptación y estados hacia la plataforma | Onl RF19, RN27 (alerta a los 2 minutos) | Cubierto |
| 5 | Comanda a cocina o KDS con hora comprometida | Ven RF25, RF07; Onl RF25 | Cubierto |
| 6 | Artículo no vinculado | Onl EX16; Ven EX21 | Cubierto |
| 7 | Cobro registrado por Ventas con "Cobro por plataforma" | Ven RF09, RN60; Fin RF02, RN26 | Cubierto |
| 8 | Factura como consumidor final | Onl RN27; Ven RF17 | Cubierto |
| 9 | Descuento de stock (sin reserva previa) y faltante al preparar | Ven RF25, RN06; Onl EX04 | Cubierto |
| 10 | Comisión por porcentaje o por el importe informado | Onl RN28; Fin RF24, RN26 | Cubierto |
| 11 | Liquidación y conciliación contra los pedidos entregados | Fin RF24, RF06, EX18; Onl Liquidacion_Online | Cubierto |
| 12 | Comprobante del tercero por la comisión: IVA crédito y no duplicar el gasto | Fin RF24, RN44, EX33 (comprobante del tercero y "Gasto con comprobante fiscal" por el neto y el IVA, sin segundo gasto); Con RF19, RN37, EX23; Cmp RF13, RF15 | Cubierto |
| 13 | Cancelación por la plataforma | Onl EX17 | Cubierto |
| 14 | Contabilización de la venta, la comisión y el cobro | Con RF19, RN24 | Cubierto |

### E9. Compra de insumos por bolsa de 25 kg con presentación y lote en la recepción

| # | Paso | Regla que lo cubre | Estado |
|---|---|---|---|
| 1 | Presentación "bolsa 25 kg" con factor a la unidad base | Stk RF02, RN61, EX17 | Cubierto |
| 2 | Equivalencia del código del proveedor | Usu RF16, RN20; Cmp RF10 | Cubierto |
| 3 | Lista de precios y CR por unidad base | Cmp RF10, RF11, RN05, RN23 | Cubierto |
| 4 | Pedido al proveedor | Cmp RF12, RF18 | Cubierto |
| 5 | Pesaje en la recepción y tolerancia | Cmp RN24, EX06 | Cubierto |
| 6 | Lote y vencimiento por línea, con vencimiento posterior a la recepción | Cmp RF19, RN25, EX14, EX15; Stk RF04, RN28, EX18 | Cubierto |
| 7 | Lote cuando CMP-RECEPCION-LOTES está inactiva (perfil Cafetería) | Cmp RF19, RN39 (el ingreso generado queda "Pendiente de lote"); Stk RN84, RN28, EX18, EX63; Idx A.2 | Cubierto |
| 8 | Carga única vinculada a la factura | Stk RN07, RN09; Cmp RF03, RF04, RN03 | Cubierto |
| 9 | Costo de inventario y costo de reposición | Stk RF17, RN08, RN16, RN17; Cmp RF11 | Cubierto |
| 10 | Alérgenos del insumo | Stk RF22 | Cubierto |
| 11 | Factura por foto o QR, y control contra ARCA | Cmp RF03, RF14; Stk RF05, EX03 | Cubierto |
| 12 | Libro IVA y contabilización de la compra | Cmp RF13, RN04, RN12; Con RF03, RN11 | Cubierto |
| 13 | Mercadería rechazada o vencida: devolución al proveedor y nota de crédito | Cmp RF25, RN38, EX06, EX15, EX24; Stk RF40, RN80, EX58 | Cubierto (ver R1) |
| 14 | Orden de pago | Cmp RF06; Fin RF17 | Cubierto |

### E10. Cierre de turno con diferencia, reapertura con supervisor y contabilización

| # | Paso | Regla que lo cubre | Estado |
|---|---|---|---|
| 1 | Apertura con fondo de cambio | Fin RF03, RN28 | Cubierto |
| 2 | Los cobros de Ventas llegan al turno por mensaje | Fin RF02, RF17, RF27; Ven RN58 | Cubierto |
| 3 | Arqueo parcial y retiro a caja fuerte | Fin RF03, RF04, RF05 | Cubierto |
| 4 | Cierre con conteo por forma de pago (ciego opcional) | Fin RF04, RN06 | Cubierto |
| 5 | Diferencia: motivo y supervisor fuera de tolerancia | Fin RN05, EX03 | Cubierto |
| 6 | Evento "Cierre de turno" y contabilización de la diferencia | Fin RF04, RF17; Con RF03, RF01 (Diferencias de caja) | Cubierto |
| 7 | Cierre con cobros de Ventas aún Pendientes, Retenidos o Rechazados | Fin RF04, RF28, RN41, EX29 | Cubierto |
| 8 | Reapertura con motivo y autorización de otro usuario | Fin RF18, RN07, EX14; Usu RF05, RN08 | Cubierto |
| 9 | Antigüedad del turno que se puede reabrir | Fin RN07, RN43, EX32 (Antiguedad_Maxima_Reapertura, 7 días); Idx Para confirmar 2 | Cubierto |
| 10 | Movimientos en el turno reabierto con fecha real | Fin RF18 | Cubierto |
| 11 | Nuevo cierre: recálculo y compensación del faltante o sobrante anterior | Fin RF18, RN02 | Cubierto |
| 12 | Cobro confirmado después del cierre: a qué turno va | Fin RF27, RN31, RN41, EX30 | Cubierto |
| 13 | Ajustes hacia adelante en Contable, sin recontabilizar | Fin RN20; Con RF21, RN20, EX14 | Cubierto |
| 14 | Auditoría de cierre, reapertura y autorizante | Fin RF18; Usu RF08 | Cubierto |

### E11. Tablero de margen con costos de distinto origen

| # | Paso | Regla que lo cubre | Estado |
|---|---|---|---|
| 1 | Costo por línea con su origen y fecha | Ven RN62(c), Costo_Aplicado, Origen_Costo | Cubierto |
| 2 | CV desde el movimiento de Stock (CI o CP) | Stk RN63, RF17 | Cubierto |
| 3 | Venta pendiente de costo | Ven EX47, RF20 | Cubierto |
| 4 | Sin Stock: CR vigente congelado en la línea | Ven RN62; Cmp RF21, RN27 | Cubierto |
| 5 | Sin ningún costo: margen parcial | Ven RF45, EX47 | Cubierto |
| 6 | Costo provisorio de un ingreso sin precio | Stk RN08, RN63 envían la marca; Ven RN75, Pedido_Item.Costo_Provisorio, EX47; Idx C.3 regla 3 | Cubierto |
| 7 | Combo: suma de los CV | Ven RN62, RN69 | Cubierto |
| 8 | Costo en moneda extranjera | Ven RN62(e); Stk RN18 | Cubierto |
| 9 | Un solo indicador de margen por producto | Ven RF45, RN75; Stk RF24, RF33, RN76; Usu RF19; Cmp RF21, RF22; Idx C.4 ("Margen realizado" y "Margen teórico de receta") | Cubierto (ver R13) |
| 10 | Mezcla de orígenes en el mismo producto y período | Ven RF45, RN62(c), RN75 (margen "parcial" también con costo provisorio u orígenes mezclados; se marca, no se corrige) | Cubierto |
| 11 | Costo de ventas contable igual al CV, no al CR | Con RF20, RN25 | Cubierto |
| 12 | Permisos y alcance de la consulta de costos | Stk RN21, RN47; Usu RF19, RN34 | Cubierto |

### E12. Consolidación de sucursales con una sucursal sin conexión

| # | Paso | Regla que lo cubre | Estado |
|---|---|---|---|
| 1 | Marcar Casa Central y sucursales | Usu RF20, RN38 | Cubierto |
| 2 | Cada módulo publica su paquete | Ven RF46, RN48; Stk RF34; Fin RF26; Con RF22 | Cubierto |
| 3 | La sucursal sigue operando sin internet | Usu RN01; Ven RF18 | Cubierto |
| 4 | El paquete queda en cola o se exporta como archivo firmado | Usu RF20, EX24; Ven EX35; Stk EX33 | Cubierto |
| 5 | Importación idempotente y con firma válida | Usu RN39, RN40, EX20, EX21 | Cubierto |
| 6 | Paquete faltante a las 48 horas: alerta | Usu RN42, EX23 | Cubierto |
| 7 | Informes con el período marcado "Incompleto" | Usu RF20, EX23; Con EX16 | Cubierto |
| 8 | Llegada tardía: la versión mayor reemplaza; provisorio y definitivo | Usu RN40; Con RF22, RN26 | Cubierto |
| 9 | Módulos que no consolidan (por diseño) | Cli RN18; Onl RN41; Usu RN41 | Cubierto |
| 10 | Casa Central sin el módulo del paquete | Usu EX25 | Cubierto |

### E13. Tienda de ropa con variantes talla y color, y devolución (rubro retail)

| # | Paso | Regla que lo cubre | Estado |
|---|---|---|---|
| 1 | Alta del artículo con variantes de talla y color | Ven RF01, RN03, RN02; Variante, Codigo_Articulo | Cubierto |
| 2 | Puesta en marcha con perfil Personalizado y funciones del café desactivadas | Usu RF18, RN29; Idx A.2 | Cubierto |
| 3 | Listas y promociones por categoría o temporada | Ven RF34, RF36 | Cubierto |
| 4 | Compra y stock por variante, con reposición | Cmp RF03; Stk RN03, RF01, RF29 | Cubierto |
| 5 | Etiquetas de góndola con precio | Stk RF27, RN40 | Cubierto |
| 6 | Venta en el POS por variante y código de barras | Ven RN03, RF02 | Cubierto |
| 7 | Venta online con selector de talle y color | Onl RF02, RN03 | Cubierto |
| 8 | Devolución con nota de crédito y reingreso de la variante | Ven RF15; Stk RF08 | Cubierto |
| 9 | Cambio de talle o color | Ven RF50, RF15, RN34, RN64 (devolución con cambio: nota de crédito y nueva venta en un solo cobro neto, sin CLI-FIDEL) | Cubierto (ver R3) |
| 10 | Crédito de tienda (vale por devolución) | Ven RF49, RN76, RN58; Cli RF23, RF29, RN31 (requiere CLI-FIDEL) | Cubierto |
| 11 | Arrepentimiento online | Onl RN15 | Cubierto |
| 12 | Contabilización y control de mercaderías | Con RF01 (plantilla Personalizado), RF03, RF11 | Cubierto |
| 13 | Tablero de ventas | Ven RF45 | Cubierto |

### E14. Venta de un equipo serializado con garantía y devolución (rubro retail)

| # | Paso | Regla que lo cubre | Estado |
|---|---|---|---|
| 1 | Activar VEN-SERIE y STK-SERIE | Usu RN25; Ven RF33; Stk RN71 | Cubierto |
| 2 | Alta del artículo Serializado | Ven RF01, RF33 | Cubierto |
| 3 | Compra e ingreso con series | Cmp RF24, RN37, EX23; Stk RF06, EX06 | Cubierto |
| 4 | Venta con serie obligatoria y validada | Ven RN05, EX33; Stk RN05, RF36 | Cubierto |
| 5 | Venta online con serie asignada al preparar | Onl RN12, RF12 | Cubierto |
| 6 | Garantía: plazo, vencimiento, certificado y reclamo | Ven RF33, RN79 (Plazo_Garantia_Dias, Fecha_Fin_Garantia, advertencia en la devolución); Stk RF41, RN79 | Cubierto en plazo y vencimiento; el certificado y el trámite del reclamo no se modelan (no eran parte de G16) |
| 7 | Consulta de la venta y del cliente a partir de la serie | Ven RF20 (filtro por serie y por garantía), RN79; Stk RF41, RF18 | Cubierto |
| 8 | Devolución: la serie vuelve a Disponible o pasa a Baja | Ven RN05, RN79(3), RF15; Stk RF08, RN05, RN79, EX60 | Cubierto |
| 9 | Nota de crédito y reintegro | Ven RF15, RF47 | Cubierto |
| 10 | Baja de la serie | Stk RF37, RN05 | Cubierto |
| 11 | Costo y margen del equipo | Ven RN62; Stk RN17, RN63 | Cubierto |
| 12 | Contabilización | Con RF03, RF20 | Cubierto |

---

## Parte 3. Brechas y contradicciones

Severidad: Alta (riesgo de inocuidad, de dato contable incorrecto o de contradicción directa), Media (un flujo queda sin regla o ambiguo), Baja (precisión o consistencia).

| # | Sev | Dónde ocurre | Qué falta o qué reglas se contradicen | Corrección mínima |
|---|---|---|---|---|
| G1 | Alta | Matriz filas 9, 10, 12, 14 (F10); E1 paso 5; E2 paso 6 | Ven RN42 y RF31 definen los alérgenos solo del "artículo elaborado" (declarados más derivados por receta). La entidad Opcion_Modificador de Ventas no tiene alérgenos. Stk RF31 e Item_Alergeno (Origen "Opción de modificador") los suman solo con STK-ALERGENOS y no dicen cómo llegan a la línea, la comanda y el ticket. Onl RN32 limita la tienda a "declarados en Ventas o derivados por receta; nunca los infiere" y excluye las opciones. Combos, kits y porciones no tienen regla de unión ni de herencia. Un café con leche de soja no mostraría soja. | Ven RN42: los alérgenos de una línea son la unión de los del artículo, los de las opciones elegidas (campo Alergenos_Declarados en Opcion_Modificador; con STK-ALERGENOS, los del insumo sustituto) y, en combos, kits y porciones, los de sus componentes u origen. Onl RN32 remite a esa regla. Stk RF22 expone el cálculo por línea. |
| G2 | Alta | Matriz filas 4 y 13 (F10); E5 paso 5; E6 paso 7 | Stk RN31 ("por FEFO si el usuario no lo indica") y Stk RF19 (validación de lotes para Ventas) suponen que el usuario puede indicar el lote, pero Ventas no tiene campo ni regla para hacerlo (Pedido_Item no tiene lote; solo Compromiso_Venta.Lote opcional y Onl Pedido_Item.ID_Lote). El código de barras de la etiqueta propia (Ven RN71) tampoco lleva lote. El alcance de un retiro (Stk RF21) refleja el lote que eligió FEFO, no necesariamente el entregado, justo en remitos mayoristas y piezas etiquetadas. | Ven RF08, RF12 y Pedido_Item: Lote_Indicado opcional (por selección o lectura de etiqueta), enviado en el mensaje de descuento (RN06). Stk RF07 y RN31: usar el lote indicado si está disponible y registrar "indicado" o "asignado por FEFO". Stk RF21: marcar en el alcance los lotes asignados por FEFO como "no confirmados". |
| G3 | Alta | Matriz fila 8 (F11); E4 paso 13 | Contradicción. Stk RN15 y RN36 prorratean la merma de cocción y la diferencia de rendimiento en el costo unitario del terminado, que ingresa por el costo total (RF11). Con RF20 manda "merma de cocción u horneado, diferencia entre rendimiento teórico y real" a la cuenta de resultado "Mermas de producción y de vitrina", y Con RN25 pide no mezclarla con el costo de ventas. Stock no publica un movimiento valorizado de esa merma: o se cuenta dos veces (terminado a costo total más resultado) o Contable espera un evento que no existe. | Con RF20: la merma de cocción y el desvío dentro de tolerancia quedan en el costo del producto terminado, sin asiento a resultado; solo el desperdicio, los vencimientos y el desvío fuera de tolerancia (Stk RN35, EX23) van a "Mermas". Stk RF11 y RN36: publicar como movimiento de merma el desvío que no se capitaliza. |
| G4 | Media | Matriz fila 13 (F6); E2 paso 8 | Stk RF08 reingresa "en el depósito indicado, al costo original" pero no dice a qué lote vuelve; Stk RN28 y EX18 rechazan el ingreso de un ítem con lote sin lote. Ven RF15 y Stk RF08 dicen "registrar una merma" sin definir si es ingreso más egreso (para revertir el CV y cargar la merma, Con RN25), ni qué pasa si el lote está bloqueado por un retiro (Stk RN32). | Stk RF08: el reingreso conserva el lote del movimiento original; si está bloqueado o vencido solo admite merma. "Merma por devolución" = ingreso al costo original más egreso por motivo "Devolución a merma". |
| G5 | Media | Matriz fila 11 (F5); modalidades para llevar, delivery y retiro | Ven RF05 registra la modalidad, pero el mensaje de descuento solo lleva "artículo, cantidad, variante y modificadores" (Ven RN06, RN69) y Stk RF07 expande por receta y modificadores. No hay regla para consumir vaso, tapa, bolsa o caja según la modalidad, aunque Con RF01 prevé "Costo de ventas - packaging". | Stk RF31: mapeo Modalidad a insumo de envase por artículo o categoría. Ven RN06 y RN69: incluir la modalidad del pedido en el mensaje de descuento. Stk RN63: el envase integra el CV. |
| G6 | Media | E10 pasos 7 y 12 | Fin RF04 y RN05 calculan la diferencia contra el teórico, pero los cobros llegan por mensajes (Ven RN58, Fin RF27) que pueden estar Pendientes, Retenidos o Rechazados. No hay regla como la de Stk EX51 (toma bloqueada por mensajes pendientes) ni se dice a qué turno va un cobro confirmado después del cierre (Fin EX13 solo cubre anulaciones). Se genera un sobrante o faltante falso. | Fin RF04: antes de cerrar, listar los cobros del turno con integración pendiente (Ven RF20 "integración pendiente") y exigir resolverlos o confirmar con motivo. Fin RF27 y RN31: un cobro confirmado tras el cierre se registra en el turno reabierto o como ajuste del turno actual (RN20). |
| G7 | Media | E6 paso 5 | Ven RF16 y RN27 y Cli RF12, RN04 y RF26 aplican veredicto y reserva a la "venta cobrada con Cuenta Corriente". El remito asignado a la cuenta (Ven RF12; Cli RF05, RF19, Movimiento_CC tipo Remito) suma al saldo desde la entrega (Cli RN22), pero ninguna regla dice que pida veredicto o reserva: un cliente bloqueado o sobre el límite podría recibir remitos. | Ven RF12 y RN27, Cli RF05 y RN04: asignar un remito a la cuenta pide veredicto y reserva de crédito como una venta a cuenta (con la contingencia de RF27 y EX22). |
| G8 | Media | E6 paso 11 | Contable no menciona "remito" ni "facturación agrupada" (búsqueda sin resultados). Con RN11 reconoce la venta "al emitirse el comprobante" y su sección 2 cita "facturas y tickets facturados". Cli RN22 y RN10 suman el remito al saldo desde la entrega y lo reemplazan por la factura. El control cruzado "Deudores por ventas" (Con RF11) mostrará diferencias, el costo (descuento de stock en el remito) precede a la venta contable y no se sabe si el remito genera evento de venta. | Con RF03 y RN11: formulario "Remito a facturar" (debe Deudores por ventas, haber transitorio "Remitos a facturar"); la factura agrupada lo cancela y reconoce venta e IVA; RF11 incluye ese transitorio. Ven RN58: aclarar qué evento publica el remito. |
| G9 | Baja | E6 paso 12 | La factura agrupada la emite Ventas a pedido de Clientes (RF27, RF17) y referencia remitos (RN31), pero Ven RF15 genera la nota de crédito por venta y no dice que referencie la factura agrupada ni qué estado toma el remito. Cli RN09 solo exige referenciar el comprobante corregido. | Ven RF15 y RF27: la NC parcial de un remito facturado referencia la factura agrupada. Cli RN10: la NC reduce el saldo de la factura sin reabrir el remito. |
| G10 | Media | Matriz fila 1 (F12); E11 pasos 6, 9 y 10 | Cuatro definiciones de "margen por producto": Ven RF45 (realizado con CV, "margen parcial"), Stk RF24 y RF33 (con CP o con Compras), Usu RF19 (Compras o Stock) y Cmp RF21 y RF22 (el CR solo rige sin Stock). Stk RF33 admite [Requiere: Compras] aunque Cmp RF21 dice que con Stock rige el CV. Stk RN63 entrega la marca de costo provisorio (RN08) y Ventas no la guarda (Pedido_Item no la tiene); Idx Anexo C.3 regla 3 impide corregir el CV congelado; tampoco se marca el producto que mezcla orígenes en el período. | Usu RF19 e Idx Anexo C: dos indicadores con nombre propio, "Margen realizado" (Ven RF45, CV) y "Margen teórico de receta" (Stk RF24, RF33, CP); quitar [Requiere: Compras] de Stk RF33. Ven Pedido_Item: marca Costo_Provisorio; Ven RF45: "margen parcial" también con costo provisorio u orígenes mezclados (se marca, no se corrige). |
| G11 | Media | Matriz fila 1 (F6); E2 pasos 9 y 10; E13 paso 10 | Ven RF15 define nota de crédito, reingreso y "contramovimiento del cobro", pero no la forma de devolver el dinero (efectivo, reverso de tarjeta, transferencia, vale), ni cómo se reparte un pago mixto original. Cli RF23 y RN31 suponen que Ventas ofrece "crédito en lugar de reintegro" y que el vale "se genera desde una devolución registrada en Ventas", pero RF15 y la lista de efectos de Ven RN58 no incluyen ese mensaje. Fin RN08 y EX04 bloquean egresos que dejen la caja en negativo, sin excepción para devoluciones. | Ven RF15: elegir al devolver la forma de reintegro (misma forma de pago, otra, o vale con CLI-FIDEL) y sumar a RN58 el mensaje "emisión de vale por devolución" hacia Cli. Fin RN08: excepción con autorización de supervisor para devoluciones en efectivo. |
| G12 | Media | Fuera de las 14 filas (gift card) | Cli RF23: la gift card "se vende en Ventas como ítem por un importe fijo o libre". Ven RF01 no tiene ese tipo de artículo ni precio libre, y RN58 no incluye el mensaje de emisión del instrumento que Cli RN29 y Con RF17 esperan. Ventas no marca que la línea no es ingreso (alícuota). | Ven RF01: tipo "Gift card" [Requiere: CLI-FIDEL], con precio fijo o libre, sin alícuota ni stock, que al cerrar envía a Cli el mensaje de emisión. |
| G13 | Baja | E1 paso 10 | (Retirado: el sistema ya no maneja propinas.) | — |
| G14 | Media | Matriz fila 12 (F6, F8, F9, F10); E2 pasos 3, 6 y 8 | (a) Stk RF08 prevé solo "reintegrar insumos o merma" para elaborados: no define devolver una porción. (b) Stk RF11 y RN15 dan costo a Producción y Armado, no a Fraccionamiento (RF30). (c) RF30 no dice si las porciones heredan lote y vencimiento (RN30 solo habla de órdenes de producción) y Stk RN04 (decimales solo en kg, litro, metro) choca con "1/8 de la pieza" si la unidad es la pieza. (d) Ven RN42 solo cubre el "elaborado": la porción no hereda alérgenos. | Stk RF30: la orden de fraccionamiento crea lotes de porciones con el lote y vencimiento del origen y costo igual a pieza dividida por porciones; el descuento proporcional usa la unidad base "porción" (factor de la presentación). Stk RF08: devolución de porción = merma. Ven RN42: la porción hereda los alérgenos del origen. |
| G15 | Baja | Matriz fila 6 (F8) | Ven RN62 y EX47: todo ítem sin costo queda "Sin costo", dispara la alerta de comisión y marca "margen parcial". Un servicio no tiene CR, CI ni CP, así que cada venta lo dispara. Articulo no tiene costo manual ni marca "sin costo por diseño". | Ven RF01 y RN62: marca "Sin costo asociado" por tipo Servicio (o costo manual opcional) para excluirlo de la alerta y del margen parcial. |
| G16 | Media | Matriz fila 5 (F6, F7, F9, F10); E14 pasos 3, 6, 7 y 8 | (a) Garantía: ningún SPEC la define (solo aparece "garantías de idempotencia"). (b) Ven RF20 filtra por artículo y categoría, no por número de serie. (c) Cmp RF04 genera el ingreso sin series y Cmp RF19 solo captura lotes, mientras Stk RF04 y EX06 exigen series. (d) Stk RF14 y Conteo_Linea no tienen nivel serie. (e) Stk RN05: la devolución va a "Disponible o Baja" sin criterio. | Ven RF33: Plazo_Garantia_Dias en el artículo, fecha de fin en la venta y filtro por serie en RF20. Stk RF26: historial por serie (compra, venta, cliente, devolución). Cmp RF04: capturar series al generar el ingreso. Stk RF14: conteo por serie. Stk RF08: criterio (sin uso, Disponible; con falla, Baja con motivo). |
| G17 | Media | Matriz fila 13 (F7); E5 paso 12; E9 paso 13 | Cmp EX15 sugiere "rechazar la mercadería y reclamar al proveedor" y EX06 espera una "nota de crédito del proveedor", pero ninguna regla define el egreso físico de lo devuelto ni su vínculo con la NC (Stk RF06 vincula ingresos con facturas, no egresos con notas). El costo (CI y CR) queda sin ajuste. | Stk RF12: motivo "Devolución a proveedor" que referencia el ingreso y lote originales y publica un evento a Compras. Cmp RF03: la NC de mercadería se vincula a ese egreso (como RF04) y ajusta el CR. Stk RN17: se revierte la capa o el costo. |
| G18 | Media | E8 paso 12 | Fin Liquidacion.IVA_Comisiones (RF06, RF24) y Con RF19 (gasto contra "Plataformas a cobrar") no dicen si el IVA crédito de la comisión llega al Libro IVA Compras: Cmp RF13 y RF15 solo toman comprobantes cargados o el evento "Gasto con comprobante fiscal" (Fin RF10). Si además se carga la factura del tercero como gasto, la comisión se duplica. | Fin RF24: al conciliar la liquidación, adjuntar el comprobante del tercero y publicar "Gasto con comprobante fiscal" por el neto y el IVA de la comisión, sin segundo gasto. Con RF19: línea de IVA crédito fiscal. |
| G19 | Baja | Matriz fila 2 (F6); E13 paso 9 | No existe el cambio de mercadería: solo devolución con nota de crédito y nueva venta; el crédito de tienda exige CLI-FIDEL (Cli RF23). | Ven RF15: "devolución con cambio": NC del ítem devuelto y nueva venta en un solo cobro neto, sin requerir CLI-FIDEL. |
| G20 | Media | Matriz fila 9 (F4); E3 paso 12 | Onl RF27 publica packs "como artículos compuestos o como combo a precio cerrado". Stk RF15, RN22 y RN54 reservan solo ítems con stock y la expansión de combos (Stk RF09, RN64) está definida para descuento y compromiso, no para reserva. Onl RN03 y RN38 no definen la disponibilidad de un combo sin stock propio. | Stk RF15 y RN22: la reserva de un combo virtual se expande a sus componentes (todo o nada). Onl RN03 y RN38: disponibilidad del combo = mínimo de sus componentes. |
| G21 | Baja | Matriz fila 13 (F7); E9 paso 7 | Stk RF20 dice que en el perfil "Cafetería" STK-LOTES "lo define el perfil", pero Idx A.2 no lo lista (queda Sí). Con CMP-RECEPCION-LOTES en No (Cafetería), Cmp RF19 no dice qué pasa con un ítem con lote cuando Compras genera el ingreso, que Stk RN28 y EX18 rechazan. | Idx A.2: agregar STK-LOTES. Cmp RF19: con CMP-RECEPCION-LOTES inactiva, el ingreso generado queda "Pendiente de lote" hasta completarlo en Stock. |
| G22 | Baja | Matriz fila 10 (F1) | Ven RF01, RN69 y Articulo declaran el kit armado [Requiere: Stock]; Stk RF09 y RN65 e Idx Para confirmar 17 exigen STK-PRODUCCION. | Ven RF01, RN69 y Articulo: [Requiere: Stock + función STK-PRODUCCION]. |
| G23 | Baja | Matriz fila 4 (F1) | Ven RN71 exige una etiqueta emitida con STK-ETIQUETAS con "prefijo propio y dígito verificador válido", pero Stk RF27 solo habla de "códigos de peso-precio" y Plantilla_Etiqueta no define prefijo ni verificador. Articulo no indica que el ítem se vende con etiqueta propia. Si la etiqueta lleva importe, no se dice si prevalece sobre la lista (Ven RN17, RN32) tras un cambio de precio (Stk RN40 solo cubre góndola). | Stk RF27: prefijo propio de la instancia y algoritmo del verificador. Ven RN71: el importe embebido se contrasta con el precio vigente; si difiere se rechaza o pide confirmación. |
| G24 | Media | E5 paso 7 | Contradicción. Cli sección 2 y RF19 dicen que implementa el "puerto de contacto de clientes alcanzados por un retiro de lote que define Stock". Stk sección 2 dice que usa el ID_Cliente del mensaje de venta y que "Stock no consulta a Clientes y CC"; ni Stk RF19 ni Idx B.2 listan ese puerto. | Definir el puerto en Idx B.2 y Stk RF19, o (más simple) que Cli RF19 llame hacia abajo a Stock (N3 a N2) por el alcance del retiro y complete el contacto. |
| G25 | Baja | E5 paso 11 | Retiro_Lote_Alcance guarda lo vendido pero no el aviso al cliente, la cantidad recuperada ni su destino; Stk EX21 solo informa cantidades en stock, vendidas, consumidas y mermadas. | Stk RF21: estado por línea de alcance (Pendiente de aviso, Avisado, Recuperado) y recepción del producto devuelto como merma del lote bloqueado. |
| G26 | Media | Matriz fila 9 (F2); E3 pasos 3, 4 y 8 | Ven RN70 deja la promoción tipo combo a RN34 ("cada ítem conserva su precio y su descuento"), pero Promocion_Aplicada guarda un Importe por venta y Pedido_Item un solo ID_Promocion_Aplicada: no hay descuento por ítem para devolver una parte. Tampoco se define si una promoción sobre un combo virtual (RN33, "mismo ítem") se aplica antes o después del prorrateo de RN70. | Ven RN33 y RN70: prorratear el descuento de cada promoción entre las líneas alcanzadas y guardarlo por línea (Importe_Descuento); el prorrateo de RN70 se hace sobre el precio ya descontado. |
| G27 | Baja | E10 paso 9 | Idx Para confirmar 2 deja abierta la antigüedad máxima para reabrir un turno; Fin RN07 solo exige que la caja no tenga otro turno abierto. | Fin RN07: parámetro Antiguedad_Maxima_Reapertura; fuera del tope, ajuste en el turno actual (última frase de RN07). |

### Estado de las brechas

Verificación hecha leyendo los SPECS vigentes (no los reportes de los agentes) y comparándolos con las copias previas `*.pre-correcciones3.md`. Para cada G se comprobó que (a) la regla existe, (b) usa los mismos nombres de campos, eventos y mensajes en todos los módulos que la mencionan y (c) no queda la contradicción original. Estados: CERRADA, PARCIAL, ABIERTA. "Obs." remite a la Parte 3B.

| G | Estado | Referencias de cierre | Obs. |
|---|---|---|---|
| G1 | CERRADA | Ven RF30, RF31, RN42, Opcion_Modificador.Alergenos_Declarados, Alergenos_Linea; Stk RF22, RF31, RF39, RN77, EX22, EX62; Onl RN32, EX37 | R4, R5, R6 |
| G2 | CERRADA | Ven RF08, RF12, RF48, RN06, RN80, EX57, Pedido_Item.Lote_Indicado y Origen_Lote; Stk RF07, RF20, RF21, RF36, RN06, RN31, RN32, RN73, EX55 | R13, R15 |
| G3 | CERRADA | Stk RF11, RF12, RF23, RN15, RN35, RN36, RN72, EX23; Con RF20, RN25; Idx B.3 ("Merma de producción") | R1 |
| G4 | CERRADA | Stk RF08, RN28, RN74, EX18, EX56; Ven RF15 | R1 |
| G5 | CERRADA | Ven RF08, RN06, RN69, RN72; Stk RF07, RF38, RN63, RN75, EX57, Mapeo_Envase | |
| G6 | CERRADA | Fin RF04, RF27, RF28, RN31, RN41, EX29, EX30; Ven RF20 (filtro "integración pendiente"), RN58 | |
| G7 | CERRADA | Ven RF12, RN27, RN73, EX22; Cli RF05, RF12, RF26, RF27, RN41, EX29 | |
| G8 | CERRADA | Con RF03, RF11, RF24, RN11, RN35, EX22, Asiento_Origen; Ven RN58, RN73; Cli RN41; Idx B.3 ("Remito emitido") | R8, R9 |
| G9 | CERRADA | Ven RF15, RF27, RN74; Cli RN10, Movimiento_CC.ID_Movimiento_Referenciado; Con RF24 | |
| G10 | CERRADA | Idx C.4; Ven RF45, RN62(c), RN75, Pedido_Item.Costo_Provisorio; Stk RF24, RF33, RN63, RN76; Usu RF19, Entidad Indicador; Cmp RF22, RN27 | R13 |
| G11 | CERRADA | Ven RF15, RF49, RN58, RN76, EX58; Cli RF23, RF29, RN31, EX30; Fin RN08, RN42, EX04, EX31 | R7, R13 |
| G12 | CERRADA | Ven RF01, RF51, RN16, RN58, RN77, EX59, Articulo; Cli RF23, RF29, RN29, EX30, EX31; Con RF17, RF25, RN36 | R2, R7, R16 |
| G13 | CERRADA | (Retirado: sin propinas) | |
| G14 | CERRADA | Stk RF08, RF30, RN04, RN28, RN44, RN74, RN78; Ven RN42(c) | |
| G15 | CERRADA | Ven RF01, RF45, RN62, RN78, EX47, Articulo.Sin_Costo_Asociado | R13 |
| G16 | CERRADA | Ven RF15, RF20, RF33, RN79, Pedido_Item.Fecha_Fin_Garantia; Stk RF14, RF26, RF41, RN05, RN79, EX60; Cmp RF24, RN37, EX23. Certificado y trámite del reclamo no se modelan (no eran parte de G16) | R7 |
| G17 | CERRADA | Stk RF12, RF40, RN17, RN80, EX58; Cmp RF03, RF25, RN33, RN38, EX06, EX15, EX24; Idx B.3 | R1, R7 |
| G18 | CERRADA | Fin RF24, RN44, EX33; Con RF19, RN37, EX23; Cmp RF15 | R12 |
| G19 | CERRADA | Ven RF15, RF50, Devolucion.Tipo e ID_Venta_Cambio, Forma_Pago "Compensación por cambio" | R3 |
| G20 | CERRADA | Stk RF15, RN22, RN81; Onl RF27, RN03, RN38, RN53, EX38 | |
| G21 | CERRADA | Cmp RF19, RN39, Vinculo_Ingreso; Stk RN28, RN84, EX18, EX63; Idx A.2 ("activas en los cuatro perfiles") | R11 |
| G22 | CERRADA | Ven RF01, RN69, Articulo; Stk RF09, RF11, RN65; Onl RF27, RN53; Idx Para confirmar 17 | |
| G23 | CERRADA | Stk RF27, RN40, RN82, EX59, Configuracion_Stock; Ven RN71, EX56 | R14 |
| G24 | CERRADA | Stk sección 2, RF19, RF21, RF42, RN57, RN83; Cli secciones 1 y 2, RF19, RF30, RN38, EX32; Idx B.3b. Ya no queda ningún "puerto" de contacto en Cli ni en Stk | R10 |
| G25 | CERRADA | Stk RF21, RF42, RN83, EX21, EX61, Retiro_Lote_Alcance | R10 |
| G26 | CERRADA | Ven RF36, RN33, RN34, RN70, Promocion_Aplicada_Linea, Pedido_Item.Importe_Descuento | |
| G27 | CERRADA | Fin RF18, RN07, RN43, EX32, Configuracion_Financiero; Idx Para confirmar 2 | |

Resultado: 27 CERRADAS, 0 PARCIALES, 0 ABIERTAS. Coordinación verificada: los mensajes y eventos "Remito emitido", "Emisión de vale por devolución", "Emisión de gift card", "Devolución a proveedor", "Merma de producción" y el servicio "Alcance de un retiro de lote" tienen el mismo nombre en todos los módulos que los citan y en el Idx B.3 y B.3b; el estado "Pendiente de lote" coincide entre Cmp RF19, RN39 y Stk RN84; los dos indicadores "Margen realizado" y "Margen teórico de receta" coinciden en Ven, Stk, Usu e Idx C.4; el kit armado exige Stock y STK-PRODUCCION en Ven, Stk y Onl.

---

## Parte 3B. Hallazgos de la verificación (regresiones)

Búsquedas por concepto sobre los ocho SPECS. No se encontraron llamadas hacia arriba que violen las capas N0 a N4 (Cli llama hacia abajo a Stock, Fin consulta a Ventas, Cmp vincula la nota de crédito en Stock, Con lee la lista de remitos de Cli) ni referencias RF/RN/EX internas a reglas inexistentes (comprobado por script en los ocho archivos). Los hallazgos son de contenido: 0 Alta, 4 Media y 12 Baja.

| # | Sev | Dónde ocurre | Qué pasa | Corrección mínima |
|---|---|---|---|---|
| R1 | Media | Con RF20, RN25 contra Stk RF12, RF40, RN74, RN80 y Cmp RF03, RN38 | Contable no menciona los dos movimientos nuevos de Stock: el egreso "Devolución a proveedor" y el egreso "Devolución a merma". Stk RF12 y Motivo_Movimiento solo definen Clase_Contable "Merma de producción" u "Otra". Sin regla, el egreso "Devolución a proveedor" puede acreditar Insumos otra vez cuando la nota de crédito de Compras (Cmp RF03) ya los acreditó, o quedar Rechazado por falta de regla (Con RN30). La "merma por devolución" no dice a qué cuenta va. | Con RF20 y Stk RF12: Clase_Contable de los motivos reservados. "Devolución a proveedor": el egreso no genera asiento propio (el haber de Insumos viene de la nota de crédito de Compras). "Devolución a merma": "Mermas de producción y de vitrina". |
| R2 | Media | Ven RN77(3), Cli RF29, RN29, Con RF25, RN36, Idx B.3 | Dos fuentes para contabilizar la gift card. Ven RN77(3) dice que el evento de venta informa el importe con el concepto "Gift card" y que Contable la registra como deuda. Con RF25 y RN36 dicen que se contabiliza solo con el evento de pasivo de Clientes y CC. El Idx B.3 solo lista a Clientes y CC como suscriptor de "Emisión de gift card". Con RF25 toma la cuenta de cobro "según la forma de pago de la venta", pero el mensaje de Ven RF51 y Cli RF29 no lleva la forma de pago. | Ven RN77(3): el concepto "Gift card" del evento de venta sirve solo para excluir el importe de ventas, IVA y cobro. Cli RF29 y RN29: el evento de pasivo lleva ID_Venta. Con RF25: la cuenta de cobro sale del cobro de esa venta. |
| R3 | Media | Ven RF50, Forma_Pago "Compensación por cambio"; Con RF03 | La forma de pago interna "Compensación por cambio" no mueve dinero ni va a Financiero, pero la nueva venta la informa a Contable entre los cobros por forma de pago y Contable no tiene regla para ella (búsqueda sin resultados en 06). Puede quedar Rechazado (Con RN30) o generar un cobro sin movimiento de dinero. | Con RF03: formulario o cuenta puente para "Compensación por cambio" que la nota de crédito cancela; o Ven RF50: no informarla como cobro. |
| R4 | Media | Idx Para confirmar 26 contra Stk RN77, RF31 y Ven RN42 | Contradicción sobre el alérgeno al sustituir un insumo. El Idx dice que con STK-ALERGENOS "el cálculo por receta sí excluye el insumo sustituido". Stk RN77 dice que "una sustitución no quita los alérgenos del artículo base (criterio conservador)" y RF31 solo suma. Es riesgo de inocuidad si se implementa lo del Idx. | Corregir el Idx 26 (o Stk RN77, si se quiere el otro criterio) para que los tres textos digan lo mismo. |
| R5 | Baja | Stk RF39, RN77, sección 2 contra Onl RN32, EX37 | Stk dice que Ventas Online llama hacia abajo a RF39 y "dependen de Ventas Online (RF22, RF39)". Onl RN32 dice que no recalcula: compone lo que Ventas publica en cada sincronización (RF04). Onl no cita RF39. | Una sola fuente: Stk RF39 y sección 2 pasan a "Ventas publica; Ventas Online compone", o Onl RN32 cita RF39. |
| R6 | Baja | Ven RN42 contra Stk EX62 | Mismo caso (el cálculo de alérgenos no responde), dos comportamientos: Ven muestra los declarados con la leyenda "alérgenos derivados pendientes de calcular"; Stk EX62 muestra los últimos publicados y los declarados con la marca "sin cálculo en vivo". | Unificar leyenda y fuente en Ven RN42 y Stk EX62. |
| R7 | Baja | Ven RN79(2), RN76(4), RF51/RN77(3) contra Stk RF41, Cli RF29, RN31, Stk RN80, Cmp RF25 | Cargas de mensajes incompletas o distintas. (a) El mensaje de descuento de Ven RN79(2) lleva serie y cliente, pero Stk RF41 y Historial_Serie esperan Fecha_Fin_Garantia. (b) "Emisión de vale por devolución": Ven RN76(4) envía importe, ID_Devolucion, nota de crédito y cliente; Cli RF29, RN31, EX30 usan además la venta original y el importe devuelto. (c) Ven envía un mensaje por cada gift card; Cli RF29 crea una por unidad "con importe igual al de la línea", ambiguo si la cantidad es mayor que 1. (d) El evento "Devolución a proveedor" de Stk RN80 no lista el ID del egreso que Cmp guarda como ID_Egreso_Stock. | Completar la carga en un lado u otro: sumar esos campos a Ven RN79(2), RN76(4) y Stk RN80, y en Cli RF29 decir "importe de cada gift card". |
| R8 | Baja | Ven RN73(2), RN58 contra Cli RF05, RN41, RF28 | Ven lista como efectos separados "el débito en la cuenta corriente (movimiento tipo Remito)" y "el evento Remito emitido"; Cli trata el evento como el débito ("lo registra como débito de tipo Remito"). Si son dos mensajes con distinto ID_Operacion, el débito podría duplicarse. | Ven RN73(2): un único mensaje "Remito emitido" hacia Cli (débito) y Contable, más el descuento de Stock aparte. |
| R9 | Baja | Ven RF27, RN73 | No hay regla expresa de que la factura agrupada o individual de remitos no publica de nuevo el descuento de stock (ya hecho con el remito). Con y Cli sí evitan duplicar deuda y venta (Con RF24, Cli RN10). | Ven RF27: el evento de venta de la factura de remitos no incluye descuento de stock ni cobro. |
| R10 | Baja | Stk RF42, RN83, sección 2 contra Cli RF30 | Stk dice que el aviso se registra "desde Clientes y CC por el mismo servicio"; Cli RF30 dice que el estado y su gestión son de Stock y que solo los muestra, y no tiene función para registrar avisos. | Cli RF30: registrar el aviso por el servicio de Stock, o Stk RF42: el aviso se registra solo en Stock. |
| R11 | Baja | Stk RF20, RF23, L45 contra Idx A.2 | Stk RF20 dice que en "Cafetería" STK-LOTES "lo define el perfil" y RF23 lo mismo para STK-PRODUCCION; Idx A.2 dice que STK-LOTES está activa en los cuatro perfiles y la tabla no cambia STK-PRODUCCION. Stk RN84 y EX63 (`[Requiere: Compras]`) no figuran en la lista "Dependen de Compras" de la sección 2. | Stk RF20 y RF23: "Sí en los cuatro perfiles". Sumar RN84 y EX63 a esa lista. |
| R12 | Baja | Idx B.3 contra Con RF19, RN37, EX23 y sección 2 | Idx B.3 lista solo a Compras como suscriptor de "Gasto con comprobante fiscal"; Contable también lo recibe (lo vincula al asiento de la comisión). | Idx B.3: agregar Contable. |
| R13 | Baja | Ven RN63, RN38, RN76(3); Cmp RF21, RF22, RN27; Con RN25 | Textos no actualizados. Ven RN63 dice "con lote FEFO" y no el lote indicado (RF48, RN80). Ven RN38 no remite a RN78 para el servicio sin costo. Ven RN76(3) es ambiguo ("salvo el vale, si el parámetro está activo"). Cmp y Con dicen "margen por producto" o "margen del tablero" en vez de "Margen realizado". | Ajustar esas frases. |
| R14 | Baja | Ven RN71 contra Stk RF27, RN82, EX59 | Ven dice que el prefijo y el verificador están "en la plantilla de etiqueta" y que Ventas los aplica leyendo la configuración; Stk los guarda en Configuracion_Stock (Prefijo_Etiqueta_Propia, Algoritmo_Verificador) y dice que Stock valida y devuelve artículo y valor. | Definir quién valida: Ventas con la configuración de Stock, o Stock por el puerto. |
| R15 | Baja | Onl RN39, Pedido_Item.ID_Lote contra Ven RF48, RN80 y Stk RF21 | Onl registra el lote FEFO asignado al preparar "para la trazabilidad hasta la entrega", pero no dice que sea Lote_Indicado; Stock lo marcaría "Lote no confirmado" en el alcance de un retiro. | Onl RN39: el lote registrado al preparar viaja como Lote_Indicado. |
| R16 | Baja | Ven RN77, RF45, RN38; Onl (catálogo) | La gift card no tiene reglas para la tienda online (entrega del código, arrepentimiento, RN15), ni se la excluye de los indicadores de ventas (RF45). | Onl: no publicar el tipo Gift card o definir su entrega; Ven RF45: excluirla de ventas por hora y ticket promedio. |

---

## Parte 4. Resumen y veredicto

### Conteo de la matriz (168 celdas)

| Total | Cubierto | N/A | Parcial | BRECHA |
|---|---|---|---|---|
| 168 celdas | 150 | 18 | 0 | 0 |

Antes de la verificación: 125 Cubiertas, 25 Parciales. Las 25 celdas Parciales pasaron a Cubiertas con la regla citada en cada celda (G1, G2, G3, G4, G5, G10, G11, G14, G15, G16, G17, G19, G20, G21, G22, G23, G26).

Por fila:

| # | Tipo de ítem | Cubierto | N/A | Parcial | BRECHA |
|---|---|---|---|---|---|
| 1 | Estándar | 12 | 0 | 0 | 0 |
| 2 | Con variantes (tamaño, talla, color) | 12 | 0 | 0 | 0 |
| 3 | Pesable a granel | 12 | 0 | 0 | 0 |
| 4 | Peso variable envasado con etiqueta propia | 10 | 2 | 0 | 0 |
| 5 | Serializado | 12 | 0 | 0 | 0 |
| 6 | Servicio | 8 | 4 | 0 | 0 |
| 7 | Elaborado de producción en venta | 11 | 1 | 0 | 0 |
| 8 | Elaborado de producción previa | 11 | 1 | 0 | 0 |
| 9 | Combo virtual | 10 | 2 | 0 | 0 |
| 10 | Kit armado | 11 | 1 | 0 | 0 |
| 11 | Insumo no vendible | 8 | 4 | 0 | 0 |
| 12 | Porción de una pieza entera | 12 | 0 | 0 | 0 |
| 13 | Perecedero con lote y vencimiento | 12 | 0 | 0 | 0 |
| 14 | Artículo con modificadores (leche, extra shot) | 9 | 3 | 0 | 0 |

### Conteo de pasos de los escenarios

| Total | Cubierto | Parcial | BRECHA |
|---|---|---|---|
| 186 pasos | 186 | 0 | 0 |

De los 186 pasos, 175 no tienen observación y 11 quedan "Cubiertos" con una observación de la Parte 3B (E1 p5, E2 p6 y p8, E5 p7, p11 y p12, E6 p11, E9 p13, E11 p9, E13 p9, E14 p6). Antes de la verificación: 153 Cubiertos, 27 Parciales y 8 BRECHA.

Por escenario:

| Escenario | Cubierto | Parcial | BRECHA |
|---|---|---|---|
| E1. Café con leche vegetal en mesa, con pago mixto | 13 | 0 | 0 |
| E2. Torta vendida por porción y devolución de una porción | 13 | 0 | 0 |
| E3. Combo café + medialuna con promoción y devolución parcial | 12 | 0 | 0 |
| E4. Producción por tanda con rinde menor al teórico y venta del lote | 13 | 0 | 0 |
| E5. Retiro de un lote contaminado hasta los clientes mayoristas alcanzados | 13 | 0 | 0 |
| E6. Venta mayorista con remito, cuenta corriente, factura agrupada y cheque rechazado | 18 | 0 | 0 |
| E7. Café en grano online con diferencia de peso y reintegro | 15 | 0 | 0 |
| E8. Pedido de delivery por plataforma con comisión y liquidación | 14 | 0 | 0 |
| E9. Compra de insumos por bolsa de 25 kg con presentación y lote en la recepción | 14 | 0 | 0 |
| E10. Cierre de turno con diferencia, reapertura con supervisor y contabilización | 14 | 0 | 0 |
| E11. Tablero de margen con costos de distinto origen | 12 | 0 | 0 |
| E12. Consolidación de sucursales con una sucursal sin conexión | 10 | 0 | 0 |
| E13. Tienda de ropa con variantes talla y color, y devolución (rubro retail) | 13 | 0 | 0 |
| E14. Venta de un equipo serializado con garantía y devolución (rubro retail) | 12 | 0 | 0 |

### Brechas (G) y hallazgos de la verificación (R)

| Severidad | Cantidad de G | Brechas | Cerradas | Parciales | Abiertas |
|---|---|---|---|---|---|
| Alta | 3 | G1, G2, G3 | 3 | 0 | 0 |
| Media | 15 | G4, G5, G6, G7, G8, G10, G11, G12, G14, G16, G17, G18, G20, G24, G26 | 15 | 0 | 0 |
| Baja | 9 | G9, G13, G15, G19, G21, G22, G23, G25, G27 | 9 | 0 | 0 |
| Total | 27 | | 27 | 0 | 0 |

| Severidad | Cantidad de R | Hallazgos |
|---|---|---|
| Alta | 0 | |
| Media | 4 | R1, R2, R3, R4 |
| Baja | 12 | R5 a R16 |
| Total | 16 | |

### Veredicto

**Las 27 brechas de la auditoría original están cerradas con reglas que existen, usan los mismos nombres entre módulos y no dejan la contradicción original. Con eso, cada celda aplicable de los 14 tipos de ítem y cada paso de los 14 escenarios tiene una regla concreta que lo cubre. La verificación no permite afirmar que el conjunto esté libre de contradicciones: las correcciones introdujeron 16 inconsistencias nuevas, ninguna de severidad Alta.**

- Las cuatro Medias (R1 a R4) conviene resolverlas antes de cerrar el alcance: la imputación contable de la devolución a proveedor y de la merma por devolución (R1), la fuente contable única de la gift card (R2), la forma de pago "Compensación por cambio" en Contable (R3) y el criterio de alérgenos al sustituir un insumo, donde el índice contradice a Stock (R4).
- Las 12 Bajas (R5 a R16) son de precisión: cargas de mensajes, quién calcula o valida, textos no actualizados y entradas del índice. Cada una se corrige con una frase en uno o dos módulos.
- Capas: no se encontró ninguna llamada hacia arriba nueva. El servicio "Alcance de un retiro de lote" (Stock, N2) lo llama Clientes y CC (N3) hacia abajo, y la nota de crédito del proveedor la vincula Compras (N3) en Stock (N2).
- Dinero y costo: no se encontró un doble conteo definido por las reglas. Los puntos donde podría ocurrir por falta de una regla son R1 (inventario), R2 y R3 (cobro) y R9 (stock del remito y la factura agrupada). La comisión de plataforma (Fin RN44, Con RN37), la merma de cocción (Stk RN72, Con RF20, RN25), y el remito con la factura agrupada (Con RF24, RN35; Cli RN10) están protegidos por reglas expresas.
- Multirubro: el cambio de mercadería (G19), el crédito de tienda (G11) y la garantía (G16) ya existen, con la salvedad de R3 y de que el certificado y el reclamo de garantía no se modelan.
- Ninguna corrección exige rediseñar módulos ni alterar la arquitectura de capas.

---

## Búsquedas de verificación de las ausencias (auditoría original)

- "garant": solo aparece en "garantías de idempotencia" (01 RN64, 02 RN69, 03 RN39, 04 RF25, 06 RN33). No hay garantía de producto.
- "remito" y "agrupad" en `06-contable.md`: sin resultados (G8).
- "lote" en `01-ventas.md`: solo Compromiso_Venta y la descripción del compromiso; Pedido_Item no tiene lote (G2).
- "expand" junto a "reserv" en `02-stock-insumos.md`: sin resultados (G20).
- "packaging", "descartable" y "para llevar" en Stock: solo la lista de insumos del alcance (G5).
- "serie" en `07-compras.md`: sin resultados (G16).
- "vale por devolución" en `01-ventas.md`: sin resultados (G11); "importe libre" y "precio libre": sin resultados (G12).
- "cambio de talle", "cambio de producto": sin resultados en los ocho archivos (G19).
- "devolución a proveedor": sin resultados en `02-stock-insumos.md` ni `07-compras.md` (G17).
- En `05-financiero.md`, RF04 y RN05 no mencionan mensajes de integración pendientes (G6).

## Re-verificación tras las correcciones

- "garant": ahora definida en Ven RF33, RN79 y Articulo.Plazo_Garantia_Dias, y en Stk RF41, RN79 (G16).
- "remito" y "agrupad" en `06-contable.md`: ahora en RF24, RN35, EX22, RF03, RF11 y Asiento_Origen (G8).
- "Lote_Indicado" en `01-ventas.md`: RF48, RN80, Pedido_Item (G2).
- "reserva de un combo virtual" en `02-stock-insumos.md`: RF15, RN22 y RN81 (G20).
- "Mapeo_Envase" en Stock: RF38, RN75 (G5).
- "serie" en `07-compras.md`: RF24, RN37, EX23, Comprobante_Linea_Serie (G16).
- "vale por devolución", "Precio_Libre" y "Devolución con Cambio" en `01-ventas.md`: RF49, RN76, RF51, RF50 (G11, G12, G19).
- "Devolución a proveedor": Stk RF40, RN80 y Cmp RF25, RN38 (G17). En `06-contable.md` sigue sin resultados (R1).
- "Compensación por cambio" en `06-contable.md`: sin resultados (R3).
- "integración pendiente" en `05-financiero.md`: RF04, RF28, RN41, EX29 (G6).
- Referencias internas RF/RN/EX de los ocho SPECS: todas apuntan a reglas definidas (el único caso, "EX53" en Onl, remite a Ventas).

---

## Parte 5. Estado de los hallazgos R1 a R16 (corrección posterior a la verificación)

Los 16 hallazgos de la Parte 3B se corrigieron en una ronda posterior. Esta ronda se comprobó con controles automáticos (numeración continua, IDs de funciones definidos, ausencia de las frases viejas) y con búsquedas sobre cada corrección. **No hubo una segunda auditoría independiente**: si se quiere certeza equivalente a la de las brechas G, conviene repetir la verificación sobre estos 16 puntos.

| # | Estado | Dónde quedó la corrección |
|---|---|---|
| R1 | Corregido | Stock RF12, RN72, RN80 y Motivo_Movimiento; Contable RF20 y RN25. "Devolución a proveedor" no genera asiento propio y "Devolución a merma" va a "Mermas de producción y de vitrina" |
| R2 | Corregido | Ventas RN77(3) y RF51; Clientes RF29 y RN29; Contable RF25 y RN36. Una sola fuente: el evento de pasivo de Clientes y CC, con la ID de la venta |
| R3 | Corregido | Ventas RF50; Contable RF03. La compensación por cambio no se informa como cobro |
| R4 | Corregido | Índice (Para confirmar 26) alineado con Stock RN77: criterio conservador de alérgenos |
| R5 | Corregido | Stock RF39, RF19, RF22 y sección 2; Ventas Online RN32. Ventas publica y Ventas Online compone |
| R6 | Corregido | Ventas RN42; Stock EX62. Leyenda única "alérgenos derivados pendientes de calcular" |
| R7 | Corregido | Ventas RN79(2) y RN76(4); Clientes RF29; Stock RN80 y RF40; Compras RF25 |
| R8 | Corregido | Ventas RN73(2), RN58 y RF12; Clientes RF05, RN41 y RF28. Un único mensaje "Remito emitido" |
| R9 | Corregido | Ventas RF27 y RN73. La factura de remitos no repite descuento de stock ni cobro |
| R10 | Corregido | Stock RF42; Clientes RF30 y EX32. Stock registra el aviso y Clientes lo marca llamando hacia abajo |
| R11 | Corregido | Stock RF20, RF23 y sección 2 |
| R12 | Corregido | Índice, Anexo B.3 (Contable suscripto al evento de gasto con comprobante fiscal) |
| R13 | Corregido | Ventas RN63, RN38 y RN76(3); Compras RF21, RF22 y RN27; Contable RN25 |
| R14 | Corregido | Ventas RN71. Valida Stock por el puerto y Ventas contrasta el importe |
| R15 | Corregido | Ventas Online RN39. El lote del pedido viaja como Lote_Indicado |
| R16 | Corregido | Ventas Online RN54; Ventas RF45 y RN77(6). La gift card no se publica online ni cuenta en los indicadores de ventas |

---

## Nota posterior a las decisiones fundacionales F1 a F4

Esta matriz verifica que cada celda tenga una regla, no que las reglas sean coherentes entre sí ante fallas y concurrencia. Las reglas nuevas de las decisiones fundacionales (Usuarios RF28, RN79 a RN83, EX54 a EX58; Clientes RF31, EX33 y EX34) no tienen filas en esta matriz. El Anexo E (matriz de pruebas) debe cubrirlas con casos de prueba de falla: pérdida de conexión de una pantalla en medio de una venta, reserva vencida antes de confirmar, dos terminales sobre el mismo vale y la misma clave de comprobante cargada desde dos terminales.

## Nota posterior a los problemas 11 a 31

Cada decisión posterior tiene su regla y su caso de prueba en el Anexo E, sección E.7. Esta tabla verifica existencia y vínculo; la coherencia ante fallas se prueba con esos casos.

| Punto | Regla | Caso |
|-------|-------|------|
| 11 Funciones con peso sanitario | Usuarios RN86 | T51 |
| 12 Devolución en efectivo | Ventas RN76, EX58; Financiero RN42, RN45, EX31 | T52 |
| 13 Factura agrupada | Ventas RN31 | T53 |
| 14 Reservas sin pago | Ventas Online RN56 | T54 |
| 15 Permisos del Administrador | Usuarios RN07 | T55 |
| 16 Cierre de venta | Ventas RN85 | T56 |
| 17 Devolución con cambio | Ventas RF50, EX61 | T57 |
| 18 Gift card | Ventas RF51, EX62; Clientes RF29 | T58 |
| 19 Desinstalar módulos | Usuarios RN87, EX59 | T59 |
| 20 Pedidos inmediatos online | Ventas Online RN04 | T60 |
| 21 Etiqueta de balanza | Stock RN82; Ventas RN71 | T61 |
| 22 Ingreso sin lote | Stock RN84; Compras RF19 | T62 |
| 23 Presentaciones de venta | Ventas RN86; Stock RN87 | T63 |
| 25 Fraccionables | Ventas RF01, RN04 | T64 |
| 26 Cuentas en otra moneda | Ventas RN87; Clientes RN03, RN04 | T65 |
| 28 a 31 Contradicciones | Ventas EX10, RN76; Índice B.4 | T66 |
| 24 y 27 | Fuera del alcance | Sin caso |
