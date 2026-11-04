import { useState, useEffect } from 'react'
import * as api from '../../api'
import Spinner from '../Spinner'

const EMPTY = { nombre: '', unidad: '', costo_unitario: '', stock: '', disponible: true }

export default function InsumoModal({ insumo, onClose, onSaved, addToast }) {
  const editing = !!insumo
  const [form, setForm] = useState(EMPTY)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (insumo) {
      setForm({
        nombre:         insumo.nombre         ?? '',
        unidad:         insumo.unidad         ?? '',
        costo_unitario: insumo.costo_unitario ?? '',
        stock:          insumo.stock          ?? '',
        disponible:     insumo.disponible !== undefined ? !!insumo.disponible : true,
      })
    }
  }, [insumo])

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const validate = () => {
    if (!form.nombre.trim())                                       return 'El nombre es obligatorio.'
    if (!form.unidad.trim())                                       return 'La unidad es obligatoria.'
    if (form.costo_unitario !== '' && (isNaN(Number(form.costo_unitario)) || Number(form.costo_unitario) < 0))
                                                                   return 'El costo unitario debe ser un número ≥ 0.'
    if (!editing && form.stock !== '' && (isNaN(Number(form.stock)) || Number(form.stock) < 0))
                                                                   return 'El stock debe ser un número ≥ 0.'
    return null
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    const err = validate()
    if (err) return setError(err)
    setError('')
    setSubmitting(true)
    const payload = {
      nombre:         form.nombre.trim(),
      unidad:         form.unidad.trim(),
      costo_unitario: form.costo_unitario !== '' ? parseFloat(form.costo_unitario) : null,
      disponible:     form.disponible,
      // El stock solo se define al crear el insumo; luego solo se descuenta automáticamente
      // al venderse productos que lo usan, no se edita a mano.
      ...(!editing && { stock: form.stock !== '' ? parseFloat(form.stock) : 0 }),
    }
    try {
      if (editing) {
        await api.updateInsumo(insumo.id, payload)
        addToast('Insumo actualizado.')
      } else {
        await api.createInsumo(payload)
        addToast('Insumo creado.')
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
        <div className="bg-cafe-800 px-6 py-5 text-white flex justify-between items-center">
          <h2 className="font-bold text-lg">{editing ? 'Editar Insumo' : 'Nuevo Insumo'}</h2>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-white/20 transition text-xl leading-none">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-2.5 rounded-lg">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Nombre *</label>
            <input value={form.nombre} onChange={set('nombre')} required
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-marca-500" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">Unidad *</label>
              <input value={form.unidad} onChange={set('unidad')} placeholder="kg, litros, unidades…" required
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-marca-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">Costo unitario</label>
              <input type="number" step="0.01" min="0" value={form.costo_unitario} onChange={set('costo_unitario')}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-marca-500" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Stock</label>
            <input type="number" min="0" step="0.001" value={form.stock} onChange={set('stock')}
              disabled={editing}
              title={editing ? 'El stock se descuenta automáticamente al vender productos que usan este insumo.' : undefined}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-marca-500
                disabled:bg-stone-100 disabled:text-stone-400 disabled:cursor-not-allowed" />
            <p className="text-xs text-stone-400 mt-1">
              {editing ? 'Se actualiza solo al venderse productos que lo usan.' : 'Cantidad inicial en existencia.'}
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-stone-700">
            <input type="checkbox" checked={form.disponible}
              onChange={(e) => setForm(f => ({ ...f, disponible: e.target.checked }))}
              className="rounded border-stone-300 text-cafe-800 focus:ring-marca-500" />
            Disponible
          </label>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 border border-stone-300 text-stone-700 py-2 rounded-lg font-medium text-sm hover:bg-stone-50 transition">
              Cancelar
            </button>
            <button type="submit" disabled={submitting}
              className="flex-1 bg-cafe-800 text-white py-2 rounded-lg font-medium text-sm hover:bg-cafe-700 transition disabled:opacity-50 flex items-center justify-center gap-2">
              {submitting && <Spinner size="sm" />}
              {editing ? 'Guardar cambios' : 'Crear insumo'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
