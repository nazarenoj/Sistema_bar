import { useState } from 'react'
import { descargarArchivo } from '../../utils/ticket'
import FormatoArchivoSelector from './FormatoArchivoSelector'
import { formatoPorValue, metodoPagoLabel, estadoFacturaLabel, conFacturaLabel } from './constantes'

const formatFechaCorta = (iso) => {
  if (!iso) return ''
  const [a, m, d] = iso.split('-')
  return `${d}/${m}/${a}`
}

// Describe los filtros aplicados en la pantalla como chips, con las mismas etiquetas que la barra
// de filtros. El backend hace lo suyo por separado (ver describirFiltros en pedidoController) para
// dejarlos escritos dentro del archivo; acá es solo para que el usuario confirme qué va a exportar.
const describirFiltros = (f) => {
  const chips = []
  if (f.desde && f.hasta) chips.push(`Del ${formatFechaCorta(f.desde)} al ${formatFechaCorta(f.hasta)}`)
  else if (f.desde) chips.push(`Desde el ${formatFechaCorta(f.desde)}`)
  else if (f.hasta) chips.push(`Hasta el ${formatFechaCorta(f.hasta)}`)
  if (f.numero_mesa) chips.push(`Mesa ${f.numero_mesa}`)
  if (f.metodo_pago) chips.push(metodoPagoLabel(f.metodo_pago))
  if (f.con_factura) chips.push(conFacturaLabel(f.con_factura))
  if (f.estado_factura) chips.push(estadoFacturaLabel(f.estado_factura))
  return chips
}

// Exporta el historial de cuentas cerradas que coincide con los filtros aplicados en la pantalla.
// Los filtros se muestran en modo lectura a propósito: la única forma de cambiarlos es la barra de
// filtros del historial, así no hay dos lugares distintos donde configurar el mismo recorte y lo
// que se descarga siempre es lo que se está viendo.
export default function ReporteHistorialModal({ filtrosAplicados, sort, order, onClose, addToast }) {
  const [formato, setFormato] = useState('xlsx')
  const [incluirItems, setIncluirItems] = useState(true)
  const [generando, setGenerando] = useState(false)

  const chips = describirFiltros(filtrosAplicados)

  const handleGenerar = async () => {
    setGenerando(true)
    try {
      const params = new URLSearchParams({ formato, incluir_items: incluirItems ? '1' : '0' })
      // Mismo criterio que getHistorialPedidos en api/index.js: los filtros vacíos no se mandan.
      Object.entries({ ...filtrosAplicados, sort, order }).forEach(([k, v]) => { if (v) params.set(k, v) })

      const { ext } = formatoPorValue(formato)
      const sufijo = filtrosAplicados.desde || filtrosAplicados.hasta
        ? `${filtrosAplicados.desde || 'inicio'}_a_${filtrosAplicados.hasta || 'hoy'}`
        : 'completo'
      await descargarArchivo(`/api/pedidos/reporte?${params}`, `historial-ventas-${sufijo}.${ext}`)
      onClose()
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setGenerando(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="animate-fade-in bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="bg-cafe-800 px-6 py-5 text-white flex justify-between items-center">
          <h2 className="font-bold text-lg">Exportar historial filtrado</h2>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-white/20 transition text-xl leading-none">✕</button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-2">
              Se va a exportar
            </p>
            {chips.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {chips.map((chip) => (
                  <span key={chip} className="text-xs font-semibold px-2 py-1 rounded-full bg-marca-50 text-cafe-800">
                    {chip}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
                Sin filtros: se exporta el historial completo. Si son muchas ventas, conviene acotar
                el rango de fechas en la pantalla antes de descargar.
              </p>
            )}
            <p className="text-xs text-stone-400 mt-2">
              Son los filtros aplicados en la pantalla. Para cambiarlos, cerrá este cuadro y usá la
              barra de filtros del historial.
            </p>
          </div>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={incluirItems}
              onChange={(e) => setIncluirItems(e.target.checked)}
              className="mt-0.5 accent-cafe-800"
            />
            <span className="text-sm text-stone-700">
              Incluir detalle de ítems vendidos
              <span className="block text-xs text-stone-400">
                Agrega cada producto de cada cuenta, con cantidad y subtotal.
              </span>
            </span>
          </label>

          <FormatoArchivoSelector value={formato} onChange={setFormato} disabled={generando} />

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg border text-stone-600 text-sm font-semibold hover:bg-stone-50 transition"
            >
              Cancelar
            </button>
            <button
              onClick={handleGenerar}
              disabled={generando}
              className="px-4 py-2 rounded-lg bg-cafe-800 text-white text-sm font-semibold hover:bg-cafe-700 transition disabled:opacity-50"
            >
              {generando ? 'Generando…' : `⬇ Descargar ${formatoPorValue(formato).label}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
