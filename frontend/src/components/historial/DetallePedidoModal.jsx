import { useState, useEffect } from 'react'
import * as api from '../../api'
import Spinner from '../Spinner'

const formatHora = (fecha) =>
  fecha ? new Date(fecha).toLocaleString('es-AR', { hour12: false }) : '—'

const TIPO_COMPROBANTE_LABEL = { 1: 'Factura A', 6: 'Factura B', 11: 'Factura C' }

export default function DetallePedidoModal({ pedidoId, onClose, addToast }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelado = false
    setLoading(true)
    api.getPedido(pedidoId)
      .then(res => { if (!cancelado) setData(res) })
      .catch(err => { addToast(err.message, 'error'); onClose() })
      .finally(() => { if (!cancelado) setLoading(false) })
    return () => { cancelado = true }
  }, [pedidoId])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="animate-fade-in bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        <div className="bg-cafe-800 px-6 py-5 text-white flex justify-between items-center">
          <h2 className="font-bold text-lg">
            {data ? `Mesa ${data.pedido.numero_mesa ?? ''} · Pedido #${data.pedido.id}` : 'Detalle del pedido'}
          </h2>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-white/20 transition text-xl leading-none">✕</button>
        </div>

        <div className="p-6">
          {loading ? (
            <div className="flex justify-center py-10"><Spinner size="lg" /></div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 mb-4 text-xs">
                <div className="bg-stone-50 rounded-lg px-3 py-2">
                  <p className="text-stone-400 uppercase tracking-wider mb-0.5">Apertura mesa</p>
                  <p className="text-stone-700 font-medium">{formatHora(data.pedido.sesion_apertura)}</p>
                </div>
                <div className="bg-stone-50 rounded-lg px-3 py-2">
                  <p className="text-stone-400 uppercase tracking-wider mb-0.5">Apertura silla</p>
                  <p className="text-stone-700 font-medium">{formatHora(data.pedido.fecha_creacion)}</p>
                </div>
                <div className="bg-stone-50 rounded-lg px-3 py-2">
                  <p className="text-stone-400 uppercase tracking-wider mb-0.5">Cierre silla</p>
                  <p className="text-stone-700 font-medium">{formatHora(data.pedido.fecha_cierre)}</p>
                </div>
                <div className="bg-stone-50 rounded-lg px-3 py-2">
                  <p className="text-stone-400 uppercase tracking-wider mb-0.5">Cierre mesa</p>
                  <p className="text-stone-700 font-medium">{formatHora(data.pedido.hora_cierre_mesa)}</p>
                </div>
              </div>

              {data.pedido.factura_id && (
                <div className="bg-stone-50 rounded-xl px-4 py-3 mb-4 text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-stone-500">Comprobante</span>
                    <span className="font-semibold text-stone-700">
                      {TIPO_COMPROBANTE_LABEL[data.pedido.tipo_comprobante] || '—'}
                      {data.pedido.factura_numero
                        ? ` · ${String(data.pedido.factura_punto_venta).padStart(4, '0')}-${String(data.pedido.factura_numero).padStart(8, '0')}`
                        : ''}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-stone-500">Estado</span>
                    <span className="font-semibold text-stone-700 capitalize">{data.pedido.factura_estado}</span>
                  </div>
                  {data.pedido.cae && (
                    <div className="flex justify-between">
                      <span className="text-stone-500">CAE</span>
                      <span className="font-mono text-stone-700">{data.pedido.cae}</span>
                    </div>
                  )}
                  {data.pedido.metodo_pago && (
                    <div className="flex justify-between">
                      <span className="text-stone-500">Método de pago</span>
                      <span className="font-semibold text-stone-700 capitalize">
                        {data.pedido.metodo_pago.replace('_', ' ')}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {data.items.length === 0 ? (
                <p className="text-center text-stone-400 py-6">Este pedido no tiene productos.</p>
              ) : (
                <div className="border rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-stone-50 border-b text-stone-500 text-xs uppercase tracking-wider">
                        <th className="text-left px-4 py-2">Producto</th>
                        <th className="text-right px-4 py-2">Cant.</th>
                        <th className="text-right px-4 py-2">P. Unit.</th>
                        <th className="text-right px-4 py-2">Subtotal</th>
                        <th className="text-center px-4 py-2">Entregado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {data.items.map(item => (
                        <tr key={item.id}>
                          <td className="px-4 py-2.5 font-medium text-stone-800">{item.nombre}</td>
                          <td className="px-4 py-2.5 text-right text-stone-600">{item.cantidad}</td>
                          <td className="px-4 py-2.5 text-right text-stone-600">${Number(item.precio_unitario).toFixed(2)}</td>
                          <td className="px-4 py-2.5 text-right font-semibold text-stone-800">${Number(item.subtotal).toFixed(2)}</td>
                          <td className="px-4 py-2.5 text-center">{item.entregado ? '✅' : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex justify-between items-center pt-5 mt-2 border-t">
                <span className="text-sm font-semibold text-stone-500">Total</span>
                <span className="text-xl font-bold text-stone-800">${Number(data.pedido.total).toFixed(2)}</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
