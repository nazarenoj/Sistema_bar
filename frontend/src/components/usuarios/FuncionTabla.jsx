import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import Spinner from '../Spinner'

const MODULOS = {
  ventas: 'Ventas', stock: 'Stock e Insumos', clientes: 'Clientes y CC', compras: 'Compras',
  financiero: 'Financiero', contable: 'Contable', ventas_online: 'Ventas Online', usuarios: 'Usuarios y Auditoría',
}

// Pantalla única de activación de funciones (Usuarios RF18): solo el Administrador cambia el estado.
export default function FuncionTabla({ addToast, confirm }) {
  const [datos, setDatos] = useState(null)
  const [perfil, setPerfil] = useState('')
  const [pideMotivo, setPideMotivo] = useState(null) // cuerpo del cambio que espera un motivo
  const [motivo, setMotivo] = useState('')

  const cargar = useCallback(async () => {
    try {
      setDatos(await api.getFunciones())
    } catch (err) {
      addToast(err.message, 'error')
    }
  }, [addToast])
  useEffect(() => { cargar() }, [cargar])

  // Un cambio puede pedir confirmaciones (cascada, pendientes) o un motivo (función sanitaria): se
  // reenvía con lo que la persona confirme. Nada se aplica hasta que el servidor lo acepta completo.
  const aplicar = async (cuerpo) => {
    try {
      await api.cambiarFunciones(cuerpo)
      addToast('Cambio aplicado.')
      cargar()
    } catch (err) {
      const d = err.detalle || {}
      if (err.codigo === 'REQUIERE_CONFIRMACION') {
        const lineas = [...(d.cascada ? [`Se desactivan también: ${d.cascada.join(', ')}.`] : []), ...(d.pendientes || [])]
        if (await confirm(`${lineas.join('\n')}\n\n¿Confirmás?`, { title: 'Confirmar cambio' }))
          return aplicar({ ...cuerpo, confirmar: { cascada: !!d.cascada || cuerpo.confirmar?.cascada, pendientes: !!d.pendientes || cuerpo.confirmar?.pendientes } })
      } else if (err.codigo === 'MOTIVO_REQUERIDO') {
        setPideMotivo(cuerpo) // función con peso sanitario: se pide el motivo y después la credencial de otro Administrador
      } else if (err.codigo === 'REQUIERE_AUTORIZACION_SANITARIA') {
        const autorizacion = await api.pedirAutorizacion('funciones.sanitarias')
        if (autorizacion) return aplicar({ ...cuerpo, autorizacion })
      } else {
        addToast(err.message, 'error')
      }
    }
  }

  const alternar = (f) => aplicar(f.deseada ? { desactivar: [f.id] } : { activar: [f.id] })

  const aplicarPerfil = async () => {
    if (!perfil || !(await confirm('El perfil vuelve a cargar el valor de todas las funciones. No toca usuarios, roles ni datos.', { title: 'Aplicar perfil' }))) return
    try { await api.aplicarPerfil(perfil); addToast('Perfil aplicado.'); cargar() } catch (err) { addToast(err.message, 'error') }
  }

  if (!datos) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>
  const modulos = [...new Set(datos.funciones.map(f => f.modulo))]

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <p className="text-sm text-gray-500 mr-auto">Versión de configuración: <b>{datos.version}</b>. Los cambios rigen desde el siguiente documento que se abra.</p>
        <select value={perfil} onChange={(e) => setPerfil(e.target.value)} className="border rounded-lg px-3 py-1.5 text-sm">
          <option value="">Perfil de rubro…</option>
          {datos.perfiles.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
        </select>
        <button onClick={aplicarPerfil} disabled={!perfil} className="px-3 py-1.5 rounded-lg border border-indigo-200 text-indigo-600 text-sm font-semibold hover:bg-indigo-50 disabled:opacity-40">Aplicar</button>
      </div>
      {pideMotivo && (
        <form className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4 flex flex-wrap gap-3 items-center"
          onSubmit={(e) => { e.preventDefault(); const c = pideMotivo; setPideMotivo(null); aplicar({ ...c, motivo }); setMotivo('') }}>
          <span className="text-sm text-amber-800">Función con peso sanitario. Motivo de la desactivación:</span>
          <input value={motivo} onChange={(e) => setMotivo(e.target.value)} required minLength={3} autoFocus className="border rounded-lg px-3 py-1.5 text-sm flex-1 min-w-48" />
          <button className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-sm font-semibold">Continuar</button>
          <button type="button" onClick={() => setPideMotivo(null)} className="text-sm text-gray-500">Cancelar</button>
        </form>
      )}
      {modulos.map(m => (
        <div key={m} className="bg-white rounded-2xl shadow-sm border mb-4 overflow-hidden">
          <h3 className="px-5 py-3 bg-gray-50 border-b text-xs font-semibold text-gray-500 uppercase tracking-wider">{MODULOS[m] || m}</h3>
          <ul className="divide-y">
            {datos.funciones.filter(f => f.modulo === m).map(f => (
              <li key={f.id} className="flex items-center justify-between gap-4 px-5 py-3">
                <div>
                  <div className="text-sm font-semibold text-gray-800">
                    {f.nombre} <span className="font-mono text-xs text-gray-400">{f.id}</span>
                    {f.sanitaria && <span className="ml-2 text-xs text-amber-600">peso sanitario</span>}
                  </div>
                  {f.motivo && <div className="text-xs text-gray-400">{f.motivo}</div>}
                </div>
                <button onClick={() => alternar(f)} disabled={f.deshabilitada && !f.deseada}
                  title={f.motivo || ''}
                  className={`px-3 py-1 rounded-full text-xs font-semibold shrink-0 transition disabled:opacity-40
                    ${f.activa ? 'bg-emerald-100 text-emerald-700' : f.deseada ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                  {f.activa ? 'Activa' : f.deseada ? 'Deshabilitada' : 'Inactiva'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
