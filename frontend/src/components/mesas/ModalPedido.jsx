import { useState, useEffect } from 'react'
import * as api from '../../api'
import Spinner from '../Spinner'
import BuscadorProducto from './BuscadorProducto'
import CierreCuentaModal from './CierreCuentaModal'
import { imprimirTicket, descargarArchivo } from '../../utils/ticket'

const formatHora = (fecha) =>
  fecha ? new Date(fecha).toLocaleString('es-AR', { hour12: false }) : '—'

export default function ModalPedido({ mesa, productos, onClose, onMesaUpdate, addToast, confirm }) {
  const [localEstado, setLocalEstado] = useState(mesa.estado)
  const [ticketPendiente, setTicketPendiente] = useState(!!mesa.ticket_pendiente)
  const [cuentaData, setCuentaData]   = useState({ pedidos: [], hora_apertura: null, total_acumulado: 0 })
  const [loading, setLoading]         = useState(false)
  const [submitting, setSubmitting]   = useState(false)
  const [ticketPrompt, setTicketPrompt] = useState(null) // { titulo, url, filename, cierre, onDismiss }
  const [ticketBusy, setTicketBusy]   = useState(false)
  const [showCierreCuenta, setShowCierreCuenta] = useState(false)
  const [facturaInfo, setFacturaInfo] = useState(null)
  const [comandaBusy, setComandaBusy] = useState(false)

  const ticketCuentaMesa = () => ({
    titulo: 'Cuenta cerrada',
    url: `/api/mesas/${mesa.id}/ticket`,
    filename: `ticket-mesa-${mesa.id}.pdf`,
    cierre: true,
    onDismiss: onClose,
  })

  // Si la mesa ya tenía un ticket pendiente de una cuenta cerrada anteriormente (por ejemplo,
  // se salió del menú sin imprimir/descargar), se vuelve a ofrecer directamente en vez de mostrar
  // la pantalla normal de pedidos, ya que no puede haber pedidos activos en ese estado.
  useEffect(() => {
    if (localEstado !== 'ocupado') return
    if (ticketPendiente) {
      setTicketPrompt(ticketCuentaMesa())
    } else {
      fetchPedidosActivos()
    }
  }, [localEstado]) // eslint-disable-line

  const fetchPedidosActivos = async () => {
    setLoading(true)
    try {
      const data = await api.getPedidosActivosMesa(mesa.id)
      setCuentaData(data)
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  const handleAbrirPedido = async () => {
    setSubmitting(true)
    try {
      await api.abrirPedido(mesa.id)
      setLocalEstado('ocupado')
      onMesaUpdate()
      addToast('Pedido abierto.')
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleNuevoPedido = async () => {
    setSubmitting(true)
    try {
      await api.abrirPedido(mesa.id)
      await fetchPedidosActivos()
      onMesaUpdate()
      addToast('Nueva silla agregada a la mesa.')
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleAddProducto = async (pedido_id, producto_id, cantidad) => {
    setSubmitting(true)
    try {
      await api.addProductosPedido(pedido_id, [{ producto_id, cantidad }])
      await fetchPedidosActivos()
      addToast('Producto añadido.')
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleCerrarPedido = async (pedido, silla) => {
    if (!(await confirm(`¿Cerrar la cuenta de la silla ${silla}?`, { title: 'Cerrar cuenta', danger: false }))) return
    setSubmitting(true)
    try {
      const result = await api.cerrarPedidoIndividual(pedido.id)
      addToast(`Silla ${silla} cerrada · Total: $${Number(result.total).toFixed(2)}`)
      if (result.ticket_pendiente) {
        // Era la última silla activa: la cuenta de la mesa quedó completa y lista para el
        // ticket consolidado. La mesa sigue ocupada hasta imprimirlo/descargarlo.
        setTicketPendiente(true)
        setTicketPrompt(ticketCuentaMesa())
      } else {
        setTicketPrompt({
          titulo: `Silla ${silla} cerrada`,
          url: `/api/pedidos/${pedido.id}/ticket`,
          filename: `ticket-pedido-${pedido.id}.pdf`,
          cierre: false,
          onDismiss: null,
        })
        await fetchPedidosActivos()
      }
      onMesaUpdate()
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleEliminarPedido = async (pedido, silla) => {
    if (!(await confirm(`¿Eliminar la silla ${silla}? Esta acción no se puede deshacer.`, { title: 'Eliminar silla' }))) return
    setSubmitting(true)
    try {
      const result = await api.eliminarPedido(pedido.id)
      addToast(`Silla ${silla} eliminada.`)
      if (result.mesa_liberada) {
        setLocalEstado('libre')
      } else {
        await fetchPedidosActivos()
      }
      onMesaUpdate()
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleEliminarItem = async (pedido_id, item_id) => {
    setSubmitting(true)
    try {
      await api.eliminarItemPedido(pedido_id, item_id)
      await fetchPedidosActivos()
      addToast('Producto quitado del pedido.')
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleToggleItemEntregado = async (pedido_id, item_id, entregado) => {
    setSubmitting(true)
    try {
      await api.marcarItemEntregado(pedido_id, item_id, entregado)
      await fetchPedidosActivos()
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleToggleSillaEntregado = async (pedido_id, entregado) => {
    setSubmitting(true)
    try {
      await api.marcarPedidoEntregado(pedido_id, entregado)
      await fetchPedidosActivos()
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  // Confirma al backend que el ticket se imprimió/descargó: recién ahí la mesa pasa a libre.
  const confirmarLiberacionMesa = async () => {
    try {
      await api.confirmarTicketMesa(mesa.id)
      setTicketPendiente(false)
      setLocalEstado('libre')
      onMesaUpdate()
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  const handleImprimirTicket = async () => {
    setTicketBusy(true)
    try {
      await imprimirTicket(ticketPrompt.url)
      if (ticketPrompt.cierre) await confirmarLiberacionMesa()
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setTicketBusy(false)
    }
  }

  const handleDescargarTicket = async () => {
    setTicketBusy(true)
    try {
      await descargarArchivo(ticketPrompt.url, ticketPrompt.filename)
      if (ticketPrompt.cierre) await confirmarLiberacionMesa()
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setTicketBusy(false)
    }
  }

  // Cuando ya hay factura fiscal aprobada, la URL del ticket devuelve ese PDF por defecto;
  // este botón pide explícitamente el ticket interno no fiscal (?tipo=interno) para uso de
  // mostrador/cocina, sin afectar el flujo de liberación de la mesa.
  const handleDescargarTicketInterno = async () => {
    setTicketBusy(true)
    try {
      await descargarArchivo(`${ticketPrompt.url}?tipo=interno`, `interno-${ticketPrompt.filename}`)
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setTicketBusy(false)
    }
  }

  // Al cerrar una silla el modal sigue abierto y el prompt se descarta solo; al cerrar toda la
  // cuenta, la mesa queda ocupada con el ticket pendiente y el usuario puede salir del menú sin
  // imprimir/descargar (se le va a volver a ofrecer la próxima vez que abra esta mesa).
  const cerrarTicketPrompt = () => {
    const prompt = ticketPrompt
    setTicketPrompt(null)
    prompt?.onDismiss?.()
  }

  // La comanda (para cocina/barra) se puede imprimir en cualquier momento con la cuenta abierta,
  // a diferencia del ticket que solo está disponible al cerrar silla/cuenta.
  const handleImprimirComanda = async () => {
    setComandaBusy(true)
    try {
      await imprimirTicket(`/api/mesas/${mesa.id}/comanda`)
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setComandaBusy(false)
    }
  }

  // Clave de la operación "cerrar cuenta": una por formulario abierto, así el doble clic cobra una sola vez.
  const [solicitudCierre, setSolicitudCierre] = useState(api.nuevaSolicitud)
  const handleCerrarCuenta = () => setShowCierreCuenta(true)

  const handleConfirmarCierreCuenta = async (body) => {
    setSubmitting(true)
    try {
      const result = await api.cerrarCuenta(mesa.id, body, solicitudCierre)
      setShowCierreCuenta(false)
      setFacturaInfo(result.factura)
      addToast(`Cuenta cerrada · Total: $${Number(result.total_acumulado).toFixed(2)}`)
      setTicketPendiente(true)
      onMesaUpdate()
      setTicketPrompt(ticketCuentaMesa())
    } catch (err) {
      // Con una respuesta definitiva la próxima vez es otra operación (clave nueva); con la respuesta perdida se reintenta con la misma.
      if (err.status) setSolicitudCierre(api.nuevaSolicitud())
      addToast(err.message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleReintentarFactura = async () => {
    if (!facturaInfo) return
    setSubmitting(true)
    try {
      const result = await api.reintentarFactura(facturaInfo.id)
      setFacturaInfo(result.factura)
      addToast(
        result.factura.estado === 'aprobada'
          ? `Factura emitida · CAE ${result.factura.cae}`
          : 'ARCA sigue sin responder. Podés reintentar más tarde desde el historial.',
        result.factura.estado === 'aprobada' ? 'success' : 'error'
      )
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const isLibre = localEstado === 'libre'
  const headerBg = isLibre ? 'bg-emerald-500' : 'bg-rose-500'
  const hayItems = cuentaData.pedidos.some(p => p.items.length > 0)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="animate-fade-in bg-white rounded-2xl shadow-2xl w-full max-w-xl mx-4 overflow-hidden max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className={`${headerBg} p-6 text-white transition-colors duration-500 shrink-0`}>
          <div className="flex justify-between items-start">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest opacity-75">Mesa</p>
              <p className="text-5xl font-black leading-none">{mesa.numero_mesa_grupo ?? mesa.numero_mesa}</p>
              <span className={`mt-2 inline-block text-xs font-bold px-2.5 py-0.5 rounded-full
                ${isLibre ? 'bg-emerald-600' : 'bg-rose-600'}`}>
                {ticketPendiente ? 'ticket pendiente' : localEstado}
              </span>
              {!isLibre && cuentaData.hora_apertura && (
                <p className="mt-2 text-xs opacity-90">Mesa abierta desde: {formatHora(cuentaData.hora_apertura)}</p>
              )}
            </div>
            <button onClick={onClose}
              className="p-2 rounded-full hover:bg-white/20 transition text-xl leading-none mt-1">✕</button>
          </div>
        </div>

        <div className="p-6 overflow-y-auto">

          {/* ── LIBRE ── */}
          {isLibre && (
            <div className="text-center py-10">
              <div className="text-6xl mb-4">🍽️</div>
              <p className="text-gray-500 mb-8 text-sm">Esta mesa está libre y disponible.</p>
              <button onClick={handleAbrirPedido} disabled={submitting}
                className="bg-emerald-500 text-white px-10 py-3 rounded-xl font-bold text-lg
                  hover:bg-emerald-600 active:scale-95 transition-all disabled:opacity-50">
                {submitting ? 'Abriendo…' : '🛎 Abrir Pedido'}
              </button>
            </div>
          )}

          {/* ── OCUPADO ── */}
          {!isLibre && (
            <>
              {loading ? (
                <div className="flex justify-center py-12"><Spinner /></div>
              ) : (
                <>
                  <div className="space-y-4 mb-4">
                    {cuentaData.pedidos.map((pedido, idx) => (
                      <div key={pedido.id} className="rounded-xl border overflow-hidden">
                        <div className="bg-gray-50 px-4 py-2 flex justify-between items-center text-xs">
                          <span className="font-bold text-gray-500 uppercase tracking-wider">
                            Silla {idx + 1}
                          </span>
                          <div className="flex items-center gap-3">
                            <label className="flex items-center gap-1.5 text-gray-500 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={!!pedido.entregado}
                                disabled={submitting || pedido.items.length === 0}
                                onChange={(e) => handleToggleSillaEntregado(pedido.id, e.target.checked)}
                              />
                              Entregado
                            </label>
                            <span className="text-gray-400">{formatHora(pedido.fecha_creacion)}</span>
                          </div>
                        </div>

                        {pedido.items.length === 0 ? (
                          <p className="text-gray-400 text-center py-4 text-sm">Sin productos aún.</p>
                        ) : (
                          <div className="max-h-40 overflow-y-auto">
                            <table className="w-full text-sm">
                              <tbody className="divide-y">
                                {pedido.items.map(item => (
                                  <tr key={item.id} className="hover:bg-gray-50">
                                    <td className="text-center pl-3 pr-1 py-2">
                                      <input
                                        type="checkbox"
                                        checked={!!item.entregado}
                                        disabled={submitting}
                                        title="Entregado"
                                        onChange={(e) => handleToggleItemEntregado(pedido.id, item.id, e.target.checked)}
                                      />
                                    </td>
                                    <td className="px-3 py-2 font-medium text-gray-800">{item.nombre}</td>
                                    <td className="text-center px-3 py-2 text-gray-500">×{item.cantidad}</td>
                                    <td className="text-right px-4 py-2 font-semibold">
                                      ${Number(item.subtotal).toFixed(2)}
                                    </td>
                                    <td className="text-center pr-2">
                                      <button
                                        onClick={() => handleEliminarItem(pedido.id, item.id)}
                                        disabled={submitting}
                                        title="Quitar producto"
                                        className="text-gray-300 hover:text-rose-600 transition disabled:opacity-30 disabled:cursor-not-allowed">
                                        ✕
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        <div className="px-4 py-2 bg-gray-50 flex justify-between text-sm border-t">
                          <span className="text-gray-500">Subtotal pedido</span>
                          <span className="font-bold text-gray-700">${Number(pedido.subtotal).toFixed(2)}</span>
                        </div>

                        <div className="p-3 border-t">
                          <BuscadorProducto
                            productos={productos}
                            disabled={submitting}
                            onAdd={(producto_id, cantidad) => handleAddProducto(pedido.id, producto_id, cantidad)}
                          />
                        </div>

                        <div className="px-3 pb-3 flex gap-2">
                          <button
                            onClick={() => handleCerrarPedido(pedido, idx + 1)}
                            disabled={submitting || pedido.items.length === 0}
                            className="flex-1 bg-rose-50 text-rose-600 border border-rose-200 py-2 rounded-lg
                              text-xs font-bold hover:bg-rose-100 transition
                              disabled:opacity-40 disabled:cursor-not-allowed">
                            💳 Cerrar esta silla
                          </button>
                          <button
                            onClick={() => handleEliminarPedido(pedido, idx + 1)}
                            disabled={submitting}
                            title="Eliminar silla"
                            className="px-3 py-2 rounded-lg text-xs font-bold text-gray-500 border border-gray-200
                              hover:bg-gray-100 hover:text-rose-600 transition disabled:opacity-40 disabled:cursor-not-allowed">
                            🗑
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <button onClick={handleNuevoPedido} disabled={submitting}
                    className="w-full mb-3 border-2 border-dashed border-indigo-300 text-indigo-600
                      py-2.5 rounded-xl font-semibold text-sm hover:bg-indigo-50 transition disabled:opacity-50">
                    + Agregar otra silla a esta mesa
                  </button>

                  <button onClick={handleImprimirComanda} disabled={comandaBusy || !hayItems}
                    className="w-full mb-4 border-2 border-amber-300 text-amber-700 bg-amber-50
                      py-2.5 rounded-xl font-semibold text-sm hover:bg-amber-100 transition
                      disabled:opacity-40 disabled:cursor-not-allowed">
                    {comandaBusy ? '⏳ Generando…' : '🧾 Imprimir comanda (cocina/barra)'}
                  </button>

                  {/* Total */}
                  <div className="flex justify-between items-center bg-gray-50 border rounded-xl px-4 py-3 mb-4">
                    <span className="text-sm font-semibold text-gray-600">Total Acumulado</span>
                    <span className="text-2xl font-black text-rose-600">
                      ${Number(cuentaData.total_acumulado).toFixed(2)}
                    </span>
                  </div>

                  {/* Close account */}
                  <button onClick={handleCerrarCuenta}
                    disabled={submitting || !hayItems}
                    className="w-full bg-rose-600 text-white py-3.5 rounded-xl font-bold text-lg
                      hover:bg-rose-700 active:scale-[.99] transition-all
                      disabled:opacity-40 disabled:cursor-not-allowed">
                    {submitting ? '⏳ Procesando…' : '💳 Cerrar Cuenta'}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {showCierreCuenta && (
        <CierreCuentaModal
          submitting={submitting}
          onCancel={() => setShowCierreCuenta(false)}
          onConfirm={handleConfirmarCierreCuenta}
        />
      )}

      {ticketPrompt && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
          onClick={(e) => e.target === e.currentTarget && cerrarTicketPrompt()}
        >
          <div className="animate-fade-in bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4 text-center">
            <div className="text-5xl mb-3">🧾</div>
            <p className="font-bold text-gray-800 mb-1">{ticketPrompt.titulo}</p>

            {facturaInfo && (
              facturaInfo.estado === 'aprobada' ? (
                <p className="text-xs text-emerald-600 font-semibold mb-3">
                  ✅ Factura emitida · CAE {facturaInfo.cae}
                </p>
              ) : (
                <div className="text-xs text-amber-600 font-semibold mb-3">
                  <p>
                    ⚠ La factura quedó {facturaInfo.estado === 'rechazada' ? 'rechazada' : 'pendiente'}
                    {' '}(ARCA no respondió o rechazó el comprobante). El ticket de abajo es el respaldo no fiscal.
                  </p>
                  <button onClick={handleReintentarFactura} disabled={submitting}
                    className="mt-1 underline hover:no-underline disabled:opacity-50">
                    Reintentar factura
                  </button>
                </div>
              )
            )}

            <p className="text-sm text-gray-500 mb-6">
              {ticketPrompt.cierre
                ? 'La mesa va a seguir ocupada hasta que imprimas o descargues el ticket.'
                : '¿Querés imprimir o descargar el ticket?'}
            </p>
            <div className="flex flex-col gap-2">
              <button onClick={handleImprimirTicket} disabled={ticketBusy}
                className="bg-indigo-600 text-white py-2.5 rounded-xl font-semibold
                  hover:bg-indigo-700 transition disabled:opacity-50">
                🖨 Imprimir ticket
              </button>
              <button onClick={handleDescargarTicket} disabled={ticketBusy}
                className="bg-gray-100 text-gray-700 py-2.5 rounded-xl font-semibold
                  hover:bg-gray-200 transition disabled:opacity-50">
                ⬇ Descargar PDF
              </button>
              {facturaInfo?.estado === 'aprobada' && (
                <button onClick={handleDescargarTicketInterno} disabled={ticketBusy}
                  className="bg-gray-100 text-gray-700 py-2.5 rounded-xl font-semibold
                    hover:bg-gray-200 transition disabled:opacity-50">
                  🧾 Descargar ticket no fiscal
                </button>
              )}
              <button onClick={cerrarTicketPrompt}
                className="text-gray-400 text-sm py-1 hover:text-gray-600 transition">
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
