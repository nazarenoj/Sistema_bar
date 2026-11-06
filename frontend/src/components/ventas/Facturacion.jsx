import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import DataTable from '../layout/DataTable'
import { Campo, Tarjeta } from '../layout/Modal'
import Spinner from '../Spinner'
import { dinero, fecha, numeroComprobante } from '../../utils/formato'
import { descargarArchivo } from '../../utils/ticket'
import Modulo from '../layout/Modulo'

const ESTADOS = { aprobada: 'bg-marca-600', pendiente: 'bg-amber-500', rechazada: 'bg-rose-400', indeterminada: 'bg-amber-500' }
const PESTANAS = [['comprobantes', 'Comprobantes'], ['libro', 'Libro IVA'], ['arca', 'Estado de ARCA'], ['numeracion', 'Numeración']]

function Comprobantes({ addToast, puedeReintentar }) {
  const [pagina, setPagina] = useState(1)
  const [datos, setDatos] = useState(null)
  const cargar = useCallback(async () => {
    try { setDatos(await api.llamar(`/facturas${api.qs({ page: pagina, limit: 20 })}`)) } catch (err) { addToast(err.message, 'error') }
  }, [pagina, addToast])
  useEffect(() => { cargar() }, [cargar])

  const reintentar = async (f) => {
    try { await api.reintentarFactura(f.id); addToast('Se volvió a pedir el comprobante a ARCA.'); cargar() } catch (err) { addToast(err.message, 'error') }
  }
  const pdf = async (f) => {
    try { await descargarArchivo(`/api/facturas/${f.id}/pdf`, `factura-${numeroComprobante(f.punto_venta, f.numero)}.pdf`) } catch (err) { addToast(err.message, 'error') }
  }
  if (!datos) return <div className="flex justify-center py-12"><Spinner size="lg" /></div>

  const columnas = [
    { key: 'fecha_emision', titulo: 'Fecha', render: f => fecha(f.fecha_emision) },
    { key: 'numero', titulo: 'Número', render: f => numeroComprobante(f.punto_venta, f.numero) },
    { key: 'numero_mesa', titulo: 'Mesa', render: f => `Mesa ${f.numero_mesa}` },
    { key: 'receptor_nombre', titulo: 'Receptor', render: f => f.receptor_nombre || (f.doc_nro ? `Doc. ${f.doc_nro}` : 'Consumidor final') },
    { key: 'importe_total', titulo: 'Total', align: 'right', render: f => dinero(f.importe_total) },
    { key: 'modalidad', titulo: 'Tipo', align: 'center', render: f => (f.devolucion_id ? 'Nota de crédito' : f.modalidad) },
    { key: 'estado', titulo: 'Estado', align: 'center', render: f => <span className={`etiqueta ${ESTADOS[f.estado] ?? 'bg-stone-400'}`}>{f.estado}</span> },
  ]
  return (
    <>
      <DataTable
        filas={datos.facturas} columnas={columnas} vacio="Todavía no se emitió ningún comprobante."
        acciones={f => (
          <>
            {f.estado === 'aprobada' && <button onClick={() => pdf(f)} className="btn btn-azul btn-chico mr-1">PDF</button>}
            {puedeReintentar && f.estado !== 'aprobada' && <button onClick={() => reintentar(f)} className="btn bg-amber-500 hover:bg-amber-600 btn-chico">Reintentar</button>}
          </>
        )}
      />
      {datos.total_paginas > 1 && (
        <div className="flex items-center justify-center gap-3 mt-3 text-sm text-stone-600">
          <button disabled={pagina === 1} onClick={() => setPagina(p => p - 1)} className="paginador rounded-lg">« Más recientes</button>
          <span>Página {datos.page} de {datos.total_paginas}</span>
          <button disabled={pagina >= datos.total_paginas} onClick={() => setPagina(p => p + 1)} className="paginador rounded-lg">Anteriores »</button>
        </div>
      )}
    </>
  )
}

function LibroIva({ addToast }) {
  const [periodo, setPeriodo] = useState(new Date().toISOString().slice(0, 7).replace('-', ''))
  const [resumen, setResumen] = useState(null)
  const [control, setControl] = useState(null)
  const consultar = async () => {
    setControl(null)
    try { setResumen(await api.llamar(`/facturas/libro-iva${api.qs({ periodo })}`)) } catch (err) { setResumen(null); addToast(err.message, 'error') }
  }
  const bajar = async (archivo) => {
    try { await descargarArchivo(`/api/facturas/libro-iva${api.qs({ periodo, archivo })}`, `LIBRO_IVA_VENTAS_${archivo}_${periodo}.txt`) } catch (err) { addToast(err.message, 'error') }
  }
  const controlar = async () => {
    try { setControl(await api.llamar(`/facturas/control-arca${api.qs({ periodo })}`)) } catch (err) { addToast(err.message, 'error') }
  }
  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-end gap-3">
        <Campo etiqueta="Período (AAAAMM)"><input value={periodo} onChange={e => setPeriodo(e.target.value)} maxLength={6} className="campo w-32" /></Campo>
        <button onClick={consultar} className="btn btn-azul">Consultar</button>
      </div>
      {resumen && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Tarjeta titulo="Comprobantes" valor={resumen.cantidad} />
            <Tarjeta titulo="Total" valor={dinero(resumen.total)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => bajar('comprobantes')} className="btn btn-azul">Descargar comprobantes</button>
            <button onClick={() => bajar('alicuotas')} className="btn btn-azul">Descargar alícuotas</button>
            <button onClick={controlar} className="btn bg-marca-600 hover:bg-marca-700">Controlar contra ARCA</button>
          </div>
        </>
      )}
      {control && <pre className="text-xs bg-crema border border-stone-200 rounded-xl p-3 overflow-auto max-h-80">{JSON.stringify(control, null, 2)}</pre>}
      <p className="text-xs text-stone-500">Las notas de crédito y débito de Clientes y CC todavía no entran al libro IVA (se resuelve con Contable).</p>
    </div>
  )
}

function EstadoArca({ addToast }) {
  const [estado, setEstado] = useState(null)
  const [config, setConfig] = useState(null)
  const [caea, setCaea] = useState(null)
  useEffect(() => {
    api.getFacturaConfig().then(setConfig).catch(err => addToast(err.message, 'error'))
    api.getEstadoAfip().then(setEstado).catch(err => setEstado({ error: err.message }))
    api.llamar('/facturas/caea/vigente').then(setCaea).catch(() => setCaea(null))
  }, [addToast])
  return (
    <div className="space-y-4 max-w-2xl">
      {config && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Tarjeta titulo="Entorno" valor={config.entorno} />
          <Tarjeta titulo="Condición del emisor" valor={config.condicion_iva_emisor} />
          <Tarjeta titulo="Comprobantes" valor={(config.tipos_comprobante ?? []).map(t => t.nombre).join(', ')} />
        </div>
      )}
      <div>
        <p className="font-semibold text-stone-700 mb-1">Servicio de ARCA</p>
        {!estado ? <Spinner /> : estado.error
          ? <p className="text-rose-500 text-sm">No se pudo consultar: {estado.error}</p>
          : <pre className="text-xs bg-crema border border-stone-200 rounded-xl p-3 overflow-auto">{JSON.stringify(estado, null, 2)}</pre>}
      </div>
      <div>
        <p className="font-semibold text-stone-700 mb-1">CAEA vigente</p>
        <pre className="text-xs bg-crema border border-stone-200 rounded-xl p-3 overflow-auto">{caea ? JSON.stringify(caea, null, 2) : 'Sin CAEA vigente.'}</pre>
      </div>
    </div>
  )
}

const Numeracion = (p) => (
  <Modulo {...p} tabs={[{
    id: 'claves', titulo: 'Claves de emisión', ruta: '/facturas/claves', permiso: 'facturacion.claves.ver',
    ayuda: 'Cada comprobante se pide a ARCA con una clave única, para no emitir dos veces. Si una quedó bloqueada, un supervisor puede liberarla.',
    crear: { titulo: 'Validar numeración con ARCA', ruta: '/facturas/claves/validar', permiso: 'facturacion.claves.resolver', mensaje: 'Numeración validada.', campos: [{ k: 'tipo_comprobante', etiqueta: 'Tipo de comprobante (código ARCA)', tipo: 'entero', requerido: true, ayuda: '1 = Factura A, 6 = Factura B, 11 = Factura C' }] },
    acciones: [
      { titulo: 'Liberar', permiso: 'facturacion.claves.resolver', ruta: () => '/facturas/claves/liberar', mensaje: 'Clave liberada.', campos: [{ k: 'motivo', etiqueta: 'Motivo', requerido: true }], body: (f, v) => ({ clave: f.clave, motivo: v.motivo }) },
    ],
  },
  {
    id: 'sincronizar', titulo: 'Tras restaurar una copia', ruta: '/facturas/claves', permiso: 'facturacion.claves.ver',
    ayuda: 'Después de restaurar una copia, hay que sincronizar la numeración con ARCA antes de emitir.',
    crear: { titulo: 'Sincronizar numeración', ruta: '/facturas/claves/sincronizar', permiso: 'facturacion.claves.resolver', mensaje: 'Numeración sincronizada.', campos: [], armar: () => ({}) },
  }]} />
)

export default function Facturacion({ addToast, usuario, confirm }) {
  const [pestana, setPestana] = useState('comprobantes')
  return (
    <div>
      <div className="flex gap-1 border-b border-stone-200 mb-4">
        {PESTANAS.map(([id, t]) => (
          <button key={id} onClick={() => setPestana(id)}
            className={`px-4 py-2 text-sm -mb-px border-b-2 ${pestana === id ? 'border-cafe-800 text-cafe-800 font-semibold' : 'border-transparent text-stone-500 hover:text-stone-800'}`}>{t}</button>
        ))}
      </div>
      {pestana === 'comprobantes' && <Comprobantes addToast={addToast} puedeReintentar={api.can(usuario, 'facturacion.reintentar')} />}
      {pestana === 'libro' && <LibroIva addToast={addToast} />}
      {pestana === 'arca' && <EstadoArca addToast={addToast} />}
      {pestana === 'numeracion' && <Numeracion addToast={addToast} usuario={usuario} confirm={confirm} />}
    </div>
  )
}
