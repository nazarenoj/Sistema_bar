import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

// Buscador con sugerencias en vivo para agregar un producto a un pedido (reemplaza al <select>).
// La lista de sugerencias se renderiza en un portal a document.body y se posiciona por coordenadas
// reales del input, para no quedar recortada por los contenedores con overflow-hidden/auto del modal.
export default function BuscadorProducto({ productos, onAdd, disabled }) {
  const [query, setQuery] = useState('')
  const [seleccionado, setSeleccionado] = useState(null)
  const [cantidad, setCantidad] = useState(1)
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState(null)
  const containerRef = useRef(null)
  const inputWrapRef = useRef(null)
  const dropdownRef = useRef(null)

  const texto = query.trim().toLowerCase()
  const coincidencias = texto === ''
    ? []
    : productos.filter(p => p.nombre.toLowerCase().includes(texto)).slice(0, 8)

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

  const handleSelect = (producto) => {
    setSeleccionado(producto)
    setQuery(producto.nombre)
    setOpen(false)
  }

  const handleQueryChange = (e) => {
    setQuery(e.target.value)
    setSeleccionado(null)
    setOpen(true)
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!seleccionado) return
    onAdd(seleccionado.id, parseInt(cantidad, 10))
    setQuery('')
    setSeleccionado(null)
    setCantidad(1)
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
          placeholder="Buscar producto…"
          onChange={handleQueryChange}
          onFocus={() => setOpen(true)}
          className="w-full border rounded-lg px-3 py-2 text-sm bg-white
            focus:outline-none focus:ring-2 focus:ring-marca-500"
        />
      </div>

      {open && dropdownStyle && coincidencias.length > 0 && createPortal(
        <ul ref={dropdownRef} style={dropdownStyle}
          className="z-[100] bg-white border rounded-lg shadow-lg max-h-52 overflow-y-auto">
          {coincidencias.map(p => (
            <li key={p.id}>
              <button type="button" onClick={() => handleSelect(p)}
                className="w-full text-left px-3 py-2 text-sm hover:bg-marca-50 flex justify-between gap-2">
                <span className="font-medium text-stone-800">{p.nombre}</span>
                <span className="text-stone-500 shrink-0">${Number(p.precio).toFixed(2)}</span>
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

      <input type="number" min="1" required value={cantidad}
        disabled={disabled}
        onChange={e => setCantidad(e.target.value)}
        className="w-16 border rounded-lg px-2 py-2 text-sm text-center
          focus:outline-none focus:ring-2 focus:ring-marca-500" />
      <button type="submit" disabled={disabled || !seleccionado}
        className="bg-cafe-800 text-white px-4 py-2 rounded-lg text-sm font-semibold
          hover:bg-cafe-700 transition disabled:opacity-50">
        Añadir
      </button>
    </form>
  )
}
