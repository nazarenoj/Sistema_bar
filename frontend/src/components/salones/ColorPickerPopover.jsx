import { useEffect, useRef } from 'react'

// Popover flotante y genérico para editar uno o más colores (mesa libre/ocupada, fondo de salón, etc.)
// `fields`: [{ key, label, value }]. `onChange(key, value)` se dispara en vivo; `onClose` al hacer click afuera.
export default function ColorPickerPopover({ anchorPos, title, fields, onChange, onClose }) {
  const ref = useRef(null)

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  const left = Math.min(Math.max(8, anchorPos.x), window.innerWidth - 232)
  const top  = Math.min(Math.max(8, anchorPos.y), window.innerHeight - 200)

  return (
    <div
      ref={ref}
      style={{ position: 'fixed', left, top, zIndex: 60 }}
      className="bg-white rounded-xl shadow-2xl border w-56 p-4 space-y-3 animate-fade-in"
    >
      {title && <p className="text-xs font-bold text-stone-500 uppercase tracking-wide">{title}</p>}
      {fields.map(({ key, label, value }) => (
        <label key={key} className="flex items-center justify-between text-sm text-stone-600 gap-3">
          {label}
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(key, e.target.value)}
            className="w-10 h-8 rounded cursor-pointer border"
          />
        </label>
      ))}
      <button
        onClick={onClose}
        className="w-full text-xs font-semibold text-cafe-800 hover:text-cafe-900 pt-1"
      >
        Cerrar
      </button>
    </div>
  )
}
