import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import Spinner from '../Spinner'
import BuscadorInsumo from './BuscadorInsumo'

const EMPTY = { nombre: '', precio: '', descripcion: '', stock: '' }

export default function ProductoModal({ producto, insumos, onClose, onSaved, addToast, confirm }) {
  const editing = !!producto
  const [form, setForm] = useState(EMPTY)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [recetaInsumos, setRecetaInsumos] = useState([])

  useEffect(() => {
    if (producto) {
      setForm({
        nombre:      producto.nombre      ?? '',
        precio:      producto.precio      ?? '',
        descripcion: producto.descripcion ?? '',
        stock:       producto.stock       ?? '',
      })
    }
  }, [producto])

  const fetchReceta = useCallback(async () => {
    if (!producto) return
    try {
      setRecetaInsumos(await api.getInsumosDeProducto(producto.id))
    } catch (err) {
      addToast(err.message, 'error')
    }
  }, [producto, addToast])

  useEffect(() => { fetchReceta() }, [fetchReceta])

  // Si el producto ya existe (editando), cada alta/baja de insumo pega directo contra la API.
  // Si todavía no existe (creando), se junta localmente y recién se manda al servidor cuando
  // el producto se crea y tiene id (ver handleSubmit).
  const handleAddInsumo = async (insumo_id, cantidad_consumida) => {
    if (editing) {
      try {
        await api.addInsumoAProducto(producto.id, insumo_id, cantidad_consumida)
        fetchReceta()
      } catch (err) {
        addToast(err.message, 'error')
      }
      return
    }
    if (recetaInsumos.some(r => r.insumo_id === insumo_id)) {
      addToast('Ese insumo ya está en la receta.', 'error')
      return
    }
    const info = insumos.find(i => i.id === insumo_id)
    setRecetaInsumos(r => [...r, { id: insumo_id, insumo_id, cantidad_consumida, nombre: info?.nombre, unidad: info?.unidad }])
  }

  const handleRemoveInsumo = async (linea) => {
    if (editing) {
      if (!(await confirm(`¿Quitar "${linea.nombre}" de la receta?`, { title: 'Quitar insumo' }))) return
      try {
        await api.eliminarInsumoDeProducto(producto.id, linea.id)
        fetchReceta()
      } catch (err) {
        addToast(err.message, 'error')
      }
      return
    }
    setRecetaInsumos(r => r.filter(x => x.insumo_id !== linea.insumo_id))
  }

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const validate = () => {
    if (!form.nombre.trim())                                       return 'El nombre es obligatorio.'
    if (form.precio === '' || isNaN(Number(form.precio)) || Number(form.precio) < 0)
                                                                   return 'El precio debe ser un número ≥ 0.'
    if (!editing && form.stock !== '' && (!Number.isInteger(Number(form.stock)) || Number(form.stock) < 0))
                                                                   return 'El stock debe ser un entero ≥ 0.'
    return null
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    const err = validate()
    if (err) return setError(err)
    setError('')
    setSubmitting(true)
    const payload = {
      nombre:      form.nombre.trim(),
      precio:      parseFloat(form.precio),
      descripcion: form.descripcion.trim() || null,
      // El stock solo se define al crear el producto; luego solo se descuenta
      // automáticamente al cerrar cuentas, no se edita a mano.
      ...(!editing && { stock: form.stock !== '' ? parseInt(form.stock) : 0 }),
    }
    try {
      if (editing) {
        await api.updateProducto(producto.id, payload)
        addToast('Producto actualizado.')
      } else {
        const nuevo = await api.createProducto(payload)
        for (const linea of recetaInsumos) {
          try {
            await api.addInsumoAProducto(nuevo.id, linea.insumo_id, linea.cantidad_consumida)
          } catch (err) {
            addToast(`No se pudo agregar "${linea.nombre}" a la receta: ${err.message}`, 'error')
          }
        }
        addToast('Producto creado.')
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
      <div className="animate-fade-in bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        <div className="bg-cafe-800 px-6 py-5 text-white flex justify-between items-center">
          <h2 className="font-bold text-lg">{editing ? 'Editar Producto' : 'Nuevo Producto'}</h2>
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
              <label className="block text-sm font-medium text-stone-700 mb-1">Precio *</label>
              <input type="number" step="0.01" min="0" value={form.precio} onChange={set('precio')} required
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-marca-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">Stock</label>
              <input type="number" min="0" step="1" value={form.stock} onChange={set('stock')}
                disabled={editing}
                title={editing ? 'El stock se descuenta automáticamente al cerrar cuentas.' : undefined}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-marca-500
                  disabled:bg-stone-100 disabled:text-stone-400 disabled:cursor-not-allowed" />
              {editing && (
                <p className="text-xs text-stone-400 mt-1">Se actualiza solo al cerrar cuentas.</p>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Descripción</label>
            <textarea value={form.descripcion} onChange={set('descripcion')} rows={2}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-marca-500 resize-none" />
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 border border-stone-300 text-stone-700 py-2 rounded-lg font-medium text-sm hover:bg-stone-50 transition">
              Cancelar
            </button>
            <button type="submit" disabled={submitting}
              className="flex-1 bg-cafe-800 text-white py-2 rounded-lg font-medium text-sm hover:bg-cafe-700 transition disabled:opacity-50 flex items-center justify-center gap-2">
              {submitting && <Spinner size="sm" />}
              {editing ? 'Guardar cambios' : 'Crear producto'}
            </button>
          </div>
        </form>

        <div className="px-6 pb-6 pt-2 border-t">
            <h3 className="text-sm font-semibold text-stone-700 mb-3">Insumos que consume</h3>

            {recetaInsumos.length === 0 ? (
              <p className="text-xs text-stone-400 mb-3">
                {editing ? 'Este producto todavía no tiene insumos asociados.' : 'Todavía no agregaste insumos a la receta.'}
              </p>
            ) : (
              <div className="mb-3 rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <tbody className="divide-y">
                    {recetaInsumos.map(linea => (
                      <tr key={linea.id} className="hover:bg-stone-50">
                        <td className="px-3 py-2 font-medium text-stone-800">{linea.nombre}</td>
                        <td className="px-3 py-2 text-right text-stone-500">
                          {Number(linea.cantidad_consumida)} {linea.unidad}
                        </td>
                        <td className="text-center pr-2 w-8">
                          <button
                            type="button"
                            onClick={() => handleRemoveInsumo(linea)}
                            title="Quitar insumo"
                            className="text-stone-300 hover:text-rose-600 transition">
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <BuscadorInsumo
              insumos={insumos.filter(i => !recetaInsumos.some(r => r.insumo_id === i.id))}
              onAdd={handleAddInsumo}
            />
        </div>
      </div>
    </div>
  )
}
