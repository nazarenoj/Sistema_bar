import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import Spinner from '../Spinner'

const NIVELES = [
  { id: 'permitido', texto: 'Permitido' },
  { id: 'requiere_autorizacion', texto: 'Requiere autorización' },
  { id: 'denegado', texto: 'Denegado' },
]
const boton = 'px-3 py-1 rounded-lg border text-xs font-semibold transition'
const campo = 'w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400'

export default function RolTabla({ addToast, confirm }) {
  const [roles, setRoles] = useState([])
  const [catalogo, setCatalogo] = useState([])
  const [loading, setLoading] = useState(true)
  const [edit, setEdit] = useState(undefined) // undefined=cerrado, null=nuevo, obj=editar

  const cargar = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([api.getRoles(), api.getCatalogoPermisos()])
      setRoles(r); setCatalogo(c.permisos)
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [addToast])
  useEffect(() => { cargar() }, [cargar])

  const borrar = async (r) => {
    if (!(await confirm(`¿Borrar el rol "${r.nombre}"?`, { title: 'Borrar rol' }))) return
    try { await api.deleteRol(r.id); addToast('Rol borrado.'); cargar() } catch (err) { addToast(err.message, 'error') }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">Cada permiso se asigna como Permitido, Requiere autorización de un supervisor o Denegado. El Administrador puede todo.</p>
        <button onClick={() => setEdit(null)} className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-700 shrink-0">+ Nuevo rol</button>
      </div>
      <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
        {loading ? <div className="flex justify-center py-16"><Spinner size="lg" /></div> : (
          <table className="w-full text-sm">
            <thead><tr className="bg-gray-50 border-b text-gray-500 text-xs uppercase tracking-wider">
              <th className="text-left px-5 py-3">Rol</th><th className="text-left px-5 py-3">Descripción</th>
              <th className="text-center px-5 py-3">Usuarios</th><th className="text-right px-5 py-3">Acciones</th>
            </tr></thead>
            <tbody className="divide-y">
              {roles.map(r => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-5 py-3.5 font-semibold text-gray-800">{r.nombre}{r.predefinido ? <span className="ml-2 text-xs text-gray-400">referencia</span> : null}</td>
                  <td className="px-5 py-3.5 text-gray-500">{r.descripcion || '—'}</td>
                  <td className="px-5 py-3.5 text-center text-gray-600">{r.usuarios}</td>
                  <td className="px-5 py-3.5"><div className="flex gap-2 justify-end">
                    {r.codigo !== 'administrador' && <button onClick={() => setEdit(r)} className={`${boton} border-indigo-200 text-indigo-600 hover:bg-indigo-50`}>Permisos</button>}
                    {!r.predefinido && <button onClick={() => borrar(r)} className={`${boton} border-rose-200 text-rose-600 hover:bg-rose-50`}>Borrar</button>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit !== undefined && <RolModal rol={edit} catalogo={catalogo} onClose={() => setEdit(undefined)} onSaved={cargar} addToast={addToast} />}
    </div>
  )
}

function RolModal({ rol, catalogo, onClose, onSaved, addToast }) {
  const [nombre, setNombre] = useState(rol?.nombre ?? '')
  const [permisos, setPermisos] = useState(rol?.permisos ?? {})
  const [error, setError] = useState('')
  const modulos = [...new Set(catalogo.map(p => p.modulo))]

  const guardar = async (e) => {
    e.preventDefault(); setError('')
    try {
      if (rol) await api.updateRol(rol.id, { nombre, permisos })
      else await api.createRol({ nombre, permisos })
      addToast('Rol guardado.'); onSaved(); onClose()
    } catch (err) { setError(err.message) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form onSubmit={guardar} className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[92vh] flex flex-col overflow-hidden">
        <div className="bg-indigo-600 px-6 py-5 text-white font-bold text-lg">{rol ? `Permisos de ${rol.nombre}` : 'Nuevo rol'}</div>
        <div className="p-6 space-y-4 overflow-y-auto">
          {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-2.5 rounded-lg">{error}</div>}
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} required maxLength={60} placeholder="Nombre del rol" className={campo} />
          {modulos.map(m => (
            <div key={m}>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{m}</h3>
              {catalogo.filter(p => p.modulo === m).map(p => (
                <div key={p.id} className="flex items-center justify-between gap-3 py-1.5 border-b border-gray-100">
                  <span className="text-sm text-gray-700">{p.descripcion}</span>
                  <select value={permisos[p.id] ?? 'denegado'} onChange={(e) => setPermisos(x => ({ ...x, [p.id]: e.target.value }))}
                    className="border rounded-lg px-2 py-1 text-xs shrink-0">
                    {NIVELES.map(n => <option key={n.id} value={n.id}>{n.texto}</option>)}
                  </select>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="flex gap-3 p-4 border-t">
          <button type="button" onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg font-medium text-sm hover:bg-gray-50">Cancelar</button>
          <button type="submit" className="flex-1 bg-indigo-600 text-white py-2 rounded-lg font-medium text-sm hover:bg-indigo-700">Guardar</button>
        </div>
      </form>
    </div>
  )
}
