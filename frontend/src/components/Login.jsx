import { useState } from 'react'
import * as api from '../api'

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [terminal, setTerminal] = useState(api.getTerminal())
  const [instancia, setInstancia] = useState(api.getInstancia())
  const [verTerminal, setVerTerminal] = useState(false)
  const [error, setError] = useState('')
  const [aviso] = useState(api.getAviso())
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      api.setTerminal(terminal.trim().toUpperCase())
      api.setInstancia(instancia.trim().toUpperCase())
      const data = await api.login(username.trim(), password)
      api.clearAviso()
      api.setToken(data.token)
      api.setUsuario(data.usuario)
      onLogin(data.usuario)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm">
        <p className="text-xs font-semibold text-indigo-500 uppercase tracking-widest mb-1">Sistema</p>
        <h1 className="text-2xl font-black text-gray-800 mb-6">Chapola</h1>

        {aviso && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-2.5 rounded-lg mb-4">
            {aviso}
          </div>
        )}

        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
          Usuario
        </label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          required
          className="w-full border rounded-lg px-3 py-2 mb-4 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />

        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
          Contraseña
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="w-full border rounded-lg px-3 py-2 mb-4 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />

        {error && <p className="text-rose-600 text-sm mb-4">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-indigo-600 text-white py-2.5 rounded-xl font-bold hover:bg-indigo-700 transition disabled:opacity-50"
        >
          {submitting ? 'Ingresando…' : 'Ingresar'}
        </button>

        <div className="mt-5 text-center">
          {verTerminal || terminal || instancia ? (
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1 text-left">
                Código de esta terminal
              </label>
              <input
                type="text"
                value={terminal}
                onChange={(e) => setTerminal(e.target.value.toUpperCase())}
                maxLength={8}
                placeholder="Lo da el Administrador"
                className="w-full border rounded-lg px-3 py-2 text-sm font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1 mt-3 text-left">
                Cliente (solo si el Administrador lo indica)
              </label>
              <input
                type="text"
                value={instancia}
                onChange={(e) => setInstancia(e.target.value.toUpperCase())}
                maxLength={10}
                className="w-full border rounded-lg px-3 py-2 text-sm font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
            </div>
          ) : (
            <button type="button" onClick={() => setVerTerminal(true)} className="text-xs text-gray-400 hover:text-gray-600">
              Configurar terminal
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
