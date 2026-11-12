import Modulo from '../layout/Modulo'

// Financiero (Fase G): cajas y cuentas, turnos, gastos, transferencias, liquidaciones, cheques, divisas e informes.
const B = '/financiero'
const hoy = new Date().toISOString().slice(0, 10)
const rango = [{ k: 'desde', etiqueta: 'Desde', tipo: 'date' }, { k: 'hasta', etiqueta: 'Hasta', tipo: 'date' }]
const cuenta = (k, etiqueta, extra = {}) => ({ k, etiqueta, tipo: 'select', requerido: true, fuente: { ruta: `${B}/cuentas`, valor: 'id', texto: 'nombre' }, ...extra })
const importe = (extra = {}) => ({ k: 'importe', etiqueta: 'Importe', tipo: 'number', requerido: true, ...extra })
const efectivo = (v) => ({ conteo: { efectivo: Number(v.efectivo) } })

const TABS = [
    { id: 'cuentas', titulo: 'Cajas y cuentas', ruta: `${B}/cuentas`, permiso: 'financiero.cajas.ver',
      ver: { titulo: 'Cuenta', ruta: (f) => `${B}/cuentas/${f.id}` },
      crear: { titulo: 'Cuenta', ruta: `${B}/cuentas`, permiso: 'financiero.cajas.configurar', campos: [
        { k: 'nombre', etiqueta: 'Nombre', requerido: true },
        { k: 'tipo', etiqueta: 'Tipo', tipo: 'select', requerido: true, opciones: [['caja_efectivo', 'Caja de efectivo'], ['caja_reparto', 'Caja de reparto'], ['caja_fuerte', 'Caja fuerte'], ['banco', 'Banco'], ['billetera', 'Billetera'], ['procesador', 'Procesador de pagos'], ['pasarela', 'Pasarela']] },
        { k: 'moneda', etiqueta: 'Moneda (si no es pesos)' },
        { k: 'saldo_inicial', etiqueta: 'Saldo inicial', tipo: 'number' },
        { k: 'limite_descubierto', etiqueta: 'Límite de descubierto', tipo: 'number' },
      ] },
      acciones: [
        { titulo: 'Desactivar', permiso: 'financiero.cajas.configurar', ruta: (f) => `${B}/cuentas/${f.id}/desactivar`, confirmar: '¿Desactivar la cuenta?', mostrar: (f) => f.activa !== false && f.estado !== 'inactiva' },
        { titulo: 'Activar', permiso: 'financiero.cajas.configurar', ruta: (f) => `${B}/cuentas/${f.id}/activar`, mostrar: (f) => f.activa === false || f.estado === 'inactiva' },
      ] },
    { id: 'turnos', titulo: 'Turnos de caja', ruta: `${B}/turnos`, permiso: 'financiero.cajas.ver',
      ver: { titulo: 'Turno', ruta: (f) => `${B}/turnos/${f.id}` },
      crear: { titulo: 'Abrir turno', ruta: `${B}/turnos`, permiso: 'financiero.turnos.operar', campos: [cuenta('cuenta_id', 'Caja'), { k: 'fondo_contado', etiqueta: 'Fondo contado', tipo: 'number', requerido: true }] },
      acciones: [
        { titulo: 'Movimiento', permiso: 'financiero.movimientos.registrar', ruta: (f) => `${B}/turnos/${f.id}/movimientos`, mostrar: (f) => f.estado === 'abierto',
          campos: [{ k: 'tipo', etiqueta: 'Tipo', tipo: 'select', requerido: true, opciones: [['ingreso', 'Ingreso'], ['retiro', 'Retiro']] }, importe(), { k: 'motivo', etiqueta: 'Motivo', requerido: true }] },
        { titulo: 'Arqueo', permiso: 'financiero.turnos.operar', ruta: (f) => `${B}/turnos/${f.id}/arqueos`, mostrar: (f) => f.estado === 'abierto',
          campos: [{ k: 'efectivo', etiqueta: 'Efectivo contado', tipo: 'number', requerido: true }], body: (f, v) => efectivo(v) },
        { titulo: 'Cerrar', permiso: 'financiero.turnos.operar', ruta: (f) => `${B}/turnos/${f.id}/cerrar`, mostrar: (f) => f.estado === 'abierto',
          campos: [{ k: 'efectivo', etiqueta: 'Efectivo contado', tipo: 'number', requerido: true }], body: (f, v) => efectivo(v) },
        { titulo: 'Reabrir', permiso: 'financiero.turnos.reabrir', ruta: (f) => `${B}/turnos/${f.id}/reabrir`, mostrar: (f) => f.estado === 'cerrado',
          campos: [{ k: 'motivo', etiqueta: 'Motivo', requerido: true, ancho: 'completo' }] },
      ] },
    { id: 'movimientos', titulo: 'Movimientos', ruta: `${B}/movimientos`, permiso: 'financiero.movimientos.ver', filtros: rango },
    { id: 'gastos', titulo: 'Gastos', ruta: `${B}/gastos`, permiso: 'financiero.gastos.ver', filtros: rango,
      ver: { titulo: 'Gasto', ruta: (f) => `${B}/gastos/${f.id}` },
      crear: { titulo: 'Gasto', ruta: `${B}/gastos`, permiso: 'financiero.gastos.registrar', campos: [
        { k: 'categoria_id', etiqueta: 'Categoría', tipo: 'select', requerido: true, fuente: { ruta: `${B}/categorias`, valor: 'id', texto: 'nombre' } },
        cuenta('cuenta_id', 'Pagado desde'), importe(), { k: 'fecha', etiqueta: 'Fecha', tipo: 'date', defecto: hoy }, { k: 'comprobante', etiqueta: 'Comprobante' },
      ] },
      acciones: [{ titulo: 'Anular', estilo: 'rojo', permiso: 'financiero.gastos.anular', ruta: (f) => `${B}/gastos/${f.id}/anular`, mostrar: (f) => f.estado !== 'anulado',
        campos: [{ k: 'motivo', etiqueta: 'Motivo', requerido: true, ancho: 'completo' }] }] },
    { id: 'recurrentes', titulo: 'Gastos recurrentes', ruta: `${B}/gastos-recurrentes`, permiso: 'financiero.gastos.ver',
      acciones: [{ titulo: 'Pagar', permiso: 'financiero.gastos.registrar', ruta: (f) => `${B}/gastos-recurrentes/${f.id}/pagar`, confirmar: '¿Registrar el pago de este gasto?' }] },
    { id: 'transferencias', titulo: 'Transferencias', ruta: `${B}/transferencias`, permiso: 'financiero.cajas.ver', filtros: rango,
      crear: { titulo: 'Transferencia', ruta: `${B}/transferencias`, permiso: 'financiero.transferencias.registrar', campos: [cuenta('origen_id', 'Origen'), cuenta('destino_id', 'Destino'), importe(), { k: 'motivo', etiqueta: 'Motivo', requerido: true }] } },
    { id: 'acreditaciones', titulo: 'Acreditaciones', ruta: `${B}/acreditaciones`, permiso: 'financiero.cajas.ver' },
    { id: 'liquidaciones', titulo: 'Liquidaciones', ruta: `${B}/liquidaciones`, permiso: 'financiero.cajas.ver',
      ver: { titulo: 'Liquidación', ruta: (f) => `${B}/liquidaciones/${f.id}` },
      crear: { titulo: 'Liquidación', ruta: `${B}/liquidaciones`, permiso: 'financiero.liquidaciones.registrar', campos: [cuenta('cuenta_id', 'Procesador'), cuenta('destino_id', 'Se acredita en'), { k: 'fecha', etiqueta: 'Fecha', tipo: 'date', defecto: hoy }, importe({ etiqueta: 'Importe liquidado' })] } },
    { id: 'plataformas', titulo: 'Plataformas', ruta: `${B}/plataformas/liquidaciones`, permiso: 'financiero.plataformas.ver',
      acciones: [{ titulo: 'Resolver', permiso: 'financiero.plataformas.resolver', ruta: (f) => `${B}/plataformas/liquidaciones/${f.id}/resolver`,
        campos: [{ k: 'motivo', etiqueta: 'Motivo', requerido: true, ancho: 'completo' }] }] },
    { id: 'cheques', titulo: 'Cheques', ruta: `${B}/cheques`, permiso: 'financiero.cajas.ver',
      ver: { titulo: 'Cheque', ruta: (f) => `${B}/cheques/${f.id}` },
      crear: { titulo: 'Cheque', ruta: `${B}/cheques`, permiso: 'financiero.cheques.gestionar', campos: [
        { k: 'origen', etiqueta: 'Origen', tipo: 'select', requerido: true, opciones: [['tercero', 'De tercero'], ['propio', 'Propio']] },
        { k: 'tipo', etiqueta: 'Tipo', tipo: 'select', requerido: true, opciones: [['fisico', 'Físico'], ['electronico', 'Electrónico']] },
        { k: 'banco', etiqueta: 'Banco', requerido: true }, { k: 'numero', etiqueta: 'Número', requerido: true }, { k: 'cuit_librador', etiqueta: 'CUIT del librador' },
        importe(), { k: 'fecha_pago', etiqueta: 'Fecha de pago', tipo: 'date', requerido: true },
      ] },
      acciones: [
        { titulo: 'Depositar', permiso: 'financiero.cheques.gestionar', ruta: (f) => `${B}/cheques/${f.id}/depositar`, mostrar: (f) => f.estado === 'en_cartera', campos: [cuenta('cuenta_id', 'Cuenta de depósito')] },
        { titulo: 'Acreditar', permiso: 'financiero.cheques.gestionar', ruta: (f) => `${B}/cheques/${f.id}/acreditar`, mostrar: (f) => f.estado === 'depositado' },
        { titulo: 'Rechazar', permiso: 'financiero.cheques.gestionar', ruta: (f) => `${B}/cheques/${f.id}/rechazar`, mostrar: (f) => f.estado === 'depositado', campos: [{ k: 'motivo', etiqueta: 'Motivo', requerido: true, ancho: 'completo' }] },
        { titulo: 'Anular', estilo: 'rojo', permiso: 'financiero.cheques.gestionar', ruta: (f) => `${B}/cheques/${f.id}/anular`, campos: [{ k: 'motivo', etiqueta: 'Motivo', requerido: true, ancho: 'completo' }] },
      ] },
    { id: 'conciliacion', titulo: 'Conciliación', ruta: `${B}/extractos/lineas`, permiso: 'financiero.conciliar',
      ayuda: 'Líneas del extracto bancario. La conciliación automática vincula las que coinciden con un movimiento.',
      crear: { titulo: 'Conciliar automáticamente', ruta: `${B}/conciliacion/automatica`, permiso: 'financiero.conciliar', campos: [cuenta('cuenta_id', 'Cuenta bancaria')], mensaje: 'Conciliación hecha.' },
      acciones: [{ titulo: 'Desvincular', permiso: 'financiero.conciliar', ruta: (f) => `${B}/conciliacion/lineas/${f.id}/desvincular`, mostrar: (f) => f.estado === 'conciliada' }] },
    { id: 'divisas', titulo: 'Divisas', ruta: `${B}/divisas/operaciones`, permiso: 'financiero.informes.ver',
      crear: { titulo: 'Compra o venta de divisa', ruta: `${B}/divisas/operaciones`, permiso: 'financiero.divisas.operar', campos: [
        cuenta('origen_id', 'Cuenta que entrega'), cuenta('destino_id', 'Cuenta que recibe'), importe({ etiqueta: 'Importe que entrega' }), { k: 'cotizacion', etiqueta: 'Cotización', tipo: 'number', requerido: true },
      ] } },
    { id: 'saldos', titulo: 'Saldos', ruta: `${B}/informes/saldos`, permiso: 'financiero.saldos.ver' },
    { id: 'flujo', titulo: 'Flujo de fondos', ruta: `${B}/informes/flujo`, permiso: 'financiero.informes.ver', filtros: rango },
    { id: 'balance', titulo: 'Balance', ruta: `${B}/informes/balance`, permiso: 'financiero.informes.ver', filtros: rango },
    { id: 'config', titulo: 'Configuración', ruta: `${B}/config`, permiso: 'financiero.cajas.ver' },
]

const grupo = (ids) => (p) => <Modulo {...p} tabs={TABS.filter(t => ids.includes(t.id))} />
export const FinCajas = grupo(['cuentas', 'turnos', 'movimientos', 'saldos'])
export const FinPagos = grupo(['gastos', 'recurrentes', 'transferencias', 'cheques'])
export const FinCobros = grupo(['acreditaciones', 'liquidaciones', 'plataformas', 'conciliacion', 'divisas'])
export const FinInformes = grupo(['flujo', 'balance', 'config'])
