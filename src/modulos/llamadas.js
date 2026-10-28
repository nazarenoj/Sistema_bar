// Registro único de las llamadas inmediatas entre módulos (Índice B.5): las únicas que esperan
// respuesta. Una que no figure acá no puede existir; lo demás se recibe por eventos y se guarda en
// una copia local. `falla` es la política cuando no hay respuesta en `esperaMs` (Usuarios RN56):
//   cerrar                 la acción no se ejecuta
//   abrir_con_autorizacion sigue solo con un supervisor, con motivo, y queda marcada
//   degradar               la función se oculta o funciona reducida
// `caller` / `callee` son ids de src/modulos/catalogo.js; '*' = todos los demás módulos.
const S3 = 3000;

const LLAMADAS = [
  { n: 1, caller: ['ventas'], callee: 'clientes', para: 'Veredicto y reserva de crédito', esperaMs: S3, falla: 'cerrar' },
  { n: 2, caller: ['ventas'], callee: 'clientes', para: 'Retención de saldo de vales, gift cards y puntos', esperaMs: S3, falla: 'cerrar' },
  { n: 3, caller: ['ventas'], callee: 'stock', para: 'Compromiso de venta', esperaMs: S3, falla: 'abrir_con_autorizacion' },
  { n: 4, caller: ['ventas'], callee: 'stock', para: 'Validación de etiquetas propias y lotes disponibles', esperaMs: S3, falla: 'degradar' },
  { n: 5, caller: ['ventas'], callee: 'financiero', para: 'Turno de caja abierto', esperaMs: S3, falla: 'abrir_con_autorizacion' },
  { n: 6, caller: ['ventas'], callee: 'arca', para: 'Emisión de comprobantes y consulta al padrón', esperaMs: 15000, falla: 'degradar' },
  { n: 7, caller: ['ventas_online'], callee: 'stock', para: 'Reserva de stock', esperaMs: 5000, falla: 'degradar' },
  { n: 8, caller: ['ventas_online'], callee: 'clientes', para: 'Veredicto y reserva de crédito', esperaMs: S3, falla: 'cerrar' },
  { n: 9, caller: ['ventas_online'], callee: 'clientes', para: 'Retención de saldo de vales', esperaMs: S3, falla: 'cerrar' },
  { n: 10, caller: ['stock', 'compras', 'financiero'], callee: 'usuarios', para: 'Reservar la clave de un comprobante', esperaMs: S3, falla: 'cerrar' },
  { n: 11, caller: ['*'], callee: 'usuarios', para: 'Validar permisos y autorización de supervisor', esperaMs: S3, falla: 'cerrar' },
  { n: 12, caller: ['clientes'], callee: 'ventas', para: 'Notas de débito y crédito, y consulta al padrón', esperaMs: 15000, falla: 'degradar' },
  { n: 13, caller: ['clientes'], callee: 'stock', para: 'Alcance de un retiro de lote', esperaMs: S3, falla: 'degradar' },
  { n: 14, caller: ['compras'], callee: 'ventas', para: 'Padrón y constatación de comprobantes en ARCA', esperaMs: 15000, falla: 'degradar' },
  { n: 15, caller: ['compras'], callee: 'stock', para: 'Presentaciones vigentes de un ítem', esperaMs: S3, falla: 'cerrar' },
  { n: 16, caller: ['financiero'], callee: 'ventas', para: 'Cobros del turno con integración pendiente', esperaMs: S3, falla: 'abrir_con_autorizacion' },
  { n: 17, caller: ['stock'], callee: 'ventas', para: 'Ventas del período para el informe de diferencias', esperaMs: S3, falla: 'degradar' },
  { n: 18, caller: ['contable'], callee: '*', para: 'Saldos iniciales, controles cruzados y navegación al origen', esperaMs: S3, falla: 'degradar' },
  { n: 19, caller: ['ventas_online'], callee: 'ventas', para: 'Totales cobrado, reintegrado y facturado neto de un pedido', esperaMs: S3, falla: 'degradar' },
  { n: 20, caller: ['ventas'], callee: 'financiero', para: 'Saldo de caja antes de una devolución en efectivo', esperaMs: S3, falla: 'abrir_con_autorizacion' },
  { n: 21, caller: ['ventas_online'], callee: 'stock', para: 'Disponibilidad de elaborados de preparación inmediata', esperaMs: S3, falla: 'cerrar' },
];

// Servicios que un módulo de arriba expone hacia abajo (B.3b) y los de la plataforma (N0), que
// todos pueden usar: autenticación, permisos, auditoría, notificaciones, funcionalidades y bandeja
// de salida (Usuarios RF26). Con esto la prueba de arquitectura sabe qué cruces entre capas son legales.
const SERVICIOS_HACIA_ABAJO = [
  { expone: 'stock', llaman: ['clientes'], servicio: 'Alcance de un retiro de lote' },
  { expone: 'ventas', llaman: ['clientes', 'compras', 'ventas_online'], servicio: 'Emisión de comprobantes, padrón y constatación' },
  { expone: 'usuarios', llaman: ['stock', 'compras', 'financiero'], servicio: 'Identificación de comprobantes de terceros' },
];

const FALLAS = ['cerrar', 'abrir_con_autorizacion', 'degradar'];

const porNumero = (n) => LLAMADAS.find((l) => l.n === n) || null;

module.exports = { LLAMADAS, SERVICIOS_HACIA_ABAJO, FALLAS, porNumero };
