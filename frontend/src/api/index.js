const TOKEN_KEY   = 'chepola_token'
const USUARIO_KEY = 'chepola_usuario'

export const getToken   = () => localStorage.getItem(TOKEN_KEY)
export const setToken   = (token) => localStorage.setItem(TOKEN_KEY, token)
export const getUsuario = () => {
  try { return JSON.parse(localStorage.getItem(USUARIO_KEY)) } catch { return null }
}
export const setUsuario = (usuario) => localStorage.setItem(USUARIO_KEY, JSON.stringify(usuario))
export const logout = () => {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USUARIO_KEY)
}

// Código de la terminal (se carga una vez en cada equipo, ver Login). Es solo un identificador del
// equipo, no un dato del negocio.
const TERMINAL_KEY = 'chepola_terminal'
export const getTerminal = () => localStorage.getItem(TERMINAL_KEY) || ''
export const setTerminal = (codigo) =>
  codigo ? localStorage.setItem(TERMINAL_KEY, codigo) : localStorage.removeItem(TERMINAL_KEY)

// Código de la instancia (cliente). Solo hace falta cuando el servidor atiende a varios clientes por
// la misma dirección; si el servidor la distingue por dirección web, queda vacío.
const INSTANCIA_KEY = 'chepola_instancia'
export const getInstancia = () => localStorage.getItem(INSTANCIA_KEY) || ''
export const setInstancia = (codigo) =>
  codigo ? localStorage.setItem(INSTANCIA_KEY, codigo) : localStorage.removeItem(INSTANCIA_KEY)

// Aviso que se muestra en el login después de que el servidor cerró la sesión (ej. inactividad).
const AVISO_KEY = 'chepola_aviso'
export const getAviso = () => sessionStorage.getItem(AVISO_KEY) || ''
export const clearAviso = () => sessionStorage.removeItem(AVISO_KEY)

// Estado de conexión con el servidor (lo mantiene useConexion). Sin conexión el sistema no opera:
// toda llamada nueva se rechaza acá, sin guardar nada en el navegador (Usuarios RN80).
let enLinea = true
export const setEnLinea = (valor) => { enLinea = valor }

// Chequeo de conectividad: no pasa por request() para poder usarse justamente cuando no hay conexión.
export const chequearConexion = async () => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 4000)
  try {
    const res = await fetch('/health', { signal: ctrl.signal, cache: 'no-store' })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// Quien pide la credencial de un supervisor cuando una acción "requiere autorización" (la
// registra App). Devuelve { credencial, usuario? } o null si la persona cancela.
let autorizador = null
export const setAutorizador = (fn) => { autorizador = fn }

export const pedirAutorizacion = (permiso) => (autorizador ? autorizador(permiso) : Promise.resolve(null))

export const can = (usuario, permiso) => usuario?.permisos?.[permiso] === 'permitido' || usuario?.permisos?.[permiso] === 'requiere_autorizacion'

// Clave de una operación con efecto (Usuarios RN69): se genera ANTES del primer envío y se reutiliza en
// los reintentos de esa misma operación. Un formulario que se queda abierto la guarda y la renueva
// recién cuando recibe una respuesta definitiva.
export const nuevaSolicitud = () =>
  (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`)

const cabeceras = () => {
  const token = getToken()
  return {
    'Content-Type': 'application/json',
    'X-Hora-Cliente': String(Date.now()), // solo para avisar si el reloj del equipo está mal; la hora oficial es la del servidor
    ...(token && { Authorization: `Bearer ${token}` }),
    ...(getInstancia() && { 'X-Instancia': getInstancia() }),
  }
}

// Ante una respuesta perdida no se reenvía a ciegas (RN71): se pregunta el estado de la operación por su
// clave y solo se reenvía si el servidor no la conoce. Si tampoco se puede preguntar, queda "pendiente de verificar".
const verificarSolicitud = async (id) => {
  try {
    const r = await fetch(`/api/solicitudes/${id}`, { headers: cabeceras() })
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

const request = async (path, options = {}) => {
  const { body, reintento, solicitud, ...rest } = options
  const idSolicitud = (rest.method || 'GET') === 'GET' ? null : (solicitud || nuevaSolicitud())
  if (!enLinea) throw new Error('Sin conexión con el servidor. No se pueden hacer operaciones hasta que vuelva.')
  const enviar = () => fetch(`/api${path}`, {
    ...rest,
    headers: { ...cabeceras(), ...(idSolicitud && { 'X-ID-Solicitud': idSolicitud }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  let res
  try {
    res = await enviar()
  } catch (errRed) {
    if (!idSolicitud) throw errRed
    const estado = await verificarSolicitud(idSolicitud)
    if (!estado) throw Object.assign(new Error('No se pudo confirmar si la operación se realizó. Revisá antes de repetirla.'), { pendienteVerificar: true })
    if (estado.estado === 'desconocida') res = await enviar() // el servidor nunca la recibió: es seguro reenviar
    else if (estado.estado === 'procesada') return estado.resultado
    else if (estado.estado === 'rechazada') throw Object.assign(new Error(estado.resultado?.error || 'La operación fue rechazada.'), { codigo: estado.resultado?.codigo, status: estado.status })
    else throw Object.assign(new Error('La operación sigue en proceso. Esperá un momento y revisá antes de repetirla.'), { pendienteVerificar: true })
  }

  const data = await res.json().catch(() => ({}))

  // Sesión vencida o inválida: se desloguea y se recarga para mostrar el login de nuevo. El login y el cambio
  // rápido de usuario también devuelven 401 cuando las credenciales no son correctas, y ese caso se muestra en el formulario, no es una sesión vencida.
  if (res.status === 401 && !['/auth/login', '/auth/cambiar-usuario'].includes(path)) {
    sessionStorage.setItem(AVISO_KEY, data.error || 'Sesión expirada. Iniciá sesión de nuevo.')
    logout()
    window.location.reload()
    throw new Error('Sesión expirada.')
  }

  if (res.status === 403 && data.codigo === 'REQUIERE_AUTORIZACION' && autorizador && !reintento) {
    const aut = await autorizador(data.permiso)
    if (aut) return request(path, { ...options, solicitud: idSolicitud, body: { ...(options.body || {}), autorizacion: aut }, reintento: true })
  }

  if (!res.ok) {
    const msg =
      data.error ||
      (Array.isArray(data.errores) ? data.errores.join(' ') : null) ||
      `Error ${res.status}`
    throw Object.assign(new Error(msg), { codigo: data.codigo, detalle: data, status: res.status })
  }
  return data
}

// Auth
export const login = (username, password) =>
  request('/auth/login', { method: 'POST', body: { username, password, terminal: getTerminal() || undefined } })
export const getSesion       = () => request('/auth/sesion')
export const cerrarSesion    = () => request('/auth/logout', { method: 'POST' })
export const cambiarPassword = (actual, nueva) => request('/auth/cambiar-password', { method: 'POST', body: { actual, nueva } })
export const cambiarUsuario  = (codigo) => request('/auth/cambiar-usuario', { method: 'POST', body: { codigo } })
export const ping            = () => request('/terminales/ping', { method: 'POST' })

// Usuarios, terminales y sesiones (solo Administrador)
export const getUsuarios      = ()         => request('/usuarios')
export const createUsuario    = (body)     => request('/usuarios', { method: 'POST', body })
export const updateUsuario    = (id, body) => request(`/usuarios/${id}`, { method: 'PUT', body })
export const desactivarUsuario = (id)      => request(`/usuarios/${id}/desactivar`, { method: 'POST' })
export const activarUsuario   = (id)       => request(`/usuarios/${id}/activar`, { method: 'POST' })
export const desbloquearUsuario = (id)     => request(`/usuarios/${id}/desbloquear`, { method: 'POST' })
export const resetPasswordUsuario = (id, password) => request(`/usuarios/${id}/password`, { method: 'POST', body: { password } })
export const getRoles         = ()         => request('/roles')
export const getCatalogoPermisos = ()      => request('/roles/permisos')
export const createRol        = (body)     => request('/roles', { method: 'POST', body })
export const updateRol        = (id, body) => request(`/roles/${id}`, { method: 'PUT', body })
export const deleteRol        = (id)       => request(`/roles/${id}`, { method: 'DELETE' })
export const getAccesos       = (id)       => request(`/roles/usuarios/${id}`)
export const setAccesos       = (id, body) => request(`/roles/usuarios/${id}`, { method: 'PUT', body })
export const getAuditoria     = (filtros)  => request(`/auditoria?${new URLSearchParams(filtros)}`)
export const verificarAuditoria = ()       => request('/auditoria/verificar')
export const getFunciones     = ()         => request('/funciones')
export const cambiarFunciones = (body)     => request('/funciones/cambiar', { method: 'POST', body })
export const aplicarPerfil    = (perfil)   => request('/funciones/perfil', { method: 'POST', body: { perfil } })
export const getNotificaciones = ()        => request('/notificaciones')
export const marcarNotificacionLeida = (id) => request(`/notificaciones/${id}/leida`, { method: 'POST' })
export const resolverNotificacion = (id)   => request(`/notificaciones/${id}/resuelta`, { method: 'POST' })
export const getPendientesIntegracion = () => request('/integracion/pendientes')
export const reintentarPendiente = (id)    => request(`/integracion/pendientes/${id}/reintentar`, { method: 'POST' })
export const descartarPendiente = (id, motivo) => request(`/integracion/pendientes/${id}/descartar`, { method: 'POST', body: { motivo } })
export const conciliarIntegracion = ()     => request('/integracion/conciliar', { method: 'POST' })
export const getTerminales    = ()         => request('/terminales')
export const createTerminal   = (body)     => request('/terminales', { method: 'POST', body })
export const updateTerminal   = (id, body) => request(`/terminales/${id}`, { method: 'PUT', body })
export const getSesiones      = ()         => request('/sesiones')
export const cerrarSesionForzada = (id)    => request(`/sesiones/${id}/cerrar`, { method: 'POST' })

// Productos
export const getProductos  = ()          => request('/productos')
export const createProducto = (body)     => request('/productos',     { method: 'POST',   body })
export const updateProducto = (id, body) => request(`/productos/${id}`, { method: 'PUT',  body })
export const deleteProducto = (id)       => request(`/productos/${id}`, { method: 'DELETE' })

// Insumos
export const getInsumos    = ()          => request('/insumos')
export const createInsumo  = (body)      => request('/insumos',     { method: 'POST',   body })
export const updateInsumo  = (id, body)  => request(`/insumos/${id}`, { method: 'PUT',  body })
export const deleteInsumo  = (id)        => request(`/insumos/${id}`, { method: 'DELETE' })

// Receta (insumos que consume un producto)
export const getInsumosDeProducto = (producto_id) => request(`/productos/${producto_id}/insumos`)
export const addInsumoAProducto   = (producto_id, insumo_id, cantidad_consumida) =>
  request(`/productos/${producto_id}/insumos`, { method: 'POST', body: { insumo_id, cantidad_consumida } })
export const updateInsumoDeProducto = (producto_id, id, cantidad_consumida) =>
  request(`/productos/${producto_id}/insumos/${id}`, { method: 'PUT', body: { cantidad_consumida } })
export const eliminarInsumoDeProducto = (producto_id, id) =>
  request(`/productos/${producto_id}/insumos/${id}`, { method: 'DELETE' })

// Mesas
export const getMesas         = (salon_id) => request(`/mesas?salon_id=${salon_id}`)
export const createMesa       = (body) => request('/mesas',           { method: 'POST', body })
export const deleteMesa       = (id)   => request(`/mesas/${id}`,     { method: 'DELETE' })
export const getPedidosActivosMesa = (id) => request(`/mesas/${id}/pedidos-activos`)
export const updateMesaPosicion = (id, pos_x, pos_y) =>
  request(`/mesas/${id}/posicion`, { method: 'PATCH', body: { pos_x, pos_y } })
export const updateMesaColor  = (id, color_libre, color_ocupado) =>
  request(`/mesas/${id}/color`, { method: 'PATCH', body: { color_libre, color_ocupado } })
export const updateMesaTamano = (id, tamano) =>
  request(`/mesas/${id}/tamano`, { method: 'PATCH', body: { tamano } })
export const cerrarCuenta     = (id, body, solicitud) => request(`/mesas/${id}/cerrar`, { method: 'POST', body, solicitud })
export const confirmarTicketMesa = (id) => request(`/mesas/${id}/confirmar-ticket`, { method: 'POST' })
export const combinarMesas    = (body) => request('/mesas/combinar', { method: 'POST', body })
export const separarGrupo     = (grupoId) => request(`/mesas/grupos/${grupoId}/separar`, { method: 'POST' })

// Sillas (dibujo fijo alrededor de cada mesa, independiente de los pedidos)
export const crearSilla    = (mesa_id) => request(`/mesas/${mesa_id}/sillas`, { method: 'POST' })
export const moverSilla    = (id, pos_x, pos_y) =>
  request(`/sillas/${id}/posicion`, { method: 'PATCH', body: { pos_x, pos_y } })
export const eliminarSilla = (id) => request(`/sillas/${id}`, { method: 'DELETE' })

// Salones
export const getSalones   = ()          => request('/salones')
export const createSalon  = (body)      => request('/salones',     { method: 'POST', body })
export const updateSalon  = (id, body)  => request(`/salones/${id}`, { method: 'PUT', body })
export const deleteSalon  = (id)        => request(`/salones/${id}`, { method: 'DELETE' })

// Estructuras
export const getEstructuras = (salon_id) => request(`/estructuras?salon_id=${salon_id}`)
export const createEstructura = (body)   => request('/estructuras', { method: 'POST', body })
export const updateEstructuraPosicion = (id, pos_x, pos_y) =>
  request(`/estructuras/${id}/posicion`, { method: 'PATCH', body: { pos_x, pos_y } })
export const updateEstructura = (id, body) => request(`/estructuras/${id}`, { method: 'PUT', body })
export const deleteEstructura = (id)     => request(`/estructuras/${id}`, { method: 'DELETE' })

// Pedidos
export const abrirPedido      = (mesa_id)             => request('/pedidos', { method: 'POST', body: { mesa_id } })
export const addProductosPedido = (pedido_id, productos) =>
  request(`/pedidos/${pedido_id}/productos`, { method: 'POST', body: { productos } })
export const cerrarPedidoIndividual = (pedido_id) => request(`/pedidos/${pedido_id}/cerrar`, { method: 'POST' })
export const eliminarPedido         = (pedido_id) => request(`/pedidos/${pedido_id}`, { method: 'DELETE' })
export const eliminarItemPedido     = (pedido_id, item_id) =>
  request(`/pedidos/${pedido_id}/productos/${item_id}`, { method: 'DELETE' })
export const marcarItemEntregado = (pedido_id, item_id, entregado) =>
  request(`/pedidos/${pedido_id}/productos/${item_id}/entregado`, { method: 'PATCH', body: { entregado } })
export const marcarPedidoEntregado = (pedido_id, entregado) =>
  request(`/pedidos/${pedido_id}/entregado`, { method: 'PATCH', body: { entregado } })
export const getHistorialPedidos = (page = 1, limit = 20, filtros = {}) => {
  const params = new URLSearchParams({ page, limit })
  Object.entries(filtros).forEach(([k, v]) => { if (v) params.set(k, v) })
  return request(`/pedidos/historial?${params}`)
}
export const getPedido           = (id) => request(`/pedidos/${id}`)
export const getEstadisticasVentas = (tipo, fecha) =>
  request(`/pedidos/estadisticas?${new URLSearchParams({ tipo, fecha })}`)

// Facturación (ARCA / ex AFIP)
export const getFacturaConfig     = ()       => request('/facturas/config')
export const getHistorialFacturas = (page = 1, limit = 20) => request(`/facturas?page=${page}&limit=${limit}`)
export const getFactura           = (id)     => request(`/facturas/${id}`)
export const reintentarFactura    = (id)     => request(`/facturas/${id}/reintentar`, { method: 'POST' })
export const getEstadoAfip        = ()       => request('/facturas/estado-afip')
