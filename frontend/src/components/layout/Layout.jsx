import { useState } from 'react'
import Menu, { TITULOS } from './Menu'
import Contencion from './Contencion'

// Armazón de todas las pantallas: barra lateral cálida, barra superior clara, título con migas de pan y contenido en tarjeta.
export default function Layout({ vista, setVista, usuario, enLinea, nuevasNotif, onLogout, onCambiarUsuario, onCambiarPassword, children }) {
  const [abierto, setAbierto] = useState(true)       // barra lateral visible
  const [usuarioMenu, setUsuarioMenu] = useState(false)
  const info = TITULOS[vista] ?? { titulo: '', grupo: '' }
  const nombre = usuario?.nombre || usuario?.username

  return (
    <div className="flex flex-1 min-h-0 bg-crema text-stone-800">
      {abierto && (
        <Menu vista={vista} setVista={setVista} usuario={usuario} enLinea={enLinea} nuevasNotif={nuevasNotif} />
      )}

      <div className="flex flex-col flex-1 min-w-0">
        <header className="h-[50px] shrink-0 bg-white/80 border-b border-stone-200 text-stone-600 flex items-center justify-between px-3 relative z-20">
          <button onClick={() => setAbierto(v => !v)} className="p-2 hover:bg-stone-100 rounded-lg" aria-label="Mostrar u ocultar el menú">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2}><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <div className="relative">
            <button onClick={() => setUsuarioMenu(v => !v)} className="flex items-center gap-2 px-2 py-1 hover:bg-stone-100 rounded-lg text-sm">
              <span className="w-7 h-7 rounded-full bg-arena-300 text-cafe-800 grid place-items-center font-bold uppercase">{nombre?.[0]}</span>
              <span className="hidden sm:inline">{nombre}</span>
            </button>
            {usuarioMenu && (
              <div className="absolute right-0 mt-1 w-56 bg-white text-stone-700 shadow-lg border border-stone-200 rounded-xl overflow-hidden text-sm" onClick={() => setUsuarioMenu(false)}>
                <div className="px-4 py-3 bg-marca-50 text-stone-800">
                  <p className="font-semibold truncate">{nombre}</p>
                  <p className="text-xs capitalize text-stone-500">{usuario?.roles?.[0] ?? usuario?.rol}{usuario?.terminal ? ` · ${usuario.terminal.nombre}` : ''}</p>
                </div>
                <button onClick={onCambiarUsuario} className="block w-full text-left px-4 py-2 hover:bg-stone-100">Cambiar de usuario</button>
                <button onClick={onCambiarPassword} className="block w-full text-left px-4 py-2 hover:bg-stone-100">Cambiar contraseña</button>
                <button onClick={onLogout} className="block w-full text-left px-4 py-2 hover:bg-stone-100 border-t">Cerrar sesión</button>
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4 pb-2">
            <h1 className="text-2xl font-semibold text-stone-700 flex items-center gap-2">
              <span className="text-stone-500">{info.icono}</span>{info.titulo}
            </h1>
            <nav className="text-xs text-stone-500 bg-white/70 border border-stone-200 px-3 py-1 rounded-full">
              <button onClick={() => setVista('inicio')} className="hover:underline">Inicio</button>
              {info.grupo && <> <span className="mx-1">›</span> {info.grupo}</>}
              <span className="mx-1">›</span> <span className="text-stone-400">{info.titulo}</span>
            </nav>
          </div>
          <div className="px-5 pb-6">
            <div className="bg-white border border-stone-200 rounded-2xl shadow-sm p-5"><Contencion key={vista}>{children}</Contencion></div>
          </div>
          <footer className="px-5 py-3 text-xs text-stone-500 border-t border-stone-200 flex justify-between">
            <span>Sistema Chepola</span>
            <span>Versión {__APP_VERSION__}</span>
          </footer>
        </main>
      </div>
    </div>
  )
}
