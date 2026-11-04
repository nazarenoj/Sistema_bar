import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import DataTable from '../layout/DataTable'
import Modal, { Campo, Tarjeta } from '../layout/Modal'
import Spinner from '../Spinner'
import { dinero, fecha, numeroComprobante } from '../../utils/formato'
import { descargarArchivo } from '../../utils/ticket'

const ESTADOS = { cerrada: ['Cerrada', 'bg-marca-600'], devuelta_parcial: ['Devuelta parcial', 'bg-amber-500'], anulada: ['Anulada', 'bg-rose-400'] }
const FILTROS_VACIOS = { desde: '', hasta: '', estado: '', mesa: '', usuario: '' }
const textoComprobante = (v) => (v.numero ? numeroComprobante(v.punto_venta, v.numero) : v.numero_no_fiscal ? `NF ${v.numero_no_fiscal}` : 'Sin comprobante')

export default function RegistroVentas({ addToast }) {
  const [filtros, setFiltros] = useState(FILTROS_VACIOS)
  const [aplicados, setAplicados] = useState(FILTROS_VACIOS)
  const [pagina, setPagina] = useState(1)
  const [datos, setDatos] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [detalle, setDetalle] = useState(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    try { setDatos(await api.llamar(`/ventas${api.qs({ ...aplicados, page: pagina })}`)) }
    catch (err) { addToast(err.message, 'error') }
    finally { setCargando(false) }
  }, [aplicados, pagina, addToast])
  useEffect(() => { cargar() }, [cargar])

  const buscar = (e) => { e.preventDefault(); setPagina(1); setAplicados(filtros) }
  const limpiar = () => { setFiltros(FILTROS_VACIOS); setPagina(1); setAplicados(FILTROS_VACIOS) }
  const exportar = async (formato) => {
    try { await descargarArchivo(`/api/ventas/exportar${api.qs({ ...aplicados, formato })}`, `registro-ventas.${formato}`) }
    catch (err) { addToast(err.message, 'error') }
  }
  const abrir = async (v) => {
    try { setDetalle(await api.llamar(`/ventas/${v.id_global}`)) } catch (err) { addToast(err.message, 'error') }
  }
  const set = (k) => (e) => setFiltros(f => ({ ...f, [k]: e.target.value }))

  const columnas = [
    { key: 'created_at', titulo: 'Fecha', render: v => fecha(v.created_at) },
    { key: 'numero_mesa', titulo: 'Mesa', render: v => `Mesa ${v.numero_mesa}` },
    { key: 'comprobante', titulo: 'Comprobante', valor: textoComprobante, render: textoComprobante },
    { key: 'formas', titulo: 'Forma de pago', render: v => (v.formas || '—').split(',').join(' + ') },
    { key: 'usuario', titulo: 'Usuario' },
    { key: 'total', titulo: 'Total', align: 'right', render: v => dinero(v.total) },
    { key: 'estado', titulo: 'Estado', align: 'center', render: v => { const [t, c] = ESTADOS[v.estado] ?? [v.estado, 'bg-stone-400']; return <span className={`etiqueta ${c}`}>{t}</span> } },
  ]

  return (
    <div>
      <form onSubmit={buscar} className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end mb-4">
        <Campo etiqueta="Desde"><input type="date" value={filtros.desde} onChange={set('desde')} className="campo w-full" /></Campo>
        <Campo etiqueta="Hasta"><input type="date" value={filtros.hasta} onChange={set('hasta')} className="campo w-full" /></Campo>
        <Campo etiqueta="Estado">
          <select value={filtros.estado} onChange={set('estado')} className="campo w-full">
            <option value="">Todos</option>
            {Object.entries(ESTADOS).map(([k, [t]]) => <option key={k} value={k}>{t}</option>)}
          </select>
        </Campo>
        <Campo etiqueta="Mesa"><input value={filtros.mesa} onChange={set('mesa')} className="campo w-full" /></Campo>
        <Campo etiqueta="Usuario"><input value={filtros.usuario} onChange={set('usuario')} className="campo w-full" /></Campo>
        <div className="flex gap-2">
          <button className="btn btn-azul">Buscar</button>
          <button type="button" onClick={limpiar} className="btn bg-stone-400 hover:bg-stone-500">Limpiar</button>
        </div>
      </form>

      {datos && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <Tarjeta titulo="Ventas" valor={datos.totales.cantidad} />
          <Tarjeta titulo="Total vendido" valor={dinero(datos.totales.total)} nota="neto de devoluciones" />
          {datos.totales.por_forma_pago.slice(0, 2).map(p => <Tarjeta key={p.forma} titulo={p.forma} valor={dinero(p.total)} />)}
        </div>
      )}

      <div className="flex gap-2 mb-3">
        {['csv', 'xlsx', 'pdf'].map(f => <button key={f} onClick={() => exportar(f)} className="btn bg-marca-600 hover:bg-marca-700 btn-chico uppercase">{f}</button>)}
      </div>

      {cargando && !datos ? <div className="flex justify-center py-16"><Spinner size="lg" /></div> : (
        <>
          <DataTable
            filas={(datos?.ventas ?? []).map(v => ({ ...v, id: v.id_global }))} columnas={columnas} vacio="No hay ventas con esos filtros."
            acciones={v => <button onClick={() => abrir(v)} className="btn btn-azul btn-chico">Ver</button>}
          />
          {datos && datos.total_paginas > 1 && (
            <div className="flex items-center justify-center gap-3 mt-3 text-sm text-stone-600">
              <button disabled={pagina === 1} onClick={() => setPagina(p => p - 1)} className="paginador rounded-lg">« Más recientes</button>
              <span>Página {datos.page} de {datos.total_paginas}</span>
              <button disabled={pagina >= datos.total_paginas} onClick={() => setPagina(p => p + 1)} className="paginador rounded-lg">Anteriores »</button>
            </div>
          )}
        </>
      )}

      {detalle && (
        <Modal titulo={`Venta · ${fecha(detalle.created_at)}`} onClose={() => setDetalle(null)}>
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-2 items-center">
              <span className={`etiqueta ${(ESTADOS[detalle.estado] ?? [0, 'bg-stone-400'])[1]}`}>{(ESTADOS[detalle.estado] ?? [detalle.estado])[0]}</span>
              {detalle.pendiente_de_costo && <span className="etiqueta bg-amber-500">Costo pendiente</span>}
              <span className="text-stone-500">{detalle.id_global}</span>
            </div>
            <table className="w-full">
              <thead><tr className="text-left text-stone-500 border-b"><th className="py-1">Producto</th><th className="text-right">Cant.</th><th className="text-right">Precio</th><th className="text-right">Subtotal</th></tr></thead>
              <tbody>
                {detalle.detalle.map((l, i) => (
                  <tr key={i} className="border-b border-stone-100">
                    <td className="py-1">{l.nombre}{l.serie && <span className="text-xs text-stone-500"> · serie {l.serie}</span>}</td>
                    <td className="text-right">{l.cantidad}</td>
                    <td className="text-right">{dinero(l.precio_unitario)}</td>
                    <td className="text-right">{dinero(l.cantidad * l.precio_unitario)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div>
              <p className="font-semibold text-stone-700 mb-1">Pagos</p>
              {detalle.pagos.map((p, i) => <p key={i} className="flex justify-between"><span>{p.metodo_pago}{p.moneda ? ` (${p.moneda})` : ''}</span><span>{dinero(p.importe)}</span></p>)}
              <p className="flex justify-between font-semibold border-t mt-1 pt-1"><span>Total</span><span>{dinero(detalle.total)}</span></p>
              {detalle.devuelto > 0 && <p className="flex justify-between text-rose-500"><span>Devuelto</span><span>−{dinero(detalle.devuelto)}</span></p>}
            </div>
            {detalle.reimpresiones?.length > 0 && <p className="text-xs text-stone-500">Reimpresiones: {detalle.reimpresiones.length}</p>}
          </div>
        </Modal>
      )}
    </div>
  )
}
