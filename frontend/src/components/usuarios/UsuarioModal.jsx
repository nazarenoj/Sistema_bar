import { useState, useEffect } from 'react'
import * as api from '../../api'
import Spinner from '../Spinner'

const campo = 'w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:bg-gray-100 disabled:text-gray-400'

export default function UsuarioModal({ usuario, onClose, onSaved, addToast }) {
  const editing = !!usuario
  const [form, setForm] = useState({
    username: usuario?.username ?? '',
    nombre: usuario?.nombre ?? '',
    email: usuario?.email ?? '',
    rolIds: usuario?.roles?.map(r => r.id) ?? [],
    password: '',
    pin: '',
    quitarPin: false,
    tarjeta: '',
    quitarTarjeta: false,
    fecha_baja: usuario?.fecha_baja ? String(usuario.fecha_baja).slice(0, 10) : '',
  })
  const [roles, setRoles] = useState([])
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    api.getRoles().then(r => {
      setRoles(r)
      // Un usuario nuevo arranca con el rol de menor alcance que ofrezca el servidor: Mozo.
      if (!usuario) setForm(f => ({ ...f, rolIds: [r.find(x => x.codigo === 'mozo')?.id ?? r[0].id] }))
    }).catch(() => {})
  }, [usuario])

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))
  const check = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.checked }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)

    // El PIN y la tarjeta no vuelven del servidor: vacío = no tocar, y "quitar" manda null.
    const body = {
      nombre: form.nombre.trim() || null,
      email: form.email.trim() || null,
      fecha_baja: form.fecha_baja || null,
      ...(form.quitarPin ? { pin: null } : form.pin ? { pin: form.pin } : {}),
      ...(form.quitarTarjeta ? { codigo_tarjeta: null } : form.tarjeta ? { codigo_tarjeta: form.tarjeta } : {}),
    }
    try {
      if (editing) {
        await api.updateUsuario(usuario.id, body)
        await api.setAccesos(usuario.id, { rolIds: form.rolIds })
        addToast('Usuario actualizado.')
      } else {
        await api.createUsuario({ ...body, rolIds: form.rolIds, username: form.username.trim(), password: form.password })
        addToast('Usuario creado. Va a cambiar la contraseña en su primer ingreso.')
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
      <div className="animate-fade-in bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden max-h-[92vh] flex flex-col">
        <div className="bg-indigo-600 px-6 py-5 text-white flex justify-between items-center">
          <h2 className="font-bold text-lg">{editing ? `Editar ${usuario.username}` : 'Nuevo usuario'}</h2>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-white/20 transition text-xl leading-none">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto">
          {error && (
            <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-2.5 rounded-lg">{error}</div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Usuario de acceso *</label>
              <input value={form.username} onChange={set('username')} required disabled={editing}
                title={editing ? 'El usuario de acceso no se cambia.' : undefined} className={campo} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Roles *</label>
              <div className="border rounded-lg px-3 py-2 max-h-28 overflow-y-auto space-y-1">
                {roles.map(r => (
                  <label key={r.id} className="flex items-center gap-1.5 text-sm text-gray-700">
                    <input type="checkbox" checked={form.rolIds.includes(r.id)}
                      onChange={(e) => setForm(f => ({ ...f, rolIds: e.target.checked ? [...f.rolIds, r.id] : f.rolIds.filter(x => x !== r.id) }))} />
                    {r.nombre}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nombre</label>
              <input value={form.nombre} onChange={set('nombre')} className={campo} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Correo</label>
              <input type="email" value={form.email} onChange={set('email')} className={campo} />
            </div>
          </div>

          {!editing && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Contraseña inicial *</label>
              <input type="text" value={form.password} onChange={set('password')} required minLength={8} className={campo} />
              <p className="text-xs text-gray-400 mt-1">Mínimo 8 caracteres. La cambia al ingresar por primera vez.</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">PIN</label>
              <input type="password" inputMode="numeric" value={form.pin} onChange={set('pin')} autoComplete="new-password"
                placeholder={usuario?.tiene_pin ? 'Ya tiene PIN' : '4 a 12 dígitos'} disabled={form.quitarPin} className={campo} />
              {usuario?.tiene_pin && (
                <label className="flex items-center gap-1.5 text-xs text-gray-500 mt-1">
                  <input type="checkbox" checked={form.quitarPin} onChange={check('quitarPin')} /> Quitar PIN
                </label>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Tarjeta / llave</label>
              <input type="password" value={form.tarjeta} onChange={set('tarjeta')} autoComplete="new-password"
                placeholder={usuario?.tiene_tarjeta ? 'Ya tiene tarjeta' : 'Pasá la tarjeta'} disabled={form.quitarTarjeta} className={campo} />
              {usuario?.tiene_tarjeta && (
                <label className="flex items-center gap-1.5 text-xs text-gray-500 mt-1">
                  <input type="checkbox" checked={form.quitarTarjeta} onChange={check('quitarTarjeta')} /> Quitar tarjeta
                </label>
              )}
            </div>
          </div>
          <p className="text-xs text-gray-400 -mt-2">El PIN y la tarjeta se guardan cifrados y no se pueden ver después.</p>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Baja programada</label>
            <input type="date" value={form.fecha_baja} onChange={set('fecha_baja')} className={campo} />
            <p className="text-xs text-gray-400 mt-1">Desde ese día el usuario ya no puede ingresar. Vacío = sin baja.</p>
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg font-medium text-sm hover:bg-gray-50 transition">
              Cancelar
            </button>
            <button type="submit" disabled={submitting}
              className="flex-1 bg-indigo-600 text-white py-2 rounded-lg font-medium text-sm hover:bg-indigo-700 transition disabled:opacity-50 flex items-center justify-center gap-2">
              {submitting && <Spinner size="sm" />}
              {editing ? 'Guardar cambios' : 'Crear usuario'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
