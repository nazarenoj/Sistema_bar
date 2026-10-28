import { useEffect, useState } from 'react'
import * as api from '../api'

const CADA_MS = 10000
const LATIDO_MS = 30000

// Mantiene el estado de conexión con el servidor (Usuarios RF28, RN80): consulta /health cada pocos
// segundos y avisa al resto de la app para que bloquee las operaciones nuevas mientras no haya
// conexión. Con la sesión abierta manda además un latido para que el Administrador vea
// que el equipo está en línea. El latido también sirve para enterarse enseguida de que el servidor
// cerró la sesión (inactividad o cierre forzado) sin esperar a que el usuario toque algo.
export default function useConexion(logueado) {
  const [enLinea, setEnLinea] = useState(true)

  useEffect(() => {
    let vivo = true
    const chequear = async () => {
      const ok = await api.chequearConexion()
      if (!vivo) return
      api.setEnLinea(ok)
      setEnLinea(ok)
    }
    chequear()
    const id = setInterval(chequear, CADA_MS)
    window.addEventListener('online', chequear)
    window.addEventListener('offline', chequear)
    return () => {
      vivo = false
      clearInterval(id)
      window.removeEventListener('online', chequear)
      window.removeEventListener('offline', chequear)
    }
  }, [])

  useEffect(() => {
    if (!logueado) return
    const latir = () => api.ping().catch(() => {})
    latir()
    const id = setInterval(latir, LATIDO_MS)
    return () => clearInterval(id)
  }, [logueado])

  return enLinea
}
