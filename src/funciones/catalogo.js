// Registro de funcionalidades activables (Usuarios RF18), cargado como datos desde el Anexo A.1 del
// índice de SPECS. Cada módulo es dueño de las que llevan su prefijo (RN32).
//
//   base        valor por defecto de la función (columna "Base" del catálogo)
//   modulos     módulos que tienen que estar instalados para poder activarla (requisito duro, RN25)
//   funciones   funciones que tienen que estar activas (requisito duro)
//   condicional [{ funcion, siModulo }]: exige esa función solo si ese módulo está instalado (RN25)
//   internet    necesita conexión a internet solo para parte de su trabajo: no impide activarla
//   docs        tipos de documento cuyo procesamiento afecta (Tipos_Documento_Afectados, RN75)
//   sanitaria   peso sanitario (RN86)
//   datosVigentes  true: la función puede declarar datos que impiden desactivarla (RN27); ver comprobaciones.js
//
// Cuando la columna "Requiere" del Anexo A.1 nombra algo que solo se usa para una parte de la función
// (por ejemplo "Stock, solo para cambiar el insumo descontado"), no es un requisito duro: la función
// se activa igual y esa parte se degrada. Solo es duro lo que impide que la función exista.
const f = (id, modulo, nombre, base, extra = {}) => ({
  id, modulo, nombre, base, modulos: [], funciones: [], condicional: [], internet: false,
  docs: [], sanitaria: false, datosVigentes: false, ...extra,
});

const PREFIJOS = {
  VEN: 'ventas', STK: 'stock', CLI: 'clientes', CMP: 'compras', FIN: 'financiero',
  CON: 'contable', ONL: 'ventas_online', USU: 'usuarios',
};

const FUNCIONES = [
  f('VEN-SALON', 'ventas', 'Modo Salón (mesas y sillas)', true, { docs: ['pedido'] }),
  f('VEN-FRANJA', 'ventas', 'Menú por franja horaria', false, { docs: ['pedido'] }),
  f('VEN-MODIF', 'ventas', 'Modificadores y opciones del producto', true, { docs: ['pedido'] }),
  f('VEN-ALERGENOS', 'ventas', 'Alérgenos en menú, comanda y ticket', true, { docs: ['pedido'], sanitaria: true }),
  f('VEN-SERIE', 'ventas', 'Artículos con número de serie', false, { docs: ['pedido'], datosVigentes: true }),
  f('VEN-CC', 'ventas', 'Venta a cuenta corriente', false, { modulos: ['clientes'], docs: ['pedido'] }),
  f('VEN-PRECIO-COSTO', 'ventas', 'Precios por costo con margen', false, { modulos: ['compras'] }),
  f('VEN-DIVISA', 'ventas', 'Cobro en moneda extranjera', false, { condicional: [{ funcion: 'FIN-MONEDA-EXT', siModulo: 'financiero' }], docs: ['pedido'] }),
  f('VEN-LISTAS', 'ventas', 'Listas de precios múltiples', false, { docs: ['pedido'] }),
  f('VEN-PROMOS', 'ventas', 'Promociones automáticas', false, { docs: ['pedido'] }),
  f('VEN-KDS', 'ventas', 'Pantalla de cocina y barra', false, { docs: ['pedido'] }),
  f('VEN-MOVIL', 'ventas', 'Pedidos desde tablet o celular del mozo', false, { docs: ['pedido'] }),
  f('VEN-COMISIONES', 'ventas', 'Comisiones de vendedores', false, { docs: ['pedido'] }),
  f('VEN-RESERVAS', 'ventas', 'Reservas de mesa, turnos y pedidos especiales', false, { funciones: ['VEN-SALON'], internet: true, docs: ['reserva'] }),
  f('STK-LOTES', 'stock', 'Lotes y vencimiento', true, { sanitaria: true, docs: ['toma_inventario'] }),
  f('STK-TRAZA', 'stock', 'Trazabilidad y retiro de lote', true, { funciones: ['STK-LOTES'], sanitaria: true }),
  f('STK-ALERGENOS', 'stock', 'Alérgenos derivados por receta', true, { sanitaria: true }),
  f('STK-PRODUCCION', 'stock', 'Tandas, rendimiento, ficha técnica y costeo', true, { docs: ['orden_produccion'] }),
  f('STK-TEMP', 'stock', 'Registro de temperaturas y controles de inocuidad', false, { sanitaria: true }),
  f('STK-SERIE', 'stock', 'Control de números de serie', false, { funciones: ['VEN-SERIE'] }),
  f('STK-ETIQUETAS', 'stock', 'Etiquetas de vitrina y de productos elaborados', false),
  f('STK-APP', 'stock', 'App móvil de inventario', false, { docs: ['toma_inventario'] }),
  f('STK-REPO-AUTO', 'stock', 'Reposición automática sugerida', false),
  f('CLI-FIDEL', 'clientes', 'Fidelización y vales (sellos, puntos, gift cards)', false),
  f('CLI-MORA', 'clientes', 'Intereses por mora', false),
  f('CLI-RETENCIONES', 'clientes', 'Retenciones sufridas', false),
  f('CLI-FACT-AGRUPADA', 'clientes', 'Facturación agrupada de remitos', false, { funciones: ['VEN-CC'] }),
  f('CLI-MONEDA-EXT', 'clientes', 'Cuentas en moneda extranjera', false),
  f('CMP-PEDIDOS', 'compras', 'Pedidos a proveedores', true, { internet: true }),
  f('CMP-LISTAS-PROVEEDOR', 'compras', 'Listas de precios de proveedor', true),
  f('CMP-FOTO', 'compras', 'Carga de facturas por foto', true, { internet: true }),
  f('CMP-CONTROL-ARCA', 'compras', 'Controles contra ARCA', true, { internet: true }),
  f('CMP-UNIDADES-COMPRA', 'compras', 'Unidades de compra y conversión', true, { modulos: ['stock'] }),
  f('CMP-RECEPCION-LOTES', 'compras', 'Lotes y vencimientos en la recepción', true, { modulos: ['stock'], funciones: ['STK-LOTES'] }),
  f('CMP-PAGOS-PROGRAMADOS', 'compras', 'Pagos programados', false),
  f('CMP-RETENCIONES', 'compras', 'Retenciones practicadas', false),
  f('CMP-PEDIDO-SUGERIDO', 'compras', 'Pedido a partir de la reposición sugerida', false, { modulos: ['stock'], funciones: ['STK-REPO-AUTO', 'CMP-PEDIDOS'] }),
  f('FIN-CIERRE-CIEGO', 'financiero', 'Cierre de caja ciego', false, { docs: ['turno'] }),
  f('FIN-CHEQUES', 'financiero', 'Cartera de cheques y e-cheq', false),
  f('FIN-CONCILIACION', 'financiero', 'Conciliación bancaria', false),
  f('FIN-GASTOS-REC', 'financiero', 'Gastos recurrentes', false),
  f('FIN-MONEDA-EXT', 'financiero', 'Moneda extranjera y diferencia de cambio', false),
  f('FIN-FOTO-GASTOS', 'financiero', 'Carga de gastos por foto', false, { internet: true }),
  f('CON-ASIENTOS-RESUMIDOS', 'contable', 'Asientos resumidos por día', true),
  f('CON-CONTROLES-CRUZADOS', 'contable', 'Controles cruzados con los demás módulos', true),
  f('CON-REVALUACION', 'contable', 'Revaluación de moneda extranjera', false),
  f('CON-EXPORT-PLANTILLAS', 'contable', 'Plantillas de exportación al estudio contable', false),
  f('CON-CONSOL', 'contable', 'Balance consolidado en Casa Central', false, { funciones: ['USU-CONSOL'] }),
  f('ONL-CUPONES', 'ventas_online', 'Cupones y envío gratis', true),
  f('ONL-CUENTA-CLIENTE', 'ventas_online', 'Cuentas de cliente', true),
  f('ONL-PASARELA', 'ventas_online', 'Pasarela de pago', true, { internet: true }),
  f('ONL-ENVIOS-TRANSPORTISTA', 'ventas_online', 'Transportistas integrados', true, { internet: true }),
  f('ONL-MARKETPLACES', 'ventas_online', 'Marketplaces y plataformas de delivery', false, { modulos: ['financiero'], internet: true }),
  f('ONL-RESERVAS', 'ventas_online', 'Reservas y pedidos especiales desde la tienda', false, { funciones: ['VEN-RESERVAS'] }),
  f('USU-TABLERO', 'usuarios', 'Tablero de indicadores', false),
  f('USU-CONSOL', 'usuarios', 'Consolidación de sucursales (Casa Central)', false, { internet: true }),
  f('USU-2FA', 'usuarios', 'Segundo factor de autenticación', false),
  f('USU-FOTO', 'usuarios', 'Servicio de lectura de comprobantes por foto', false, { internet: true }),
  f('USU-COTIZ-AUTO', 'usuarios', 'Actualización automática de cotizaciones', false, { internet: true }),
  f('USU-NUBE', 'usuarios', 'Copia adicional de las copias de seguridad en almacenamiento externo', false, { internet: true }),
  f('USU-CORREO', 'usuarios', 'Notificaciones por correo', false, { internet: true }),
];

// Perfiles de rubro (Anexo A.2): solo lo que cambia respecto de la columna "Base". El perfil pre-carga
// valores; después se cambian uno a uno (RN29).
const PERFIL_CAFETERIA = {};
const PERFILES = {
  cafeteria: { nombre: 'Cafetería', cambios: PERFIL_CAFETERIA },
  produccion_alimentos: {
    nombre: 'Producción de alimentos',
    cambios: { 'VEN-SALON': false, 'VEN-CC': true, 'CLI-FACT-AGRUPADA': true, 'CLI-RETENCIONES': true, 'FIN-CHEQUES': true },
  },
  cafeteria_produccion_propia: {
    nombre: 'Cafetería con producción propia',
    cambios: { 'VEN-SALON': true, 'VEN-CC': true, 'CLI-FACT-AGRUPADA': true, 'CLI-RETENCIONES': true, 'FIN-CHEQUES': true },
  },
  personalizado: { nombre: 'Personalizado', cambios: PERFIL_CAFETERIA }, // "Como Cafetería"
};

const porId = Object.fromEntries(FUNCIONES.map((x) => [x.id, x]));

module.exports = { FUNCIONES, PERFILES, PREFIJOS, porId };
