import Modulo from '../layout/Modulo'

// Ventas Online (Fase I): panel de administración de la tienda. La tienda pública (/tienda/<código>) la usan los clientes finales y no tiene pantalla acá.
const B = '/ventas-online'
const motivo = { k: 'motivo', etiqueta: 'Motivo', requerido: true, ancho: 'completo' }
const abierto = (f) => !['cancelado', 'entregado'].includes(f.estado)

export const VentasOnline = (p) => (
  <Modulo {...p} tabs={[
    { id: 'pedidos', titulo: 'Pedidos', ruta: `${B}/pedidos`, permiso: 'ventas_online.pedidos.ver',
      filtros: [{ k: 'estado', etiqueta: 'Estado', tipo: 'select', opciones: [['pendiente_autorizacion', 'Pendiente de autorización'], ['pendiente_pago', 'Pendiente de pago'], ['pagado', 'Pagado'], ['en_preparacion', 'En preparación'], ['listo', 'Listo'], ['despachado', 'Despachado'], ['entregado', 'Entregado'], ['cancelado', 'Cancelado']] }],
      ver: { titulo: 'Pedido', ruta: (f) => `${B}/pedidos/${f.id}` },
      acciones: [
        { titulo: 'Aceptar', permiso: 'ventas_online.pedidos.gestionar', ruta: (f) => `${B}/pedidos/${f.id}/aceptar`, mostrar: (f) => f.estado === 'pendiente_pago' || f.estado === 'pagado', mensaje: 'Pedido aceptado.' },
        { titulo: 'Autorizar reserva', permiso: 'ventas_online.pedidos.autorizar_reserva', ruta: (f) => `${B}/pedidos/${f.id}/autorizar-reserva`, mostrar: (f) => f.estado === 'pendiente_autorizacion', campos: [motivo] },
        { titulo: 'Confirmar transferencia', permiso: 'ventas_online.pagos.gestionar', ruta: (f) => `${B}/pedidos/${f.id}/confirmar-transferencia`, mostrar: (f) => f.estado === 'pendiente_pago' && f.medio_pago === 'transferencia', confirmar: '¿Llegó la transferencia?' },
        { titulo: 'Cambiar estado', permiso: 'ventas_online.pedidos.gestionar', ruta: (f) => `${B}/pedidos/${f.id}/estado`, mostrar: abierto,
          campos: [{ k: 'estado', etiqueta: 'Nuevo estado', tipo: 'select', requerido: true, opciones: [['en_preparacion', 'En preparación'], ['listo', 'Listo'], ['despachado', 'Despachado'], ['entregado', 'Entregado']] }] },
        { titulo: 'Facturar', permiso: 'ventas_online.facturacion.gestionar', ruta: (f) => `${B}/pedidos/${f.id}/facturar`, mostrar: abierto },
        { titulo: 'Cancelar', estilo: 'rojo', permiso: 'ventas_online.pedidos.cancelar', ruta: (f) => `${B}/pedidos/${f.id}/cancelar`, mostrar: abierto, campos: [motivo] },
      ] },
    { id: 'preparacion', titulo: 'Preparación', ruta: `${B}/preparacion`, permiso: 'ventas_online.pedidos.ver',
      ayuda: 'Lo que hay que preparar, en orden de entrega.' },
    { id: 'catalogo', titulo: 'Catálogo', ruta: `${B}/catalogo`, permiso: 'ventas_online.catalogo.ver',
      crear: { titulo: 'Sincronizar con la carta', ruta: `${B}/sincronizar`, permiso: 'ventas_online.catalogo.gestionar', campos: [], mensaje: 'Catálogo sincronizado.' },
      acciones: [
        { titulo: 'Publicar / editar', permiso: 'ventas_online.catalogo.gestionar', ruta: (f) => `${B}/catalogo/${f.id ?? f.producto_id}`, metodo: 'PUT',
          campos: [{ k: 'categoria_online', etiqueta: 'Categoría en la tienda', requerido: true }] },
        { titulo: 'Quitar', estilo: 'rojo', permiso: 'ventas_online.catalogo.gestionar', ruta: (f) => `${B}/catalogo/${f.id ?? f.producto_id}`, metodo: 'DELETE', confirmar: '¿Quitar de la tienda?' },
      ] },
    { id: 'cupones', titulo: 'Cupones', ruta: `${B}/cupones`, permiso: 'ventas_online.tienda.ver',
      crear: { titulo: 'Cupón', ruta: `${B}/cupones`, permiso: 'ventas_online.cupones.gestionar', campos: [
        { k: 'codigo', etiqueta: 'Código', requerido: true },
        { k: 'tipo', etiqueta: 'Tipo', tipo: 'select', requerido: true, opciones: [['porcentaje', 'Porcentaje'], ['monto', 'Monto fijo']] },
        { k: 'valor', etiqueta: 'Valor', tipo: 'number', requerido: true },
        { k: 'minimo_compra', etiqueta: 'Compra mínima', tipo: 'number' },
        { k: 'usos_max', etiqueta: 'Usos máximos', tipo: 'entero' },
        { k: 'vigente_hasta', etiqueta: 'Vigente hasta', tipo: 'date' },
        { k: 'acumulable', etiqueta: 'Acumulable con promociones', tipo: 'checkbox' },
      ] } },
    { id: 'zonas', titulo: 'Zonas de envío', ruta: `${B}/zonas`, permiso: 'ventas_online.tienda.ver',
      crear: { titulo: 'Zona', ruta: `${B}/zonas`, permiso: 'ventas_online.envios.configurar', campos: [
        { k: 'nombre', etiqueta: 'Nombre', requerido: true },
        { k: 'codigos_postales', etiqueta: 'Códigos postales (separados por coma)', requerido: true },
        { k: 'costo', etiqueta: 'Costo del envío', tipo: 'number' }, { k: 'minimo_compra', etiqueta: 'Compra mínima', tipo: 'number' },
        { k: 'gratis_desde', etiqueta: 'Envío gratis desde', tipo: 'number' }, { k: 'plazo_min', etiqueta: 'Plazo (minutos)', tipo: 'entero' },
      ], armar: (v) => ({ ...Object.fromEntries(Object.entries(v).filter(([k, x]) => x !== '' && k !== 'codigos_postales')),
        codigos_postales: String(v.codigos_postales).split(/[,\s]+/).filter(Boolean),
        ...(v.costo !== '' && v.costo !== undefined && { costo: Number(v.costo) }), ...(v.minimo_compra && { minimo_compra: Number(v.minimo_compra) }),
        ...(v.gratis_desde && { gratis_desde: Number(v.gratis_desde) }), ...(v.plazo_min && { plazo_min: Number(v.plazo_min) }) }) } },
    { id: 'clientes', titulo: 'Clientes', ruta: `${B}/clientes`, permiso: 'ventas_online.clientes.ver',
      acciones: [{ titulo: 'Vincular a cliente', permiso: 'ventas_online.clientes.vincular', ruta: (f) => `${B}/clientes/${f.id}/vinculo`, metodo: 'PUT',
        campos: [{ k: 'cliente_id', etiqueta: 'Cliente', tipo: 'select', requerido: true, fuente: { ruta: '/clientes', valor: 'id', texto: (c) => c.razon_social ?? c.nombre } }] }] },
    { id: 'reintegros', titulo: 'Reintegros', ruta: `${B}/reintegros`, permiso: 'ventas_online.pedidos.ver',
      crear: { titulo: 'Reintentar pendientes', ruta: `${B}/reintegros/reintentar`, permiso: 'ventas_online.pagos.gestionar', campos: [], mensaje: 'Reintegros reintentados.' },
      acciones: [{ titulo: 'Marcar hecho a mano', permiso: 'ventas_online.reintegros.manual', ruta: (f) => `${B}/reintegros/${f.id}/manual`, mostrar: (f) => f.estado !== 'reintegrado', campos: [motivo] }] },
    { id: 'arrepentimientos', titulo: 'Arrepentimientos', ruta: `${B}/arrepentimientos`, permiso: 'ventas_online.pedidos.ver' },
    { id: 'plataformas', titulo: 'Plataformas', ruta: `${B}/plataformas`, permiso: 'ventas_online.plataformas.gestionar',
      ayuda: 'Conectores con las plataformas de delivery. Sin el cliente de la plataforma el conector figura desconectado y los envíos quedan en cola.',
      acciones: [{ titulo: 'Pausar / reanudar', permiso: 'ventas_online.plataformas.gestionar', ruta: (f) => `${B}/plataformas/${f.id}/pausa` }, { titulo: 'Publicar menú', permiso: 'ventas_online.plataformas.gestionar', ruta: (f) => `${B}/plataformas/${f.id}/publicar` }] },
    { id: 'reservas', titulo: 'Reservas', ruta: `${B}/reservas-tienda`, permiso: 'ventas_online.reservas.gestionar',
      acciones: [{ titulo: 'Confirmar', permiso: 'ventas_online.reservas.gestionar', ruta: (f) => `${B}/reservas-tienda/${f.id}/confirmar`, mostrar: (f) => f.estado === 'pendiente' }] },
    { id: 'informes', titulo: 'Informes', ruta: `${B}/informes`, permiso: 'ventas_online.informes.ver',
      ver: { titulo: 'Informe', ruta: (f) => `${B}/informes/${f.tipo ?? f.id}` } },
    { id: 'tienda', titulo: 'Tienda', ruta: `${B}/tienda`, permiso: 'ventas_online.tienda.ver',
      crear: { titulo: 'Configurar tienda', ruta: `${B}/tienda`, metodo: 'PUT', permiso: 'ventas_online.tienda.configurar', campos: [
        { k: 'codigo', etiqueta: 'Código (dirección de la tienda)', requerido: true }, { k: 'nombre', etiqueta: 'Nombre', requerido: true },
        { k: 'razon_social', etiqueta: 'Razón social', requerido: true }, { k: 'cuit', etiqueta: 'CUIT', requerido: true },
        { k: 'domicilio', etiqueta: 'Domicilio', requerido: true }, { k: 'activa', etiqueta: 'Tienda activa', tipo: 'checkbox', defecto: true },
      ] } },
  ]} />
)
