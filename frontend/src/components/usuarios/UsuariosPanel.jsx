import { useState } from 'react'
import UsuarioTabla from './UsuarioTabla'
import TerminalTabla from './TerminalTabla'
import SesionTabla from './SesionTabla'
import RolTabla from './RolTabla'
import AuditoriaTabla from './AuditoriaTabla'
import FuncionTabla from './FuncionTabla'
import IntegracionTabla from './IntegracionTabla'
import { can } from '../../api'

const TABS = [
  { id: 'usuarios', label: 'Usuarios' },
  { id: 'terminales', label: 'Terminales' },
  { id: 'sesiones', label: 'Sesiones abiertas' },
  { id: 'roles', label: 'Roles y permisos', permiso: 'usuarios.roles.gestionar' },
  { id: 'funciones', label: 'Funciones', soloAdmin: true },
  { id: 'integracion', label: 'Integración', permiso: 'integracion.pendientes.ver' },
  { id: 'auditoria', label: 'Auditoría', permiso: 'auditoria.ver' },
]

export default function UsuariosPanel({ addToast, confirm, usuario }) {
  const [tab, setTab] = useState('usuarios')

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-4">Usuarios y accesos</h1>
      <div className="flex gap-1 border-b mb-6">
        {TABS.filter(t => (!t.permiso || can(usuario, t.permiso)) && (!t.soloAdmin || usuario.roles?.includes('administrador'))).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-semibold -mb-px border-b-2 transition
              ${tab === t.id ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'usuarios' && <UsuarioTabla addToast={addToast} confirm={confirm} usuario={usuario} />}
      {tab === 'terminales' && <TerminalTabla addToast={addToast} />}
      {tab === 'roles' && <RolTabla addToast={addToast} confirm={confirm} />}
      {tab === 'funciones' && <FuncionTabla addToast={addToast} confirm={confirm} />}
      {tab === 'integracion' && <IntegracionTabla addToast={addToast} usuario={usuario} />}
      {tab === 'auditoria' && <AuditoriaTabla addToast={addToast} />}
      {tab === 'sesiones' && <SesionTabla addToast={addToast} confirm={confirm} />}
    </div>
  )
}
