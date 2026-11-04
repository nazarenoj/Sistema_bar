// Ventana modal común: cierra con Escape o al tocar fuera.
import { useEffect } from 'react'

export default function Modal({ titulo, onClose, ancho = 'max-w-2xl', children, pie }) {
  useEffect(() => {
    const f = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 bg-cafe-900/40 flex items-start justify-center p-4 overflow-y-auto" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`w-full ${ancho} bg-white rounded-2xl shadow-xl border border-stone-200 mt-10`}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-stone-200">
          <h2 className="font-semibold text-stone-800">{titulo}</h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-xl leading-none" aria-label="Cerrar">×</button>
        </div>
        <div className="p-5">{children}</div>
        {pie && <div className="px-5 py-3 border-t border-stone-200 flex justify-end gap-2">{pie}</div>}
      </div>
    </div>
  )
}

export const Campo = ({ etiqueta, children, className = '' }) => (
  <label className={`block text-sm text-stone-600 ${className}`}>
    <span className="block mb-1">{etiqueta}</span>
    {children}
  </label>
)

export const Tarjeta = ({ titulo, valor, nota }) => (
  <div className="rounded-xl border border-stone-200 bg-crema px-4 py-3">
    <p className="text-xs uppercase tracking-wide text-stone-500">{titulo}</p>
    <p className="text-xl font-semibold text-cafe-800">{valor}</p>
    {nota && <p className="text-xs text-stone-500">{nota}</p>}
  </div>
)
