import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

// Buscador con sugerencias en vivo para agregar un insumo a la receta de un producto.
// Clon de mesas/BuscadorProducto.jsx, con cantidad decimal (los insumos se miden en kg/litros/etc).
export default function BuscadorInsumo({ insumos, onAdd, disabled }) {
  const [query, setQuery] = useState('')
  const [seleccionado, setSeleccionado] = useState(null)
  const [cantidad, setCantidad] = useState('')
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState(null)
  const containerRef = useRef(null)
  const inputWrapRef = useRef(null)
  const dropdownRef = useRef(null)

  const texto = query.trim().toLowerCase()
  const coincidencias = texto === ''
    ? []
    : insumos.filter(i => i.nombre.toLowerCase().includes(texto)).slice(0, 8)

  useEffect(() => {
    const handleClickOutside = (e) => {
      const dentroInput = containerRef.current && containerRef.current.contains(e.target)
      const dentroDropdown = dropdownRef.current && dropdownRef.current.contains(e.target)
      if (!dentroInput && !dentroDropdown) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    const updateRect = () => {
      if (inputWrapRef.current) setRect(inputWrapRef.current.getBoundingClientRect())
    }
    updateRect()
    window.addEventListener('scroll', updateRect, true)
    window.addEventListener('resize', updateRect)
    return () => {
      window.removeEventListener('scroll', updateRect, true)
      window.removeEventListener('resize', updateRect)
    }
  }, [open, texto])

  const handleSelect = (insumo) => {
    setSeleccionado(insumo)
    setQuery(insumo.nombre)
    setOpen(false)
  }

  const handleQueryChange = (e) => {
    setQuery(e.target.value)
    setSeleccionado(null)
    setOpen(true)
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!seleccionado || cantidad === '') return
    onAdd(seleccionado.id, parseFloat(cantidad))
    setQuery('')
    setSeleccionado(null)
    setCantidad('')
  }

  const dropdownStyle = rect
    ? { position: 'fixed', top: rect.bottom + 4, left: rect.left, width: rect.width }
    : null

  return (
    <form onSubmit={handleSubmit} className="flex gap-2" ref={containerRef}>
      <div className="relative flex-1" ref={inputWrapRef}>
        <input
          type="text"
          value={query}
          disabled={disabled}
          placeholder="Buscar insumo…"
          onChange={handleQueryChange}
          onFocus={() => setOpen(true)}
          className="w-full border rounded-lg px-3 py-2 text-sm bg-white
            focus:outline-none focus:ring-2 focus:ring-marca-500"
        />
      </div>

      {open && dropdownStyle && coincidencias.length > 0 && createPortal(
        <ul ref={dropdownRef} style={dropdownStyle}
          className="z-[100] bg-white border rounded-lg shadow-lg max-h-52 overflow-y-auto">
          {coincidencias.map(i => (
            <li key={i.id}>
              <button type="button" onClick={() => handleSelect(i)}
                className="w-full text-left px-3 py-2 text-sm hover:bg-marca-50 flex justify-between gap-2">
                <span className="font-medium text-stone-800">{i.nombre}</span>
                <span className="text-stone-500 shrink-0">{i.unidad}</span>
              </button>
            </li>
          ))}
        </ul>,
        document.body
      )}
      {open && dropdownStyle && texto !== '' && coincidencias.length === 0 && createPortal(
        <div ref={dropdownRef} style={dropdownStyle}
          className="z-[100] bg-white border rounded-lg shadow-lg px-3 py-2 text-sm text-stone-400">
          Sin coincidencias
        </div>,
        document.body
      )}

      <input type="number" min="0" step="0.001" required value={cantidad}
        disabled={disabled}
        placeholder="Cant."
        onChange={e => setCantidad(e.target.value)}
        className="w-20 border rounded-lg px-2 py-2 text-sm text-center
          focus:outline-none focus:ring-2 focus:ring-marca-500" />
      <button type="submit" disabled={disabled || !seleccionado || cantidad === ''}
        className="bg-cafe-800 text-white px-4 py-2 rounded-lg text-sm font-semibold
          hover:bg-cafe-700 transition disabled:opacity-50">
        Añadir
      </button>
    </form>
  )
}
