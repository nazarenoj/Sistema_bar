import { useState, useEffect } from 'react'
import * as api from '../../api'
import Spinner from '../Spinner'

const METODOS_PAGO = [
  { value: 'efectivo', label: '💵 Efectivo' },
  { value: 'tarjeta_debito', label: '💳 Débito' },
  { value: 'tarjeta_credito', label: '💳 Crédito' },
  { value: 'transferencia', label: '🏦 Transferencia' },
  { value: 'otro', label: '➕ Otro' },
]

const CONDICIONES_IVA_RECEPTOR = [
  { id: 5, label: 'Consumidor Final' },
  { id: 1, label: 'Responsable Inscripto' },
  { id: 6, label: 'Monotributista' },
  { id: 4, label: 'Exento' },
  { id: 7, label: 'No Categorizado' },
]

// Paso explícito al cerrar cuenta: método de pago + (opcionalmente) tipo de comprobante ARCA y
// datos del receptor. "Emitir factura" es una opción, no algo obligatorio: si ARCA está caído o
// la cuenta no requiere comprobante fiscal, se puede cerrar sin facturar. Ver ModalPedido.jsx.
export default function CierreCuentaModal({ onConfirm, onCancel, submitting }) {
  const [config, setConfig] = useState(null)
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [error, setError] = useState(null)

  const [metodoPago, setMetodoPago] = useState('efectivo')
  const [facturar, setFacturar] = useState(true)
  const [tipoComprobante, setTipoComprobante] = useState(null)
  const [consumidorFinal, setConsumidorFinal] = useState(true)
  const [docTipo, setDocTipo] = useState(99)
  const [docNro, setDocNro] = useState('')
  const [condicionIvaReceptorId, setCondicionIvaReceptorId] = useState(5)
  const [receptorNombre, setReceptorNombre] = useState('')
  const [domicilioReceptor, setDomicilioReceptor] = useState('')

  useEffect(() => {
    api.getFacturaConfig()
      .then((data) => {
        setConfig(data)
        setTipoComprobante(data.tipos_comprobante[0]?.tipo_comprobante ?? null)
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoadingConfig(false))
  }, [])

  // Factura A exige receptor con CUIT: si se elige ese tipo, se fuerza a cargarlo.
  useEffect(() => {
    if (tipoComprobante === 1) {
      setConsumidorFinal(false)
      setDocTipo(80)
      setCondicionIvaReceptorId((prev) => (prev === 5 ? 1 : prev))
    }
  }, [tipoComprobante])

  const handleConsumidorFinalToggle = (checked) => {
    setConsumidorFinal(checked)
    if (checked) {
      setDocTipo(99)
      setDocNro('')
      setCondicionIvaReceptorId(5)
      setReceptorNombre('')
      setDomicilioReceptor('')
    } else {
      setDocTipo(96)
    }
  }

  const configNoDisponible = !loadingConfig && !config
  const puedeFacturar = facturar && !configNoDisponible

  const handleSubmit = () => {
    if (puedeFacturar && !consumidorFinal && !(docNro.trim() && Number(docNro.trim()) > 0)) {
      setError(`Ingresá un ${docTipo === 80 ? 'CUIT' : 'DNI'} válido (mayor a 0).`)
      return
    }
    setError(null)
    onConfirm({
      metodo_pago: metodoPago,
      tipo_comprobante: puedeFacturar ? tipoComprobante : null,
      doc_tipo: puedeFacturar ? docTipo : null,
      doc_nro: puedeFacturar ? (consumidorFinal ? '0' : docNro.trim()) : null,
      condicion_iva_receptor_id: puedeFacturar ? condicionIvaReceptorId : null,
      receptor_nombre: puedeFacturar ? (receptorNombre.trim() || null) : null,
      domicilio_receptor: puedeFacturar ? (domicilioReceptor.trim() || null) : null,
    })
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="animate-fade-in bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 max-h-[90vh] overflow-y-auto">
        <div className="bg-rose-600 px-6 py-4 text-white">
          <h2 className="font-bold text-lg">Cerrar cuenta</h2>
          <p className="text-xs opacity-90">Elegí cómo se pagó y si corresponde emitir comprobante.</p>
        </div>

        <div className="p-6">
          <p className="text-xs font-bold uppercase tracking-wider text-stone-400 mb-2">Método de pago</p>
          <div className="grid grid-cols-2 gap-2 mb-5">
            {METODOS_PAGO.map((m) => (
              <button
                key={m.value}
                onClick={() => setMetodoPago(m.value)}
                className={`py-2 rounded-lg text-sm font-semibold border transition
                  ${metodoPago === m.value ? 'bg-cafe-800 text-white border-cafe-800' : 'border-stone-200 text-stone-600 hover:bg-stone-50'}`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-sm text-stone-700 mb-4 select-none font-semibold">
            <input
              type="checkbox"
              checked={facturar}
              onChange={(e) => setFacturar(e.target.checked)}
            />
            Emitir factura electrónica (ARCA)
          </label>

          {facturar && (
            loadingConfig ? (
              <div className="flex justify-center py-6"><Spinner /></div>
            ) : !config ? (
              <p className="text-amber-600 text-xs mb-5 bg-amber-50 rounded-lg px-3 py-2">
                No se pudo cargar la configuración de facturación. Desmarcá "Emitir factura" para
                cerrar la cuenta igual, sin comprobante fiscal, o reintentá más tarde desde el historial.
              </p>
            ) : (
              <>
                <p className="text-xs font-bold uppercase tracking-wider text-stone-400 mb-2">Comprobante</p>
                <div className="flex gap-2 mb-5">
                  {config.tipos_comprobante.map((t) => (
                    <button
                      key={t.tipo_comprobante}
                      onClick={() => setTipoComprobante(t.tipo_comprobante)}
                      className={`flex-1 py-2 rounded-lg text-sm font-semibold border transition
                        ${tipoComprobante === t.tipo_comprobante ? 'bg-cafe-800 text-white border-cafe-800' : 'border-stone-200 text-stone-600 hover:bg-stone-50'}`}
                    >
                      {t.nombre}
                    </button>
                  ))}
                </div>

                <label className="flex items-center gap-2 text-sm text-stone-600 mb-3 select-none">
                  <input
                    type="checkbox"
                    checked={consumidorFinal}
                    disabled={tipoComprobante === 1}
                    onChange={(e) => handleConsumidorFinalToggle(e.target.checked)}
                  />
                  Consumidor Final (sin CUIT/DNI)
                </label>

                {!consumidorFinal && (
                  <div className="space-y-2 mb-5">
                    <div className="flex gap-2">
                      <select
                        value={docTipo}
                        disabled={tipoComprobante === 1}
                        onChange={(e) => setDocTipo(Number(e.target.value))}
                        className="border rounded-lg px-2 py-2 text-sm"
                      >
                        <option value={96}>DNI</option>
                        <option value={80}>CUIT</option>
                      </select>
                      <input
                        value={docNro}
                        onChange={(e) => setDocNro(e.target.value.replace(/\D/g, ''))}
                        placeholder={docTipo === 80 ? 'CUIT (11 dígitos)' : 'DNI'}
                        className="flex-1 border rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <select
                      value={condicionIvaReceptorId}
                      onChange={(e) => setCondicionIvaReceptorId(Number(e.target.value))}
                      className="w-full border rounded-lg px-3 py-2 text-sm"
                    >
                      {CONDICIONES_IVA_RECEPTOR.map((c) => (
                        <option key={c.id} value={c.id}>{c.label}</option>
                      ))}
                    </select>
                    <input
                      value={receptorNombre}
                      onChange={(e) => setReceptorNombre(e.target.value)}
                      placeholder="Nombre / Razón social (opcional)"
                      className="w-full border rounded-lg px-3 py-2 text-sm"
                    />
                    <input
                      value={domicilioReceptor}
                      onChange={(e) => setDomicilioReceptor(e.target.value)}
                      placeholder="Domicilio (opcional)"
                      className="w-full border rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                )}
              </>
            )
          )}

          {error && <p className="text-rose-600 text-sm mb-3">{error}</p>}

          <div className="flex flex-col gap-2">
            <button
              onClick={handleSubmit}
              disabled={submitting || (puedeFacturar && tipoComprobante === null)}
              className="bg-rose-600 text-white py-2.5 rounded-xl font-bold hover:bg-rose-700 transition disabled:opacity-50"
            >
              {submitting ? '⏳ Procesando…' : puedeFacturar ? '💳 Cerrar y facturar' : '💳 Cerrar sin facturar'}
            </button>
            <button onClick={onCancel} disabled={submitting}
              className="text-stone-400 text-sm py-1 hover:text-stone-600 transition">
              Cancelar
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
