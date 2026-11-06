import { useState, useEffect, useCallback, useRef } from 'react'
import * as api from '../../api'
import DataTable from '../layout/DataTable'
import Modal, { Campo } from '../layout/Modal'
import Spinner from '../Spinner'

const ESTADOS = { pendiente_lectura: 'Sin leer', borrador: 'Para revisar', confirmado: 'Confirmado', descartado: 'Descartado' }
const VACIA = { descripcion: '', cantidad: '', costo: '' }
const ENC = [['proveedor', 'Proveedor'], ['cuit', 'CUIT'], ['clase', 'Clase (FACTURA, REMITO…)'], ['tipo', 'Letra'], ['punto_venta', 'Punto de venta'], ['numero', 'Número']]

// Revisión de un comprobante subido: carga a mano si no se pudo leer, asocia cada línea a un artículo y confirma el ingreso.
function Revision({ id, onClose, onCambio, addToast, puedeEditar }) {
  const [b, setB] = useState(null)
  const [items, setItems] = useState({ insumo: [], producto: [] })
  const [enc, setEnc] = useState({})
  const [lineas, setLineas] = useState([{ ...VACIA }])
  const [ocupado, setOcupado] = useState(false)

  const cargar = useCallback(async () => {
    const r = await api.llamar(`/stock-ingresos/fotos/${id}`)
    setB(r); setEnc(r.encabezado ?? {})
  }, [id])
  useEffect(() => {
    cargar().catch(e => { addToast(e.message, 'error'); onClose() })
    Promise.all([api.getInsumos(), api.getProductos()]).then(([insumo, producto]) => setItems({ insumo, producto })).catch(() => {})
  }, [cargar, addToast, onClose])

  const correr = async (fn, ok) => {
    setOcupado(true)
    try { await fn(); if (ok) addToast(ok); await cargar(); onCambio() } catch (e) { addToast(e.message, 'error') } finally { setOcupado(false) }
  }
  const verImagen = async () => {
    try {
      const res = await fetch(`/api/stock-ingresos/fotos/${id}/imagen`, { headers: { Authorization: `Bearer ${api.getToken()}`, ...(api.getInstancia() && { 'X-Instancia': api.getInstancia() }) } })
      if (!res.ok) throw new Error('No se pudo abrir la imagen.')
      window.open(URL.createObjectURL(await res.blob()), '_blank')
    } catch (e) { addToast(e.message, 'error') }
  }
  const cargarLectura = () => correr(() => api.llamar(`/stock-ingresos/fotos/${id}/lectura`, { method: 'PUT', body: {
    encabezado: Object.fromEntries(Object.entries(enc).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, k === 'punto_venta' || k === 'numero' ? Number(v) : v])),
    lineas: lineas.filter(l => l.descripcion || l.cantidad).map(l => ({ descripcion: l.descripcion, cantidad: Number(l.cantidad), ...(l.costo !== '' && { costo: Number(l.costo) }) })),
  } }), 'Lectura cargada.')
  const asociar = (n, valor) => { const [tipo, itemId] = valor.split(':'); return correr(() => api.llamar(`/stock-ingresos/fotos/${id}/lineas/${n}`, { method: 'PUT', body: { item: { tipo, id: Number(itemId) } } })) }
  const confirmar = () => correr(() => api.llamar(`/stock-ingresos/fotos/${id}/confirmar`, { method: 'POST', body: {} }), 'Ingreso confirmado: el stock ya se actualizó.')
  const setLinea = (n, k, v) => setLineas(ls => ls.map((l, i) => (i === n ? { ...l, [k]: v } : l)))

  if (!b) return <Modal titulo="Comprobante" onClose={onClose}><div className="flex justify-center py-8"><Spinner /></div></Modal>
  const editable = puedeEditar && ['pendiente_lectura', 'borrador'].includes(b.estado)
  const sinAsociar = b.lineas.filter(l => !l.item).length

  return (
    <Modal titulo={`Comprobante · ${ESTADOS[b.estado] ?? b.estado}`} onClose={onClose} ancho="max-w-3xl"
      pie={editable && (
        <>
          <button onClick={verImagen} className="btn bg-stone-400 hover:bg-stone-500">Ver imagen</button>
          {b.estado === 'borrador' && <button onClick={confirmar} disabled={ocupado || sinAsociar > 0} className="btn btn-verde" title={sinAsociar ? 'Falta asociar un artículo a cada línea' : ''}>Confirmar ingreso</button>}
        </>
      )}>
      {b.estado === 'pendiente_lectura' ? (
        <div className="space-y-3">
          <p className="text-sm text-stone-600">Todavía no se leyó este comprobante. Podés pedir la lectura de nuevo o cargar los datos a mano mirando la imagen.</p>
          {editable && <button onClick={() => correr(() => api.llamar(`/stock-ingresos/fotos/${id}/releer`, { method: 'POST', body: {} }), 'Se volvió a pedir la lectura.')} disabled={ocupado} className="btn btn-azul btn-chico">Leer de nuevo</button>}
          {editable && (
            <>
              <div className="grid grid-cols-2 gap-2">
                {ENC.map(([k, t]) => <Campo key={k} etiqueta={t}><input className="campo w-full" value={enc[k] ?? ''} onChange={e => setEnc(v => ({ ...v, [k]: e.target.value }))} /></Campo>)}
              </div>
              <div className="space-y-1">
                {lineas.map((l, n) => (
                  <div key={n} className="flex gap-2">
                    <input className="campo flex-1" placeholder="Descripción" value={l.descripcion} onChange={e => setLinea(n, 'descripcion', e.target.value)} />
                    <input className="campo w-24" type="number" min="0" step="any" placeholder="Cantidad" value={l.cantidad} onChange={e => setLinea(n, 'cantidad', e.target.value)} />
                    <input className="campo w-28" type="number" min="0" step="any" placeholder="Costo" value={l.costo} onChange={e => setLinea(n, 'costo', e.target.value)} />
                  </div>
                ))}
                <button onClick={() => setLineas(ls => [...ls, { ...VACIA }])} className="text-sm text-cafe-700 hover:underline">+ Agregar línea</button>
              </div>
              <button onClick={cargarLectura} disabled={ocupado} className="btn btn-azul">Cargar datos</button>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {b.encabezado && <p className="text-sm text-stone-600">{[b.encabezado.proveedor, b.encabezado.cuit && `CUIT ${b.encabezado.cuit}`, b.encabezado.clase, b.encabezado.numero && `N° ${b.encabezado.punto_venta ?? ''}-${b.encabezado.numero}`].filter(Boolean).join(' · ')}</p>}
          {b.ingreso_id_global && <p className="text-sm text-stone-600">Ingreso generado: {b.ingreso_id_global}</p>}
          <table className="w-full text-sm">
            <thead><tr className="text-left text-stone-500"><th className="py-1">Descripción</th><th>Cantidad</th><th>Costo</th><th>Artículo</th></tr></thead>
            <tbody>
              {b.lineas.map((l, n) => (
                <tr key={n} className="border-t border-stone-100">
                  <td className="py-1.5 pr-2">{l.descripcion}</td><td>{l.cantidad}</td><td>{l.costo ?? ''}</td>
                  <td>
                    {editable ? (
                      <select className={`campo ${l.item ? '' : '!border-amber-400'}`} value={l.item ? `${l.item.tipo}:${l.item.id}` : ''} disabled={ocupado} onChange={e => e.target.value && asociar(n, e.target.value)}>
                        <option value="">Elegir…</option>
                        <optgroup label="Insumos">{items.insumo.map(i => <option key={`i${i.id}`} value={`insumo:${i.id}`}>{i.nombre}</option>)}</optgroup>
                        <optgroup label="Productos">{items.producto.map(i => <option key={`p${i.id}`} value={`producto:${i.id}`}>{i.nombre}</option>)}</optgroup>
                      </select>
                    ) : (l.item ? `${l.item.tipo} #${l.item.id}` : '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {editable && sinAsociar > 0 && <p className="text-xs text-amber-700">Faltan {sinAsociar} línea(s) por asociar a un artículo. Se recuerda para la próxima vez que llegue algo del mismo proveedor.</p>}
        </div>
      )}
    </Modal>
  )
}

export default function IngresoFoto({ addToast, usuario }) {
  const [filas, setFilas] = useState(null)
  const [id, setId] = useState(null)
  const [subiendo, setSubiendo] = useState(false)
  const [depositos, setDepositos] = useState([])
  const [deposito, setDeposito] = useState('')
  const entrada = useRef(null)
  const puedeEditar = api.can(usuario, 'stock.movimientos.registrar')

  const recargar = useCallback(() => api.llamar('/stock-ingresos/fotos').then(setFilas).catch(e => { addToast(e.message, 'error'); setFilas([]) }), [addToast])
  useEffect(() => { recargar(); api.llamar('/depositos').then(setDepositos).catch(() => {}) }, [recargar])

  const subir = async (e) => {
    const archivo = e.target.files?.[0]
    e.target.value = ''
    if (!archivo) return
    setSubiendo(true)
    try {
      const r = await api.llamar(`/stock-ingresos/fotos${deposito ? `?deposito_id=${deposito}` : ''}`, { method: 'POST', archivo })
      addToast(r.estado === 'borrador' ? 'Comprobante leído: revisalo antes de confirmar.' : 'Comprobante subido. No se pudo leer solo: cargá los datos a mano.')
      await recargar(); setId(r.id)
    } catch (err) { addToast(err.message, 'error') } finally { setSubiendo(false) }
  }

  return (
    <div>
      <p className="text-sm text-stone-500 mb-3">Subí la foto o el PDF de una factura o remito de un proveedor. El stock no cambia hasta que revises las líneas y confirmes.</p>
      {puedeEditar && (
        <div className="flex flex-wrap items-end gap-2 mb-4">
          <Campo etiqueta="Depósito (opcional)">
            <select className="campo" value={deposito} onChange={e => setDeposito(e.target.value)}>
              <option value="">El principal</option>
              {depositos.map(d => <option key={d.id} value={d.id}>{d.nombre}</option>)}
            </select>
          </Campo>
          <input ref={entrada} type="file" accept="image/jpeg,image/png,application/pdf" onChange={subir} className="hidden" />
          <button onClick={() => entrada.current?.click()} disabled={subiendo} className="btn btn-azul">{subiendo ? 'Subiendo…' : 'Subir comprobante'}</button>
        </div>
      )}
      {!filas ? <div className="flex justify-center py-12"><Spinner size="lg" /></div> : (
        <DataTable filas={filas} vacio="Todavía no subiste comprobantes."
          columnas={[
            { key: 'created_at', titulo: 'Fecha', valor: f => f.created_at, render: f => new Date(f.created_at).toLocaleString('es-AR') },
            { key: 'imagen_nombre', titulo: 'Archivo', render: f => (f.imagen_nombre ? decodeURIComponent(f.imagen_nombre) : '—') },
            { key: 'estado', titulo: 'Estado', valor: f => ESTADOS[f.estado] ?? f.estado, render: f => <span className={`etiqueta ${f.estado === 'confirmado' ? 'bg-marca-600' : f.estado === 'descartado' ? 'bg-stone-400' : 'bg-amber-500'}`}>{ESTADOS[f.estado] ?? f.estado}</span> },
          ]}
          acciones={f => (
            <div className="flex gap-1">
              <button onClick={() => setId(f.id)} className="btn btn-azul btn-chico">{['borrador', 'pendiente_lectura'].includes(f.estado) && puedeEditar ? 'Revisar' : 'Ver'}</button>
              {puedeEditar && ['borrador', 'pendiente_lectura'].includes(f.estado) && (
                <button className="btn btn-rojo btn-chico" onClick={async () => { try { await api.llamar(`/stock-ingresos/fotos/${f.id}/descartar`, { method: 'POST', body: {} }); addToast('Descartado.'); recargar() } catch (e) { addToast(e.message, 'error') } }}>Descartar</button>
              )}
            </div>
          )} />
      )}
      {id && <Revision id={id} puedeEditar={puedeEditar} addToast={addToast} onClose={() => setId(null)} onCambio={recargar} />}
    </div>
  )
}
