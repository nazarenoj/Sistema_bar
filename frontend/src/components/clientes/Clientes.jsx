import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import DataTable from '../layout/DataTable'
import TablaAuto from '../layout/TablaAuto'
import Modal, { Campo, Tarjeta } from '../layout/Modal'
import Spinner from '../Spinner'
import { dinero, dia } from '../../utils/formato'

const PESTANAS = [['clientes', 'Clientes'], ['deudores', 'Deudores'], ['antiguedad', 'Antigüedad de deuda'], ['cobranzas', 'Cobranzas']]

function FormCliente({ cliente, onClose, onGuardado, addToast }) {
  const [f, setF] = useState({ tipo_documento: 'DNI', nro_documento: '', razon_social: '', telefono: '', email: '', domicilio_fiscal: '', condicion_iva: '', ...cliente })
  const [guardando, setGuardando] = useState(false)
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }))
  const guardar = async (e) => {
    e.preventDefault()
    setGuardando(true)
    try {
      const body = { razon_social: f.razon_social, telefono: f.telefono || undefined, email: f.email || undefined, domicilio_fiscal: f.domicilio_fiscal || undefined, condicion_iva: f.condicion_iva || undefined }
      if (cliente) await api.llamar(`/clientes/${cliente.id}`, { method: 'PUT', body })
      else await api.llamar('/clientes', { method: 'POST', body: { ...body, tipo_documento: f.tipo_documento, nro_documento: f.nro_documento } })
      addToast(cliente ? 'Cliente actualizado.' : 'Cliente creado.')
      onGuardado()
    } catch (err) { addToast(err.message, 'error') } finally { setGuardando(false) }
  }
  return (
    <Modal titulo={cliente ? 'Editar cliente' : 'Nuevo cliente'} onClose={onClose} ancho="max-w-xl">
      <form onSubmit={guardar} className="grid grid-cols-2 gap-3">
        {!cliente && (
          <>
            <Campo etiqueta="Tipo de documento"><select value={f.tipo_documento} onChange={set('tipo_documento')} className="campo w-full">{['DNI', 'CUIT', 'CUIL', 'PASAPORTE'].map(t => <option key={t}>{t}</option>)}</select></Campo>
            <Campo etiqueta="Número"><input required value={f.nro_documento} onChange={set('nro_documento')} className="campo w-full" /></Campo>
          </>
        )}
        <Campo etiqueta="Nombre o razón social" className="col-span-2"><input required value={f.razon_social} onChange={set('razon_social')} className="campo w-full" /></Campo>
        <Campo etiqueta="Teléfono"><input value={f.telefono ?? ''} onChange={set('telefono')} className="campo w-full" /></Campo>
        <Campo etiqueta="Correo"><input type="email" value={f.email ?? ''} onChange={set('email')} className="campo w-full" /></Campo>
        <Campo etiqueta="Domicilio fiscal" className="col-span-2"><input value={f.domicilio_fiscal ?? ''} onChange={set('domicilio_fiscal')} className="campo w-full" /></Campo>
        <Campo etiqueta="Condición frente al IVA" className="col-span-2"><input value={f.condicion_iva ?? ''} onChange={set('condicion_iva')} className="campo w-full" placeholder="Ej.: Responsable Inscripto" /></Campo>
        <div className="col-span-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn bg-stone-400 hover:bg-stone-500">Cancelar</button>
          <button disabled={guardando} className="btn btn-azul">{guardando ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </form>
    </Modal>
  )
}

function Ficha({ cliente, onClose, onEditar, puedeEditar, addToast }) {
  const [cuentas, setCuentas] = useState(null)
  const [cuenta, setCuenta] = useState(null)
  const [movs, setMovs] = useState(null)
  const [pendientes, setPendientes] = useState(null)

  useEffect(() => {
    api.llamar(`/cuentas-corrientes${api.qs({ cliente_id: cliente.id })}`).then(c => { setCuentas(c); if (c[0]) setCuenta(c[0]) }).catch(() => setCuentas([]))
  }, [cliente.id])
  useEffect(() => {
    if (!cuenta) return
    setMovs(null); setPendientes(null)
    api.llamar(`/cuentas-corrientes/${cuenta.id}/movimientos`).then(setMovs).catch(e => addToast(e.message, 'error'))
    api.llamar(`/cuentas-corrientes/${cuenta.id}/pendientes`).then(setPendientes).catch(() => setPendientes([]))
  }, [cuenta, addToast])

  const deuda = (pendientes ?? []).reduce((a, p) => a + Number(p.saldo_pendiente), 0)
  return (
    <Modal titulo={cliente.razon_social} onClose={onClose} ancho="max-w-4xl"
      pie={puedeEditar && <button onClick={onEditar} className="btn btn-azul">Editar datos</button>}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 text-sm">
        <Tarjeta titulo="Documento" valor={`${cliente.tipo_documento} ${cliente.nro_documento}`} />
        <Tarjeta titulo="Teléfono" valor={cliente.telefono || '—'} />
        <Tarjeta titulo="Correo" valor={cliente.email || '—'} />
        <Tarjeta titulo="Condición IVA" valor={cliente.condicion_iva || '—'} />
      </div>
      {!cuentas ? <Spinner /> : cuentas.length === 0 ? <p className="text-sm text-stone-500">Este cliente no tiene cuenta corriente.</p> : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            {cuentas.length > 1 && (
              <select value={cuenta?.id} onChange={e => setCuenta(cuentas.find(c => c.id === Number(e.target.value)))} className="campo">
                {cuentas.map(c => <option key={c.id} value={c.id}>Cuenta {c.id} ({c.moneda})</option>)}
              </select>
            )}
            {cuenta && <><Tarjeta titulo="Límite de crédito" valor={dinero(cuenta.limite_credito)} /><Tarjeta titulo="Deuda pendiente" valor={dinero(deuda)} /></>}
          </div>
          <p className="font-semibold text-stone-700 text-sm">Movimientos</p>
          {!movs ? <Spinner /> : (
            <DataTable filas={movs} vacio="Sin movimientos."
              columnas={[
                { key: 'fecha', titulo: 'Fecha', render: m => dia(m.fecha) },
                { key: 'tipo', titulo: 'Tipo' },
                { key: 'comprobante_ref', titulo: 'Comprobante' },
                { key: 'importe', titulo: 'Importe', align: 'right', render: m => <span className={m.naturaleza === 'debito' ? 'text-rose-500' : 'text-marca-700'}>{m.naturaleza === 'debito' ? '' : '−'}{dinero(m.importe)}</span> },
                { key: 'saldo_pendiente', titulo: 'Pendiente', align: 'right', render: m => (Number(m.saldo_pendiente) ? dinero(m.saldo_pendiente) : '—') },
              ]} />
          )}
        </div>
      )}
    </Modal>
  )
}

function Buscador({ addToast, usuario }) {
  const [q, setQ] = useState('')
  const [filas, setFilas] = useState(null)
  const [ficha, setFicha] = useState(null)
  const [form, setForm] = useState(undefined) // undefined=cerrado, null=nuevo, obj=editar
  const puedeEditar = api.can(usuario, 'clientes.editar')

  const buscar = useCallback(async (e) => {
    e?.preventDefault()
    if (!q.trim()) { setFilas(null); return }
    try { setFilas(await api.llamar(`/clientes${api.qs({ q: q.trim() })}`)) } catch (err) { addToast(err.message, 'error') }
  }, [q, addToast])

  return (
    <div>
      <form onSubmit={buscar} className="flex flex-wrap items-center gap-2 mb-4">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Nombre, documento, teléfono o código de socio" className="campo flex-1 min-w-64" />
        <button className="btn btn-azul">Buscar</button>
        {puedeEditar && <button type="button" onClick={() => setForm(null)} className="btn bg-marca-600 hover:bg-marca-700">+ Nuevo cliente</button>}
      </form>
      {filas === null ? <p className="text-sm text-stone-500">Buscá un cliente para ver su ficha y su cuenta corriente.</p> : (
        <DataTable filas={filas} vacio="No se encontraron clientes."
          columnas={[
            { key: 'razon_social', titulo: 'Nombre' },
            { key: 'documento', titulo: 'Documento', valor: c => `${c.tipo_documento} ${c.nro_documento}` },
            { key: 'telefono', titulo: 'Teléfono' },
            { key: 'condicion_iva', titulo: 'Condición IVA' },
            { key: 'estado', titulo: 'Estado', align: 'center', render: c => <span className={`etiqueta ${c.estado === 'activo' ? 'bg-marca-600' : 'bg-stone-400'}`}>{c.estado}</span> },
          ]}
          acciones={c => <button onClick={() => setFicha(c)} className="btn btn-azul btn-chico">Ver</button>} />
      )}
      {ficha && <Ficha cliente={ficha} onClose={() => setFicha(null)} puedeEditar={puedeEditar} addToast={addToast} onEditar={() => { setForm(ficha); setFicha(null) }} />}
      {form !== undefined && <FormCliente cliente={form} onClose={() => setForm(undefined)} addToast={addToast} onGuardado={() => { setForm(undefined); buscar() }} />}
    </div>
  )
}

function Informe({ tipo, addToast }) {
  const [datos, setDatos] = useState(null)
  useEffect(() => {
    setDatos(null)
    api.llamar(`/clientes-informes/${tipo}`).then(setDatos).catch(e => { addToast(e.message, 'error'); setDatos({}) })
  }, [tipo, addToast])
  if (!datos) return <div className="flex justify-center py-12"><Spinner size="lg" /></div>
  if (tipo === 'deudores') return (
    <>
      <div className="mb-4 max-w-xs"><Tarjeta titulo="Total vencido" valor={dinero(datos.total_vencido)} /></div>
      <TablaAuto filas={datos.deudores ?? []} formato={{ importe_vencido: d => dinero(d.importe_vencido) }} vacio="No hay deudores vencidos." />
    </>
  )
  if (tipo === 'antiguedad') return (
    <>
      <div className="mb-4 max-w-xs"><Tarjeta titulo="Deuda total" valor={dinero(datos.total)} /></div>
      <TablaAuto filas={datos.clientes ?? []} vacio="Sin deuda." />
    </>
  )
  return (
    <div className="grid md:grid-cols-2 gap-6">
      <div><p className="font-semibold text-stone-700 mb-2">Por forma de pago</p><TablaAuto filas={datos.por_forma ?? []} formato={{ importe: d => dinero(d.importe) }} vacio="Sin cobranzas." /></div>
      <div><p className="font-semibold text-stone-700 mb-2">Por día</p><TablaAuto filas={datos.por_dia ?? []} formato={{ importe: d => dinero(d.importe) }} vacio="Sin cobranzas." /></div>
    </div>
  )
}

export default function Clientes({ addToast, usuario }) {
  const [pestana, setPestana] = useState('clientes')
  return (
    <div>
      <div className="flex flex-wrap gap-1 border-b border-stone-200 mb-4">
        {PESTANAS.map(([id, t]) => (
          <button key={id} onClick={() => setPestana(id)}
            className={`px-4 py-2 text-sm -mb-px border-b-2 ${pestana === id ? 'border-cafe-800 text-cafe-800 font-semibold' : 'border-transparent text-stone-500 hover:text-stone-800'}`}>{t}</button>
        ))}
      </div>
      {pestana === 'clientes' ? <Buscador addToast={addToast} usuario={usuario} /> : <Informe tipo={pestana} addToast={addToast} />}
    </div>
  )
}
