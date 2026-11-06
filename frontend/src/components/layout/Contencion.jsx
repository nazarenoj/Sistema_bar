import { Component } from 'react'

// Si una pantalla falla al dibujarse, muestra un aviso en lugar de dejar la página en blanco.
export default class Contencion extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-stone-700">
        <p className="font-semibold text-rose-600 mb-1">Esta pantalla tuvo un problema y no se pudo mostrar.</p>
        <p className="mb-3">Probá volver a entrar o elegir otra opción del menú. Si se repite, avisá con este detalle:</p>
        <pre className="text-xs bg-white border border-rose-100 rounded-lg p-2 overflow-auto">{String(this.state.error?.message ?? this.state.error)}</pre>
      </div>
    )
  }
}
