import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import Spinner from '../Spinner'
import UsuarioModal from './UsuarioModal'

const fecha = (v) => (v ? new Date(v).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—')

const estado = (u) => {
  if (!u.activo) return { texto: 'Desactivado', clase: 'bg-gray-100 text-gray-500' }
  if (!u.habilitado) return { texto: 'Baja cumplida', clase: 'bg-gray-100 text-gray-500' }
  if (u.bloqueo_min) return { texto: `Bloqueado ${u.bloqueo_min} min`, clase: 'bg-amber-100 text-amber-700' }
  if (u.fecha_baja) return { texto: `Baja el ${String(u.fecha_baja).slice(0, 10)}`, clase: 'bg-sky-100 text-sky-700' }
  return { texto: 'Activo', clase: 'bg-emerald-100 text-emerald-700' }
}

const boton = 'px-3 py-1 rounded-lg border text-xs font-semibold transition'

export default function UsuarioTabla({ addToast, confirm, usuario }) {
  const [usuarios, setUsuarios] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(undefined) // undefined=cerrado, null=nuevo, obj=editar
  const [reset, setReset] = useState(null) // { usuario, password, error }

  const cargar = useCallback(async () => {
    try {
      setUsuarios(await api.getUsuarios())
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [addToast])

  useEffect(() => { cargar() }, [cargar])

  const accion = async (fn, mensaje) => {
    try {
      await fn()
      addToast(mensaje)
      cargar()
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  const alternarActivo = async (u) => {
    if (u.activo && !(await confirm(`¿Desactivar a "${u.username}"? Se le cierran las sesiones abiertas.`, { title: 'Desactivar usuario' }))) return
    accion(() => (u.activo ? api.desactivarUsuario(u.id) : api.activarUsuario(u.id)), u.activo ? 'Usuario desactivado.' : 'Usuario activado.')
  }

  const restablecer = async (e) => {
    e.preventDefault()
    try {
      await api.resetPasswordUsuario(reset.usuario.id, reset.password)
      addToast('Contraseña restablecida.')
      setReset(null)
      cargar()
    } catch (err) {
      setReset(r => ({ ...r, error: err.message }))
    }
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button
          onClick={() => setModal(null)}
          className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition flex items-center gap-2"
        >
          <span className="text-lg leading-none">+</span> Nuevo usuario
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16"><Spinner size="lg" /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b text-gray-500 text-xs uppercase tracking-wider">
                  <th className="text-left px-5 py-3">Usuario</th>
                  <th className="text-left px-5 py-3">Nombre</th>
                  <th className="text-left px-5 py-3">Rol</th>
                  <th className="text-center px-5 py-3">Estado</th>
                  <th className="text-center px-5 py-3">PIN / Tarjeta</th>
                  <th className="text-left px-5 py-3">Último ingreso</th>
                  <th className="text-right px-5 py-3">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {usuarios.map(u => {
                  const e = estado(u)
                  const soyYo = u.id === usuario.id
                  return (
                    <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3.5 font-semibold text-gray-800">
                        {u.username}{soyYo && <span className="ml-2 text-xs text-gray-400">(vos)</span>}
                      </td>
                      <td className="px-5 py-3.5 text-gray-500">{u.nombre || '—'}</td>
                      <td className="px-5 py-3.5 text-gray-500">{u.roles?.map(r => r.nombre).join(', ') || u.rol}</td>
                      <td className="px-5 py-3.5 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${e.clase}`}>{e.texto}</span>
                        {!!u.debe_cambiar_password && (
                          <span className="ml-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-600">Cambia clave</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-center text-gray-500">
                        {u.tiene_pin ? 'PIN' : '—'} / {u.tiene_tarjeta ? 'Tarjeta' : '—'}
                      </td>
                      <td className="px-5 py-3.5 text-gray-500">{fecha(u.ultimo_login)}</td>
                      <td className="px-5 py-3.5">
                        <div className="flex gap-2 justify-end flex-wrap">
                          <button onClick={() => setModal(u)} className={`${boton} border-indigo-200 text-indigo-600 hover:bg-indigo-50`}>Editar</button>
                          {u.bloqueo_min > 0 && (
                            <button onClick={() => accion(() => api.desbloquearUsuario(u.id), 'Usuario desbloqueado.')}
                              className={`${boton} border-amber-200 text-amber-700 hover:bg-amber-50`}>Desbloquear</button>
                          )}
                          <button onClick={() => setReset({ usuario: u, password: '', error: '' })} className={`${boton} border-gray-300 text-gray-600 hover:bg-gray-50`}>Restablecer clave</button>
                          <button onClick={() => alternarActivo(u)}
                            className={`${boton} ${u.activo ? 'border-rose-200 text-rose-600 hover:bg-rose-50' : 'border-emerald-200 text-emerald-600 hover:bg-emerald-50'}`}>
                            {u.activo ? 'Desactivar' : 'Activar'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {reset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={(e) => e.target === e.currentTarget && setReset(null)}>
          <form onSubmit={restablecer} className="animate-fade-in bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 space-y-4">
            <h2 className="font-bold text-lg text-gray-800">Restablecer clave de {reset.usuario.username}</h2>
            <p className="text-sm text-gray-500">
              Se cierran sus sesiones abiertas y va a tener que cambiar esta contraseña temporal al ingresar.
            </p>
            {reset.error && (
              <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-2.5 rounded-lg">{reset.error}</div>
            )}
            <input type="text" value={reset.password} onChange={(e) => setReset(r => ({ ...r, password: e.target.value }))}
              placeholder="Contraseña temporal (mínimo 8)" required minLength={8} autoFocus
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
            <div className="flex gap-3">
              <button type="button" onClick={() => setReset(null)}
                className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg font-medium text-sm hover:bg-gray-50 transition">Cancelar</button>
              <button type="submit"
                className="flex-1 bg-indigo-600 text-white py-2 rounded-lg font-medium text-sm hover:bg-indigo-700 transition">Restablecer</button>
            </div>
          </form>
        </div>
      )}

      {modal !== undefined && (
        <UsuarioModal usuario={modal} onClose={() => setModal(undefined)} onSaved={cargar} addToast={addToast} />
      )}
    </div>
  )
}
