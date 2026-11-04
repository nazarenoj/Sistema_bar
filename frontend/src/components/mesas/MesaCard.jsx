import { useState, useEffect, useRef } from 'react'
import SillaItem from './SillaItem'

const GRID_STEP = 10
const snap = (value) => Math.max(0, Math.round(value / GRID_STEP) * GRID_STEP)
const DRAG_THRESHOLD = 4

export const DEFAULT_LIBRE = '#10b981'   // emerald-500
export const DEFAULT_OCUPADO = '#f43f5e' // rose-500

const MIN_TAMANO = 60
const MAX_TAMANO = 240

// Mesa (o grupo de mesas combinadas) del mapa del salón.
// Fuera de modo edición: sólo click para abrir el pedido, sin arrastre (evita moverla sin querer en servicio).
// En modo edición: arrastrable, seleccionable (para combinar), redimensionable y con accesos a color/eliminar/separar.
export default function MesaCard({
  mesa, size, editMode, selected, isGrupo, onClick, onDelete, onMove, onColorEdit, onSeparar, onResize,
  onAgregarSilla, onMoverSilla, onEliminarSilla,
}) {
  const libre = mesa.estado === 'libre'
  const [pos, setPos] = useState({ x: mesa.pos_x, y: mesa.pos_y })
  const [tamano, setTamano] = useState(mesa.tamano ?? 96)
  const dragRef = useRef(null)
  const resizeRef = useRef(null)

  useEffect(() => {
    if (!dragRef.current) setPos({ x: mesa.pos_x, y: mesa.pos_y })
  }, [mesa.pos_x, mesa.pos_y])

  useEffect(() => {
    if (!resizeRef.current) setTamano(mesa.tamano ?? 96)
  }, [mesa.tamano])

  const handlePointerDown = (e) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, moved: false, curX: pos.x, curY: pos.y }
  }

  const handlePointerMove = (e) => {
    if (!editMode) return
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) d.moved = true
    if (d.moved) {
      d.curX = Math.max(0, d.origX + dx)
      d.curY = Math.max(0, d.origY + dy)
      setPos({ x: d.curX, y: d.curY })
    }
  }

  const handlePointerUp = () => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (editMode && d.moved) {
      const snapped = { x: snap(d.curX), y: snap(d.curY) }
      setPos(snapped)
      onMove(snapped.x, snapped.y)
    } else {
      onClick()
    }
  }

  const handleResizeDown = (e) => {
    if (!editMode) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizeRef.current = { startX: e.clientX, startY: e.clientY, origTamano: tamano, curTamano: tamano }
  }

  const handleResizeMove = (e) => {
    e.stopPropagation()
    const r = resizeRef.current
    if (!r) return
    const delta = Math.max(e.clientX - r.startX, e.clientY - r.startY)
    r.curTamano = Math.min(MAX_TAMANO, Math.max(MIN_TAMANO, r.origTamano + delta))
    setTamano(r.curTamano)
  }

  const handleResizeUp = (e) => {
    e.stopPropagation()
    const r = resizeRef.current
    resizeRef.current = null
    if (!r) return
    const snapped = Math.min(MAX_TAMANO, Math.max(MIN_TAMANO, snap(r.curTamano)))
    setTamano(snapped)
    onResize(snapped)
  }

  const color = libre ? (mesa.color_libre || DEFAULT_LIBRE) : (mesa.color_ocupado || DEFAULT_OCUPADO)
  const numero = mesa.numero_mesa_grupo ?? mesa.numero_mesa
  const sillas = mesa.sillas ?? []
  // Para mesas combinadas (rectangulares) se usa el lado más chico, para que las sillas
  // no queden gigantes en una mesa larga.
  const tamanoMesa = Math.min(size?.width ?? tamano, size?.height ?? tamano)

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{
        position: 'absolute', left: pos.x, top: pos.y,
        width: size?.width ?? tamano,
        height: size?.height ?? tamano,
        backgroundColor: color,
        touchAction: 'none',
      }}
      className={`relative group rounded-2xl p-3 select-none flex flex-col items-center justify-center
        transition-shadow duration-300 hover:shadow-xl hover:brightness-110 shadow-lg
        ${editMode ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}
        ${selected ? 'ring-4 ring-marca-500 ring-offset-2' : ''}`}
    >
      {editMode && (
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onAgregarSilla() }}
            className="w-6 h-6 rounded-full bg-black/20 hover:bg-black/40 text-white text-xs flex items-center justify-center"
            title="Agregar silla"
          >
            🪑
          </button>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onColorEdit(e) }}
            className="w-6 h-6 rounded-full bg-black/20 hover:bg-black/40 text-white text-xs flex items-center justify-center"
            title="Colores"
          >
            🎨
          </button>
          {isGrupo && libre && (
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onSeparar() }}
              className="w-6 h-6 rounded-full bg-black/20 hover:bg-black/40 text-white text-xs flex items-center justify-center"
              title="Separar mesas"
            >
              🔓
            </button>
          )}
          {!isGrupo && (
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onDelete() }}
              className="w-6 h-6 rounded-full bg-black/20 hover:bg-black/40 text-white text-xs flex items-center justify-center"
              title="Eliminar mesa"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {sillas.map((s, i) => (
        <SillaItem
          key={s.id}
          silla={s}
          numero={i + 1}
          editMode={editMode}
          tamanoMesa={tamanoMesa}
          onMove={(x, y) => onMoverSilla(s.id, x, y)}
          onDelete={() => onEliminarSilla(s.id)}
        />
      ))}

      <p className="text-white/70 text-xs font-semibold uppercase tracking-widest mb-1">Mesa</p>
      <p className="text-white text-4xl font-black leading-none mb-2 truncate max-w-full px-1">{numero}</p>
      <span className="inline-block text-xs font-bold px-2 py-0.5 rounded-full text-white bg-black/25">
        {mesa.ticket_pendiente ? 'ticket pendiente' : mesa.estado}
      </span>

      {editMode && !isGrupo && (
        <div
          onPointerDown={handleResizeDown}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeUp}
          style={{ touchAction: 'none' }}
          className="absolute -bottom-1 -right-1 w-4 h-4 bg-white border-2 border-stone-400 rounded-sm
            cursor-nwse-resize opacity-0 group-hover:opacity-100 transition-opacity"
          title="Redimensionar"
        />
      )}
    </div>
  )
}
