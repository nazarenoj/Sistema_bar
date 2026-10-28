import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import Spinner from '../Spinner'

const hora = (ms) => new Date(Number(ms)).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
const boton = 'px-3 py-1 rounded-lg border text-xs font-semibold transition'

// Bandeja de pendientes de integración (Usuarios RN53, RN85): mensajes rechazados o fallidos entre módulos.
export default function IntegracionTabla({ addToast, usuario }) {
  const [filas, setFilas] = useState(null)
  const [descartando, setDescartando] = useState(null)
  const [motivo, setMotivo] = useState('')

  const cargar = useCallback(async () => {
    try { setFilas(await api.getPendientesIntegracion()) } catch (err) { addToast(err.message, 'error') }
  }, [addToast])
  useEffect(() => { cargar() }, [cargar])

  const reintentar = async (p) => {
    try { await api.reintentarPendiente(p.id); addToast('Reintento en marcha.'); cargar() } catch (err) { addToast(err.message, 'error') }
  }
  // El descarte "requiere autorización": request() pide la credencial de un supervisor y reintenta.
  const descartar = async (e) => {
    e.preventDefault()
    try { await api.descartarPendiente(descartando.id, motivo); addToast('Pendiente descartado.'); setDescartando(null); setMotivo(''); cargar() } catch (err) { addToast(err.message, 'error') }
  }
  const conciliar = async () => {
    try { const r = await api.conciliarIntegracion(); addToast(`Conciliación terminada: ${r.diferencias.length} diferencia(s) nueva(s).`); cargar() } catch (err) { addToast(err.message, 'error') }
  }

  if (!filas) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">Efectos entre módulos que no se pudieron aplicar. El documento de origen no se revierte.</p>
        {api.can(usuario, 'integracion.conciliar') && (
          <button onClick={conciliar} className="px-3 py-1.5 rounded-lg border border-indigo-200 text-indigo-600 text-sm font-semibold hover:bg-indigo-50">Ejecutar conciliación</button>
        )}
      </div>
      {descartando && (
        <form onSubmit={descartar} className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4 flex flex-wrap gap-3 items-center">
          <span className="text-sm text-amber-800">Motivo del descarte:</span>
          <input value={motivo} onChange={(e) => setMotivo(e.target.value)} required minLength={3} autoFocus className="border rounded-lg px-3 py-1.5 text-sm flex-1 min-w-48" />
          <button className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-sm font-semibold">Descartar</button>
          <button type="button" onClick={() => setDescartando(null)} className="text-sm text-gray-500">Cancelar</button>
        </form>
      )}
      <div className="bg-white rounded-2xl shadow-sm border overflow-x-auto">
        {filas.length === 0 ? <div className="text-center py-16 text-gray-400">No hay pendientes.</div> : (
          <table className="w-full text-sm">
            <thead><tr className="bg-gray-50 border-b text-gray-500 text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-3">Causa</th><th className="text-left px-4 py-3">Detalle</th>
              <th className="text-left px-4 py-3">Responsable</th><th className="text-left px-4 py-3">Plazo</th><th className="text-right px-4 py-3">Acciones</th>
            </tr></thead>
            <tbody className="divide-y">
              {filas.map(p => (
                <tr key={p.id} className="align-top hover:bg-gray-50">
                  <td className="px-4 py-3 capitalize">{p.causa.replace('_', ' ')}</td>
                  <td className="px-4 py-3 text-gray-600">{p.motivo}<div className="text-xs text-gray-400">{p.id_operacion}</div></td>
                  <td className="px-4 py-3 text-gray-500">{p.modulo_responsable} · {p.rol_responsable}</td>
                  <td className="px-4 py-3 text-gray-500">{hora(p.limite_ms)}{p.vencido ? <span className="ml-1 text-rose-600 font-semibold">Vencido</span> : null}</td>
                  <td className="px-4 py-3"><div className="flex gap-2 justify-end">
                    {p.mensaje_id && <button onClick={() => reintentar(p)} className={`${boton} border-indigo-200 text-indigo-600 hover:bg-indigo-50`}>Reintentar</button>}
                    <button onClick={() => setDescartando(p)} className={`${boton} border-rose-200 text-rose-600 hover:bg-rose-50`}>Descartar</button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
