import DataTable from './DataTable'

// Tabla que arma sus columnas con las claves de la primera fila: para listados simples sin formato especial.
// `titulos` renombra columnas ({ clave: 'Título' }); `ocultar` saca claves; `formato` da el render de una clave.
const legible = (k) => k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())

export default function TablaAuto({ filas, titulos = {}, ocultar = [], formato = {}, vacio, acciones }) {
  const claves = Object.keys(filas[0] ?? {}).filter(k => !ocultar.includes(k) && typeof filas[0][k] !== 'object')
  const columnas = claves.map(k => ({
    key: k,
    titulo: titulos[k] ?? legible(k),
    render: formato[k] ?? (f => (typeof f[k] === 'boolean' ? (f[k] ? 'Sí' : 'No') : (f[k] ?? '—'))),
    align: typeof filas[0][k] === 'number' ? 'right' : undefined,
  }))
  return <DataTable filas={filas.map((f, i) => ({ id: f.id ?? i, ...f }))} columnas={columnas} vacio={vacio} acciones={acciones} />
}
