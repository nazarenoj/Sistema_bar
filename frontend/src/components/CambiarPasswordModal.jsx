import { useState } from 'react'
import * as api from '../api'
import Spinner from './Spinner'

// Cambio de contraseña. Con `forzado` (primer ingreso o restablecida por un Administrador) no se
// puede cerrar: hasta cambiarla el servidor no deja usar nada más.
export default function CambiarPasswordModal({ forzado, onDone, onClose, addToast }) {
  const [actual, setActual] = useState('')
  const [nueva, setNueva] = useState('')
  const [repetir, setRepetir] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (nueva !== repetir) return setError('Las contraseñas nuevas no coinciden.')
    setError('')
    setSubmitting(true)
    try {
      await api.cambiarPassword(actual, nueva)
      addToast('Contraseña actualizada.')
      onDone()
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const campo = 'w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => !forzado && e.target === e.currentTarget && onClose()}
    >
      <div className="animate-fade-in bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
        <div className="bg-indigo-600 px-6 py-5 text-white flex justify-between items-center">
          <h2 className="font-bold text-lg">{forzado ? 'Elegí tu contraseña' : 'Cambiar contraseña'}</h2>
          {!forzado && (
            <button onClick={onClose} className="p-1 rounded-full hover:bg-white/20 transition text-xl leading-none">✕</button>
          )}
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {forzado && (
            <p className="text-sm text-gray-600">
              Tenés que cambiar la contraseña que te dieron antes de usar el sistema.
            </p>
          )}
          {error && (
            <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-2.5 rounded-lg">{error}</div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Contraseña actual</label>
            <input type="password" value={actual} onChange={(e) => setActual(e.target.value)} required autoFocus className={campo} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Contraseña nueva</label>
            <input type="password" value={nueva} onChange={(e) => setNueva(e.target.value)} required minLength={8} className={campo} />
            <p className="text-xs text-gray-400 mt-1">Mínimo 8 caracteres.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Repetir la nueva</label>
            <input type="password" value={repetir} onChange={(e) => setRepetir(e.target.value)} required className={campo} />
          </div>

          <div className="flex gap-3 pt-2">
            {!forzado && (
              <button type="button" onClick={onClose}
                className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg font-medium text-sm hover:bg-gray-50 transition">
                Cancelar
              </button>
            )}
            <button type="submit" disabled={submitting}
              className="flex-1 bg-indigo-600 text-white py-2 rounded-lg font-medium text-sm hover:bg-indigo-700 transition disabled:opacity-50 flex items-center justify-center gap-2">
              {submitting && <Spinner size="sm" />}
              Guardar
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
