import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import Spinner from '../Spinner'
import DataTable from '../layout/DataTable'
import InsumoModal from './InsumoModal'

const COLUMNAS = [
  { key: 'id', titulo: 'N°' },
  { key: 'nombre', titulo: 'Nombre' },
  { key: 'unidad', titulo: 'Unidad' },
  { key: 'costo_unitario', titulo: 'Costo unitario', align: 'right', render: f => (f.costo_unitario != null ? `$${Number(f.costo_unitario).toFixed(2)}` : '—') },
  { key: 'stock', titulo: 'Stock', align: 'center', render: f => <span className={`etiqueta ${Number(f.stock) > 0 ? 'bg-marca-600' : 'bg-rose-400'}`}>{Number(f.stock)}</span> },
  {
    key: 'disponible', titulo: 'Disponible', align: 'center', valor: f => (f.disponible ? 'Sí' : 'No'),
    render: f => <span className={`etiqueta ${f.disponible ? 'bg-marca-600' : 'bg-stone-400'}`}>{f.disponible ? 'Sí' : 'No'}</span>,
  },
]

export default function InsumoTabla({ addToast, confirm }) {
  const [insumos, setInsumos] = useState([])
  const [loading, setLoading] = useState(true)
  const [modalInsumo, setModalInsumo] = useState(undefined) // undefined=closed, null=new, obj=edit

  const fetchInsumos = useCallback(async () => {
    setLoading(true)
    try {
      setInsumos(await api.getInsumos())
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [addToast])

  useEffect(() => { fetchInsumos() }, [fetchInsumos])

  const handleDelete = async (i) => {
    if (!(await confirm(`¿Eliminar "${i.nombre}"?`, { title: 'Eliminar insumo' }))) return
    try {
      await api.deleteInsumo(i.id)
      addToast('Insumo eliminado.')
      fetchInsumos()
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  return (
    <div>
      <div className="mb-4">
        <button onClick={() => setModalInsumo(null)} className="btn btn-azul">+ Nuevo insumo</button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : (
        <DataTable
          filas={insumos}
          columnas={COLUMNAS}
          vacio="No hay insumos registrados."
          acciones={i => (
            <>
              <button onClick={() => setModalInsumo(i)} className="btn btn-azul btn-chico mr-1">Editar</button>
              <button onClick={() => handleDelete(i)} className="btn btn-rojo btn-chico">Eliminar</button>
            </>
          )}
        />
      )}

      {modalInsumo !== undefined && (
        <InsumoModal
          insumo={modalInsumo}
          onClose={() => setModalInsumo(undefined)}
          onSaved={fetchInsumos}
          addToast={addToast}
        />
      )}
    </div>
  )
}
