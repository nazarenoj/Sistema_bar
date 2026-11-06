import * as api from '../../api'
import Modulo from '../layout/Modulo'
import SegundoFactor from './SegundoFactor'

export const Copias = (p) => (
  <Modulo {...p} tabs={[
    {
      id: 'copias', titulo: 'Copias de seguridad', ruta: '/copias', permiso: 'usuarios.copias.gestionar',
      ayuda: 'Las copias se cifran con la clave que configures. Sin esa clave no se pueden restaurar.',
      crear: { titulo: 'Generar copia ahora', ruta: '/copias', mensaje: 'Copia generada.', campos: [{ k: 'clave', etiqueta: 'Clave de cifrado', tipo: 'password' }] },
      ver: { titulo: 'Copia', ruta: (f) => `/copias/${f.id}/detalle` },
      acciones: [
        { titulo: 'Verificar', ruta: (f) => `/copias/${f.id}/verificar`, mensaje: 'Copia verificada.', campos: [{ k: 'clave', etiqueta: 'Clave de cifrado', tipo: 'password' }] },
        {
          titulo: 'Restaurar', estilo: 'rojo', ruta: (f) => `/copias/${f.id}/restaurar`, mensaje: 'Restauración hecha.', confirmar: 'Restaurar reemplaza los datos actuales. ¿Seguro?',
          campos: [{ k: 'clave', etiqueta: 'Clave de cifrado', tipo: 'password' }],
        },
      ],
    },
    { id: 'destino', titulo: 'Destino externo', ruta: '/copias/destino', permiso: 'usuarios.copias.gestionar' },
  ]} />
)

export const Correo = (p) => (
  <Modulo {...p} tabs={[
    { id: 'estado', titulo: 'Configuración', ruta: '/correo', permiso: 'usuarios.correo.gestionar', ayuda: 'Estado de la cuenta de correo que envía los avisos del sistema.' },
    {
      id: 'cola', titulo: 'Cola de envíos', ruta: '/correo/cola', permiso: 'usuarios.correo.gestionar',
      crear: { titulo: 'Enviar prueba', ruta: '/correo/probar', mensaje: 'Prueba enviada.', campos: [{ k: 'destino', etiqueta: 'Enviar a', tipo: 'email', requerido: true }] },
      acciones: [{ titulo: 'Reintentar', ruta: (f) => `/correo/cola/${f.id}/reintentar`, mostrar: (f) => f.estado !== 'enviado', mensaje: 'Reintento pedido.' }],
    },
  ]} />
)

export const Padron = (p) => (
  <Modulo {...p} tabs={[
    {
      id: 'padron', titulo: 'Consulta de CUIT', ruta: (f) => `/padron/${String(f.cuit).replace(/\D/g, '')}`,
      filtros: [{ k: 'cuit', etiqueta: 'CUIT / CUIL', requerido: true }],
      ayuda: 'Consulta el padrón de ARCA: razón social, condición frente al IVA y domicilio.',
    },
  ]} />
)

export const Consolidacion = (p) => (
  <Modulo {...p} tabs={[
    { id: 'sucursales', titulo: 'Sucursales', ruta: '/consolidacion/sucursales', permiso: 'usuarios.consolidacion.ver',
      acciones: [{ titulo: 'Activar / desactivar', ruta: (f) => `/consolidacion/sucursales/${f.codigo}/activa`, metodo: 'PUT', body: (f) => ({ activa: !f.activa }), permiso: 'usuarios.consolidacion.gestionar', mensaje: 'Sucursal actualizada.' }] },
    { id: 'paquetes', titulo: 'Paquetes recibidos', ruta: '/consolidacion/paquetes', permiso: 'usuarios.consolidacion.ver' },
    { id: 'control', titulo: 'Control', ruta: '/consolidacion/control', permiso: 'usuarios.consolidacion.ver' },
    { id: 'ventas', titulo: 'Ventas consolidadas', ruta: '/consolidacion/informes/ventas', permiso: 'usuarios.consolidacion.ver', filtros: [{ k: 'desde', etiqueta: 'Desde', tipo: 'date' }, { k: 'hasta', etiqueta: 'Hasta', tipo: 'date' }] },
    { id: 'stock', titulo: 'Stock consolidado', ruta: '/consolidacion/informes/stock', permiso: 'usuarios.consolidacion.ver' },
  ]} />
)

export const Seguridad = (p) => (
  <div className="space-y-8">
    <SegundoFactor addToast={p.addToast} />
    {api.can(p.usuario, 'usuarios.roles.gestionar') && (
      <div>
        <h2 className="font-semibold text-stone-700 mb-2">Roles que exigen la verificación</h2>
        <Modulo {...p} tabs={[{
          id: 'roles', titulo: 'Roles', ruta: '/2fa/roles',
          crear: { titulo: 'Cambiar los roles', ruta: '/2fa/roles', metodo: 'PUT', mensaje: 'Roles actualizados.', campos: [{ k: 'roles', etiqueta: 'Códigos de rol, separados por coma', ayuda: 'Ej.: administrador, gerente' }], armar: (v) => ({ roles: String(v.roles ?? '').split(',').map(x => x.trim()).filter(Boolean) }) },
        }]} />
      </div>
    )}
  </div>
)
