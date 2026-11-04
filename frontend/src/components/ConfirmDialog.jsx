import { useEffect } from 'react'

export default function ConfirmDialog({ state, onResolve }) {
  const open = !!state

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onResolve(false)
      if (e.key === 'Enter') onResolve(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onResolve])

  if (!open) return null

  const {
    message,
    title = 'Confirmar',
    confirmLabel = 'Confirmar',
    cancelLabel = 'Cancelar',
    danger = true,
  } = state

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onResolve(false)}
    >
      <div className="animate-fade-in bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
        <div className="px-6 pt-6 pb-2">
          <h2 className="font-bold text-lg text-stone-900">{title}</h2>
          <p className="mt-2 text-sm text-stone-600">{message}</p>
        </div>
        <div className="flex gap-3 px-6 pb-6 pt-4">
          <button
            onClick={() => onResolve(false)}
            className="flex-1 border border-stone-300 text-stone-700 py-2 rounded-lg font-medium text-sm hover:bg-stone-50 transition"
          >
            {cancelLabel}
          </button>
          <button
            onClick={() => onResolve(true)}
            autoFocus
            className={`flex-1 py-2 rounded-lg font-medium text-sm text-white transition ${
              danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-cafe-800 hover:bg-cafe-700'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
