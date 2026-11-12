import Modulo from '../layout/Modulo'

// Compras (Fase H): proveedores, comprobantes, cuenta corriente, órdenes de pago, costos, pedidos, Libro IVA, controles ARCA, devoluciones e informes.
const B = '/compras'
const hoy = new Date().toISOString().slice(0, 10)
const rango = [{ k: 'desde', etiqueta: 'Desde', tipo: 'date' }, { k: 'hasta', etiqueta: 'Hasta', tipo: 'date' }]
const proveedor = (extra = {}) => ({ k: 'proveedor_id', etiqueta: 'Proveedor', tipo: 'select', requerido: true, fuente: { ruta: `${B}/proveedores`, valor: 'id', texto: 'razon_social' }, ...extra })
const motivo = { k: 'motivo', etiqueta: 'Motivo', requerido: true, ancho: 'completo' }

const TABS = [
    { id: 'proveedores', titulo: 'Proveedores', ruta: `${B}/proveedores`, permiso: 'compras.proveedores.ver',
      ver: { titulo: 'Proveedor', ruta: (f) => `${B}/proveedores/${f.id}` },
      crear: { titulo: 'Proveedor', ruta: `${B}/proveedores`, permiso: 'compras.proveedores.gestionar', campos: [
        { k: 'cuit', etiqueta: 'CUIT', requerido: true }, { k: 'razon_social', etiqueta: 'Razón social', requerido: true },
        { k: 'condicion_iva', etiqueta: 'Condición frente al IVA', tipo: 'select', opciones: [['Responsable Inscripto', 'Responsable Inscripto'], ['Monotributo', 'Monotributo'], ['Exento', 'Exento']] },
        { k: 'condicion_pago_dias', etiqueta: 'Plazo de pago (días)', tipo: 'number' },
        { k: 'consultar_arca', etiqueta: 'Completar datos desde ARCA', tipo: 'checkbox' },
      ] },
      acciones: [
        { titulo: 'Verificar en ARCA', permiso: 'compras.proveedores.gestionar', ruta: (f) => `${B}/proveedores/${f.id}/verificar-arca` },
        { titulo: 'Desactivar', permiso: 'compras.proveedores.gestionar', ruta: (f) => `${B}/proveedores/${f.id}/desactivar`, confirmar: '¿Desactivar al proveedor?', mostrar: (f) => f.activo !== false && f.estado !== 'inactivo' },
        { titulo: 'Activar', permiso: 'compras.proveedores.gestionar', ruta: (f) => `${B}/proveedores/${f.id}/activar`, mostrar: (f) => f.activo === false || f.estado === 'inactivo' },
      ] },
    { id: 'comprobantes', titulo: 'Comprobantes', ruta: `${B}/comprobantes`, permiso: 'compras.comprobantes.ver', filtros: rango,
      ver: { titulo: 'Comprobante', ruta: (f) => `${B}/comprobantes/${f.id}` },
      crear: { titulo: 'Comprobante', ruta: `${B}/comprobantes`, permiso: 'compras.comprobantes.registrar', campos: [
        { k: 'cuit', etiqueta: 'CUIT del proveedor', requerido: true },
        { k: 'clase', etiqueta: 'Clase', tipo: 'select', requerido: true, defecto: 'FACTURA', opciones: [['FACTURA', 'Factura'], ['NOTA_CREDITO', 'Nota de crédito'], ['NOTA_DEBITO', 'Nota de débito']] },
        { k: 'tipo', etiqueta: 'Tipo', tipo: 'select', requerido: true, defecto: 'A', opciones: [['A', 'A'], ['B', 'B'], ['C', 'C']] },
        { k: 'punto_venta', etiqueta: 'Punto de venta', tipo: 'entero', requerido: true }, { k: 'numero', etiqueta: 'Número', requerido: true },
        { k: 'fecha', etiqueta: 'Fecha', tipo: 'date', defecto: hoy, requerido: true }, { k: 'cae', etiqueta: 'CAE' },
        { k: 'neto', etiqueta: 'Neto gravado 21 %', tipo: 'number' }, { k: 'iva', etiqueta: 'IVA 21 %', tipo: 'number' },
        { k: 'total', etiqueta: 'Total', tipo: 'number', requerido: true },
      ], armar: (v) => {
        const { neto, iva, ...resto } = v
        const cuerpo = { ...resto, punto_venta: Number(v.punto_venta), total: Number(v.total) }
        if (Number(neto)) cuerpo.alicuotas = [{ alicuota: 21, neto: Number(neto), iva: Number(iva || 0) }]
        return Object.fromEntries(Object.entries(cuerpo).filter(([, x]) => x !== '' && x !== undefined))
      } },
      acciones: [
        { titulo: 'Anular', estilo: 'rojo', permiso: 'compras.comprobantes.anular', ruta: (f) => `${B}/comprobantes/${f.id}/anular`, mostrar: (f) => f.estado !== 'anulado', campos: [motivo] },
        { titulo: 'Constatar', permiso: 'compras.arca.controlar', ruta: (f) => `${B}/comprobantes/${f.id}/constatar` },
      ] },
    { id: 'deuda', titulo: 'Deuda', ruta: `${B}/deuda`, permiso: 'compras.cuentas.ver' },
    { id: 'vencimientos', titulo: 'Vencimientos', ruta: `${B}/vencimientos`, permiso: 'compras.cuentas.ver' },
    { id: 'ordenes', titulo: 'Órdenes de pago', ruta: `${B}/ordenes-pago`, permiso: 'compras.ordenes.ver',
      ver: { titulo: 'Orden de pago', ruta: (f) => `${B}/ordenes-pago/${f.id}` },
      crear: { titulo: 'Orden de pago', ruta: `${B}/ordenes-pago`, permiso: 'compras.ordenes.crear', campos: [
        proveedor(), { k: 'vencimiento_id', etiqueta: 'N.º de vencimiento a pagar', tipo: 'entero', requerido: true },
        { k: 'medio', etiqueta: 'Medio', tipo: 'select', requerido: true, defecto: 'efectivo', opciones: [['efectivo', 'Efectivo'], ['transferencia', 'Transferencia'], ['cheque_propio', 'Cheque propio'], ['echeq', 'eCheq'], ['cheque_tercero', 'Cheque de tercero']] },
        { k: 'importe', etiqueta: 'Importe', tipo: 'number', requerido: true },
      ], armar: (v) => ({ proveedor_id: Number(v.proveedor_id), aplicaciones: [{ vencimiento_id: Number(v.vencimiento_id) }], medios: [{ medio: v.medio, importe: Number(v.importe) }] }) },
      acciones: [
        { titulo: 'Aprobar', permiso: 'compras.ordenes.aprobar', ruta: (f) => `${B}/ordenes-pago/${f.id}/aprobar`, mostrar: (f) => f.estado === 'borrador' || f.estado === 'pendiente_aprobacion' },
        { titulo: 'Ejecutar', permiso: 'compras.ordenes.ejecutar', ruta: (f) => `${B}/ordenes-pago/${f.id}/ejecutar`, confirmar: '¿Ejecutar el pago? Sale el dinero de la caja o cuenta.', mostrar: (f) => !f.ejecutada && f.estado !== 'anulada' },
        { titulo: 'Anular', estilo: 'rojo', permiso: 'compras.ordenes.anular', ruta: (f) => `${B}/ordenes-pago/${f.id}/anular`, mostrar: (f) => f.estado !== 'anulada', campos: [motivo] },
      ] },
    { id: 'retenciones', titulo: 'Retenciones', ruta: `${B}/retenciones/certificados`, permiso: 'compras.ordenes.ver', filtros: rango,
      descargas: [{ titulo: 'Exportar', ruta: (f) => `${B}/retenciones/exportar?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`, nombre: 'retenciones.csv' }] },
    { id: 'costos', titulo: 'Costos', ruta: `${B}/costos`, permiso: 'compras.costos.ver' },
    { id: 'costos-pend', titulo: 'Costos a confirmar', ruta: `${B}/costos/pendientes`, permiso: 'compras.costos.ver',
      acciones: [
        { titulo: 'Confirmar', permiso: 'compras.costos.confirmar', ruta: (f) => `${B}/costos/pendientes/${f.id}/confirmar` },
        { titulo: 'Rechazar', estilo: 'rojo', permiso: 'compras.costos.confirmar', ruta: (f) => `${B}/costos/pendientes/${f.id}/rechazar` },
      ] },
    { id: 'listas', titulo: 'Listas de precios', ruta: `${B}/listas`, permiso: 'compras.costos.ver',
      ver: { titulo: 'Lista', ruta: (f) => `${B}/listas/${f.id}` } },
    { id: 'pedidos', titulo: 'Pedidos', ruta: `${B}/pedidos`, permiso: 'compras.pedidos.ver',
      ver: { titulo: 'Pedido', ruta: (f) => `${B}/pedidos/${f.id}` },
      acciones: [
        { titulo: 'Confirmar', permiso: 'compras.pedidos.confirmar', ruta: (f) => `${B}/pedidos/${f.id}/confirmar`, mostrar: (f) => f.estado === 'borrador' },
        { titulo: 'Enviar', permiso: 'compras.pedidos.enviar', ruta: (f) => `${B}/pedidos/${f.id}/enviar`, mostrar: (f) => f.estado === 'confirmado' },
        { titulo: 'Cancelar', estilo: 'rojo', permiso: 'compras.pedidos.confirmar', ruta: (f) => `${B}/pedidos/${f.id}/cancelar`, mostrar: (f) => !['cancelado', 'recibido'].includes(f.estado), campos: [motivo] },
      ] },
    { id: 'sugerido', titulo: 'Pedido sugerido', ruta: `${B}/pedidos/sugerencia`, permiso: 'compras.pedidos.ver',
      ayuda: 'Lo que conviene reponer según el stock mínimo y el consumo.',
      crear: { titulo: 'Armar pedidos desde la sugerencia', ruta: `${B}/pedidos/desde-sugerencia`, permiso: 'compras.pedidos.confirmar', campos: [], mensaje: 'Pedidos armados.' } },
    { id: 'libro-iva', titulo: 'Libro IVA', ruta: `${B}/libro-iva`, permiso: 'compras.libro_iva.ver', filtros: [{ k: 'periodo', etiqueta: 'Período (AAAA-MM)', requerido: true }],
      descargas: [{ titulo: 'Excel', ruta: (f) => `${B}/libro-iva?periodo=${f.periodo}&formato=xlsx`, nombre: 'libro-iva-compras.xlsx' }] },
    { id: 'arca', titulo: 'Control ARCA', ruta: `${B}/arca/comparacion`, permiso: 'compras.arca.controlar',
      crear: { titulo: 'Constatar pendientes', ruta: `${B}/arca/constatar-pendientes`, permiso: 'compras.arca.controlar', campos: [], mensaje: 'Constatación hecha.' } },
    { id: 'devoluciones', titulo: 'Devoluciones', ruta: `${B}/devoluciones`, permiso: 'compras.devoluciones.ver' },
    { id: 'informes', titulo: 'Informes', ruta: `${B}/informes`, permiso: 'compras.informes.ver',
      ver: { titulo: 'Informe', ruta: (f) => `${B}/informes/${f.tipo ?? f.id}` } },
    { id: 'config', titulo: 'Configuración', ruta: `${B}/config`, permiso: 'compras.proveedores.ver' },
]

const grupo = (ids) => (p) => <Modulo {...p} tabs={TABS.filter(t => ids.includes(t.id))} />
export const ComProveedores = grupo(['proveedores', 'config'])
export const ComComprobantes = grupo(['comprobantes', 'devoluciones', 'libro-iva', 'arca'])
export const ComPagos = grupo(['deuda', 'vencimientos', 'ordenes', 'retenciones'])
export const ComAbastecimiento = grupo(['costos', 'costos-pend', 'listas', 'pedidos', 'sugerido', 'informes'])
