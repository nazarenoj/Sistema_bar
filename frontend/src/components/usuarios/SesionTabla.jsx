import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import Spinner from '../Spinner'

const hora = (v) => (v ? new Date(v).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—')

export default function SesionTabla({ addToast, confirm }) {
  const [sesiones, setSesiones] = useState([])
  const [loading, setLoading] = useState(true)

  const cargar = useCallback(async () => {
    try {
      setSesiones(await api.getSesiones())
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [addToast])

  useEffect(() => {
    cargar()
    const id = setInterval(cargar, 15000)
    return () => clearInterval(id)
  }, [cargar])

  const cerrar = async (s) => {
    if (!(await confirm(`¿Cerrar la sesión de "${s.username}"${s.terminal ? ` en ${s.terminal}` : ''}?`, { title: 'Cerrar sesión' }))) return
    try {
      await api.cerrarSesionForzada(s.id)
      addToast('Sesión cerrada.')
      cargar()
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
      {loading ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : sesiones.length === 0 ? (
        <div className="text-center py-16 text-gray-400">No hay sesiones abiertas.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b text-gray-500 text-xs uppercase tracking-wider">
                <th className="text-left px-5 py-3">Usuario</th>
                <th className="text-left px-5 py-3">Terminal</th>
                <th className="text-left px-5 py-3">Inicio</th>
                <th className="text-left px-5 py-3">Última actividad</th>
                <th className="text-left px-5 py-3">IP</th>
                <th className="text-right px-5 py-3">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {sesiones.map(s => (
                <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3.5 font-semibold text-gray-800">
                    {s.username}<span className="ml-2 text-xs text-gray-400 capitalize">{s.rol}</span>
                  </td>
                  <td className="px-5 py-3.5 text-gray-500">{s.terminal || 'Equipo sin registrar'}</td>
                  <td className="px-5 py-3.5 text-gray-500">{hora(s.inicio)}</td>
                  <td className="px-5 py-3.5 text-gray-500">{hora(s.ultimo_acceso)}</td>
                  <td className="px-5 py-3.5 text-gray-400">{s.ip || '—'}</td>
                  <td className="px-5 py-3.5 text-right">
                    <button onClick={() => cerrar(s)}
                      className="px-3 py-1 rounded-lg border border-rose-200 text-rose-600 text-xs font-semibold hover:bg-rose-50 transition">
                      Cerrar sesión
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
