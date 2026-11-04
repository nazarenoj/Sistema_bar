import { useState, useEffect, useRef } from 'react'

const GRID_STEP = 10
const snap = (value) => Math.round(value / GRID_STEP) * GRID_STEP
const DRAG_THRESHOLD = 4
const LIMITE = 400 // margen amplio para poder ubicarla bien afuera del cuadro de la mesa

// Tamaño de mesa de referencia (el default al crearla) para el que el dibujo de la silla
// tiene su tamaño base; en mesas más grandes/chicas escala proporcionalmente.
const TAMANO_REFERENCIA = 96
const ESCALA_MIN = 0.85
const ESCALA_MAX = 2.2
const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

// Silla dibujada alrededor de una mesa. Su posición (pos_x/pos_y) es relativa al cuadro de la
// mesa (0,0 = esquina superior izquierda), así que viaja con la mesa sin cálculos extra.
// Su tamaño visual está ligado al tamaño de la mesa (tamanoMesa). Sólo se puede arrastrar o
// eliminar en modo edición; el número es fijo (no depende de pedidos).
export default function SillaItem({ silla, numero, editMode, tamanoMesa, onMove, onDelete }) {
  const [pos, setPos] = useState({ x: silla.pos_x, y: silla.pos_y })
  const dragRef = useRef(null)

  useEffect(() => {
    if (!dragRef.current) setPos({ x: silla.pos_x, y: silla.pos_y })
  }, [silla.pos_x, silla.pos_y])

  const handlePointerDown = (e) => {
    if (!editMode || e.button !== 0) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, moved: false, curX: pos.x, curY: pos.y }
  }

  const handlePointerMove = (e) => {
    if (!editMode) return
    e.stopPropagation()
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) d.moved = true
    if (d.moved) {
      d.curX = Math.max(-LIMITE, Math.min(LIMITE, d.origX + dx))
      d.curY = Math.max(-LIMITE, Math.min(LIMITE, d.origY + dy))
      setPos({ x: d.curX, y: d.curY })
    }
  }

  const handlePointerUp = (e) => {
    if (!editMode) return
    e.stopPropagation()
    const d = dragRef.current
    dragRef.current = null
    if (!d || !d.moved) return
    const snapped = { x: snap(d.curX), y: snap(d.curY) }
    setPos(snapped)
    onMove(snapped.x, snapped.y)
  }

  const escala = clamp((tamanoMesa ?? TAMANO_REFERENCIA) / TAMANO_REFERENCIA, ESCALA_MIN, ESCALA_MAX)
  const emojiSize = Math.round(26 * escala)
  const badgeSize = Math.round(17 * escala)
  const badgeFont = Math.round(10 * escala)
  const eliminarSize = Math.round(15 * escala)

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{
        position: 'absolute', left: pos.x, top: pos.y,
        transform: 'translate(-50%, -50%)',
        touchAction: 'none',
      }}
      className={`group/silla select-none ${editMode ? 'cursor-grab active:cursor-grabbing' : 'pointer-events-none'}`}
      title={`Silla ${numero}`}
    >
      <span style={{ fontSize: emojiSize }} className="block leading-none drop-shadow">🪑</span>
      <span
        style={{ width: badgeSize, height: badgeSize, fontSize: badgeFont }}
        className="absolute -bottom-1 -right-1 bg-white text-stone-800 font-bold
          rounded-full flex items-center justify-center border border-stone-300 pointer-events-none"
      >
        {numero}
      </span>

      {editMode && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          title="Eliminar silla"
          style={{ width: eliminarSize, height: eliminarSize, fontSize: Math.round(eliminarSize * 0.55) }}
          className="absolute -top-2 -left-2 rounded-full bg-rose-600 text-white
            leading-none flex items-center justify-center opacity-0
            group-hover/silla:opacity-100 transition-opacity"
        >
          ✕
        </button>
      )}
    </div>
  )
}
