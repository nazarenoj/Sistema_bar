import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import TablaAuto from './TablaAuto'
import Modal, { Campo, Tarjeta } from './Modal'
import Spinner from '../Spinner'
import { descargarArchivo } from '../../utils/ticket'

// Pantalla de módulo armada con una configuración: pestañas con listado, filtros, altas, acciones por fila,
// detalle y descargas. Cada pantalla de los módulos es un archivo de configuración (ver components/modulos/).
//
// tab: { id, titulo, ruta, filtros?, filas?(respuesta), ocultar?, titulos?, formato?, crear?, acciones?, ver?, descargas?, ayuda?, permiso? }
// campo: { k, etiqueta, tipo?: text|number|date|datetime-local|select|checkbox|textarea, opciones?: [[valor, texto]], fuente?: { ruta, valor, texto, filas? },
//          requerido?, defecto?, ayuda? }
// crear: { titulo, ruta | ruta(valores), metodo?, campos, armar?(valores) }
// acciones: [{ titulo, ruta(fila), metodo?, campos?, body?(fila, valores), confirmar?, mostrar?(fila), permiso?, estilo?, mensaje? }]
// ver: { titulo?, ruta(fila) }   descargas: [{ titulo, ruta(filtros), nombre }]

export const primeraLista = (d) => (Array.isArray(d) ? d : Object.values(d ?? {}).find(Array.isArray) ?? [])

const limpiar = (valores, campos) => {
  const salida = {}
  for (const c of campos) {
    const v = valores[c.k]
    if (v === '' || v === undefined || v === null) continue
    salida[c.k] = c.tipo === 'number' ? Number(v) : c.tipo === 'checkbox' ? !!v : c.tipo === 'entero' ? parseInt(v, 10) : v
  }
  for (const c of campos.filter(x => x.tipo === 'checkbox')) if (salida[c.k] === undefined) salida[c.k] = false
  return salida
}

function useFuente(campo) {
  const [opciones, setOpciones] = useState(campo.opciones ?? null)
  useEffect(() => {
    if (!campo.fuente) return
    api.llamar(campo.fuente.ruta).then(d => {
      const filas = campo.fuente.filas ? campo.fuente.filas(d) : primeraLista(d)
      setOpciones(filas.map(f => [f[campo.fuente.valor ?? 'id'], typeof campo.fuente.texto === 'function' ? campo.fuente.texto(f) : f[campo.fuente.texto ?? 'nombre']]))
    }).catch(() => setOpciones([]))
  }, [campo])
  return opciones ?? []
}

function Entrada({ campo, valor, onChange }) {
  const opciones = useFuente(campo)
  const comun = { required: campo.requerido, className: 'campo w-full' }
  if (campo.tipo === 'checkbox')
    return <label className="flex items-center gap-2 text-sm text-stone-700"><input type="checkbox" checked={!!valor} onChange={e => onChange(e.target.checked)} className="accent-cafe-800" /> {campo.etiqueta}</label>
  return (
    <Campo etiqueta={campo.etiqueta}>
      {campo.tipo === 'select' ? (
        <select {...comun} value={valor ?? ''} onChange={e => onChange(e.target.value)}>
          <option value="">{campo.requerido ? 'Elegí…' : '—'}</option>
          {opciones.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </select>
      ) : campo.tipo === 'textarea' ? (
        <textarea {...comun} rows={3} value={valor ?? ''} onChange={e => onChange(e.target.value)} />
      ) : (
        <input {...comun} type={campo.tipo === 'entero' ? 'number' : (campo.tipo ?? 'text')} step={campo.tipo === 'number' ? 'any' : undefined} value={valor ?? ''} onChange={e => onChange(e.target.value)} />
      )}
      {campo.ayuda && <span className="block text-xs text-stone-400 mt-0.5">{campo.ayuda}</span>}
    </Campo>
  )
}

function Formulario({ titulo, campos, inicial = {}, onClose, onEnviar, boton = 'Guardar' }) {
  const [v, setV] = useState(() => ({ ...Object.fromEntries(campos.filter(c => c.defecto !== undefined).map(c => [c.k, c.defecto])), ...inicial }))
  const [enviando, setEnviando] = useState(false)
  const enviar = async (e) => {
    e.preventDefault()
    setEnviando(true)
    try { await onEnviar(v) } finally { setEnviando(false) }
  }
  return (
    <Modal titulo={titulo} onClose={onClose} ancho="max-w-xl">
      <form onSubmit={enviar} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {campos.map(c => (
          <div key={c.k} className={c.tipo === 'textarea' || c.ancho === 'completo' ? 'sm:col-span-2' : ''}>
            <Entrada campo={c} valor={v[c.k]} onChange={x => setV(p => ({ ...p, [c.k]: x }))} />
          </div>
        ))}
        <div className="sm:col-span-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn bg-stone-400 hover:bg-stone-500">Cancelar</button>
          <button disabled={enviando} className="btn btn-azul">{enviando ? 'Enviando…' : boton}</button>
        </div>
      </form>
    </Modal>
  )
}

const legible = (k) => k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
export function Detalle({ datos }) {
  if (datos === null || datos === undefined) return <p className="text-stone-400">—</p>
  if (Array.isArray(datos)) return datos.length && typeof datos[0] === 'object' ? <TablaAuto filas={datos} vacio="Sin datos." /> : <p>{datos.join(', ') || '—'}</p>
  if (typeof datos !== 'object') return <span>{String(datos)}</span>
  const escalares = Object.entries(datos).filter(([, v]) => v === null || typeof v !== 'object')
  const otros = Object.entries(datos).filter(([, v]) => v !== null && typeof v === 'object')
  return (
    <div className="space-y-3 text-sm">
      {escalares.length > 0 && (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
          {escalares.map(([k, v]) => <div key={k} className="flex justify-between gap-3 border-b border-stone-100 py-1"><dt className="text-stone-500">{legible(k)}</dt><dd className="text-stone-800 text-right break-all">{typeof v === 'boolean' ? (v ? 'Sí' : 'No') : (v ?? '—')}</dd></div>)}
        </dl>
      )}
      {otros.map(([k, v]) => <div key={k}><p className="font-semibold text-stone-700 mb-1">{legible(k)}</p><Detalle datos={v} /></div>)}
    </div>
  )
}

function Pestana({ tab, addToast, usuario, confirm }) {
  const [filtros, setFiltros] = useState(() => Object.fromEntries((tab.filtros ?? []).filter(f => f.defecto !== undefined).map(f => [f.k, f.defecto])))
  const [aplicados, setAplicados] = useState(filtros)
  const [datos, setDatos] = useState(null)
  const [modal, setModal] = useState(null) // { tipo: 'crear' | 'accion' | 'ver', ... }
  const faltan = (tab.filtros ?? []).some(f => f.requerido && !aplicados[f.k])

  const cargar = useCallback(async () => {
    if (faltan) { setDatos([]); return }
    setDatos(null)
    try { setDatos(await api.llamar(typeof tab.ruta === "function" ? tab.ruta(aplicados) : `${tab.ruta}${api.qs(aplicados)}`)) }
    catch (err) { setDatos([]); addToast(err.message, 'error') }
  }, [tab, aplicados, faltan, addToast])
  useEffect(() => { cargar() }, [cargar])

  const filas = tab.filas ? tab.filas(datos ?? []) : primeraLista(datos)
  const resumen = datos && !Array.isArray(datos) && typeof datos === 'object' ? Object.entries(datos).filter(([, v]) => v !== null && typeof v !== 'object') : []
  const puede = (p) => !p || api.can(usuario, p)

  const ejecutar = async (a, f, valores) => {
    try {
      if (a.confirmar && !(await confirm(typeof a.confirmar === 'function' ? a.confirmar(f) : a.confirmar, { title: a.titulo }))) return
      const body = a.body ? a.body(f, valores) : (a.campos ? limpiar(valores, a.campos) : undefined)
      await api.llamar(a.ruta(f), { method: a.metodo ?? 'POST', ...(body !== undefined && { body }) })
      addToast(a.mensaje ?? 'Listo.')
      setModal(null)
      cargar()
    } catch (err) { addToast(err.message, 'error') }
  }
  const abrirAccion = (a, f) => (a.campos ? setModal({ tipo: 'accion', a, f }) : ejecutar(a, f, {}))
  const ver = async (f) => {
    try { setModal({ tipo: 'ver', datos: await api.llamar(tab.ver.ruta(f)), titulo: tab.ver.titulo ?? 'Detalle' }) } catch (err) { addToast(err.message, 'error') }
  }

  const acciones = (tab.acciones ?? []).filter(a => puede(a.permiso))
  const hayFilaAcciones = acciones.length > 0 || tab.ver

  return (
    <div>
      {tab.ayuda && <p className="text-sm text-stone-500 mb-3">{tab.ayuda}</p>}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        {(tab.filtros ?? []).map(f => (
          <Campo key={f.k} etiqueta={f.etiqueta}>
            {f.tipo === 'select'
              ? <select value={filtros[f.k] ?? ''} onChange={e => setFiltros(x => ({ ...x, [f.k]: e.target.value }))} className="campo"><option value="">Todos</option>{(f.opciones ?? []).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
              : <input type={f.tipo ?? 'text'} value={filtros[f.k] ?? ''} onChange={e => setFiltros(x => ({ ...x, [f.k]: e.target.value }))} className="campo w-40" />}
          </Campo>
        ))}
        {(tab.filtros ?? []).length > 0 && <button onClick={() => setAplicados(filtros)} className="btn btn-azul">Buscar</button>}
        <div className="ml-auto flex flex-wrap gap-2">
          {(tab.descargas ?? []).map(d => (
            <button key={d.titulo} onClick={() => descargarArchivo(d.ruta(aplicados), d.nombre).catch(e => addToast(e.message, 'error'))} className="btn bg-marca-600 hover:bg-marca-700 btn-chico">{d.titulo}</button>
          ))}
          {tab.crear && puede(tab.crear.permiso) && <button onClick={() => setModal({ tipo: 'crear' })} className="btn btn-azul">+ {tab.crear.titulo}</button>}
        </div>
      </div>

      {resumen.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {resumen.map(([k, v]) => <Tarjeta key={k} titulo={legible(k)} valor={typeof v === 'boolean' ? (v ? 'Sí' : 'No') : String(v)} />)}
        </div>
      )}

      {faltan ? <p className="text-sm text-stone-500">Completá los filtros obligatorios y tocá Buscar.</p>
        : !datos ? <div className="flex justify-center py-12"><Spinner size="lg" /></div>
        : (
          <TablaAuto
            filas={filas} ocultar={['created_at', 'updated_at', ...(tab.ocultar ?? [])]} titulos={tab.titulos} formato={tab.formato} vacio={tab.vacio ?? 'No hay registros.'}
            acciones={hayFilaAcciones ? (f => (
              <>
                {tab.ver && <button onClick={() => ver(f)} className="btn btn-azul btn-chico mr-1">Ver</button>}
                {acciones.filter(a => !a.mostrar || a.mostrar(f)).map(a => (
                  <button key={a.titulo} onClick={() => abrirAccion(a, f)} className={`btn btn-chico mr-1 ${a.estilo === 'rojo' ? 'btn-rojo' : 'bg-marca-600 hover:bg-marca-700'}`}>{a.titulo}</button>
                ))}
              </>
            )) : undefined}
          />
        )}

      {modal?.tipo === 'crear' && (
        <Formulario titulo={tab.crear.titulo} campos={tab.crear.campos} onClose={() => setModal(null)}
          onEnviar={async (v) => {
            try {
              const body = tab.crear.armar ? tab.crear.armar(v) : limpiar(v, tab.crear.campos)
              await api.llamar(typeof tab.crear.ruta === 'function' ? tab.crear.ruta(v) : tab.crear.ruta, { method: tab.crear.metodo ?? 'POST', body })
              addToast(tab.crear.mensaje ?? 'Guardado.')
              setModal(null)
              cargar()
            } catch (err) { addToast(err.message, 'error') }
          }} />
      )}
      {modal?.tipo === 'accion' && <Formulario titulo={modal.a.titulo} campos={modal.a.campos} boton={modal.a.titulo} onClose={() => setModal(null)} onEnviar={(v) => ejecutar(modal.a, modal.f, v)} />}
      {modal?.tipo === 'ver' && <Modal titulo={modal.titulo} onClose={() => setModal(null)} ancho="max-w-3xl"><Detalle datos={modal.datos} /></Modal>}
    </div>
  )
}

export default function Modulo({ tabs, addToast, usuario, confirm }) {
  const visibles = tabs.filter(t => !t.permiso || api.can(usuario, t.permiso))
  const [id, setId] = useState(visibles[0]?.id)
  const tab = visibles.find(t => t.id === id) ?? visibles[0]
  if (!tab) return <p className="text-stone-500 text-sm">No tenés permiso para nada de esta sección.</p>
  return (
    <div>
      {visibles.length > 1 && (
        <div className="flex flex-wrap gap-1 border-b border-stone-200 mb-4">
          {visibles.map(t => (
            <button key={t.id} onClick={() => setId(t.id)}
              className={`px-4 py-2 text-sm -mb-px border-b-2 ${tab.id === t.id ? 'border-cafe-800 text-cafe-800 font-semibold' : 'border-transparent text-stone-500 hover:text-stone-800'}`}>{t.titulo}</button>
          ))}
        </div>
      )}
      <Pestana key={tab.id} tab={tab} addToast={addToast} usuario={usuario} confirm={confirm} />
    </div>
  )
}
