import Modulo from '../layout/Modulo'

const hoy = () => new Date().toISOString().slice(0, 10)

export const Reservas = (p) => (
  <Modulo {...p} tabs={[
    {
      id: 'reservas', titulo: 'Reservas', ruta: '/reservas',
      filtros: [
        { k: 'desde', etiqueta: 'Desde', tipo: 'date', defecto: hoy() }, { k: 'hasta', etiqueta: 'Hasta', tipo: 'date' },
        { k: 'estado', etiqueta: 'Estado', tipo: 'select', opciones: [['pendiente', 'Pendiente'], ['confirmada', 'Confirmada'], ['cumplida', 'Cumplida'], ['no_presento', 'No se presentó'], ['cancelada', 'Cancelada']] },
      ],
      ocultar: ['id_global'],
      crear: {
        titulo: 'Nueva reserva', mensaje: 'Reserva creada.', ruta: '/reservas',
        campos: [
          { k: 'cliente_nombre', etiqueta: 'Nombre', requerido: true }, { k: 'cliente_telefono', etiqueta: 'Teléfono' },
          { k: 'cliente_email', etiqueta: 'Correo', tipo: 'email' }, { k: 'personas', etiqueta: 'Personas', tipo: 'entero', requerido: true, defecto: 2 },
          { k: 'fecha_hora', etiqueta: 'Fecha y hora', tipo: 'datetime-local', requerido: true },
          { k: 'duracion_min', etiqueta: 'Duración (minutos)', tipo: 'entero' },
          { k: 'en_espera', etiqueta: 'Anotar en lista de espera', tipo: 'checkbox' },
        ],
        armar: (v) => ({
          cliente_nombre: v.cliente_nombre, personas: parseInt(v.personas, 10), fecha_hora: String(v.fecha_hora).replace('T', ' ') + ':00',
          ...(v.cliente_telefono && { cliente_telefono: v.cliente_telefono }), ...(v.cliente_email && { cliente_email: v.cliente_email }),
          ...(v.duracion_min && { duracion_min: parseInt(v.duracion_min, 10) }), ...(v.en_espera && { en_espera: true }),
        }),
      },
      ver: { titulo: 'Reserva', ruta: (f) => `/reservas/${f.id}` },
      acciones: [
        { titulo: 'Confirmar', ruta: (f) => `/reservas/${f.id}/confirmar`, mostrar: (f) => f.estado === 'pendiente', mensaje: 'Reserva confirmada.' },
        { titulo: 'Cumplida', ruta: (f) => `/reservas/${f.id}/cumplir`, mostrar: (f) => f.estado === 'confirmada', mensaje: 'Reserva cumplida.' },
        { titulo: 'No vino', ruta: (f) => `/reservas/${f.id}/no-presento`, mostrar: (f) => f.estado === 'confirmada', mensaje: 'Registrada como no presentada.' },
        { titulo: 'Cancelar', estilo: 'rojo', ruta: (f) => `/reservas/${f.id}/cancelar`, mostrar: (f) => ['pendiente', 'confirmada'].includes(f.estado), mensaje: 'Reserva cancelada.', campos: [{ k: 'motivo', etiqueta: 'Motivo', requerido: true }] },
      ],
    },
    { id: 'turnos', titulo: 'Turnos de servicio', ruta: '/reservas/turnos', filtros: [{ k: 'desde', etiqueta: 'Desde', tipo: 'date', defecto: hoy() }], ver: { titulo: 'Turno', ruta: (f) => `/reservas/turnos/${f.id}` } },
    { id: 'especiales', titulo: 'Pedidos especiales', ruta: '/reservas/especiales', ver: { titulo: 'Pedido especial', ruta: (f) => `/reservas/especiales/${f.id}` } },
  ]} />
)

export const Comisiones = (p) => (
  <Modulo {...p} tabs={[
    { id: 'mias', titulo: 'Mis comisiones', ruta: '/comisiones/mias', filtros: [{ k: 'desde', etiqueta: 'Desde', tipo: 'date' }, { k: 'hasta', etiqueta: 'Hasta', tipo: 'date' }] },
    {
      id: 'reglas', titulo: 'Reglas', ruta: '/comisiones/reglas', permiso: 'ventas.comisiones.gestionar',
      crear: {
        titulo: 'Nueva regla', ruta: '/comisiones/reglas',
        campos: [
          { k: 'nombre', etiqueta: 'Nombre', requerido: true },
          { k: 'tipo', etiqueta: 'Tipo', tipo: 'select', opciones: [['porcentaje', 'Porcentaje de la venta'], ['margen', 'Porcentaje del margen']], requerido: true, defecto: 'porcentaje' },
          { k: 'porcentaje', etiqueta: 'Porcentaje', tipo: 'number', requerido: true },
          { k: 'rol', etiqueta: 'Rol al que aplica (código)', ayuda: 'Vacío = todos los vendedores' },
        ],
      },
      acciones: [{ titulo: 'Activar / desactivar', ruta: (f) => `/comisiones/reglas/${f.id}/activa`, metodo: 'PUT', body: (f) => ({ activa: !f.activa }), mensaje: 'Regla actualizada.' }],
    },
    {
      id: 'liquidaciones', titulo: 'Liquidaciones', ruta: '/comisiones/liquidaciones', permiso: 'ventas.comisiones.gestionar',
      crear: {
        titulo: 'Liquidar', ruta: '/comisiones/liquidaciones', mensaje: 'Liquidación generada.',
        campos: [
          { k: 'tipo', etiqueta: 'Período', tipo: 'select', opciones: [['semanal', 'Semanal'], ['quincenal', 'Quincenal'], ['mensual', 'Mensual']], requerido: true },
          { k: 'desde', etiqueta: 'Desde', tipo: 'date', requerido: true }, { k: 'hasta', etiqueta: 'Hasta', tipo: 'date', requerido: true },
        ],
      },
      ver: { titulo: 'Liquidación', ruta: (f) => `/comisiones/liquidaciones/${f.id}` },
      acciones: [{ titulo: 'Marcar pagada', ruta: (f) => `/comisiones/liquidaciones/${f.id}/pagar`, mostrar: (f) => f.estado !== 'pagada', confirmar: '¿Marcar la liquidación como pagada?', mensaje: 'Liquidación pagada.' }],
    },
    { id: 'previa', titulo: 'Vista previa', ruta: '/comisiones/previa', permiso: 'ventas.comisiones.gestionar', filtros: [{ k: 'desde', etiqueta: 'Desde', tipo: 'date', requerido: true }, { k: 'hasta', etiqueta: 'Hasta', tipo: 'date', requerido: true }] },
  ]} />
)

export const Carta = (p) => (
  <Modulo {...p} tabs={[
    {
      id: 'modificadores', titulo: 'Modificadores', ruta: '/modificadores', ver: { titulo: 'Modificador', ruta: (f) => `/modificadores/${f.id}` },
      acciones: [{ titulo: 'Activar / desactivar', ruta: (f) => `/modificadores/${f.id}/activo`, metodo: 'PUT', body: (f) => ({ activo: !f.activo }), permiso: 'ventas.catalogo.editar', mensaje: 'Modificador actualizado.' }],
    },
    { id: 'franjas', titulo: 'Franjas horarias', ruta: '/franjas', acciones: [{ titulo: 'Quitar', estilo: 'rojo', metodo: 'DELETE', ruta: (f) => `/franjas/${f.id}`, permiso: 'ventas.catalogo.editar', confirmar: '¿Quitar la franja?', mensaje: 'Franja quitada.' }] },
    { id: 'presentaciones', titulo: 'Presentaciones de insumos', ruta: '/presentaciones', permiso: 'stock.insumos.ver', ver: { titulo: 'Presentación', ruta: (f) => `/presentaciones/${f.id}` } },
  ]} />
)
