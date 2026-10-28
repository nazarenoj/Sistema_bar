import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import Spinner from '../Spinner'

const TIPOS = {
  venta: 'Puesto de venta',
  pantalla_cocina: 'Pantalla de cocina',
  dispositivo_movil: 'Tablet / celular',
  inventario: 'Inventario',
  otro: 'Otro',
}
const boton = 'px-3 py-1 rounded-lg border text-xs font-semibold transition'
const campo = 'w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400'

const haceCuanto = (seg) => {
  if (seg === null || seg === undefined) return 'nunca'
  if (seg < 90) return 'recién'
  if (seg < 3600) return `hace ${Math.round(seg / 60)} min`
  if (seg < 86400) return `hace ${Math.round(seg / 3600)} h`
  return `hace ${Math.round(seg / 86400)} d`
}

export default function TerminalTabla({ addToast }) {
  const [terminales, setTerminales] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(undefined) // undefined=cerrado, null=nueva, obj=editar
  const [esteEquipo, setEsteEquipo] = useState(api.getTerminal())

  const cargar = useCallback(async () => {
    try {
      setTerminales(await api.getTerminales())
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [addToast])

  useEffect(() => {
    cargar()
    const id = setInterval(cargar, 15000) // el estado de conexión cambia solo
    return () => clearInterval(id)
  }, [cargar])

  const alternarActiva = async (t) => {
    try {
      await api.updateTerminal(t.id, { activa: !t.activa })
      cargar()
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  const usarEnEsteEquipo = (t) => {
    api.setTerminal(t.codigo)
    setEsteEquipo(t.codigo)
    addToast(`Este equipo quedó registrado como "${t.nombre}". Vale desde el próximo ingreso.`)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">
          Cada puesto tiene un código. Se escribe una vez en la pantalla de ingreso del equipo (&ldquo;Configurar terminal&rdquo;).
        </p>
        <button
          onClick={() => setModal(null)}
          className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition flex items-center gap-2 shrink-0"
        >
          <span className="text-lg leading-none">+</span> Nueva terminal
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16"><Spinner size="lg" /></div>
        ) : terminales.length === 0 ? (
          <div className="text-center py-16 text-gray-400">No hay terminales registradas.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b text-gray-500 text-xs uppercase tracking-wider">
                  <th className="text-left px-5 py-3">Nombre</th>
                  <th className="text-left px-5 py-3">Tipo</th>
                  <th className="text-left px-5 py-3">Código</th>
                  <th className="text-center px-5 py-3">Conexión</th>
                  <th className="text-center px-5 py-3">Sesiones</th>
                  <th className="text-center px-5 py-3">Inactividad</th>
                  <th className="text-right px-5 py-3">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {terminales.map(t => (
                  <tr key={t.id} className={`hover:bg-gray-50 transition-colors ${t.activa ? '' : 'opacity-50'}`}>
                    <td className="px-5 py-3.5 font-semibold text-gray-800">
                      {t.nombre}{t.codigo === esteEquipo && <span className="ml-2 text-xs text-indigo-500">(este equipo)</span>}
                    </td>
                    <td className="px-5 py-3.5 text-gray-500">{TIPOS[t.tipo]}</td>
                    <td className="px-5 py-3.5 font-mono tracking-widest text-gray-700">{t.codigo}</td>
                    <td className="px-5 py-3.5 text-center">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold
                        ${t.estado_conexion === 'en_linea' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-600'}`}>
                        {t.estado_conexion === 'en_linea' ? 'En línea' : 'Sin conexión'}
                      </span>
                      <div className="text-xs text-gray-400 mt-0.5">{haceCuanto(t.segundos_sin_contacto)}</div>
                    </td>
                    <td className="px-5 py-3.5 text-center text-gray-600">{t.sesiones_abiertas}</td>
                    <td className="px-5 py-3.5 text-center text-gray-500">{t.inactividad_min ? `${t.inactividad_min} min` : 'Según rol'}</td>
                    <td className="px-5 py-3.5">
                      <div className="flex gap-2 justify-end flex-wrap">
                        <button onClick={() => usarEnEsteEquipo(t)} disabled={!t.activa}
                          className={`${boton} border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40`}>Usar en este equipo</button>
                        <button onClick={() => setModal(t)} className={`${boton} border-indigo-200 text-indigo-600 hover:bg-indigo-50`}>Editar</button>
                        <button onClick={() => alternarActiva(t)}
                          className={`${boton} ${t.activa ? 'border-rose-200 text-rose-600 hover:bg-rose-50' : 'border-emerald-200 text-emerald-600 hover:bg-emerald-50'}`}>
                          {t.activa ? 'Desactivar' : 'Activar'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal !== undefined && (
        <TerminalModal terminal={modal} onClose={() => setModal(undefined)} onSaved={cargar} addToast={addToast} />
      )}
    </div>
  )
}

function TerminalModal({ terminal, onClose, onSaved, addToast }) {
  const editing = !!terminal
  const [form, setForm] = useState({
    nombre: terminal?.nombre ?? '',
    tipo: terminal?.tipo ?? 'venta',
    inactividad_min: terminal?.inactividad_min ?? '',
  })
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    const body = {
      nombre: form.nombre.trim(),
      tipo: form.tipo,
      inactividad_min: form.inactividad_min === '' ? null : Number(form.inactividad_min),
    }
    try {
      if (editing) {
        await api.updateTerminal(terminal.id, body)
        addToast('Terminal actualizada.')
      } else {
        const r = await api.createTerminal(body)
        addToast(`Terminal creada. Su código es ${r.codigo}.`)
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="animate-fade-in bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="bg-indigo-600 px-6 py-5 text-white flex justify-between items-center">
          <h2 className="font-bold text-lg">{editing ? 'Editar terminal' : 'Nueva terminal'}</h2>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-white/20 transition text-xl leading-none">✕</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-2.5 rounded-lg">{error}</div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Nombre *</label>
            <input value={form.nombre} onChange={set('nombre')} required maxLength={60} placeholder="Caja 1, Barra, Tablet de salón…" className={campo} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Tipo</label>
              <select value={form.tipo} onChange={set('tipo')} className={campo}>
                {Object.entries(TIPOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Inactividad (min)</label>
              <input type="number" min="1" max="1440" value={form.inactividad_min} onChange={set('inactividad_min')}
                placeholder="Según rol" className={campo} />
            </div>
          </div>
          <p className="text-xs text-gray-400">
            Minutos sin actividad después de los cuales se cierra la sesión en este puesto. Vacío = el valor del rol (10 min por defecto).
          </p>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg font-medium text-sm hover:bg-gray-50 transition">Cancelar</button>
            <button type="submit" disabled={submitting}
              className="flex-1 bg-indigo-600 text-white py-2 rounded-lg font-medium text-sm hover:bg-indigo-700 transition disabled:opacity-50 flex items-center justify-center gap-2">
              {submitting && <Spinner size="sm" />}
              {editing ? 'Guardar cambios' : 'Crear terminal'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
