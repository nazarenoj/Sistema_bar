import Modulo from '../layout/Modulo'

// Contable (Fase J): configuración, plan de cuentas, asientos, pendientes, períodos, reglas, libros, controles y cierre.
const B = '/contable'
const mes = new Date().toISOString().slice(0, 7)
const rango = [
  { k: 'desde', etiqueta: 'Desde', tipo: 'date' },
  { k: 'hasta', etiqueta: 'Hasta', tipo: 'date' },
]

// "cuenta;debe;haber" por renglón → líneas del asiento (la cuenta se indica por su n.º interno).
const lineasDe = (texto) => String(texto ?? '').split('\n').map(r => r.trim()).filter(Boolean).map(r => {
  const [cuenta_id, debe, haber] = r.split(/[;,\s]+/)
  return { cuenta_id: Number(cuenta_id), ...(Number(debe) && { debe: Number(debe) }), ...(Number(haber) && { haber: Number(haber) }) }
})
const campoLineas = { k: 'lineas', etiqueta: 'Líneas', tipo: 'textarea', requerido: true, ayuda: 'Una por renglón: n.º de cuenta; debe; haber (ej. 12;500;0)', ancho: 'completo' }
const cuentasFuente = { ruta: `${B}/cuentas`, valor: 'id', texto: (c) => `${c.codigo} ${c.nombre}` }

export const Contable = (p) => (
  <Modulo {...p} tabs={[
    { id: 'asientos', titulo: 'Asientos', ruta: `${B}/asientos`, permiso: 'contable.ver', filtros: rango,
      ver: { titulo: 'Asiento', ruta: (f) => `${B}/asientos/${f.id}` },
      crear: { titulo: 'Asiento manual', ruta: `${B}/asientos-manuales`, permiso: 'contable.asientos.crear', campos: [
        { k: 'fecha', etiqueta: 'Fecha', tipo: 'date', requerido: true },
        { k: 'leyenda', etiqueta: 'Leyenda', requerido: true },
        campoLineas,
      ], armar: (v) => ({ fecha: v.fecha, leyenda: v.leyenda, lineas: lineasDe(v.lineas) }) },
      acciones: [
        { titulo: 'Anular', estilo: 'rojo', permiso: 'contable.asientos.anular', ruta: (f) => `${B}/asientos/${f.id}/anular`, mostrar: (f) => f.estado !== 'anulado',
          campos: [{ k: 'motivo', etiqueta: 'Motivo', requerido: true, ancho: 'completo' }], mensaje: 'Asiento anulado con su contraasiento.' },
      ] },
    { id: 'pendientes', titulo: 'Pendientes de imputar', ruta: `${B}/pendientes`, permiso: 'contable.ver',
      filtros: [{ k: 'estado', etiqueta: 'Estado', tipo: 'select', opciones: [['pendiente', 'Pendiente'], ['resuelto', 'Resuelto']] }],
      acciones: [
        { titulo: 'Reintentar', permiso: 'contable.pendientes.resolver', ruta: (f) => `${B}/pendientes/${f.id}/reintentar`, mensaje: 'Se volvió a intentar.' },
        { titulo: 'Imputar', permiso: 'contable.pendientes.resolver', ruta: (f) => `${B}/pendientes/${f.id}/imputar`,
          campos: [{ k: 'cuenta_id', etiqueta: 'Cuenta', tipo: 'select', requerido: true, fuente: cuentasFuente }], mensaje: 'Imputado.' },
      ] },
    { id: 'plan', titulo: 'Plan de cuentas', ruta: `${B}/cuentas`, permiso: 'contable.ver',
      descargas: [{ titulo: 'Plan (CSV)', ruta: () => `${B}/cuentas/exportar?formato=csv`, nombre: 'plan-de-cuentas.csv' }],
      crear: { titulo: 'Cuenta', ruta: `${B}/cuentas`, permiso: 'contable.plan.editar', campos: [
        { k: 'codigo', etiqueta: 'Código', requerido: true },
        { k: 'nombre', etiqueta: 'Nombre', requerido: true },
        { k: 'tipo', etiqueta: 'Tipo', tipo: 'select', requerido: true, opciones: [['activo', 'Activo'], ['pasivo', 'Pasivo'], ['patrimonio', 'Patrimonio'], ['ingreso', 'Ingreso'], ['egreso', 'Egreso']] },
        { k: 'padre_id', etiqueta: 'Cuenta madre', tipo: 'select', fuente: cuentasFuente },
        { k: 'moneda', etiqueta: 'Moneda (si no es pesos)' },
      ] },
      acciones: [
        { titulo: 'Desactivar', permiso: 'contable.plan.editar', ruta: (f) => `${B}/cuentas/${f.id}/estado`, body: () => ({ activa: false }), mostrar: (f) => f.estado !== 'inactiva' && f.activa !== false, confirmar: '¿Desactivar la cuenta?' },
        { titulo: 'Activar', permiso: 'contable.plan.editar', ruta: (f) => `${B}/cuentas/${f.id}/estado`, body: () => ({ activa: true }), mostrar: (f) => f.estado === 'inactiva' || f.activa === false },
      ] },
    { id: 'periodos', titulo: 'Ejercicios y períodos', ruta: `${B}/periodos`, permiso: 'contable.ver',
      ver: { titulo: 'Historial del período', ruta: (f) => `${B}/periodos/${f.id}/historial` },
      crear: { titulo: 'Ejercicio', ruta: `${B}/ejercicios`, permiso: 'contable.reglas.editar', campos: [
        { k: 'desde', etiqueta: 'Desde', tipo: 'date' }, { k: 'hasta', etiqueta: 'Hasta', tipo: 'date' },
      ], mensaje: 'Ejercicio creado.' },
      acciones: [
        { titulo: 'Cerrar', permiso: 'contable.periodos.cerrar', ruta: (f) => `${B}/periodos/${f.id}/cerrar`, confirmar: '¿Cerrar el período? Ya no se podrá imputar.', mostrar: (f) => f.estado === 'abierto' },
        { titulo: 'Reabrir', permiso: 'contable.periodos.reabrir', ruta: (f) => `${B}/periodos/${f.id}/reabrir`, mostrar: (f) => f.estado === 'cerrado',
          campos: [{ k: 'motivo', etiqueta: 'Motivo', requerido: true, ancho: 'completo' }] },
      ] },
    { id: 'reglas', titulo: 'Reglas de imputación', ruta: `${B}/reglas`, permiso: 'contable.ver',
      filtros: [{ k: 'formulario', etiqueta: 'Formulario' }],
      acciones: [
        { titulo: 'Pausar', permiso: 'contable.reglas.editar', ruta: (f) => `${B}/reglas/${f.id}/estado`, body: () => ({ activa: false }), mostrar: (f) => f.estado !== 'inactiva' && f.activa !== false },
        { titulo: 'Activar', permiso: 'contable.reglas.editar', ruta: (f) => `${B}/reglas/${f.id}/estado`, body: () => ({ activa: true }), mostrar: (f) => f.estado === 'inactiva' || f.activa === false },
      ] },
    { id: 'modos', titulo: 'Modo de asientos', ruta: `${B}/modos`, permiso: 'contable.ver',
      ayuda: 'Cada formulario genera un asiento por documento o un resumen por día.',
      acciones: [
        { titulo: 'Cambiar modo', permiso: 'contable.reglas.editar', ruta: (f) => `${B}/modos/${f.formulario}`, metodo: 'PUT',
          campos: [{ k: 'modo', etiqueta: 'Modo', tipo: 'select', requerido: true, opciones: [['individual', 'Individual'], ['resumen', 'Resumido']] }] },
      ] },
    { id: 'libros', titulo: 'Libros', ruta: `${B}/libros/diario`, permiso: 'contable.ver', filtros: rango,
      ayuda: 'Libro diario. El mayor y el balance se bajan con los botones.',
      descargas: [
        { titulo: 'Diario (Excel)', ruta: (f) => `${B}/libros/diario${qs({ ...f, formato: 'xlsx' })}`, nombre: 'libro-diario.xlsx' },
        { titulo: 'Balance (Excel)', ruta: (f) => `${B}/libros/balance${qs({ ...f, formato: 'xlsx' })}`, nombre: 'sumas-y-saldos.xlsx' },
        { titulo: 'Balance (PDF)', ruta: (f) => `${B}/libros/balance${qs({ ...f, formato: 'pdf' })}`, nombre: 'sumas-y-saldos.pdf' },
      ] },
    { id: 'balance', titulo: 'Sumas y saldos', ruta: `${B}/libros/balance`, permiso: 'contable.ver', filtros: rango },
    { id: 'controles', titulo: 'Controles', ruta: `${B}/controles/historial`, permiso: 'contable.ver',
      ver: { titulo: 'Control', ruta: (f) => `${B}/controles/${f.id}` },
      acciones: [],
      crear: { titulo: 'Ejecutar controles', ruta: `${B}/controles/ejecutar`, permiso: 'contable.controles.ejecutar', campos: [{ k: 'periodo', etiqueta: 'Período (AAAA-MM)', defecto: mes }], mensaje: 'Controles ejecutados.' } },
    { id: 'cierre', titulo: 'Revaluación y cierre', ruta: `${B}/revaluacion`, permiso: 'contable.ver',
      filtros: [{ k: 'periodo', etiqueta: 'Período (AAAA-MM)', defecto: mes }],
      crear: { titulo: 'Registrar revaluación', ruta: `${B}/revaluacion`, permiso: 'contable.revaluacion.registrar', campos: [{ k: 'periodo', etiqueta: 'Período (AAAA-MM)', defecto: mes, requerido: true }], mensaje: 'Revaluación registrada.' } },
    { id: 'apertura', titulo: 'Asiento de apertura', ruta: `${B}/apertura`, permiso: 'contable.ver',
      crear: { titulo: 'Asiento de apertura', ruta: `${B}/apertura`, permiso: 'contable.apertura.registrar', campos: [campoLineas], armar: (v) => ({ lineas: lineasDe(v.lineas) }) } },
    { id: 'config', titulo: 'Configuración', ruta: `${B}/config`, permiso: 'contable.ver',
      crear: { titulo: 'Iniciar contabilidad', ruta: `${B}/config/iniciar`, permiso: 'contable.configurar', campos: [
        { k: 'fecha_inicio', etiqueta: 'Fecha de inicio', tipo: 'date', requerido: true },
        { k: 'perfil', etiqueta: 'Perfil de rubro', tipo: 'select', requerido: true, defecto: 'cafeteria', opciones: [['cafeteria', 'Cafetería'], ['produccion', 'Producción'], ['cafeteria_produccion', 'Cafetería y producción'], ['personalizado', 'Personalizado']] },
      ], mensaje: 'Contabilidad iniciada.' },
      acciones: [] },
  ]} />
)

function qs(o) {
  const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v))
  return p.size ? `?${p}` : ''
}
