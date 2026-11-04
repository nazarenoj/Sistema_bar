import { can } from '../../api'
import { PERMISO_VISTA } from '../../utils/vistas'

const Ico = ({ d }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-4 h-4 shrink-0">{d}</svg>
)
const ICONOS = {
  mesas: <Ico d={<><rect x="3" y="8" width="18" height="3" rx="1" /><path d="M5 11v6M19 11v6M8 17h8" /></>} />,
  historial: <Ico d={<><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5M12 7v5l3.5 3.5" /></>} />,
  productos: <Ico d={<><path d="M20 7H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Z" /><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" /></>} />,
  insumos: <Ico d={<><path d="M4 4h5l1 4h9l-2 8H8L5 6" /><circle cx="9" cy="19" r="1.5" /><circle cx="17" cy="19" r="1.5" /></>} />,
  usuarios: <Ico d={<><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 11.5a3 3 0 1 0 0-6M18 14.4c1.7.7 3 2.4 3 4.6" /></>} />,
  notificaciones: <Ico d={<><path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" /><path d="M10 19a2 2 0 0 0 4 0" /></>} />,
}

const PUNTO = <Ico d={<circle cx="12" cy="12" r="3" />} />

// Una sola lista define el menú, el título de cada pantalla y sus migas de pan.
const GRUPOS = [
  { grupo: 'Operaciones', items: [{ id: 'mesas', titulo: 'Panel de Mesas' }, { id: 'historial', titulo: 'Historial de Pedidos' }, { id: 'ventas', titulo: 'Registro de ventas' }, { id: 'facturacion', titulo: 'Facturación' }] },
  { grupo: 'Catálogo e inventario', items: [{ id: 'productos', titulo: 'Productos' }, { id: 'insumos', titulo: 'Insumos' }, { id: 'stock', titulo: 'Stock' }] },
  { grupo: 'Clientes', items: [{ id: 'clientes', titulo: 'Clientes y cuentas' }] },
  { grupo: 'Administración', items: [{ id: 'usuarios', titulo: 'Usuarios y accesos' }, { id: 'notificaciones', titulo: 'Notificaciones' }] },
]

export const TITULOS = Object.fromEntries(
  GRUPOS.flatMap(g => g.items.map(i => [i.id, { titulo: i.titulo, grupo: g.grupo, icono: ICONOS[i.id] ?? PUNTO }]))
)

export default function Menu({ vista, setVista, usuario, enLinea, nuevasNotif }) {
  const nombre = usuario?.nombre || usuario?.username
  return (
    <aside className="w-60 shrink-0 bg-cafe-800 text-stone-300 flex flex-col">
      <div className="h-[50px] text-arena-300 font-semibold tracking-[0.25em] grid place-items-center border-b border-white/10">CHEPOLA</div>

      <div className="flex items-center gap-3 px-4 py-4">
        <span className="w-10 h-10 rounded-full bg-arena-300 text-cafe-800 grid place-items-center font-bold uppercase">{nombre?.[0]}</span>
        <div className="min-w-0">
          <p className="text-white text-sm font-semibold truncate">{nombre}</p>
          <p className="text-xs flex items-center gap-1">
            <span className={`w-2 h-2 rounded-full ${enLinea ? 'bg-green-500' : 'bg-red-500'}`} />
            {enLinea ? 'En línea' : 'Sin conexión'}
          </p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto pb-4">
        {GRUPOS.map(g => {
          const items = g.items.filter(i => PERMISO_VISTA[i.id] === undefined || can(usuario, PERMISO_VISTA[i.id]))
          if (items.length === 0) return null
          return (
            <div key={g.grupo}>
              <p className="px-5 pt-4 pb-1 text-[11px] uppercase tracking-wider text-stone-400">{g.grupo}</p>
              {items.map(i => (
                <button
                  key={i.id}
                  onClick={() => setVista(i.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 mx-2 my-0.5 text-sm text-left rounded-lg transition
                    ${vista === i.id ? 'bg-arena-300 text-cafe-800 font-semibold' : 'hover:bg-white/10 hover:text-white'}`}
                >
                  {ICONOS[i.id] ?? PUNTO}
                  <span className="flex-1">{i.titulo}</span>
                  {i.id === 'notificaciones' && nuevasNotif > 0 && (
                    <span className="bg-rose-400 text-white text-[11px] font-bold rounded px-1.5">{nuevasNotif}</span>
                  )}
                </button>
              ))}
            </div>
          )
        })}
      </nav>
    </aside>
  )
}
