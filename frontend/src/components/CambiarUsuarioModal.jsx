import { useState } from 'react'
import * as api from '../api'
import Spinner from './Spinner'

// Cambio rápido de usuario en la terminal: se escribe el PIN o se pasa la tarjeta/llave (el lector
// "escribe" el código como un teclado). Cierra la sesión actual y abre la del otro usuario.
export default function CambiarUsuarioModal({ onCambiado, onClose }) {
  const [codigo, setCodigo] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const data = await api.cambiarUsuario(codigo)
      api.setToken(data.token)
      api.setUsuario(data.usuario)
      onCambiado(data.usuario)
    } catch (err) {
      setError(err.message)
      setCodigo('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="animate-fade-in bg-white rounded-2xl shadow-2xl w-full max-w-xs mx-4 overflow-hidden">
        <div className="bg-indigo-600 px-6 py-5 text-white flex justify-between items-center">
          <h2 className="font-bold text-lg">Cambiar de usuario</h2>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-white/20 transition text-xl leading-none">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-2.5 rounded-lg">{error}</div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">PIN o tarjeta</label>
            <input
              type="password"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              autoFocus
              required
              autoComplete="off"
              className="w-full border rounded-lg px-3 py-2 text-center text-lg tracking-widest focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>
          <button type="submit" disabled={submitting}
            className="w-full bg-indigo-600 text-white py-2 rounded-lg font-medium text-sm hover:bg-indigo-700 transition disabled:opacity-50 flex items-center justify-center gap-2">
            {submitting && <Spinner size="sm" />}
            Entrar
          </button>
        </form>
      </div>
    </div>
  )
}
