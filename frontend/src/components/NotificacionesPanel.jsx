import { useState, useEffect, useCallback } from 'react'
import * as api from '../api'
import Spinner from './Spinner'

const COLOR = {
  critica: 'bg-rose-100 text-rose-700',
  alta: 'bg-orange-100 text-orange-700',
  media: 'bg-amber-100 text-amber-700',
  baja: 'bg-gray-100 text-gray-600',
}
const hora = (ms) => new Date(Number(ms)).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })

// Centro de notificaciones (Usuarios RF17): las alertas dirigidas a los roles de la persona.
export default function NotificacionesPanel({ addToast, onCambio }) {
  const [datos, setDatos] = useState(null)

  const cargar = useCallback(async () => {
    try {
      const r = await api.getNotificaciones()
      setDatos(r)
      onCambio?.(r.nuevas)
    } catch (err) {
      addToast(err.message, 'error')
    }
  }, [addToast, onCambio])
  useEffect(() => { cargar() }, [cargar])

  const marcar = async (id, accion) => {
    try { await accion(id); cargar() } catch (err) { addToast(err.message, 'error') }
  }

  if (!datos) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-4">Notificaciones</h1>
      {datos.notificaciones.length === 0 ? (
        <div className="text-center py-16 text-gray-400">No hay notificaciones.</div>
      ) : (
        <ul className="space-y-3">
          {datos.notificaciones.map(n => (
            <li key={n.id} className={`bg-white rounded-xl border shadow-sm p-4 flex gap-4 items-start ${n.estado === 'resuelta' ? 'opacity-50' : ''}`}>
              <span className={`px-2 py-0.5 rounded-full text-xs font-semibold shrink-0 ${COLOR[n.severidad]}`}>{n.severidad}</span>
              <div className="flex-1 min-w-0">
                <p className={`text-sm text-gray-800 ${n.estado === 'nueva' ? 'font-semibold' : ''}`}>{n.mensaje}</p>
                <p className="text-xs text-gray-400 mt-0.5">{hora(n.ts_ms)} · {n.modulo}{n.resolucion ? ` · ${n.resolucion}` : ''}</p>
              </div>
              {n.estado !== 'resuelta' && (
                <div className="flex gap-2 shrink-0">
                  {n.estado === 'nueva' && <button onClick={() => marcar(n.id, api.marcarNotificacionLeida)} className="text-xs text-indigo-600 font-semibold">Marcar leída</button>}
                  <button onClick={() => marcar(n.id, api.resolverNotificacion)} className="text-xs text-emerald-600 font-semibold">Resolver</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
