import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import Spinner from '../Spinner'

const COLUMNAS = [['pendiente', 'Pendientes', 'border-amber-400'], ['en_preparacion', 'En preparación', 'border-marca-500'], ['listo', 'Listas', 'border-cafe-700']]
const SIGUIENTE = { pendiente: 'Empezar', en_preparacion: 'Listo', listo: 'Entregado' }

// Tablero de cocina (VEN-KDS): se renueva solo cada 10 segundos.
export default function Cocina({ addToast, usuario }) {
  const [comandas, setComandas] = useState(null)
  const [sectores, setSectores] = useState([])
  const [sector, setSector] = useState('')
  const puedeRetroceder = api.can(usuario, 'ventas.cocina.retroceder')

  const cargar = useCallback(async () => {
    try { setComandas(await api.llamar(`/cocina/comandas${api.qs({ sector_id: sector })}`)) }
    catch (err) { setComandas([]); addToast(err.message, 'error') }
  }, [sector, addToast])
  useEffect(() => {
    cargar()
    const id = setInterval(cargar, 10000)
    return () => clearInterval(id)
  }, [cargar])
  useEffect(() => { api.llamar('/depositos/sectores').then(setSectores).catch(() => {}) }, [])

  const mover = async (c, dir) => {
    try {
      if (dir === 'avanzar') await api.llamar(`/cocina/comandas/${c.id}/avanzar`, { method: 'POST' })
      else {
        const motivo = window.prompt('Motivo para volver atrás:')
        if (!motivo) return
        await api.llamar(`/cocina/comandas/${c.id}/retroceder`, { method: 'POST', body: { motivo } })
      }
      cargar()
    } catch (err) { addToast(err.message, 'error') }
  }

  if (!comandas) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>
  return (
    <div>
      <div className="flex items-center gap-3 mb-4 text-sm">
        {sectores.length > 0 && (
          <select value={sector} onChange={e => setSector(e.target.value)} className="campo">
            <option value="">Todos los sectores</option>
            {sectores.map(s => <option key={s.id} value={s.id}>{s.nombre}</option>)}
          </select>
        )}
        <button onClick={cargar} className="btn btn-azul btn-chico">Actualizar</button>
        <span className="text-stone-500">{comandas.length} comanda(s) en curso</span>
      </div>
      <div className="grid md:grid-cols-3 gap-4">
        {COLUMNAS.map(([estado, titulo, borde]) => (
          <div key={estado} className="bg-crema rounded-xl p-3 min-h-40">
            <p className="font-semibold text-stone-700 mb-3">{titulo} <span className="text-stone-400">({comandas.filter(c => c.avance === estado).length})</span></p>
            <div className="space-y-3">
              {comandas.filter(c => c.avance === estado).map(c => (
                <div key={c.id} className={`bg-white rounded-xl border-l-4 ${c.demorada ? 'border-rose-400' : borde} shadow-sm p-3 text-sm`}>
                  <div className="flex justify-between font-semibold">
                    <span>Mesa {c.numero_mesa}{c.sector ? ` · ${c.sector}` : ''}</span>
                    <span className={c.demorada ? 'text-rose-500' : 'text-stone-500'}>{c.minutos} min</span>
                  </div>
                  <ul className="mt-2 space-y-1">
                    {c.items.map((i, k) => (
                      <li key={k}>
                        <span className="font-semibold">{i.cantidad}×</span> {i.nombre}
                        {i.opciones?.length > 0 && <span className="block text-xs text-stone-500">{i.opciones.join(', ')}</span>}
                        {i.observaciones && <span className="block text-xs text-stone-500">“{i.observaciones}”</span>}
                        {i.alergenos?.length > 0 && <span className="etiqueta bg-rose-400 mt-1">Alérgenos</span>}
                      </li>
                    ))}
                  </ul>
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => mover(c, 'avanzar')} className="btn btn-azul btn-chico">{SIGUIENTE[estado]}</button>
                    {puedeRetroceder && estado !== 'pendiente' && <button onClick={() => mover(c, 'retroceder')} className="btn bg-stone-400 hover:bg-stone-500 btn-chico">Volver</button>}
                  </div>
                </div>
              ))}
              {comandas.filter(c => c.avance === estado).length === 0 && <p className="text-xs text-stone-400">Sin comandas.</p>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
