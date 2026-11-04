import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import DataTable from '../layout/DataTable'
import TablaAuto from '../layout/TablaAuto'
import Modal, { Campo, Tarjeta } from '../layout/Modal'
import Spinner from '../Spinner'
import { dinero, fecha } from '../../utils/formato'
import { descargarArchivo } from '../../utils/ticket'

const PESTANAS = [['existencias', 'Existencias'], ['valorizado', 'Valorizado'], ['vencimientos', 'Vencimientos'], ['reposicion', 'Reposición'], ['depositos', 'Depósitos']]
const num = (n) => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 3 })

function Kardex({ item, onClose, addToast }) {
  const [filas, setFilas] = useState(null)
  useEffect(() => {
    api.llamar(`/stock/kardex${api.qs({ item_tipo: item.tipo, item_id: item.item_id, deposito_id: item.deposito_id })}`).then(setFilas).catch(e => { addToast(e.message, 'error'); onClose() })
  }, [item, addToast, onClose])
  const bajar = (formato) => descargarArchivo(`/api/stock/kardex${api.qs({ item_tipo: item.tipo, item_id: item.item_id, deposito_id: item.deposito_id, formato })}`, `kardex-${item.nombre}.${formato}`).catch(e => addToast(e.message, 'error'))
  return (
    <Modal titulo={`Kardex · ${item.nombre} (${item.deposito})`} onClose={onClose} ancho="max-w-4xl"
      pie={['csv', 'xlsx', 'pdf'].map(f => <button key={f} onClick={() => bajar(f)} className="btn btn-azul btn-chico uppercase">{f}</button>)}>
      {!filas ? <Spinner /> : (
        <DataTable filas={filas.map((f, i) => ({ id: i, ...f })).reverse()} vacio="Sin movimientos."
          columnas={[
            { key: 'created_at', titulo: 'Fecha', render: f => fecha(f.created_at) },
            { key: 'tipo', titulo: 'Tipo' },
            { key: 'motivo', titulo: 'Motivo' },
            { key: 'cantidad', titulo: 'Cantidad', align: 'right', render: f => <span className={Number(f.cantidad) < 0 ? 'text-rose-500' : 'text-marca-700'}>{num(f.cantidad)}</span> },
            { key: 'saldo', titulo: 'Saldo', align: 'right', render: f => num(f.saldo) },
          ]} />
      )}
    </Modal>
  )
}

function Movimiento({ tipo, depositos, onClose, onHecho, addToast }) {
  const [motivos, setMotivos] = useState([])
  const [items, setItems] = useState({ insumo: [], producto: [] })
  const [f, setF] = useState({ deposito_id: depositos.find(d => d.predeterminado)?.id ?? depositos[0]?.id ?? '', motivo: '', proveedor: '', observacion: '', item: '', cantidad: '', costo_unitario: '' })
  const [enviando, setEnviando] = useState(false)
  useEffect(() => {
    api.llamar('/stock/motivos').then(m => setMotivos(m.filter(x => x.tipo === tipo))).catch(() => {})
    Promise.all([api.getInsumos(), api.getProductos()]).then(([insumo, producto]) => setItems({ insumo, producto })).catch(() => {})
  }, [tipo])
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }))
  const guardar = async (e) => {
    e.preventDefault()
    const [t, id] = f.item.split(':')
    const linea = { item: { tipo: t, id: Number(id) }, cantidad: Number(f.cantidad), ...(tipo === 'ingreso' && f.costo_unitario !== '' && { costo_unitario: Number(f.costo_unitario) }) }
    setEnviando(true)
    try {
      await api.llamar(tipo === 'ingreso' ? '/stock/ingresos' : '/stock/egresos', {
        method: 'POST',
        body: { deposito_id: Number(f.deposito_id), motivo: f.motivo, observacion: f.observacion || undefined, ...(tipo === 'ingreso' && f.proveedor && { proveedor: f.proveedor }), lineas: [linea] },
      })
      addToast(tipo === 'ingreso' ? 'Ingreso registrado.' : 'Egreso registrado.')
      onHecho()
    } catch (err) { addToast(err.message, 'error') } finally { setEnviando(false) }
  }
  return (
    <Modal titulo={tipo === 'ingreso' ? 'Ingreso de mercadería' : 'Egreso de mercadería'} onClose={onClose} ancho="max-w-xl">
      <form onSubmit={guardar} className="grid grid-cols-2 gap-3">
        <Campo etiqueta="Depósito"><select required value={f.deposito_id} onChange={set('deposito_id')} className="campo w-full">{depositos.map(d => <option key={d.id} value={d.id}>{d.nombre}</option>)}</select></Campo>
        <Campo etiqueta="Motivo"><select required value={f.motivo} onChange={set('motivo')} className="campo w-full"><option value="">Elegí…</option>{motivos.map(m => <option key={m.codigo} value={m.codigo}>{m.nombre}</option>)}</select></Campo>
        <Campo etiqueta="Ítem" className="col-span-2">
          <select required value={f.item} onChange={set('item')} className="campo w-full">
            <option value="">Elegí…</option>
            <optgroup label="Insumos">{items.insumo.map(i => <option key={`i${i.id}`} value={`insumo:${i.id}`}>{i.nombre} ({i.unidad})</option>)}</optgroup>
            <optgroup label="Productos">{items.producto.map(p => <option key={`p${p.id}`} value={`producto:${p.id}`}>{p.nombre}</option>)}</optgroup>
          </select>
        </Campo>
        <Campo etiqueta="Cantidad"><input required type="number" step="any" min="0" value={f.cantidad} onChange={set('cantidad')} className="campo w-full" /></Campo>
        {tipo === 'ingreso' && <Campo etiqueta="Costo unitario"><input type="number" step="any" min="0" value={f.costo_unitario} onChange={set('costo_unitario')} className="campo w-full" /></Campo>}
        {tipo === 'ingreso' && <Campo etiqueta="Proveedor" className="col-span-2"><input value={f.proveedor} onChange={set('proveedor')} className="campo w-full" /></Campo>}
        <Campo etiqueta="Observación" className="col-span-2"><input value={f.observacion} onChange={set('observacion')} className="campo w-full" /></Campo>
        <div className="col-span-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn bg-stone-400 hover:bg-stone-500">Cancelar</button>
          <button disabled={enviando} className="btn btn-azul">{enviando ? 'Guardando…' : 'Registrar'}</button>
        </div>
      </form>
    </Modal>
  )
}

export default function Existencias({ addToast, usuario }) {
  const [pestana, setPestana] = useState('existencias')
  const [depositos, setDepositos] = useState([])
  const [filtro, setFiltro] = useState({ deposito_id: '', tipo: '' })
  const [datos, setDatos] = useState(null)
  const [kardex, setKardex] = useState(null)
  const [movimiento, setMovimiento] = useState(null)
  const [dias, setDias] = useState(7)
  const puedeRegistrar = api.can(usuario, 'stock.movimientos.registrar')

  useEffect(() => { api.llamar('/depositos').then(setDepositos).catch(() => {}) }, [])

  const cargar = useCallback(async () => {
    setDatos(null)
    try {
      if (pestana === 'existencias') setDatos(await api.llamar(`/stock/existencias${api.qs(filtro)}`))
      if (pestana === 'valorizado') setDatos(await api.llamar(`/stock/valorizado${api.qs({ deposito_id: filtro.deposito_id })}`))
      if (pestana === 'vencimientos') setDatos(await api.llamar(`/lotes/vencimientos${api.qs({ dias })}`))
      if (pestana === 'reposicion') setDatos(await api.llamar(`/inventario/reposicion${api.qs({ deposito_id: filtro.deposito_id })}`))
      if (pestana === 'depositos') setDatos(depositos)
    } catch (err) { addToast(err.message, 'error'); setDatos([]) }
  }, [pestana, filtro, dias, depositos, addToast])
  useEffect(() => { cargar() }, [cargar])

  const selDeposito = (
    <Campo etiqueta="Depósito">
      <select value={filtro.deposito_id} onChange={e => setFiltro(f => ({ ...f, deposito_id: e.target.value }))} className="campo">
        <option value="">Todos</option>{depositos.map(d => <option key={d.id} value={d.id}>{d.nombre}</option>)}
      </select>
    </Campo>
  )

  return (
    <div>
      <div className="flex flex-wrap gap-1 border-b border-stone-200 mb-4">
        {PESTANAS.map(([id, t]) => (
          <button key={id} onClick={() => setPestana(id)}
            className={`px-4 py-2 text-sm -mb-px border-b-2 ${pestana === id ? 'border-cafe-800 text-cafe-800 font-semibold' : 'border-transparent text-stone-500 hover:text-stone-800'}`}>{t}</button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-4">
        {pestana !== 'depositos' && pestana !== 'vencimientos' && selDeposito}
        {pestana === 'existencias' && (
          <Campo etiqueta="Tipo">
            <select value={filtro.tipo} onChange={e => setFiltro(f => ({ ...f, tipo: e.target.value }))} className="campo">
              <option value="">Todos</option><option value="insumo">Insumos</option><option value="producto">Productos</option>
            </select>
          </Campo>
        )}
        {pestana === 'vencimientos' && <Campo etiqueta="Vencen en los próximos (días)"><input type="number" min="0" value={dias} onChange={e => setDias(e.target.value)} className="campo w-24" /></Campo>}
        {pestana === 'existencias' && puedeRegistrar && (
          <div className="ml-auto flex gap-2">
            <button onClick={() => setMovimiento('ingreso')} className="btn btn-azul">+ Ingreso</button>
            <button onClick={() => setMovimiento('egreso')} className="btn btn-rojo">− Egreso</button>
          </div>
        )}
      </div>

      {!datos ? <div className="flex justify-center py-12"><Spinner size="lg" /></div> : (
        <>
          {pestana === 'existencias' && (
            <DataTable filas={datos.map((d, i) => ({ id: i, ...d }))} vacio="No hay existencias registradas."
              columnas={[
                { key: 'nombre', titulo: 'Ítem' }, { key: 'tipo', titulo: 'Tipo' }, { key: 'deposito', titulo: 'Depósito' }, { key: 'unidad', titulo: 'Unidad' },
                { key: 'fisico', titulo: 'Físico', align: 'right', render: d => num(d.fisico) },
                { key: 'comprometido', titulo: 'Comprometido', align: 'right', render: d => num(d.comprometido) },
                { key: 'disponible', titulo: 'Disponible', align: 'right', render: d => <span className={`etiqueta ${d.disponible > 0 ? 'bg-marca-600' : 'bg-rose-400'}`}>{num(d.disponible)}</span> },
              ]}
              acciones={d => <button onClick={() => setKardex(d)} className="btn btn-azul btn-chico">Kardex</button>} />
          )}
          {pestana === 'valorizado' && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
                <Tarjeta titulo="Valor del inventario" valor={dinero(datos.total)} />
                <Tarjeta titulo="Método de valuación" valor={datos.metodo} />
              </div>
              <DataTable filas={datos.items.map(d => ({ id: `${d.tipo}${d.item_id}`, ...d }))} vacio="Sin inventario."
                columnas={[
                  { key: 'nombre', titulo: 'Ítem' }, { key: 'tipo', titulo: 'Tipo' },
                  { key: 'cantidad', titulo: 'Cantidad', align: 'right', render: d => num(d.cantidad) },
                  { key: 'valor', titulo: 'Valor', align: 'right', render: d => dinero(d.valor) },
                  { key: 'cantidad_sin_costo', titulo: 'Sin costo', align: 'right', render: d => (d.cantidad_sin_costo ? <span className="etiqueta bg-amber-500">{num(d.cantidad_sin_costo)}</span> : '—') },
                ]} />
            </>
          )}
          {pestana === 'vencimientos' && (
            <DataTable filas={datos.map((d, i) => ({ id: i, ...d }))} vacio="No hay lotes por vencer en ese plazo."
              columnas={[
                { key: 'nombre', titulo: 'Ítem' }, { key: 'codigo', titulo: 'Lote' }, { key: 'deposito', titulo: 'Depósito' },
                { key: 'fecha_vencimiento', titulo: 'Vence' },
                { key: 'saldo', titulo: 'Saldo', align: 'right', render: d => num(d.saldo) },
                { key: 'estado', titulo: 'Estado', align: 'center', valor: d => (d.vencido ? 'Vencido' : d.bloqueado ? 'Bloqueado' : 'Por vencer'), render: d => <span className={`etiqueta ${d.vencido ? 'bg-rose-400' : d.bloqueado ? 'bg-stone-400' : 'bg-amber-500'}`}>{d.vencido ? 'Vencido' : d.bloqueado ? 'Bloqueado' : 'Por vencer'}</span> },
              ]} />
          )}
          {pestana === 'reposicion' && <TablaAuto filas={datos} vacio="No hay nada para reponer." />}
          {pestana === 'depositos' && <TablaAuto filas={datos} ocultar={['created_at', 'updated_at']} vacio="No hay depósitos." />}
        </>
      )}

      {kardex && <Kardex item={kardex} onClose={() => setKardex(null)} addToast={addToast} />}
      {movimiento && <Movimiento tipo={movimiento} depositos={depositos.filter(d => d.activo !== 0 && d.activo !== false)} onClose={() => setMovimiento(null)} onHecho={() => { setMovimiento(null); cargar() }} addToast={addToast} />}
    </div>
  )
}
