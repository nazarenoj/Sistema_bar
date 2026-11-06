import { useState, useEffect } from 'react'
import * as api from '../../api'
import DataTable from '../layout/DataTable'
import Modal from '../layout/Modal'
import Spinner from '../Spinner'

const NIVELES = [['', 'No tiene'], ['contiene', 'Contiene'], ['trazas', 'Puede tener trazas']]

// Declaración de alérgenos de cada producto o insumo. Guardar reemplaza lo declarado: lo que queda en «No tiene»
// se quita, y guardar sin marcar nada declara «sin alérgenos» (el artículo queda revisado).
function Declaracion({ tipo, item, onClose, onGuardado, addToast, puedeEditar }) {
  const [catalogo, setCatalogo] = useState(null)
  const [valores, setValores] = useState({})
  const [derivado, setDerivado] = useState(null)
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    Promise.all([api.llamar('/alergenos'), api.llamar(`/alergenos/item/${tipo}/${item.id}`)])
      .then(([cat, dec]) => {
        setCatalogo(cat.filter(a => a.activo !== 0 && a.activo !== false))
        setValores(Object.fromEntries(dec.map(d => [d.alergeno_id, d.tipo])))
      })
      .catch(err => { addToast(err.message, 'error'); onClose() })
    if (tipo === 'producto') api.llamar(`/alergenos/articulo/${item.id}`).then(setDerivado).catch(() => {})
  }, [tipo, item.id, addToast, onClose])

  const guardar = async () => {
    setGuardando(true)
    try {
      const alergenos = Object.entries(valores).filter(([, t]) => t).map(([id, t]) => ({ alergeno_id: Number(id), tipo: t }))
      await api.llamar(`/alergenos/item/${tipo}/${item.id}`, { method: 'PUT', body: { alergenos } })
      addToast(alergenos.length ? 'Alérgenos guardados.' : 'Se declaró «sin alérgenos».')
      onGuardado()
    } catch (err) { addToast(err.message, 'error') } finally { setGuardando(false) }
  }

  return (
    <Modal titulo={`Alérgenos · ${item.nombre}`} onClose={onClose} ancho="max-w-xl"
      pie={puedeEditar && catalogo && (
        <>
          <button onClick={onClose} className="btn bg-stone-400 hover:bg-stone-500">Cancelar</button>
          <button onClick={guardar} disabled={guardando} className="btn btn-azul">{guardando ? 'Guardando…' : 'Guardar'}</button>
        </>
      )}>
      {!catalogo ? <div className="flex justify-center py-8"><Spinner /></div> : catalogo.length === 0 ? (
        <p className="text-sm text-stone-500">Todavía no hay alérgenos cargados. Se dan de alta en Calidad y trazabilidad → Alérgenos.</p>
      ) : (
        <div className="space-y-2">
          {catalogo.map(a => (
            <label key={a.id} className="flex items-center justify-between gap-3 text-sm border-b border-stone-100 py-1.5">
              <span className="text-stone-800">{a.nombre}</span>
              <select disabled={!puedeEditar} value={valores[a.id] ?? ''} onChange={e => setValores(v => ({ ...v, [a.id]: e.target.value }))}
                className={`campo ${valores[a.id] === 'contiene' ? '!border-rose-400' : valores[a.id] === 'trazas' ? '!border-amber-400' : ''}`}>
                {NIVELES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}
      {Array.isArray(derivado?.alergenos) && derivado.alergenos.length > 0 && (
        <p className="mt-4 text-xs text-stone-500">Con su receta, este producto hereda: {derivado.alergenos.map(a => `${a.nombre} (${a.tipo})`).join(', ')}.</p>
      )}
    </Modal>
  )
}

export default function Alergenos({ addToast, usuario }) {
  const [tipo, setTipo] = useState('producto')
  const [filas, setFilas] = useState(null)
  const [item, setItem] = useState(null)
  const puedeEditar = api.can(usuario, 'stock.alergenos.gestionar')

  useEffect(() => {
    setFilas(null)
    ;(tipo === 'producto' ? api.getProductos() : api.getInsumos()).then(setFilas).catch(e => { addToast(e.message, 'error'); setFilas([]) })
  }, [tipo, addToast])

  return (
    <div>
      <p className="text-sm text-stone-500 mb-3">Indicá qué alérgenos contiene cada producto o insumo. Los datos viajan a la comanda y a la etiqueta.</p>
      <div className="flex gap-1 border-b border-stone-200 mb-4">
        {[['producto', 'Productos'], ['insumo', 'Insumos']].map(([id, t]) => (
          <button key={id} onClick={() => setTipo(id)}
            className={`px-4 py-2 text-sm -mb-px border-b-2 ${tipo === id ? 'border-cafe-800 text-cafe-800 font-semibold' : 'border-transparent text-stone-500 hover:text-stone-800'}`}>{t}</button>
        ))}
      </div>
      {!filas ? <div className="flex justify-center py-12"><Spinner size="lg" /></div> : (
        <DataTable filas={filas} vacio="No hay registros."
          columnas={[
            { key: 'nombre', titulo: 'Nombre' },
            { key: 'alergenos_revisado', titulo: 'Revisado', align: 'center', valor: f => (f.alergenos_revisado ? 'Sí' : 'No'), render: f => <span className={`etiqueta ${f.alergenos_revisado ? 'bg-marca-600' : 'bg-amber-500'}`}>{f.alergenos_revisado ? 'Sí' : 'Pendiente'}</span> },
          ]}
          acciones={f => <button onClick={() => setItem(f)} className="btn btn-azul btn-chico">{puedeEditar ? 'Declarar' : 'Ver'}</button>} />
      )}
      {item && <Declaracion tipo={tipo} item={item} puedeEditar={puedeEditar} addToast={addToast} onClose={() => setItem(null)} onGuardado={() => { setItem(null); setFilas(null); (tipo === 'producto' ? api.getProductos() : api.getInsumos()).then(setFilas) }} />}
    </div>
  )
}
