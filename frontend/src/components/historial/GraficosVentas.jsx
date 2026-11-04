import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import Spinner from '../Spinner'

const hoyISO = () => new Date().toISOString().slice(0, 10)

const TIPOS = [
  { value: 'dia', label: 'Día (por hora)' },
  { value: 'semana', label: 'Semana (por día)' },
  { value: 'mes', label: 'Mes (por día)' },
]

// Barras horizontales simples (una fila por hora/día): el ancho de la barra es un % del ancho
// del contenedor, que es mucho más robusto en CSS que animar/calcular alturas dentro de flexbox.
// Una sola serie de magnitud, un solo color — no hace falta leyenda (el título ya la nombra).
export default function GraficosVentas({ addToast }) {
  const [tipo, setTipo] = useState('dia')
  const [fecha, setFecha] = useState(hoyISO())
  const [modo, setModo] = useState('monto') // 'monto' | 'porcentaje'
  const [datos, setDatos] = useState([])
  const [totalPeriodo, setTotalPeriodo] = useState(0)
  const [rango, setRango] = useState({ desde: '', hasta: '' })
  const [loading, setLoading] = useState(true)

  const fetchDatos = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.getEstadisticasVentas(tipo, fecha)
      setDatos(data.datos)
      setTotalPeriodo(data.total_periodo)
      setRango({ desde: data.desde, hasta: data.hasta })
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [tipo, fecha, addToast])

  useEffect(() => { fetchDatos() }, [fetchDatos])

  const valores = datos.map(d => (modo === 'monto' ? d.total : d.porcentaje))
  const max = Math.max(1, ...valores)

  return (
    <div className="bg-white rounded-2xl shadow-sm border p-5 mb-4">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h2 className="font-bold text-stone-800 mb-1">
            Ventas {tipo === 'dia' ? 'por hora' : 'por día'}
          </h2>
          <p className="text-xs text-stone-400">
            {rango.desde === rango.hasta ? rango.desde : `${rango.desde} a ${rango.hasta}`}
            {' · '}Total del período:{' '}
            <span className="font-semibold text-stone-600">${totalPeriodo.toFixed(2)}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <select
            value={tipo}
            onChange={(e) => setTipo(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm"
          >
            {TIPOS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <input
            type="date"
            value={fecha}
            onChange={(e) => setFecha(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm"
          />
          <div className="flex rounded-lg border overflow-hidden text-sm">
            <button
              onClick={() => setModo('monto')}
              className={`px-3 py-1.5 font-semibold transition ${
                modo === 'monto' ? 'bg-cafe-800 text-white' : 'bg-white text-stone-600 hover:bg-stone-50'
              }`}
            >
              $ Monto
            </button>
            <button
              onClick={() => setModo('porcentaje')}
              className={`px-3 py-1.5 font-semibold transition ${
                modo === 'porcentaje' ? 'bg-cafe-800 text-white' : 'bg-white text-stone-600 hover:bg-stone-50'
              }`}
            >
              % Porcentaje
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Spinner size="lg" /></div>
      ) : totalPeriodo === 0 ? (
        <div className="text-center py-12 text-stone-400 text-sm">No hay ventas registradas en este período.</div>
      ) : (
        <div className="max-h-96 overflow-y-auto pr-1 space-y-1.5">
          {datos.map((d) => {
            const valor = modo === 'monto' ? d.total : d.porcentaje
            const anchoPct = valor > 0 ? Math.max((valor / max) * 100, 1.5) : 0
            return (
              <div key={d.clave} className="flex items-center gap-3">
                <div className="w-12 shrink-0 text-xs text-stone-500 text-right">{d.etiqueta}</div>
                <div className="flex-1 bg-stone-100 rounded-full h-4 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-cafe-700"
                    style={{ width: `${anchoPct}%` }}
                  />
                </div>
                <div className="w-24 shrink-0 text-xs text-stone-600 font-semibold text-right">
                  {modo === 'monto' ? `$${valor.toFixed(2)}` : `${valor}%`}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
