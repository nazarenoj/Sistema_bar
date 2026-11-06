import Modulo from '../layout/Modulo'

const PRODUCTOS = { ruta: '/productos', valor: 'id', texto: 'nombre' }
const MOTIVOS_NOTA = [['intereses_mora', 'Intereses por mora'], ['diferencia_cambio', 'Diferencia de cambio'], ['bonificacion', 'Bonificación'], ['cheque_rechazado', 'Cheque rechazado'], ['error_facturacion', 'Error de facturación'], ['otros', 'Otros']]
const FORMAS_COBRO = { ruta: '/formas-pago', valor: 'codigo', texto: 'nombre' }

export const Cobranzas = (p) => (
  <Modulo {...p} tabs={[
    {
      id: 'cuentas', titulo: 'Cuentas corrientes', ruta: '/cuentas-corrientes', permiso: 'clientes.ver',
      ayuda: 'Ingresá el número de cliente (lo ves en la ficha de Clientes y cuentas) para ver sus cuentas.',
      filtros: [{ k: 'cliente_id', etiqueta: 'N.º de cliente', tipo: 'number', requerido: true }],
      crear: {
        titulo: 'Abrir cuenta', ruta: '/cuentas-corrientes', permiso: 'clientes.cuentas.gestionar', mensaje: 'Cuenta abierta.',
        campos: [
          { k: 'cliente_id', etiqueta: 'N.º de cliente', tipo: 'entero', requerido: true }, { k: 'limite_credito', etiqueta: 'Límite de crédito', tipo: 'number', defecto: 0 },
          { k: 'plazo_dias', etiqueta: 'Plazo de pago (días)', tipo: 'entero' }, { k: 'moneda', etiqueta: 'Moneda', defecto: 'ARS' },
        ],
      },
      ver: { titulo: 'Cuenta corriente', ruta: (f) => `/cuentas-corrientes/${f.id}` },
      acciones: [
        {
          titulo: 'Cobrar', permiso: 'clientes.recibos.registrar', ruta: () => '/recibos', mensaje: 'Recibo registrado.',
          campos: [{ k: 'forma', etiqueta: 'Forma de pago', tipo: 'select', fuente: FORMAS_COBRO, requerido: true }, { k: 'importe', etiqueta: 'Importe', tipo: 'number', requerido: true }],
          body: (f, v) => ({ cuenta_id: f.id, cliente_id: f.cliente_id, moneda: f.moneda, valores: [{ forma: v.forma, importe: Number(v.importe) }] }),
        },
        {
          titulo: 'Nota', permiso: 'clientes.notas.emitir', ruta: (f) => `/cuentas-corrientes/${f.id}/notas`, mensaje: 'Nota emitida.',
          campos: [
            { k: 'tipo', etiqueta: 'Tipo', tipo: 'select', opciones: [['nd', 'Nota de débito'], ['nc', 'Nota de crédito']], requerido: true },
            { k: 'motivo', etiqueta: 'Motivo', tipo: 'select', opciones: MOTIVOS_NOTA, requerido: true }, { k: 'importe', etiqueta: 'Importe', tipo: 'number', requerido: true },
            { k: 'fiscal', etiqueta: 'Emitir comprobante fiscal (con CAE)', tipo: 'checkbox' },
          ],
          body: (f, v) => ({ tipo: v.tipo, motivo: v.motivo, importe: Number(v.importe), fiscal: !!v.fiscal }),
        },
        { titulo: 'Cerrar cuenta', estilo: 'rojo', permiso: 'clientes.cuentas.gestionar', ruta: (f) => `/cuentas-corrientes/${f.id}/cerrar`, mostrar: (f) => f.estado !== 'cerrada', confirmar: '¿Cerrar la cuenta? Tiene que estar sin saldo.', mensaje: 'Cuenta cerrada.' },
      ],
    },
    {
      id: 'recibos', titulo: 'Recibos', ruta: '/recibos', permiso: 'clientes.ver',
      filtros: [{ k: 'cuenta_id', etiqueta: 'N.º de cuenta', tipo: 'number' }, { k: 'estado', etiqueta: 'Estado', tipo: 'select', opciones: [['emitido', 'Emitido'], ['anulado', 'Anulado']] }],
      ver: { titulo: 'Recibo', ruta: (f) => `/recibos/${f.id}` },
      acciones: [
        { titulo: 'Anular', estilo: 'rojo', permiso: 'clientes.recibos.anular', ruta: (f) => `/recibos/${f.id}/anular`, mostrar: (f) => f.estado !== 'anulado', mensaje: 'Recibo anulado.', campos: [{ k: 'motivo', etiqueta: 'Motivo', requerido: true }] },
      ],
    },
    {
      id: 'ajustes', titulo: 'Intereses por mora', ruta: '/ajustes-cc', permiso: 'clientes.ajustes.gestionar',
      acciones: [
        { titulo: 'Confirmar', ruta: (f) => `/ajustes-cc/${f.id}/confirmar`, mostrar: (f) => f.estado === 'propuesto' || f.estado === 'pendiente', confirmar: '¿Confirmar el ajuste?', mensaje: 'Ajuste confirmado.' },
        { titulo: 'Descartar', estilo: 'rojo', permiso: 'clientes.ajustes.condonar', ruta: (f) => `/ajustes-cc/${f.id}/descartar`, mostrar: (f) => f.estado === 'propuesto' || f.estado === 'pendiente', mensaje: 'Ajuste descartado.', campos: [{ k: 'motivo', etiqueta: 'Motivo', requerido: true }] },
      ],
      crear: { titulo: 'Calcular mora', ruta: '/ajustes-cc/calcular-mora', mensaje: 'Mora calculada.', campos: [{ k: 'hasta', etiqueta: 'Calcular hasta', tipo: 'date' }] },
    },
    {
      id: 'remitos', titulo: 'Remitos', ruta: '/remitos', permiso: 'clientes.ver',
      crear: {
        titulo: 'Nuevo remito', ruta: '/remitos', permiso: 'ventas.remitos.emitir', mensaje: 'Remito emitido.',
        campos: [
          { k: 'cliente_id', etiqueta: 'N.º de cliente', tipo: 'entero', requerido: true },
          { k: 'producto_id', etiqueta: 'Producto', tipo: 'select', fuente: PRODUCTOS, requerido: true }, { k: 'cantidad', etiqueta: 'Cantidad', tipo: 'number', requerido: true },
          { k: 'asignar_a_cuenta', etiqueta: 'Asignar a la cuenta corriente del cliente', tipo: 'checkbox' },
        ],
        armar: (v) => ({ cliente_id: Number(v.cliente_id), asignar_a_cuenta: !!v.asignar_a_cuenta, items: [{ producto_id: Number(v.producto_id), cantidad: Number(v.cantidad) }] }),
      },
      ver: { titulo: 'Remito', ruta: (f) => `/remitos/${f.id}` },
      acciones: [{ titulo: 'Anular', estilo: 'rojo', permiso: 'ventas.remitos.emitir', ruta: (f) => `/remitos/${f.id}/anular`, mostrar: (f) => f.estado !== 'anulado', mensaje: 'Remito anulado.', campos: [{ k: 'motivo', etiqueta: 'Motivo', requerido: true }] }],
    },
    {
      id: 'pendientes', titulo: 'Remitos por facturar', ruta: '/cuentas-corrientes/remitos-pendientes', permiso: 'clientes.ver',
      ayuda: 'Indicá el número de cliente para ver sus remitos pendientes.', filtros: [{ k: 'cliente_id', etiqueta: 'N.º de cliente', tipo: 'number', requerido: true }],
      crear: {
        titulo: 'Facturar remitos de un cliente', ruta: '/remitos/facturar', permiso: 'ventas.remitos.facturar', mensaje: 'Facturación hecha.',
        campos: [{ k: 'cliente_id', etiqueta: 'N.º de cliente', tipo: 'entero', requerido: true }, { k: 'remitos', etiqueta: 'N.º de remitos (separados por coma)', requerido: true }, { k: 'previa', etiqueta: 'Solo vista previa, sin emitir', tipo: 'checkbox' }],
        armar: (v) => ({ cliente_id: Number(v.cliente_id), remitos: String(v.remitos).split(',').map(x => x.trim()).filter(Boolean), previa: !!v.previa }),
      },
    },
  ]} />
)

export const Fidelizacion = (p) => (
  <Modulo {...p} tabs={[
    { id: 'programa', titulo: 'Programa', ruta: '/fidelizacion/programa', ayuda: 'Programa de fidelización vigente y sus reglas. Para cambiarlo hace falta el permiso de configuración.' },
    { id: 'instrumentos', titulo: 'Vales y gift cards', ruta: '/fidelizacion/instrumentos', ver: { titulo: 'Instrumento', ruta: (f) => `/fidelizacion/instrumentos/${f.id}` },
      acciones: [
        { titulo: 'Anular', estilo: 'rojo', permiso: 'clientes.fidelizacion.gestionar', ruta: (f) => `/fidelizacion/instrumentos/${f.id}/anular`, mostrar: (f) => f.estado === 'activo', mensaje: 'Instrumento anulado.', campos: [{ k: 'motivo', etiqueta: 'Motivo', requerido: true }] },
        { titulo: 'Reactivar', permiso: 'clientes.fidelizacion.gestionar', ruta: (f) => `/fidelizacion/instrumentos/${f.id}/reactivar`, mostrar: (f) => f.estado === 'anulado', mensaje: 'Instrumento reactivado.' },
      ] },
    { id: 'informes', titulo: 'Informes', ruta: '/fidelizacion/informes' },
  ]} />
)
