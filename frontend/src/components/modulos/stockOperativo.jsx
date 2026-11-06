import Modulo from '../layout/Modulo'
import { dinero } from '../../utils/formato'

const PRODUCTOS = { ruta: '/productos', valor: 'id', texto: 'nombre' }
const DEPOSITOS = { ruta: '/depositos', valor: 'id', texto: 'nombre' }
const abierta = (f) => !['aprobada', 'cancelada'].includes(f.estado)

export const Produccion = (p) => (
  <Modulo {...p} tabs={[
    {
      id: 'ordenes', titulo: 'Órdenes', ruta: '/produccion/ordenes',
      filtros: [{ k: 'estado', etiqueta: 'Estado', tipo: 'select', opciones: [['borrador', 'Borrador'], ['confirmada', 'Confirmada'], ['cancelada', 'Cancelada']] }],
      ocultar: ['id_global', 'producto_id'],
      crear: {
        titulo: 'Nueva orden', mensaje: 'Orden creada.', ruta: '/produccion/ordenes',
        campos: [
          { k: 'tipo', etiqueta: 'Tipo', tipo: 'select', opciones: [['produccion', 'Producción (elaborado)'], ['armado', 'Armado (combo)']], defecto: 'produccion', requerido: true },
          { k: 'producto_id', etiqueta: 'Producto', tipo: 'select', fuente: PRODUCTOS, requerido: true },
          { k: 'cantidad', etiqueta: 'Cantidad planificada', tipo: 'number', requerido: true },
          { k: 'deposito_insumos_id', etiqueta: 'Depósito de insumos', tipo: 'select', fuente: DEPOSITOS },
          { k: 'deposito_destino_id', etiqueta: 'Depósito de destino', tipo: 'select', fuente: DEPOSITOS },
          { k: 'turno', etiqueta: 'Turno', tipo: 'select', opciones: [['manana', 'Mañana'], ['tarde', 'Tarde']] },
        ],
        armar: (v) => ({
          tipo: v.tipo, producto_id: Number(v.producto_id), cantidad: Number(v.cantidad),
          ...(v.deposito_insumos_id && { deposito_insumos_id: Number(v.deposito_insumos_id) }),
          ...(v.deposito_destino_id && { deposito_destino_id: Number(v.deposito_destino_id) }),
          ...(v.turno && { turno: v.turno }),
        }),
      },
      ver: { titulo: 'Orden de producción', ruta: (f) => `/produccion/ordenes/${f.id}` },
      acciones: [
        {
          titulo: 'Confirmar', ruta: (f) => `/produccion/ordenes/${f.id}/confirmar`, mostrar: (f) => f.estado === 'borrador', mensaje: 'Orden confirmada.',
          campos: [{ k: 'cantidad_real', etiqueta: 'Cantidad producida', tipo: 'number', requerido: true }, { k: 'lote_codigo', etiqueta: 'Código de lote' }],
        },
        { titulo: 'Cancelar', estilo: 'rojo', ruta: (f) => `/produccion/ordenes/${f.id}/cancelar`, mostrar: (f) => f.estado === 'borrador', confirmar: '¿Cancelar la orden?', mensaje: 'Orden cancelada.' },
      ],
    },
    { id: 'informe', titulo: 'Informe', ruta: '/produccion/informe', filtros: [{ k: 'desde', etiqueta: 'Desde', tipo: 'date' }, { k: 'hasta', etiqueta: 'Hasta', tipo: 'date' }] },
  ]} />
)

export const Inventario = (p) => (
  <Modulo {...p} tabs={[
    {
      id: 'tomas', titulo: 'Tomas de inventario', ruta: '/inventario/tomas',
      ayuda: 'Una toma congela las existencias, se cargan los conteos y, al aprobarla, las diferencias ajustan el stock.',
      crear: {
        titulo: 'Nueva toma general', mensaje: 'Toma creada.', ruta: '/inventario/tomas', permiso: 'stock.movimientos.registrar',
        campos: [{ k: 'congelar_manual', tipo: 'checkbox', etiqueta: 'Congelar las existencias a mano' }],
        armar: (v) => ({ alcance: {}, congelar_manual: !!v.congelar_manual }),
      },
      ver: { titulo: 'Toma de inventario', ruta: (f) => `/inventario/tomas/${f.id}` },
      acciones: [
        {
          titulo: 'Cargar conteo', ruta: (f) => `/inventario/tomas/${f.id}/lineas`, permiso: 'stock.movimientos.registrar', mostrar: abierta, mensaje: 'Conteo cargado.',
          campos: [
            { k: 'item', etiqueta: 'Ítem (tipo:id)', ayuda: 'Ej.: insumo:3 o producto:12', requerido: true },
            { k: 'deposito_id', etiqueta: 'Depósito', tipo: 'select', fuente: DEPOSITOS, requerido: true },
            { k: 'cantidad', etiqueta: 'Cantidad contada', tipo: 'number', requerido: true },
          ],
          body: (f, v) => { const [tipo, id] = String(v.item).split(':'); return { item: { tipo, id: Number(id) }, deposito_id: Number(v.deposito_id), cantidad: Number(v.cantidad) } },
        },
        { titulo: 'Aprobar', permiso: 'stock.inventario.aprobar', ruta: (f) => `/inventario/tomas/${f.id}/aprobar`, mostrar: abierta, confirmar: '¿Aprobar la toma y ajustar el stock?', mensaje: 'Toma aprobada.', body: () => ({}) },
        { titulo: 'Cancelar', estilo: 'rojo', permiso: 'stock.movimientos.registrar', ruta: (f) => `/inventario/tomas/${f.id}/cancelar`, mostrar: abierta, confirmar: '¿Cancelar la toma?', mensaje: 'Toma cancelada.' },
      ],
    },
    { id: 'diferencias', titulo: 'Diferencias', ruta: '/inventario/diferencias', ayuda: 'Diferencias entre lo contado y lo que indica el sistema.' },
  ]} />
)

export const Calidad = (p) => (
  <Modulo {...p} tabs={[
    {
      id: 'alergenos', titulo: 'Alérgenos', ruta: '/alergenos', permiso: 'stock.trazabilidad.ver',
      crear: { titulo: 'Nuevo alérgeno', ruta: '/alergenos', permiso: 'stock.alergenos.gestionar', campos: [{ k: 'codigo', etiqueta: 'Código', requerido: true }, { k: 'nombre', etiqueta: 'Nombre', requerido: true }] },
    },
    {
      id: 'puntos', titulo: 'Puntos de temperatura', ruta: '/temperaturas/puntos', permiso: 'stock.trazabilidad.ver',
      crear: {
        titulo: 'Nuevo punto', ruta: '/temperaturas/puntos', permiso: 'stock.temperaturas.configurar',
        campos: [
          { k: 'nombre', etiqueta: 'Nombre', requerido: true },
          { k: 'tipo', etiqueta: 'Tipo', tipo: 'select', opciones: [['heladera', 'Heladera'], ['freezer', 'Freezer'], ['camara', 'Cámara'], ['otro', 'Otro']], defecto: 'heladera' },
          { k: 'rango_min', etiqueta: 'Mínimo (°C)', tipo: 'number', requerido: true },
          { k: 'rango_max', etiqueta: 'Máximo (°C)', tipo: 'number', requerido: true },
          { k: 'frecuencia_horas', etiqueta: 'Cada cuántas horas', tipo: 'number', defecto: 12 },
        ],
      },
      acciones: [{ titulo: 'Registrar', permiso: 'stock.temperaturas.registrar', ruta: (f) => `/temperaturas/puntos/${f.id}/registros`, mensaje: 'Temperatura registrada.', campos: [{ k: 'valor', etiqueta: 'Temperatura (°C)', tipo: 'number', requerido: true }] }],
    },
    { id: 'registros', titulo: 'Registros de temperatura', ruta: '/temperaturas/registros', permiso: 'stock.trazabilidad.ver' },
    {
      id: 'series', titulo: 'Series', ruta: '/series/vigentes', permiso: 'stock.series.gestionar',
      ayuda: 'Números de serie en stock. Para ver una sola mercadería, usá el buscador de la tabla.',
      crear: {
        titulo: 'Ingresar series', ruta: (v) => `/series/${v.producto_id}/ingresos`, mensaje: 'Series ingresadas.',
        campos: [
          { k: 'producto_id', etiqueta: 'Producto', tipo: 'select', fuente: PRODUCTOS, requerido: true },
          { k: 'deposito_id', etiqueta: 'Depósito', tipo: 'select', fuente: DEPOSITOS },
          { k: 'series', etiqueta: 'Números de serie (uno por línea)', tipo: 'textarea', requerido: true },
          { k: 'costo_unitario', etiqueta: 'Costo unitario', tipo: 'number' }, { k: 'proveedor', etiqueta: 'Proveedor' },
        ],
        armar: (v) => ({
          series: String(v.series).split(/[\n,]+/).map(s => s.trim()).filter(Boolean),
          ...(v.deposito_id && { deposito_id: Number(v.deposito_id) }), ...(v.costo_unitario && { costo_unitario: Number(v.costo_unitario) }), ...(v.proveedor && { proveedor: v.proveedor }),
        }),
      },
      acciones: [
        {
          titulo: 'Dar de baja', estilo: 'rojo', permiso: 'stock.series.baja', ruta: (f) => `/series/${f.producto_id}/baja`, mensaje: 'Serie dada de baja.',
          campos: [{ k: 'motivo', etiqueta: 'Motivo', requerido: true }], body: (f, v) => ({ series: [f.numero_serie ?? f.numero], motivo: v.motivo }),
        },
      ],
    },
    {
      id: 'lotes', titulo: 'Lotes por vencer', ruta: '/lotes/vencimientos', permiso: 'stock.movimientos.ver',
      filtros: [{ k: 'dias', etiqueta: 'Vencen en los próximos (días)', tipo: 'number', defecto: 30 }],
      ocultar: ['insumo_id', 'producto_id', 'deposito_id'],
      crear: { titulo: 'Dar de baja lo vencido hoy', ruta: '/lotes/merma-fin-dia', permiso: 'stock.movimientos.registrar', mensaje: 'Merma de fin de día registrada.', campos: [], armar: () => ({}) },
      acciones: [
        { titulo: 'Bloquear', estilo: 'rojo', permiso: 'stock.movimientos.registrar', ruta: (f) => `/lotes/${f.id}/bloqueo`, metodo: 'PUT', mostrar: (f) => !f.bloqueado, mensaje: 'Lote bloqueado.', campos: [{ k: 'motivo', etiqueta: 'Motivo', requerido: true }], body: (f, v) => ({ bloqueado: true, motivo: v.motivo }) },
        { titulo: 'Liberar', permiso: 'stock.movimientos.registrar', ruta: (f) => `/lotes/${f.id}/bloqueo`, metodo: 'PUT', mostrar: (f) => !!f.bloqueado, mensaje: 'Lote liberado.', body: () => ({ bloqueado: false }) },
      ],
    },
    {
      id: 'imprimir', titulo: 'Etiquetas por artículo', ruta: '/productos', permiso: 'stock.etiquetas.gestionar',
      ayuda: 'Generá la etiqueta de góndola o la de un elaborado con su lote.',
      ocultar: ['descripcion', 'imagen', 'categoria_id', 'tipo', 'created_at'],
      acciones: [
        { titulo: 'Góndola', ruta: (f) => `/etiquetas/articulos/${f.id}/gondola`, mensaje: 'Etiqueta de góndola generada.', campos: [{ k: 'impresora', etiqueta: 'Impresora (opcional)' }] },
        { titulo: 'Elaborado', ruta: (f) => `/etiquetas/articulos/${f.id}/elaborado`, mensaje: 'Etiqueta de elaborado generada.', campos: [{ k: 'lote', etiqueta: 'Lote', requerido: true }, { k: 'impresora', etiqueta: 'Impresora (opcional)' }] },
        { titulo: 'Código', ruta: (f) => `/etiquetas/articulos/${f.id}/codigo`, metodo: 'PUT', mensaje: 'Código asignado.', campos: [{ k: 'codigo', etiqueta: 'Código de barras', requerido: true }] },
      ],
    },

    { id: 'etiquetas', titulo: 'Etiquetas desactualizadas', ruta: '/etiquetas/desactualizadas', permiso: 'stock.etiquetas.gestionar', ayuda: 'Etiquetas de góndola impresas a un precio que ya no rige.', formato: { precio: (f) => dinero(f.precio) } },
  ]} />
)

export const Proveedores = (p) => (
  <Modulo {...p} tabs={[
    {
      id: 'fotos', titulo: 'Ingresos por foto', ruta: '/stock-ingresos/fotos', ver: { titulo: 'Ingreso por foto', ruta: (f) => `/stock-ingresos/fotos/${f.id}` },
      acciones: [{ titulo: 'Descartar', estilo: 'rojo', ruta: (f) => `/stock-ingresos/fotos/${f.id}/descartar`, mostrar: (f) => !['confirmado', 'descartado'].includes(f.estado), confirmar: '¿Descartar la foto?', mensaje: 'Descartada.' }],
    },
    { id: 'devoluciones', titulo: 'Devoluciones a proveedor', ruta: '/stock-ingresos/devoluciones-proveedor', ver: { titulo: 'Devolución a proveedor', ruta: (f) => `/stock-ingresos/devoluciones-proveedor/${f.id}` } },
    {
      id: 'claves', titulo: 'Comprobantes de terceros', ruta: '/comprobantes-terceros',
      crear: {
        titulo: 'Registrar comprobante', ruta: '/comprobantes-terceros/reservar', mensaje: 'Comprobante registrado.',
        campos: [
          { k: 'cuit', etiqueta: 'CUIT del emisor', requerido: true },
          { k: 'clase', etiqueta: 'Clase', tipo: 'select', opciones: [['FACTURA', 'Factura'], ['NOTA_CREDITO', 'Nota de crédito'], ['NOTA_DEBITO', 'Nota de débito'], ['REMITO', 'Remito'], ['TICKET', 'Ticket'], ['RECIBO', 'Recibo'], ['OTRO', 'Otro']], requerido: true, defecto: 'FACTURA' },
          { k: 'tipo', etiqueta: 'Letra (A, B, C…)', defecto: 'A' }, { k: 'punto_venta', etiqueta: 'Punto de venta', tipo: 'entero', requerido: true }, { k: 'numero', etiqueta: 'Número', tipo: 'entero', requerido: true },
        ],
      },
      ver: { titulo: 'Comprobante', ruta: (f) => `/comprobantes-terceros/${f.id}` }, ayuda: 'Claves que evitan cargar dos veces el mismo comprobante de un proveedor.' },
  ]} />
)
