import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import Spinner from '../Spinner'

const hora = (ms) => new Date(Number(ms)).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'medium' })
const campo = 'border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-marca-500'

export default function AuditoriaTabla({ addToast }) {
  const [filas, setFilas] = useState([])
  const [filtros, setFiltros] = useState({ modulo: '', resultado: '' })
  const [loading, setLoading] = useState(true)
  const [hayMas, setHayMas] = useState(false)
  const [integridad, setIntegridad] = useState(null)

  const cargar = useCallback(async (mas = false) => {
    try {
      const q = Object.fromEntries(Object.entries({ ...filtros, limite: 50 }).filter(([, v]) => v !== ''))
      if (mas && filas.length) q.antes_de = filas[filas.length - 1].id
      const r = await api.getAuditoria(q)
      setFilas(mas ? [...filas, ...r] : r)
      setHayMas(r.length === 50)
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [filtros, filas, addToast])
  useEffect(() => { setLoading(true); cargar() }, [filtros]) // eslint-disable-line react-hooks/exhaustive-deps

  const verificar = async () => {
    try { setIntegridad(await api.verificarAuditoria()) } catch (err) { addToast(err.message, 'error') }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-3 items-center mb-4">
        <select value={filtros.modulo} onChange={(e) => setFiltros(f => ({ ...f, modulo: e.target.value }))} className={campo}>
          <option value="">Todos los módulos</option>
          {['sesiones', 'usuarios', 'permisos', 'terminales'].map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={filtros.resultado} onChange={(e) => setFiltros(f => ({ ...f, resultado: e.target.value }))} className={campo}>
          <option value="">Todos los resultados</option>
          <option value="ok">Correctos</option><option value="denegado">Denegados</option><option value="error">Con error</option>
        </select>
        <button onClick={verificar} className="px-3 py-1.5 rounded-lg border border-arena-300 text-cafe-800 text-sm font-semibold hover:bg-marca-50">Verificar integridad</button>
        {integridad && (
          <span className={`text-sm font-semibold ${integridad.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
            {integridad.ok ? `Cadena íntegra (${integridad.total} eventos)` : `Cadena rota en el evento ${integridad.primer_roto}`}
          </span>
        )}
      </div>
      <div className="bg-white rounded-2xl shadow-sm border overflow-x-auto">
        {loading ? <div className="flex justify-center py-16"><Spinner size="lg" /></div> : (
          <table className="w-full text-sm">
            <thead><tr className="bg-stone-50 border-b text-stone-500 text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-3">Fecha</th><th className="text-left px-4 py-3">Usuario</th>
              <th className="text-left px-4 py-3">Acción</th><th className="text-left px-4 py-3">Detalle</th>
            </tr></thead>
            <tbody className="divide-y">
              {filas.map(f => (
                <tr key={f.id} className="hover:bg-stone-50 align-top">
                  <td className="px-4 py-2.5 text-stone-500 whitespace-nowrap">{hora(f.ts_ms)}</td>
                  <td className="px-4 py-2.5 text-stone-700">{f.username || '—'}</td>
                  <td className="px-4 py-2.5">
                    <span className={f.resultado === 'ok' ? 'text-stone-800' : 'text-rose-600 font-semibold'}>{f.modulo}.{f.accion}</span>
                    {f.entidad && <div className="text-xs text-stone-400">{f.entidad} {f.entidad_id}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-stone-500 max-w-md break-words">
                    {f.detalle}{f.valor_anterior && <div>Antes: {f.valor_anterior}</div>}{f.valor_nuevo && <div>Después: {f.valor_nuevo}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {hayMas && <button onClick={() => cargar(true)} className="mt-4 text-sm text-cafe-800 font-semibold">Ver más</button>}
    </div>
  )
}
