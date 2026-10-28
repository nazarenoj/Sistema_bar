import { useState } from 'react'

// Pide la credencial de un supervisor cuando una acción "requiere autorización" (Usuarios RF05).
// El supervisor tiene que ser otro usuario: el servidor rechaza la autorización propia.
export default function AutorizacionModal({ permiso, onResolve }) {
  const [conPassword, setConPassword] = useState(false)
  const [usuario, setUsuario] = useState('')
  const [credencial, setCredencial] = useState('')

  const enviar = (e) => {
    e.preventDefault()
    onResolve({ credencial, ...(conPassword && { usuario: usuario.trim() }) })
  }
  const campo = 'w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400'

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <form onSubmit={enviar} className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 space-y-4">
        <h2 className="font-bold text-lg text-gray-800">Necesita autorización</h2>
        <p className="text-sm text-gray-500">
          Esta acción ({permiso}) la tiene que aprobar un supervisor. Que ponga su {conPassword ? 'usuario y contraseña' : 'PIN o pase su tarjeta'}.
        </p>
        {conPassword && <input value={usuario} onChange={(e) => setUsuario(e.target.value)} placeholder="Usuario del supervisor" required className={campo} />}
        <input type="password" value={credencial} onChange={(e) => setCredencial(e.target.value)} autoFocus required
          placeholder={conPassword ? 'Contraseña' : 'PIN o tarjeta'} autoComplete="off" className={campo} />
        <button type="button" onClick={() => setConPassword(!conPassword)} className="text-xs text-indigo-600">
          {conPassword ? 'Usar PIN o tarjeta' : 'Usar usuario y contraseña'}
        </button>
        <div className="flex gap-3">
          <button type="button" onClick={() => onResolve(null)} className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg font-medium text-sm hover:bg-gray-50">Cancelar</button>
          <button type="submit" className="flex-1 bg-indigo-600 text-white py-2 rounded-lg font-medium text-sm hover:bg-indigo-700">Autorizar</button>
        </div>
      </form>
    </div>
  )
}
