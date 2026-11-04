import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import Spinner from '../Spinner'
import DataTable from '../layout/DataTable'
import ProductoModal from './ProductoModal'

const COLUMNAS = [
  { key: 'id', titulo: 'N°' },
  { key: 'nombre', titulo: 'Nombre' },
  { key: 'descripcion', titulo: 'Descripción' },
  { key: 'precio', titulo: 'Precio', align: 'right', render: f => `$${Number(f.precio).toFixed(2)}` },
  { key: 'stock', titulo: 'Stock', align: 'center', render: f => <span className={`etiqueta ${f.stock > 0 ? 'bg-marca-600' : 'bg-rose-400'}`}>{f.stock}</span> },
]

export default function ProductoTabla({ addToast, confirm, onProductosChange }) {
  const [productos, setProductos] = useState([])
  const [insumos, setInsumos] = useState([])
  const [loading, setLoading] = useState(true)
  const [modalProducto, setModalProducto] = useState(undefined) // undefined=closed, null=new, obj=edit

  const fetchProductos = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.getProductos()
      setProductos(data)
      onProductosChange?.()
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [addToast, onProductosChange])

  const fetchInsumos = useCallback(async () => {
    try {
      setInsumos(await api.getInsumos())
    } catch {
      // silencioso: el editor de receta simplemente no tendrá sugerencias
    }
  }, [])

  useEffect(() => { fetchProductos() }, [fetchProductos])
  useEffect(() => { fetchInsumos() }, [fetchInsumos])

  const handleDelete = async (p) => {
    if (!(await confirm(`¿Eliminar "${p.nombre}"?`, { title: 'Eliminar producto' }))) return
    try {
      await api.deleteProducto(p.id)
      addToast('Producto eliminado.')
      fetchProductos()
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  return (
    <div>
      <div className="mb-4">
        <button onClick={() => setModalProducto(null)} className="btn btn-azul">+ Nuevo producto</button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : (
        <DataTable
          filas={productos}
          columnas={COLUMNAS}
          vacio="No hay productos registrados."
          acciones={p => (
            <>
              <button onClick={() => setModalProducto(p)} className="btn btn-azul btn-chico mr-1">Editar</button>
              <button onClick={() => handleDelete(p)} className="btn btn-rojo btn-chico">Eliminar</button>
            </>
          )}
        />
      )}

      {modalProducto !== undefined && (
        <ProductoModal
          producto={modalProducto}
          insumos={insumos}
          onClose={() => setModalProducto(undefined)}
          onSaved={fetchProductos}
          addToast={addToast}
          confirm={confirm}
        />
      )}
    </div>
  )
}
