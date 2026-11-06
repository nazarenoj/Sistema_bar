import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import { Campo, Tarjeta } from '../layout/Modal'
import Spinner from '../Spinner'

// Enlace del segundo factor del propio usuario: pedir el secreto, cargarlo en la app del teléfono y confirmar con un código.
export default function SegundoFactor({ addToast }) {
  const [estado, setEstado] = useState(null)
  const [enlace, setEnlace] = useState(null) // { secreto, uri }
  const [codigo, setCodigo] = useState('')
  const [recuperacion, setRecuperacion] = useState(null)

  const cargar = useCallback(() => api.llamar('/2fa').then(setEstado).catch(e => { addToast(e.message, 'error'); setEstado({}) }), [addToast])
  useEffect(() => { cargar() }, [cargar])

  const iniciar = async () => {
    try { setEnlace(await api.llamar('/2fa/iniciar', { method: 'POST' })) } catch (e) { addToast(e.message, 'error') }
  }
  const confirmar = async (e) => {
    e.preventDefault()
    try {
      const r = await api.llamar('/2fa/confirmar', { method: 'POST', body: { codigo } })
      setRecuperacion(r.codigos ?? r.codigos_recuperacion ?? []); setEnlace(null); setCodigo(''); addToast('Verificación en dos pasos activada.'); cargar()
    } catch (err) { addToast(err.message, 'error') }
  }

  if (!estado) return <div className="flex justify-center py-12"><Spinner size="lg" /></div>
  return (
    <div className="space-y-4 max-w-xl">
      <div className="grid grid-cols-3 gap-3">
        <Tarjeta titulo="Estado" valor={estado.enlazado ? 'Activada' : 'Sin activar'} />
        <Tarjeta titulo="Tu rol la exige" valor={estado.exigido ? 'Sí' : 'No'} />
        <Tarjeta titulo="Códigos de rescate" valor={estado.codigos_restantes ?? 0} />
      </div>

      {!estado.enlazado && !enlace && <button onClick={iniciar} className="btn btn-azul">Activar verificación en dos pasos</button>}

      {enlace && (
        <form onSubmit={confirmar} className="rounded-xl border border-stone-200 bg-crema p-4 space-y-3 text-sm">
          <p>1. En tu app de autenticación (Google Authenticator, Authy…) agregá una cuenta nueva con esta clave:</p>
          <p className="font-mono text-base break-all bg-white border rounded-lg p-2 select-all">{enlace.secreto}</p>
          <p className="text-xs text-stone-500">Si tu app lee enlaces: <a className="underline" href={enlace.uri}>abrir en la app</a>.</p>
          <p>2. Escribí el código de 6 dígitos que te muestra la app:</p>
          <Campo etiqueta="Código"><input required inputMode="numeric" maxLength={6} value={codigo} onChange={e => setCodigo(e.target.value)} className="campo w-32" /></Campo>
          <button className="btn btn-azul">Confirmar</button>
        </form>
      )}

      {recuperacion && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
          <p className="font-semibold mb-2">Guardá estos códigos de rescate: se muestran una sola vez.</p>
          <ul className="grid grid-cols-2 gap-1 font-mono">{recuperacion.map(c => <li key={c}>{c}</li>)}</ul>
        </div>
      )}
    </div>
  )
}
