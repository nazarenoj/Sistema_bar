import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import TablaAuto from '../layout/TablaAuto'
import Modal, { Campo } from '../layout/Modal'
import Spinner from '../Spinner'
import { dinero, dia } from '../../utils/formato'

const PESTANAS = [['formas', 'Formas de pago', '/formas-pago'], ['listas', 'Listas de precio', '/listas-precio'], ['promos', 'Promociones', '/promociones'], ['monedas', 'Monedas', '/monedas']]
const OCULTAR = ['created_at', 'updated_at', 'config_version']

function FormaPago({ forma, onClose, onGuardado, addToast }) {
  const [f, setF] = useState({ codigo: '', nombre: '', requiere_referencia: false, admite_vuelto: false, orden: 0, moneda: 'ARS', activa: true, ...forma })
  const guardar = async (e) => {
    e.preventDefault()
    const body = { nombre: f.nombre, requiere_referencia: !!f.requiere_referencia, admite_vuelto: !!f.admite_vuelto, orden: Number(f.orden) || 0, moneda: f.moneda, activa: !!f.activa }
    try {
      await api.llamar(forma ? `/formas-pago/${forma.id}` : '/formas-pago', { method: forma ? 'PUT' : 'POST', body: forma ? body : { ...body, codigo: f.codigo } })
      addToast('Forma de pago guardada.')
      onGuardado()
    } catch (err) { addToast(err.message, 'error') }
  }
  const marca = (k, t) => <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!f[k]} onChange={e => setF({ ...f, [k]: e.target.checked })} className="accent-cafe-800" /> {t}</label>
  return (
    <Modal titulo={forma ? 'Editar forma de pago' : 'Nueva forma de pago'} onClose={onClose} ancho="max-w-md">
      <form onSubmit={guardar} className="space-y-3">
        {!forma && <Campo etiqueta="Código (minúsculas, sin espacios)"><input required pattern="[a-z0-9_]{2,50}" value={f.codigo} onChange={e => setF({ ...f, codigo: e.target.value })} className="campo w-full" /></Campo>}
        <Campo etiqueta="Nombre"><input required value={f.nombre} onChange={e => setF({ ...f, nombre: e.target.value })} className="campo w-full" /></Campo>
        <div className="grid grid-cols-2 gap-3">
          <Campo etiqueta="Moneda"><input value={f.moneda} onChange={e => setF({ ...f, moneda: e.target.value.toUpperCase() })} className="campo w-full" /></Campo>
          <Campo etiqueta="Orden"><input type="number" value={f.orden} onChange={e => setF({ ...f, orden: e.target.value })} className="campo w-full" /></Campo>
        </div>
        {marca('requiere_referencia', 'Pide referencia (ej. número de operación)')}
        {marca('admite_vuelto', 'Admite vuelto')}
        {forma && marca('activa', 'Activa')}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn bg-stone-400 hover:bg-stone-500">Cancelar</button>
          <button className="btn btn-azul">Guardar</button>
        </div>
      </form>
    </Modal>
  )
}

function Cotizacion({ monedas, onClose, onGuardado, addToast }) {
  const [f, setF] = useState({ moneda: monedas.find(m => !m.es_local)?.codigo ?? '', comprador: '', vendedor: '' })
  const guardar = async (e) => {
    e.preventDefault()
    try {
      await api.llamar('/monedas/cotizaciones', { method: 'POST', body: { moneda: f.moneda, comprador: Number(f.comprador), vendedor: Number(f.vendedor) } })
      addToast('Cotización cargada.')
      onGuardado()
    } catch (err) { addToast(err.message, 'error') }
  }
  return (
    <Modal titulo="Cargar cotización" onClose={onClose} ancho="max-w-md">
      <form onSubmit={guardar} className="grid grid-cols-3 gap-3">
        <Campo etiqueta="Moneda"><select value={f.moneda} onChange={e => setF({ ...f, moneda: e.target.value })} className="campo w-full">{monedas.filter(m => !m.es_local && m.activa).map(m => <option key={m.codigo}>{m.codigo}</option>)}</select></Campo>
        <Campo etiqueta="Compra"><input required type="number" step="any" min="0" value={f.comprador} onChange={e => setF({ ...f, comprador: e.target.value })} className="campo w-full" /></Campo>
        <Campo etiqueta="Venta"><input required type="number" step="any" min="0" value={f.vendedor} onChange={e => setF({ ...f, vendedor: e.target.value })} className="campo w-full" /></Campo>
        <div className="col-span-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn bg-stone-400 hover:bg-stone-500">Cancelar</button>
          <button className="btn btn-azul">Guardar</button>
        </div>
      </form>
    </Modal>
  )
}

export default function ConfigVentas({ addToast, usuario }) {
  const [pestana, setPestana] = useState('formas')
  const [datos, setDatos] = useState(null)
  const [modal, setModal] = useState(null)
  const puedeEditar = api.can(usuario, 'ventas.catalogo.editar')
  const ruta = PESTANAS.find(p => p[0] === pestana)[2]

  const cargar = useCallback(async () => {
    setDatos(null)
    try { setDatos(await api.llamar(ruta)) } catch (err) { setDatos([]); addToast(err.message, 'error') }
  }, [ruta, addToast])
  useEffect(() => { cargar() }, [cargar])

  const alternar = async (url, body) => {
    try { await api.llamar(url, { method: 'PUT', body }); cargar() } catch (err) { addToast(err.message, 'error') }
  }

  const filas = Array.isArray(datos) ? datos : (datos?.items ?? [])
  return (
    <div>
      <div className="flex flex-wrap gap-1 border-b border-stone-200 mb-4">
        {PESTANAS.map(([id, t]) => (
          <button key={id} onClick={() => setPestana(id)}
            className={`px-4 py-2 text-sm -mb-px border-b-2 ${pestana === id ? 'border-cafe-800 text-cafe-800 font-semibold' : 'border-transparent text-stone-500 hover:text-stone-800'}`}>{t}</button>
        ))}
      </div>
      <div className="flex justify-end gap-2 mb-3">
        {pestana === 'formas' && puedeEditar && <button onClick={() => setModal({ tipo: 'forma', valor: null })} className="btn btn-azul">+ Nueva forma de pago</button>}
        {pestana === 'monedas' && api.can(usuario, 'usuarios.cotizaciones.cargar') && <button onClick={() => setModal({ tipo: 'cotizacion' })} className="btn btn-azul">+ Cargar cotización</button>}
      </div>
      {!datos ? <div className="flex justify-center py-12"><Spinner size="lg" /></div> : (
        <TablaAuto
          filas={filas} ocultar={OCULTAR} vacio="No hay registros."
          formato={{ vigente_desde: f => dia(f.vigente_desde), vigente_hasta: f => dia(f.vigente_hasta), precio: f => dinero(f.precio) }}
          acciones={pestana === 'formas' && puedeEditar ? (f => <button onClick={() => setModal({ tipo: 'forma', valor: f })} className="btn btn-azul btn-chico">Editar</button>)
            : pestana === 'listas' && puedeEditar ? (f => <button onClick={() => alternar(`/listas-precio/${f.id}/activa`, { activa: !f.activa })} className="btn bg-marca-600 hover:bg-marca-700 btn-chico">{f.activa ? 'Desactivar' : 'Activar'}</button>)
            : pestana === 'promos' && puedeEditar ? (f => <button onClick={() => alternar(`/promociones/${f.id}/pausa`, { pausada: !f.pausada })} className="btn bg-marca-600 hover:bg-marca-700 btn-chico">{f.pausada ? 'Reanudar' : 'Pausar'}</button>)
            : pestana === 'monedas' && api.can(usuario, 'usuarios.gestionar') ? (f => <button onClick={() => alternar(`/monedas/${f.codigo}/activa`, { activa: !f.activa })} className="btn bg-marca-600 hover:bg-marca-700 btn-chico">{f.activa ? 'Desactivar' : 'Activar'}</button>)
            : undefined}
        />
      )}
      {modal?.tipo === 'forma' && <FormaPago forma={modal.valor} onClose={() => setModal(null)} addToast={addToast} onGuardado={() => { setModal(null); cargar() }} />}
      {modal?.tipo === 'cotizacion' && <Cotizacion monedas={filas} onClose={() => setModal(null)} addToast={addToast} onGuardado={() => { setModal(null); cargar() }} />}
    </div>
  )
}
