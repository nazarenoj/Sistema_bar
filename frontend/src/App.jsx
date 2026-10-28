import { useState, useCallback, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import ProductoTabla from './components/productos/ProductoTabla'
import InsumoTabla from './components/insumos/InsumoTabla'
import MesaGrid from './components/mesas/MesaGrid'
import HistorialPedidos from './components/historial/HistorialPedidos'
import ToastContainer from './components/ToastContainer'
import ConfirmDialog from './components/ConfirmDialog'
import Login from './components/Login'
import UsuariosPanel from './components/usuarios/UsuariosPanel'
import CambiarPasswordModal from './components/CambiarPasswordModal'
import CambiarUsuarioModal from './components/CambiarUsuarioModal'
import AutorizacionModal from './components/AutorizacionModal'
import NotificacionesPanel from './components/NotificacionesPanel'
import { PERMISO_VISTA } from './utils/vistas'
import useConexion from './hooks/useConexion'
import useConfirm from './hooks/useConfirm'
import * as api from './api'

export default function App() {
  const [vista, setVista]         = useState('mesas')
  const [productos, setProductos] = useState([])
  const [toasts, setToasts]       = useState([])
  const [usuario, setUsuario]     = useState(api.getUsuario())
  const [modalUsuario, setModalUsuario]   = useState(false)
  const [modalPassword, setModalPassword] = useState(false)
  const [autorizacion, setAutorizacion] = useState(null) // { permiso, resolve }
  const [nuevasNotif, setNuevasNotif] = useState(0)
  const enLinea = useConexion(!!usuario)
  const { confirm, confirmState, resolveConfirm } = useConfirm()

  const addToast = useCallback((message, type = 'success') => {
    const id = Date.now()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000)
  }, [])

  useEffect(() => {
    api.setAutorizador((permiso) => new Promise((resolve) => setAutorizacion({ permiso, resolve })))
    return () => api.setAutorizador(null)
  }, [])

  // Si la pantalla actual no está permitida para el usuario (por ejemplo, al entrar con otro), pasa a la primera que sí.
  useEffect(() => {
    if (!usuario?.permisos || !PERMISO_VISTA[vista] || api.can(usuario, PERMISO_VISTA[vista])) return
    const primera = Object.keys(PERMISO_VISTA).find(v => api.can(usuario, PERMISO_VISTA[v]))
    if (primera) setVista(primera)
  }, [usuario, vista])

  // El contador de notificaciones nuevas se renueva cada medio minuto.
  useEffect(() => {
    if (!usuario || !enLinea) return
    const cargar = () => api.getNotificaciones().then(r => setNuevasNotif(r.nuevas)).catch(() => {})
    cargar()
    const id = setInterval(cargar, 30000)
    return () => clearInterval(id)
  }, [usuario, enLinea])

  const fetchProductos = useCallback(async () => {
    try {
      const data = await api.getProductos()
      setProductos(data)
    } catch {
      // silent – MesaGrid dropdown will be empty; ProductoTabla shows its own error
    }
  }, [])

  useEffect(() => { if (usuario) fetchProductos() }, [usuario, fetchProductos])

  // Al abrir con una sesión guardada se vuelven a pedir los datos al servidor: el rol o el cambio de
  // contraseña pendiente pueden haber cambiado desde la última vez. Si la sesión ya no sirve,
  // request() vuelve al login con el motivo.
  useEffect(() => {
    if (!api.getToken()) return
    api.getSesion().then(({ usuario: u }) => { api.setUsuario(u); setUsuario(u) }).catch(() => {})
  }, [])

  const handleLogout = async () => {
    await api.cerrarSesion().catch(() => {}) // si no hay conexión igual se sale; el servidor la vence por inactividad
    api.logout()
    setUsuario(null)
  }

  const handleCambioDeUsuario = (nuevo) => {
    setModalUsuario(false)
    setVista('mesas')
    setUsuario(nuevo)
  }

  const handlePasswordCambiada = () => {
    const actualizado = { ...usuario, debe_cambiar_password: false }
    api.setUsuario(actualizado)
    setUsuario(actualizado)
    setModalPassword(false)
  }

  if (!usuario) {
    return <Login onLogin={setUsuario} />
  }

  return (
    <div className="flex flex-col h-screen">
    {!enLinea && (
      <div className="bg-rose-600 text-white text-sm font-semibold text-center px-4 py-2 shrink-0">
        Sin conexión con el servidor. No se pueden hacer operaciones nuevas hasta que vuelva.
      </div>
    )}
    <div className="flex flex-1 min-h-0 bg-gray-50 overflow-hidden">
      <Sidebar
        vista={vista} setVista={setVista} usuario={usuario} onLogout={handleLogout}
        onCambiarUsuario={() => setModalUsuario(true)} onCambiarPassword={() => setModalPassword(true)} nuevasNotif={nuevasNotif}
      />

      <main className="flex-1 overflow-y-auto p-6 lg:p-8">
        {vista === 'productos' && <ProductoTabla addToast={addToast} confirm={confirm} onProductosChange={fetchProductos} />}
        {vista === 'insumos' && <InsumoTabla addToast={addToast} confirm={confirm} />}
        {vista === 'mesas' && <MesaGrid addToast={addToast} confirm={confirm} productos={productos} />}
        {vista === 'historial' && <HistorialPedidos addToast={addToast} />}
        {vista === 'notificaciones' && <NotificacionesPanel addToast={addToast} onCambio={setNuevasNotif} />}
        {vista === 'usuarios' && api.can(usuario, 'usuarios.gestionar') && <UsuariosPanel addToast={addToast} confirm={confirm} usuario={usuario} />}
      </main>

      <ToastContainer toasts={toasts} />
      <ConfirmDialog state={confirmState} onResolve={resolveConfirm} />
      {autorizacion && (
        <AutorizacionModal permiso={autorizacion.permiso} onResolve={(r) => { autorizacion.resolve(r); setAutorizacion(null) }} />
      )}

      {usuario.debe_cambiar_password && (
        <CambiarPasswordModal forzado onDone={handlePasswordCambiada} addToast={addToast} />
      )}
      {!usuario.debe_cambiar_password && modalPassword && (
        <CambiarPasswordModal onDone={handlePasswordCambiada} onClose={() => setModalPassword(false)} addToast={addToast} />
      )}
      {modalUsuario && <CambiarUsuarioModal onCambiado={handleCambioDeUsuario} onClose={() => setModalUsuario(false)} />}
    </div>
    </div>
  )
}
