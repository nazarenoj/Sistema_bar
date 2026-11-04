import { useState, useEffect } from 'react'
import * as api from '../api'
import Spinner from './Spinner'
import { dinero } from '../utils/formato'

const PERIODOS = [['dia', 'Hoy'], ['semana', 'Semana'], ['mes', 'Mes']]
const MODULOS = { ventas: 'Ventas', stock: 'Stock', clientes: 'Clientes', usuarios: 'Usuarios' }
const valor = (i) => {
  if (i.disponible === false) return '—'
  if (i.unidad === '$') return dinero(i.valor)
  const n = Number(i.valor).toLocaleString('es-AR', { maximumFractionDigits: 2 })
  return i.unidad ? `${n} ${i.unidad === '%' ? '%' : i.unidad}` : n
}

// Pantalla de inicio: los indicadores que el usuario puede ver (los resuelve el servidor según sus permisos).
export default function Inicio({ addToast }) {
  const [periodo, setPeriodo] = useState('dia')
  const [datos, setDatos] = useState(null)
  useEffect(() => {
    setDatos(null)
    api.llamar(`/tablero${api.qs({ periodo })}`).then(setDatos).catch(e => { addToast(e.message, 'error'); setDatos({ indicadores: [] }) })
  }, [periodo, addToast])

  return (
    <div>
      <div className="flex gap-1 mb-4">
        {PERIODOS.map(([id, t]) => (
          <button key={id} onClick={() => setPeriodo(id)} className={`px-4 py-1.5 text-sm rounded-full border ${periodo === id ? 'bg-cafe-800 text-white border-cafe-800' : 'bg-white text-stone-600 border-stone-300 hover:bg-stone-50'}`}>{t}</button>
        ))}
      </div>
      {!datos ? <div className="flex justify-center py-12"><Spinner size="lg" /></div> : datos.indicadores.length === 0 ? (
        <p className="text-stone-500 text-sm">No hay indicadores para mostrar con tus permisos.</p>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {datos.indicadores.map(i => (
            <div key={i.id} className="rounded-xl border border-stone-200 bg-crema p-4">
              <p className="text-xs uppercase tracking-wide text-stone-500">{MODULOS[i.modulo] ?? i.modulo}</p>
              <p className="text-sm text-stone-700 mb-1">{i.nombre}</p>
              <p className="text-2xl font-semibold text-cafe-800">{valor(i)}</p>
              {i.comparacion && !i.comparacion.sin_base && (
                <p className={`text-xs mt-1 ${i.comparacion.diferencia >= 0 ? 'text-marca-700' : 'text-rose-500'}`}>
                  {i.comparacion.diferencia >= 0 ? '▲' : '▼'} {Math.abs(i.comparacion.porcentaje)}% vs. período anterior
                </p>
              )}
              {i.atrasado && <p className="text-xs text-amber-600 mt-1">Dato atrasado</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
