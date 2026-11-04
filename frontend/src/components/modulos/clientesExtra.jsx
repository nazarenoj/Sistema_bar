import Modulo from '../layout/Modulo'

export const Cobranzas = (p) => (
  <Modulo {...p} tabs={[
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
      ver: { titulo: 'Remito', ruta: (f) => `/remitos/${f.id}` },
      acciones: [{ titulo: 'Anular', estilo: 'rojo', permiso: 'ventas.remitos.emitir', ruta: (f) => `/remitos/${f.id}/anular`, mostrar: (f) => f.estado !== 'anulado', mensaje: 'Remito anulado.', campos: [{ k: 'motivo', etiqueta: 'Motivo', requerido: true }] }],
    },
    { id: 'pendientes', titulo: 'Remitos por facturar', ruta: '/cuentas-corrientes/remitos-pendientes', permiso: 'clientes.ver' },
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
