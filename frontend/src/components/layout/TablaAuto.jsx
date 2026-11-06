import DataTable from './DataTable'

// Tabla que arma sus columnas con las claves de la primera fila: para listados simples sin formato especial.
// `titulos` renombra columnas ({ clave: 'Título' }); `ocultar` saca claves; `formato` da el render de una clave.
const CONOCIDOS = {
  id: 'N°', nombre: 'Nombre', estado: 'Estado', fecha: 'Fecha', fecha_hora: 'Fecha y hora', importe: 'Importe', total: 'Total', cantidad: 'Cantidad', saldo: 'Saldo',
  deposito: 'Depósito', usuario: 'Usuario', motivo: 'Motivo', producto: 'Producto', cliente: 'Cliente', activo: 'Activo', activa: 'Activa', numero: 'Número', tipo: 'Tipo',
  codigo: 'Código', descripcion: 'Descripción', observacion: 'Observación', observaciones: 'Observaciones', telefono: 'Teléfono', unidad: 'Unidad', lote: 'Lote',
  fecha_vencimiento: 'Vence', fecha_elaboracion: 'Elaborado', created_at: 'Creado', moneda: 'Moneda', precio: 'Precio', costo_unitario: 'Costo unitario', razon_social: 'Nombre',
}
const legible = (k) => CONOCIDOS[k] ?? k.replace(/_id$/, '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
// Claves internas: el ID global nunca se muestra, y un "algo_id" se oculta si ya viene el "algo" con su nombre.
const interna = (k, todas) => k === 'id_global' || k.endsWith('_id_global') || (k.endsWith('_id') && todas.includes(k.slice(0, -3)))

export default function TablaAuto({ filas, titulos = {}, ocultar = [], formato = {}, vacio, acciones }) {
  const todas = Object.keys(filas[0] ?? {})
  const claves = todas.filter(k => !ocultar.includes(k) && !interna(k, todas) && typeof filas[0][k] !== 'object')
  const columnas = claves.map(k => ({
    key: k,
    titulo: titulos[k] ?? legible(k),
    render: formato[k] ?? (f => (typeof f[k] === 'boolean' ? (f[k] ? 'Sí' : 'No') : (f[k] ?? '—'))),
    align: typeof filas[0][k] === 'number' ? 'right' : undefined,
  }))
  return <DataTable filas={filas.map((f, i) => ({ id: f.id ?? i, ...f }))} columnas={columnas} vacio={vacio} acciones={acciones} />
}
