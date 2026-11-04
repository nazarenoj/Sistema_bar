// Tabs para elegir el salón activo; alta/renombrado/borrado sólo visibles en modo edición.
export default function SalonSelector({ salones, salonActivoId, onSelect, editMode, onCreate, onRename, onDelete }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      {salones.map(salon => (
        <div key={salon.id} className="group relative">
          <button
            onClick={() => onSelect(salon.id)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition
              ${salon.id === salonActivoId
                ? 'bg-cafe-800 text-white shadow'
                : 'bg-white text-stone-600 border hover:bg-stone-50'}`}
          >
            {salon.nombre}
          </button>
          {editMode && (
            <div className="absolute -top-2 -right-2 hidden group-hover:flex gap-1">
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onRename(salon) }}
                title="Renombrar salón"
                className="w-5 h-5 rounded-full bg-cafe-700 text-white text-[10px] flex items-center justify-center"
              >
                ✎
              </button>
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onDelete(salon) }}
                title="Eliminar salón"
                className="w-5 h-5 rounded-full bg-rose-600 text-white text-[10px] flex items-center justify-center"
              >
                ✕
              </button>
            </div>
          )}
        </div>
      ))}
      {editMode && (
        <button
          onClick={onCreate}
          className="px-3 py-2 rounded-lg text-sm font-semibold border-2 border-dashed border-arena-300
            text-cafe-800 hover:bg-marca-50 transition"
        >
          + Salón
        </button>
      )}
    </div>
  )
}
