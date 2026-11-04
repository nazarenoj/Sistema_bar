import { useMemo, useState } from 'react'

// Tabla con "Mostrar N registros", buscador, orden por columna y paginado, todo en el navegador.
// columnas: [{ key, titulo, render?(fila), valor?(fila), align?, ordenable? }]
const TAMANOS = [10, 25, 50, 100]

export default function DataTable({ columnas, filas, vacio = 'No hay registros.', acciones }) {
  const [tamano, setTamano] = useState(10)
  const [pagina, setPagina] = useState(1)
  const [q, setQ] = useState('')
  const [orden, setOrden] = useState(null) // { key, dir }

  const valorDe = (c, f) => (c.valor ? c.valor(f) : f[c.key])

  const filtradas = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return filas
    return filas.filter(f => columnas.some(c => String(valorDe(c, f) ?? '').toLowerCase().includes(t)))
  }, [filas, q, columnas])

  const ordenadas = useMemo(() => {
    if (!orden) return filtradas
    const c = columnas.find(x => x.key === orden.key)
    const cmp = (a, b) => {
      const x = valorDe(c, a), y = valorDe(c, b)
      const nx = Number(x), ny = Number(y)
      if (x !== '' && y !== '' && !Number.isNaN(nx) && !Number.isNaN(ny)) return nx - ny
      return String(x ?? '').localeCompare(String(y ?? ''), 'es')
    }
    return [...filtradas].sort((a, b) => (orden.dir === 'asc' ? cmp(a, b) : cmp(b, a)))
  }, [filtradas, orden, columnas])

  const paginas = Math.max(1, Math.ceil(ordenadas.length / tamano))
  const actual = Math.min(pagina, paginas)
  const desde = (actual - 1) * tamano
  const visibles = ordenadas.slice(desde, desde + tamano)

  const ordenarPor = (c) => {
    if (c.ordenable === false) return
    setOrden(o => (o?.key === c.key ? (o.dir === 'asc' ? { key: c.key, dir: 'desc' } : null) : { key: c.key, dir: 'asc' }))
  }
  const alinear = (a) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left')

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3 text-sm text-stone-600">
        <label className="flex items-center gap-2">
          Mostrar
          <select value={tamano} onChange={e => { setTamano(Number(e.target.value)); setPagina(1) }} className="campo !w-auto">
            {TAMANOS.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          registros
        </label>
        <label className="flex items-center gap-2">
          Buscar:
          <input value={q} onChange={e => { setQ(e.target.value); setPagina(1) }} className="campo !w-48" />
        </label>
      </div>

      <div className="overflow-x-auto border border-stone-200 rounded-xl">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-200 bg-stone-50">
              {columnas.map(c => (
                <th
                  key={c.key}
                  onClick={() => ordenarPor(c)}
                  className={`px-3 py-2 font-semibold text-stone-800 select-none ${alinear(c.align)} ${c.ordenable === false ? '' : 'cursor-pointer'}`}
                >
                  {c.titulo}
                  {c.ordenable !== false && (
                    <span className="ml-1 text-stone-300">{orden?.key === c.key ? (orden.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
                  )}
                </th>
              ))}
              {acciones && <th className="px-3 py-2 font-semibold text-stone-800 text-center">Acciones</th>}
            </tr>
          </thead>
          <tbody>
            {visibles.length === 0 ? (
              <tr><td colSpan={columnas.length + (acciones ? 1 : 0)} className="px-3 py-8 text-center text-stone-400">{vacio}</td></tr>
            ) : visibles.map((f, i) => (
              <tr key={f.id ?? i} className="border-b border-stone-200 hover:bg-marca-50/60">
                {columnas.map(c => (
                  <td key={c.key} className={`px-3 py-2 text-stone-700 ${alinear(c.align)}`}>{c.render ? c.render(f) : (f[c.key] ?? '—')}</td>
                ))}
                {acciones && <td className="px-3 py-2 text-center whitespace-nowrap">{acciones(f)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mt-3 text-sm text-stone-600">
        <span>
          {ordenadas.length === 0 ? 'Sin registros' : `Mostrando ${desde + 1} a ${Math.min(desde + tamano, ordenadas.length)} de ${ordenadas.length} registros`}
          {q && filas.length !== ordenadas.length && ` (filtrado de ${filas.length})`}
        </span>
        <div className="flex">
          <button disabled={actual === 1} onClick={() => setPagina(actual - 1)} className="paginador rounded-l-lg">Anterior</button>
          <span className="paginador bg-marca-600 text-white border-marca-600">{actual}</span>
          <button disabled={actual === paginas} onClick={() => setPagina(actual + 1)} className="paginador rounded-r-lg">Siguiente</button>
        </div>
      </div>
    </div>
  )
}
