import { FORMATOS, formatoPorValue } from './constantes'

// Selector de formato de descarga, compartido por los dos modales de reporte.
export default function FormatoArchivoSelector({ value, onChange, disabled }) {
  const seleccionado = formatoPorValue(value)

  return (
    <div>
      <label className="block text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">
        Formato del archivo
      </label>
      <div className="grid grid-cols-4 gap-2">
        {FORMATOS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => onChange(f.value)}
            disabled={disabled}
            aria-pressed={value === f.value}
            className={`px-2 py-1.5 rounded-lg text-sm font-semibold border transition disabled:opacity-50 ${
              value === f.value
                ? 'bg-cafe-800 text-white border-cafe-800'
                : 'bg-white text-cafe-800 border-arena-300 hover:bg-marca-50'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-stone-500 mt-1.5">{seleccionado.hint}</p>
    </div>
  )
}
