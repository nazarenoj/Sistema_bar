import { useState, useEffect, useCallback, useMemo } from 'react'
import * as api from '../../api'
import MesaCard, { DEFAULT_LIBRE, DEFAULT_OCUPADO } from './MesaCard'
import ModalPedido from './ModalPedido'
import Spinner from '../Spinner'
import SalonSelector from '../salones/SalonSelector'
import EstructuraItem from '../salones/EstructuraItem'
import ColorPickerPopover from '../salones/ColorPickerPopover'

const TIPOS_ESTRUCTURA = ['ventana', 'puerta', 'mostrador', 'columna']

// Agrupa mesas combinadas: sólo la mesa maestra se renderiza, con un tamaño = bounding box
// del grupo. Las mesas miembro (no maestras) no se dibujan por separado.
const agruparMesas = (mesas) => {
  const porGrupo = new Map()
  for (const m of mesas) {
    if (!m.grupo_id) continue
    if (!porGrupo.has(m.grupo_id)) porGrupo.set(m.grupo_id, [])
    porGrupo.get(m.grupo_id).push(m)
  }

  return mesas
    .filter((m) => !m.grupo_id || m.id === m.mesa_master_id)
    .map((m) => {
      if (!m.grupo_id) return { mesa: m, size: null }
      const miembros = porGrupo.get(m.grupo_id)
      const minX = Math.min(...miembros.map((x) => x.pos_x))
      const minY = Math.min(...miembros.map((x) => x.pos_y))
      const maxX = Math.max(...miembros.map((x) => x.pos_x + x.tamano))
      const maxY = Math.max(...miembros.map((x) => x.pos_y + x.tamano))
      return { mesa: { ...m, pos_x: minX, pos_y: minY }, size: { width: maxX - minX, height: maxY - minY } }
    })
}

export default function MesaGrid({ addToast, confirm, productos }) {
  const [salones, setSalones]           = useState([])
  const [salonActivoId, setSalonActivoId] = useState(null)
  const [mesas, setMesas]               = useState([])
  const [estructuras, setEstructuras]   = useState([])
  const [loading, setLoading]           = useState(true)
  const [editMode, setEditMode]         = useState(false)
  const [seleccion, setSeleccion]       = useState(new Set())
  const [mesaSeleccionada, setSeleccionada] = useState(null)
  const [nroInput, setNroInput]         = useState('')
  const [creando, setCreando]           = useState(false)
  const [colorPopover, setColorPopover] = useState(null)

  const salonActivo = salones.find((s) => s.id === salonActivoId) ?? null

  const fetchSalones = useCallback(async () => {
    try {
      const data = await api.getSalones()
      setSalones(data)
      setSalonActivoId((prev) => prev ?? data[0]?.id ?? null)
    } catch (err) {
      addToast(err.message, 'error')
    }
  }, [addToast])

  useEffect(() => { fetchSalones() }, [fetchSalones])

  const fetchMesas = useCallback(async () => {
    if (!salonActivoId) { setMesas([]); setLoading(false); return }
    setLoading(true)
    try {
      const data = await api.getMesas(salonActivoId)
      setMesas(data)
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [salonActivoId, addToast])

  useEffect(() => { fetchMesas() }, [fetchMesas])

  const fetchEstructuras = useCallback(async () => {
    if (!salonActivoId) { setEstructuras([]); return }
    try {
      setEstructuras(await api.getEstructuras(salonActivoId))
    } catch (err) {
      addToast(err.message, 'error')
    }
  }, [salonActivoId, addToast])

  useEffect(() => { fetchEstructuras() }, [fetchEstructuras])

  const itemsMesas = useMemo(() => agruparMesas(mesas), [mesas])

  // --- Salones ---
  const handleSelectSalon = (id) => {
    setSalonActivoId(id)
    setSeleccion(new Set())
    setSeleccionada(null)
    setColorPopover(null)
  }

  const handleCrearSalon = async () => {
    const nombre = prompt('Nombre del nuevo salón:')
    if (!nombre?.trim()) return
    try {
      const salon = await api.createSalon({ nombre: nombre.trim() })
      setSalones((prev) => [...prev, salon])
      setSalonActivoId(salon.id)
      addToast('Salón creado.')
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  const handleRenombrarSalon = async (salon) => {
    const nombre = prompt('Nuevo nombre del salón:', salon.nombre)
    if (!nombre?.trim() || nombre === salon.nombre) return
    try {
      const actualizado = await api.updateSalon(salon.id, { nombre: nombre.trim(), color_fondo: salon.color_fondo })
      setSalones((prev) => prev.map((s) => (s.id === salon.id ? actualizado : s)))
      addToast('Salón renombrado.')
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  const handleEliminarSalon = async (salon) => {
    if (!(await confirm(`¿Eliminar el salón "${salon.nombre}"?`, { title: 'Eliminar salón' }))) return
    try {
      await api.deleteSalon(salon.id)
      setSalones((prev) => {
        const restantes = prev.filter((s) => s.id !== salon.id)
        if (salonActivoId === salon.id) setSalonActivoId(restantes[0]?.id ?? null)
        return restantes
      })
      addToast('Salón eliminado.')
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  // --- Mesas ---
  const handleCrear = async (e) => {
    e.preventDefault()
    const n = parseInt(nroInput)
    if (!n || n <= 0) return addToast('Ingresa un número de mesa válido.', 'error')
    setCreando(true)
    try {
      await api.createMesa({ numero_mesa: n, salon_id: salonActivoId })
      setNroInput('')
      addToast('Mesa creada.')
      fetchMesas()
    } catch (err) {
      addToast(err.message, 'error')
    } finally {
      setCreando(false)
    }
  }

  const handleEliminar = async (mesa) => {
    if (!(await confirm(`¿Eliminar mesa ${mesa.numero_mesa}?`, { title: 'Eliminar mesa' }))) return
    try {
      await api.deleteMesa(mesa.id)
      addToast('Mesa eliminada.')
      fetchMesas()
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  const handleMesaUpdate = useCallback(async () => {
    const data = await api.getMesas(salonActivoId)
    setMesas(data)
    setSeleccionada((prev) => (prev ? (data.find((m) => m.id === prev.id) ?? prev) : null))
  }, [salonActivoId])

  const handleMoverItem = useCallback(async (item, newX, newY) => {
    if (!item.size) {
      setMesas((prev) => prev.map((m) => (m.id === item.mesa.id ? { ...m, pos_x: newX, pos_y: newY } : m)))
      try {
        await api.updateMesaPosicion(item.mesa.id, newX, newY)
      } catch (err) {
        addToast(err.message, 'error')
      }
      return
    }

    // Mesa combinada: mover todo el grupo manteniendo el arreglo relativo entre sus mesas
    const dx = newX - item.mesa.pos_x
    const dy = newY - item.mesa.pos_y
    const miembros = mesas.filter((m) => m.grupo_id === item.mesa.grupo_id)
    setMesas((prev) => prev.map((m) =>
      m.grupo_id === item.mesa.grupo_id ? { ...m, pos_x: m.pos_x + dx, pos_y: m.pos_y + dy } : m
    ))
    try {
      await Promise.all(miembros.map((m) => api.updateMesaPosicion(m.id, m.pos_x + dx, m.pos_y + dy)))
    } catch (err) {
      addToast(err.message, 'error')
    }
  }, [mesas, addToast])

  const handleResizeMesa = useCallback(async (item, tamano) => {
    setMesas((prev) => prev.map((m) => (m.id === item.mesa.id ? { ...m, tamano } : m)))
    try {
      await api.updateMesaTamano(item.mesa.id, tamano)
    } catch (err) {
      addToast(err.message, 'error')
    }
  }, [addToast])

  // --- Sillas (dibujo fijo alrededor de la mesa, independiente de los pedidos) ---
  const handleAgregarSilla = useCallback(async (mesaId) => {
    try {
      const silla = await api.crearSilla(mesaId)
      setMesas((prev) => prev.map((m) => (m.id === mesaId ? { ...m, sillas: [...(m.sillas ?? []), silla] } : m)))
    } catch (err) {
      addToast(err.message, 'error')
    }
  }, [addToast])

  const handleMoverSilla = useCallback(async (mesaId, sillaId, x, y) => {
    setMesas((prev) => prev.map((m) => (m.id === mesaId
      ? { ...m, sillas: (m.sillas ?? []).map((s) => (s.id === sillaId ? { ...s, pos_x: x, pos_y: y } : s)) }
      : m)))
    try {
      await api.moverSilla(sillaId, x, y)
    } catch (err) {
      addToast(err.message, 'error')
    }
  }, [addToast])

  const handleEliminarSilla = useCallback(async (mesaId, sillaId) => {
    setMesas((prev) => prev.map((m) => (m.id === mesaId
      ? { ...m, sillas: (m.sillas ?? []).filter((s) => s.id !== sillaId) }
      : m)))
    try {
      await api.eliminarSilla(sillaId)
    } catch (err) {
      addToast(err.message, 'error')
    }
  }, [addToast])

  const toggleSeleccion = (mesaId) => {
    setSeleccion((prev) => {
      const next = new Set(prev)
      if (next.has(mesaId)) next.delete(mesaId); else next.add(mesaId)
      return next
    })
  }

  const handleClickItem = (item) => {
    if (!editMode) { setSeleccionada(item.mesa); return }
    if (item.mesa.estado !== 'libre') {
      addToast('Esta mesa tiene una cuenta abierta: cerrala primero para poder editarla.', 'error')
      return
    }
    toggleSeleccion(item.mesa.id)
  }

  const handleCombinar = async () => {
    const ids = [...seleccion]
    const sugerido = mesas.filter((m) => ids.includes(m.id)).map((m) => m.numero_mesa).join('+')
    const numero = prompt('Número combinado a mostrar para estas mesas:', sugerido)
    if (!numero?.trim()) return
    try {
      await api.combinarMesas({ mesa_ids: ids, numero_mesa: numero.trim(), salon_id: salonActivoId })
      setSeleccion(new Set())
      addToast('Mesas combinadas.')
      fetchMesas()
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  const handleSeparar = async (item) => {
    if (!(await confirm(`¿Separar las mesas combinadas en "${item.mesa.numero_mesa_grupo}"?`, { title: 'Separar mesas', danger: false }))) return
    try {
      await api.separarGrupo(item.mesa.grupo_id)
      setSeleccion(new Set())
      addToast('Mesas separadas.')
      fetchMesas()
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  // --- Colores ---
  const handleAbrirColorMesa = (mesa, e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setColorPopover({ tipo: 'mesa', id: mesa.id, anchorPos: { x: rect.right, y: rect.bottom } })
  }

  const handleCambiarColorMesa = (key, value) => {
    const mesaId = colorPopover.id
    const mesa = mesas.find((m) => m.id === mesaId)
    if (!mesa) return
    const color_libre   = key === 'color_libre'   ? value : (mesa.color_libre ?? null)
    const color_ocupado = key === 'color_ocupado' ? value : (mesa.color_ocupado ?? null)
    setMesas((prev) => prev.map((m) => (m.id === mesaId ? { ...m, color_libre, color_ocupado } : m)))
    api.updateMesaColor(mesaId, color_libre, color_ocupado).catch((err) => addToast(err.message, 'error'))
  }

  const handleAbrirColorSalon = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setColorPopover({ tipo: 'salon', id: salonActivoId, anchorPos: { x: rect.right, y: rect.bottom } })
  }

  const handleCambiarColorSalon = (key, value) => {
    setSalones((prev) => prev.map((s) => (s.id === salonActivoId ? { ...s, color_fondo: value } : s)))
    const salon = salones.find((s) => s.id === salonActivoId)
    api.updateSalon(salonActivoId, { nombre: salon.nombre, color_fondo: value })
      .catch((err) => addToast(err.message, 'error'))
  }

  // --- Estructuras ---
  const handleAgregarEstructura = async (tipo) => {
    try {
      await api.createEstructura({ salon_id: salonActivoId, tipo, pos_x: 20, pos_y: 20 })
      addToast('Estructura agregada.')
      fetchEstructuras()
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  const handleMoverEstructura = useCallback(async (id, pos_x, pos_y) => {
    setEstructuras((prev) => prev.map((e) => (e.id === id ? { ...e, pos_x, pos_y } : e)))
    try {
      await api.updateEstructuraPosicion(id, pos_x, pos_y)
    } catch (err) {
      addToast(err.message, 'error')
    }
  }, [addToast])

  const handleRotarEstructura = useCallback(async (estructura) => {
    const rotacion = (estructura.rotacion + 90) % 360
    setEstructuras((prev) => prev.map((e) => (e.id === estructura.id ? { ...e, rotacion } : e)))
    try {
      await api.updateEstructura(estructura.id, { ancho: estructura.ancho, alto: estructura.alto, rotacion })
    } catch (err) {
      addToast(err.message, 'error')
    }
  }, [addToast])

  const handleResizeEstructura = useCallback(async (estructura, ancho, alto) => {
    setEstructuras((prev) => prev.map((e) => (e.id === estructura.id ? { ...e, ancho, alto } : e)))
    try {
      await api.updateEstructura(estructura.id, { ancho, alto, rotacion: estructura.rotacion })
    } catch (err) {
      addToast(err.message, 'error')
    }
  }, [addToast])

  const handleEliminarEstructura = async (estructura) => {
    if (!(await confirm('¿Eliminar esta estructura?', { title: 'Eliminar estructura' }))) return
    try {
      await api.deleteEstructura(estructura.id)
      setEstructuras((prev) => prev.filter((e) => e.id !== estructura.id))
      addToast('Estructura eliminada.')
    } catch (err) {
      addToast(err.message, 'error')
    }
  }

  const toggleEditMode = () => {
    setEditMode((e) => !e)
    setSeleccionada(null)
    setSeleccion(new Set())
    setColorPopover(null)
  }

  const libres   = itemsMesas.filter((i) => i.mesa.estado === 'libre').length
  const ocupadas = itemsMesas.filter((i) => i.mesa.estado === 'ocupado').length

  const seleccionMesas = mesas.filter((m) => seleccion.has(m.id))
  const puedeCombinar = seleccion.size >= 2 && seleccionMesas.every((m) => !m.grupo_id)
  const grupoASepararItem = seleccion.size === 1 && seleccionMesas[0]?.grupo_id
    ? itemsMesas.find((i) => i.mesa.id === seleccionMesas[0].id)
    : null

  return (
    <div>
      {/* Header */}
      <div className="flex flex-wrap gap-4 items-center justify-between mb-4">
        <div>
          <h1 className="sr-only">Panel de Mesas</h1>
          {!loading && (
            <p className="text-sm text-stone-500 mt-0.5">
              <span className="text-emerald-600 font-semibold">{libres} libres</span>
              {' · '}
              <span className="text-rose-600 font-semibold">{ocupadas} ocupadas</span>
            </p>
          )}
        </div>
        <div className="flex gap-2 items-center">
          {editMode && (
            <form onSubmit={handleCrear} className="flex gap-2">
              <input type="number" placeholder="Nº mesa" value={nroInput}
                onChange={(e) => setNroInput(e.target.value)} min="1"
                className="w-28 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-marca-500" />
              <button type="submit" disabled={creando || !salonActivoId}
                className="bg-cafe-800 text-white px-4 py-2 rounded-lg text-sm font-semibold
                  hover:bg-cafe-700 transition disabled:opacity-50">
                + Mesa
              </button>
            </form>
          )}
          <button onClick={toggleEditMode}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition
              ${editMode ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-cafe-800 text-white hover:bg-cafe-700'}`}>
            {editMode ? '✓ Terminar edición' : '✎ Editar salón'}
          </button>
        </div>
      </div>

      <SalonSelector
        salones={salones}
        salonActivoId={salonActivoId}
        onSelect={handleSelectSalon}
        editMode={editMode}
        onCreate={handleCrearSalon}
        onRename={handleRenombrarSalon}
        onDelete={handleEliminarSalon}
      />

      {editMode && salonActivoId && (
        <div className="flex flex-wrap gap-2 items-center mb-4 bg-white border rounded-xl p-3">
          <span className="text-xs font-bold text-stone-500 uppercase tracking-wide">Agregar:</span>
          {TIPOS_ESTRUCTURA.map((tipo) => (
            <button key={tipo} onClick={() => handleAgregarEstructura(tipo)}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-stone-100 hover:bg-stone-200 text-stone-700 capitalize">
              + {tipo}
            </button>
          ))}
          <button onClick={handleAbrirColorSalon}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-stone-100 hover:bg-stone-200 text-stone-700">
            🎨 Fondo del salón
          </button>
          {puedeCombinar && (
            <button onClick={handleCombinar}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-cafe-800 text-white hover:bg-cafe-700 ml-auto">
              Combinar ({seleccion.size})
            </button>
          )}
          {grupoASepararItem && (
            <button onClick={() => handleSeparar(grupoASepararItem)}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-600 text-white hover:bg-amber-700 ml-auto">
              🔓 Separar mesa {grupoASepararItem.mesa.numero_mesa_grupo}
            </button>
          )}
          <span className="text-xs text-stone-400 ml-auto">
            Arrastrá para acomodar · arrastrá la esquina para redimensionar · click en mesas libres para seleccionarlas, combinarlas o separarlas
          </span>
        </div>
      )}

      {/* Grid */}
      {loading ? (
        <div className="flex justify-center mt-20"><Spinner size="lg" /></div>
      ) : !salonActivoId ? (
        <div className="text-center text-stone-400 mt-20">
          <p className="text-6xl mb-4">🏠</p>
          <p className="font-medium">No hay salones. Activá "Editar salón" para crear el primero.</p>
        </div>
      ) : (
        <div
          className="relative w-full min-h-[560px] rounded-2xl border-2 border-dashed border-stone-200 overflow-auto"
          style={{
            backgroundColor: salonActivo?.color_fondo || '#f9fafb',
            backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.08) 1.5px, transparent 1.5px)',
            backgroundSize: '20px 20px',
          }}
        >
          {estructuras.map((estructura) => (
            <EstructuraItem
              key={estructura.id}
              estructura={estructura}
              editMode={editMode}
              onMove={(x, y) => handleMoverEstructura(estructura.id, x, y)}
              onRotate={() => handleRotarEstructura(estructura)}
              onResize={(ancho, alto) => handleResizeEstructura(estructura, ancho, alto)}
              onDelete={() => handleEliminarEstructura(estructura)}
            />
          ))}

          {itemsMesas.map((item) => (
            <MesaCard
              key={item.mesa.id}
              mesa={item.mesa}
              size={item.size}
              editMode={editMode}
              selected={seleccion.has(item.mesa.id)}
              isGrupo={!!item.size}
              onClick={() => handleClickItem(item)}
              onDelete={() => handleEliminar(item.mesa)}
              onMove={(x, y) => handleMoverItem(item, x, y)}
              onColorEdit={(e) => handleAbrirColorMesa(item.mesa, e)}
              onSeparar={() => handleSeparar(item)}
              onResize={(tamano) => handleResizeMesa(item, tamano)}
              onAgregarSilla={() => handleAgregarSilla(item.mesa.id)}
              onMoverSilla={(sillaId, x, y) => handleMoverSilla(item.mesa.id, sillaId, x, y)}
              onEliminarSilla={(sillaId) => handleEliminarSilla(item.mesa.id, sillaId)}
            />
          ))}

          {mesas.length === 0 && estructuras.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-stone-400">
              <div className="text-center">
                <p className="text-6xl mb-4">🍽️</p>
                <p className="font-medium">Este salón está vacío.</p>
                {editMode && <p className="text-sm mt-1">Agregá mesas o estructuras arriba.</p>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Color popovers */}
      {colorPopover?.tipo === 'mesa' && (() => {
        const mesa = mesas.find((m) => m.id === colorPopover.id)
        if (!mesa) return null
        return (
          <ColorPickerPopover
            anchorPos={colorPopover.anchorPos}
            title={`Colores · Mesa ${mesa.numero_mesa}`}
            fields={[
              { key: 'color_libre', label: 'Libre', value: mesa.color_libre || DEFAULT_LIBRE },
              { key: 'color_ocupado', label: 'Ocupada', value: mesa.color_ocupado || DEFAULT_OCUPADO },
            ]}
            onChange={handleCambiarColorMesa}
            onClose={() => setColorPopover(null)}
          />
        )
      })()}

      {colorPopover?.tipo === 'salon' && (
        <ColorPickerPopover
          anchorPos={colorPopover.anchorPos}
          title="Color de fondo del salón"
          fields={[{ key: 'color_fondo', label: 'Fondo', value: salonActivo?.color_fondo || '#f9fafb' }]}
          onChange={handleCambiarColorSalon}
          onClose={() => setColorPopover(null)}
        />
      )}

      {/* Modal de pedido */}
      {mesaSeleccionada && (
        <ModalPedido
          mesa={mesaSeleccionada}
          productos={productos}
          onClose={() => setSeleccionada(null)}
          onMesaUpdate={handleMesaUpdate}
          addToast={addToast}
          confirm={confirm}
        />
      )}
    </div>
  )
}
