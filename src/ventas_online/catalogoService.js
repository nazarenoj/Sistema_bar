const pool = require('../config/db');
const puertos = require('../modulos/puertos');
const Funciones = require('../funciones/servicio');
const Alergenos = require('../services/alergenoVentaService');
const Modificadores = require('../services/modificadorService');
const { TiendaInvalida } = require('./tiendaService');

// Publicación del catálogo, precios online y disponibilidad (Ventas Online RF02 a RF04, RN03, RN04). Los artículos y sus precios son de Ventas; la tienda elige cuáles publica y cómo,
// y publica la disponibilidad que le informa Stock (o la que se carga a mano sin Stock). El precio online es el de la lista «Online» con VEN-LISTAS y, sin ella, el de Ventas más el ajuste.
const invalida = (m, status = 400, extra = {}) => Object.assign(new TiendaInvalida(m), { status, ...extra });
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const num = (x) => Number(x);

const fecha = (v, n) => { if (v === undefined || v === null || v === '') return null; const d = new Date(v); if (Number.isNaN(d.getTime())) throw invalida(`"${n}" no es una fecha válida.`); return d; };

// ---- Administración ----

const publicar = async (productoId, d = {}) => {
  const [[p]] = await pool.query('SELECT id, nombre FROM productos WHERE id = ?', [productoId]);
  if (!p) throw invalida('El artículo no existe.', 404);
  const desde = fecha(d.visible_desde, 'visible_desde'), hasta = fecha(d.visible_hasta, 'visible_hasta');
  if (desde && hasta && hasta <= desde) throw invalida('La visibilidad termina después de empezar.');
  const fotos = d.fotos === undefined ? undefined : d.fotos;
  if (fotos !== undefined && (!Array.isArray(fotos) || fotos.length > 10 || fotos.some((f) => typeof f !== 'string' || !/^(https?:\/\/|\/)/.test(f) || f.length > 255))) throw invalida('Las fotos son hasta 10 direcciones (http, https o /).');
  const margen = d.margen_seguridad === undefined ? undefined : Number(d.margen_seguridad);
  if (margen !== undefined && !(margen >= 0)) throw invalida('El margen de seguridad no puede ser negativo.');
  if (d.atributos !== undefined && (typeof d.atributos !== 'object' || Array.isArray(d.atributos) || d.atributos === null)) throw invalida('Los atributos son un objeto (por ejemplo { "molienda": "espresso" }).');
  const [[prev]] = await pool.query('SELECT * FROM onl_publicados WHERE producto_id = ?', [productoId]);
  const v = (k, nuevo, viejo) => (nuevo === undefined ? viejo ?? null : nuevo);
  await pool.query(
    `INSERT INTO onl_publicados (producto_id, titulo, descripcion, fotos, categoria_online, orden, visible_desde, visible_hasta, margen_seguridad, atributos, publicado_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE titulo = VALUES(titulo), descripcion = VALUES(descripcion), fotos = VALUES(fotos), categoria_online = VALUES(categoria_online), orden = VALUES(orden), visible_desde = VALUES(visible_desde),
       visible_hasta = VALUES(visible_hasta), margen_seguridad = VALUES(margen_seguridad), atributos = VALUES(atributos)`,
    [productoId, v('titulo', d.titulo === undefined ? undefined : String(d.titulo).slice(0, 120), prev?.titulo), v('descripcion', d.descripcion, prev?.descripcion), fotos === undefined ? prev?.fotos ?? null : JSON.stringify(fotos),
      v('categoria_online', d.categoria_online === undefined ? undefined : String(d.categoria_online).slice(0, 80), prev?.categoria_online), d.orden === undefined ? prev?.orden ?? 0 : Number(d.orden) || 0,
      d.visible_desde === undefined ? prev?.visible_desde ?? null : desde, d.visible_hasta === undefined ? prev?.visible_hasta ?? null : hasta, margen ?? Number(prev?.margen_seguridad ?? 0),
      d.atributos === undefined ? prev?.atributos ?? null : JSON.stringify(d.atributos), Date.now()]);
  await pool.query('INSERT IGNORE INTO onl_disponibilidad (producto_id, cantidad, agotado, fuente, actualizada_ms) VALUES (?, NULL, 0, ?, ?)', [productoId, 'manual', Date.now()]);
  return (await administrar()).find((x) => x.producto_id === productoId);
};

const despublicar = async (productoId) => {
  const [r] = await pool.query('DELETE FROM onl_publicados WHERE producto_id = ?', [productoId]);
  if (!r.affectedRows) throw invalida('El artículo no está publicado.', 404);
  await pool.query('DELETE FROM onl_disponibilidad WHERE producto_id = ?', [productoId]);
  return { producto_id: productoId, publicado: false };
};

const administrar = async () => (await pool.query(
  `SELECT p.id AS producto_id, p.nombre, p.precio, p.tipo, pub.titulo, pub.descripcion, pub.fotos, pub.categoria_online, pub.orden, pub.visible_desde, pub.visible_hasta, pub.margen_seguridad, pub.atributos, pub.producto_id IS NOT NULL AS publicado,
          d.cantidad, d.agotado AS agotado_online, d.fuente, d.actualizada_ms
   FROM productos p LEFT JOIN onl_publicados pub ON pub.producto_id = p.id LEFT JOIN onl_disponibilidad d ON d.producto_id = p.id ORDER BY p.nombre`))[0]
  .map((r) => ({ producto_id: r.producto_id, nombre: r.nombre, precio_ventas: num(r.precio), tipo: r.tipo, publicado: !!r.publicado, titulo: r.titulo, descripcion: r.descripcion, fotos: r.fotos ? JSON.parse(r.fotos) : [],
    categoria_online: r.categoria_online, orden: r.orden, visible_desde: r.visible_desde, visible_hasta: r.visible_hasta, margen_seguridad: num(r.margen_seguridad ?? 0), atributos: r.atributos ? JSON.parse(r.atributos) : {},
    disponibilidad: r.publicado ? { cantidad: r.cantidad === null ? null : num(r.cantidad), agotado: !!r.agotado_online, fuente: r.fuente, actualizada_ms: r.actualizada_ms ? Number(r.actualizada_ms) : null } : null }));

// ---- Precios (RF03) ----

const ajustes = async () => {
  const [[t]] = await pool.query('SELECT ajuste_pct FROM onl_tienda WHERE id = 1');
  const cats = (await pool.query('SELECT categoria_id, pct FROM onl_ajustes_categoria'))[0].map((c) => ({ categoria_id: c.categoria_id, pct: num(c.pct) }));
  return { global: num(t.ajuste_pct), categorias: cats };
};
const fijarAjustes = async ({ global, categorias }) => {
  if (global !== undefined) {
    if (typeof global !== 'number' || global < -90 || global > 500) throw invalida('El ajuste global es un porcentaje entre -90 y 500.');
    await pool.query('UPDATE onl_tienda SET ajuste_pct = ? WHERE id = 1', [global]);
  }
  for (const c of categorias ?? []) {
    if (typeof c.pct !== 'number' || c.pct < -90 || c.pct > 500) throw invalida('El ajuste por categoría es un porcentaje entre -90 y 500.');
    const [[ok]] = await pool.query('SELECT id FROM categorias_producto WHERE id = ?', [c.categoria_id]);
    if (!ok) throw invalida(`La categoría ${c.categoria_id} no existe.`, 404);
    if (c.pct === null) await pool.query('DELETE FROM onl_ajustes_categoria WHERE categoria_id = ?', [c.categoria_id]);
    else await pool.query('INSERT INTO onl_ajustes_categoria (categoria_id, pct) VALUES (?, ?) ON DUPLICATE KEY UPDATE pct = VALUES(pct)', [c.categoria_id, c.pct]);
  }
  return ajustes();
};

// El precio online de un artículo: { precio, lista, base }. `listaId` es la lista de un cliente registrado (con la prioridad «cliente», RN47). Sin precio en la lista elegida, se usa el
// base de Ventas y la lista registrada es la Minorista.
const precioOnline = async (productoId, { listaId = null, conn = pool } = {}) => {
  const [[p]] = await conn.query('SELECT precio, categoria_id FROM productos WHERE id = ?', [productoId]);
  if (!p) return null;
  const base = num(p.precio);
  if (await Funciones.estaActiva('VEN-LISTAS', conn)) {
    const hoy = new Date().toISOString().slice(0, 10);
    const lista = listaId
      ? (await conn.query('SELECT id, nombre FROM listas_precio WHERE id = ? AND activa = 1 AND (vigente_desde IS NULL OR vigente_desde <= ?) AND (vigente_hasta IS NULL OR vigente_hasta >= ?)', [listaId, hoy, hoy]))[0][0]
      : (await conn.query("SELECT id, nombre FROM listas_precio WHERE tipo = 'online' AND activa = 1 AND (vigente_desde IS NULL OR vigente_desde <= ?) AND (vigente_hasta IS NULL OR vigente_hasta >= ?) ORDER BY id LIMIT 1", [hoy, hoy]))[0][0];
    if (lista) {
      const [[i]] = await conn.query('SELECT precio FROM lista_precio_items WHERE lista_id = ? AND producto_id = ?', [lista.id, productoId]);
      if (i) return { precio: num(i.precio), lista: lista.nombre, lista_id: lista.id, base };
    }
    const [[min]] = await conn.query('SELECT id, nombre FROM listas_precio WHERE es_base = 1 LIMIT 1');
    return { precio: base, lista: min?.nombre ?? 'Minorista', lista_id: min?.id ?? null, base };
  }
  const aj = await ajustes();
  const cat = aj.categorias.find((c) => c.categoria_id === p.categoria_id);
  const pct = cat ? cat.pct : aj.global;
  return { precio: r2(base * (1 + pct / 100)), lista: null, lista_id: null, base, ajuste_pct: pct };
};

// ---- Disponibilidad (RN03, RN04) ----

const fijarDisponibilidad = async (productoId, { cantidad, agotado }) => {
  const [[pub]] = await pool.query('SELECT producto_id FROM onl_publicados WHERE producto_id = ?', [productoId]);
  if (!pub) throw invalida('El artículo no está publicado.', 404);
  if (cantidad !== undefined && cantidad !== null && !(Number(cantidad) >= 0)) throw invalida('La cantidad no puede ser negativa.');
  const [[d]] = await pool.query('SELECT * FROM onl_disponibilidad WHERE producto_id = ?', [productoId]);
  await pool.query('UPDATE onl_disponibilidad SET cantidad = ?, agotado = ?, fuente = ?, actualizada_ms = ? WHERE producto_id = ?',
    [cantidad === undefined ? d.cantidad : cantidad, agotado === undefined ? d.agotado : agotado ? 1 : 0, 'manual', Date.now(), productoId]);
  return (await administrar()).find((x) => x.producto_id === productoId).disponibilidad;
};

// Sincronización (RF04): lee de Stock lo que se puede vender de cada artículo publicado (el combo, el mínimo de sus componentes), le resta el margen de seguridad y lo publica.
// Si Stock no responde, se conserva lo último publicado y se avisa (RN02, RN04). Sin Stock la disponibilidad queda como está (manual).
const sincronizar = async () => {
  const [pubs] = await pool.query('SELECT producto_id, margen_seguridad FROM onl_publicados');
  const puerto = await puertos.obtener('stock');
  let actualizados = 0, fallo = null;
  if (puerto.disponibleUnidades) {
    for (const p of pubs) {
      try {
        const r = await puerto.disponibleUnidades(p.producto_id);
        if (!r || r.cantidad === undefined) continue;
        const cant = r.cantidad === null ? null : Math.max(0, Math.floor(r.cantidad - num(p.margen_seguridad)));
        await pool.query('UPDATE onl_disponibilidad SET cantidad = ?, agotado = 0, fuente = ?, actualizada_ms = ? WHERE producto_id = ?', [cant, 'stock', Date.now(), p.producto_id]);
        actualizados++;
      } catch (err) { fallo = err.message; break; }
    }
  }
  await pool.query('UPDATE onl_sync SET ultima_ms = ?, publicados = ?, detalle = ? WHERE id = 1', [fallo ? null : Date.now(), actualizados, fallo ? `Stock no respondió: ${fallo}`.slice(0, 255) : null]);
  if (fallo) await pool.query('UPDATE onl_sync SET ultima_ms = COALESCE(ultima_ms, (SELECT MAX(actualizada_ms) FROM onl_disponibilidad)) WHERE id = 1');
  return estadoSync();
};
const estadoSync = async () => {
  const [[s]] = await pool.query('SELECT * FROM onl_sync WHERE id = 1');
  const [[t]] = await pool.query('SELECT disponibilidad_alerta_min FROM onl_tienda WHERE id = 1');
  const ultima = s.ultima_ms ? Number(s.ultima_ms) : null;
  return { ultima_ms: ultima, publicados: s.publicados, detalle: s.detalle, desactualizada: ultima === null ? false : Date.now() - ultima > t.disponibilidad_alerta_min * 60000 };
};

// ---- Lo público (RF02) ----

const visible = (p, ahora) => (!p.visible_desde || new Date(p.visible_desde) <= ahora) && (!p.visible_hasta || new Date(p.visible_hasta) >= ahora);

// La ficha pública de un artículo publicado. `vendible` es false si no hay disponible publicado, si está agotado en Online, o si Ventas / Stock lo marcan agotado.
const ficha = async (p, { listaId = null, ahora = new Date(), sync } = {}) => {
  const precio = await precioOnline(p.producto_id, { listaId });
  const disp = p.cantidad === null || p.cantidad === undefined ? null : num(p.cantidad);
  const agotado = !!p.agotado_online || !!p.agotado || !!p.agotado_auto || (disp !== null && disp <= 0);
  return {
    id: p.producto_id, titulo: p.titulo || p.nombre, descripcion: p.descripcion ?? null, fotos: p.fotos ? JSON.parse(p.fotos) : [], categoria: p.categoria_online ?? null, atributos: p.atributos ? JSON.parse(p.atributos) : {},
    tipo: p.tipo, precio: precio.precio, ...(precio.lista && { lista: precio.lista }), disponible: agotado ? 0 : disp, vendible: !agotado, agotado,
    ...(sync?.desactualizada && disp !== null && { disponibilidad_no_confirmada: true }),
  };
};
const publicados = async ({ q, categoria, orden, listaId, sinAlergenos = [], ahora = new Date() } = {}) => {
  const [filas] = await pool.query(
    `SELECT pub.*, p.nombre, p.tipo, p.agotado, p.agotado_auto, d.cantidad, d.agotado AS agotado_online FROM onl_publicados pub JOIN productos p ON p.id = pub.producto_id LEFT JOIN onl_disponibilidad d ON d.producto_id = pub.producto_id ORDER BY pub.orden, p.nombre`);
  const sync = await estadoSync();
  let lista = [];
  const conAlergenos = await Funciones.estaActiva('VEN-ALERGENOS');
  for (const f of filas) {
    if (!visible(f, ahora)) continue;
    const x = await ficha(f, { listaId, ahora, sync });
    if (conAlergenos) { const a = await alergenosDe(f.producto_id); x.alergenos = a.alergenos; x.alergenos_pendientes = a.pendientes; }
    lista.push(x);
  }
  if (sinAlergenos.length) lista = lista.filter((x) => !(x.alergenos ?? []).some((a) => sinAlergenos.includes(a.codigo)) && !x.alergenos_pendientes);
  if (categoria) lista = lista.filter((x) => x.categoria === categoria);
  if (q) { const t = String(q).toLowerCase(); lista = lista.filter((x) => x.titulo.toLowerCase().includes(t) || (x.descripcion ?? '').toLowerCase().includes(t)); }
  if (orden === 'precio') lista.sort((a, b) => a.precio - b.precio); else if (orden === '-precio') lista.sort((a, b) => b.precio - a.precio); else if (orden === 'nombre') lista.sort((a, b) => a.titulo.localeCompare(b.titulo));
  return lista;
};
const categoriasPublicas = async (ahora = new Date()) => {
  const mapa = new Map();
  for (const x of await publicados({ ahora })) if (x.categoria) mapa.set(x.categoria, (mapa.get(x.categoria) ?? 0) + 1);
  return [...mapa].map(([nombre, articulos]) => ({ nombre, articulos })).sort((a, b) => a.nombre.localeCompare(b.nombre));
};

// ---- Alérgenos y modificadores (RF05, RF22, RN33) ----

// Alérgenos de un artículo con las opciones elegidas: los del artículo, los de cada opción y los derivados de Stock (Ventas Online RF22, Ventas RN42). Si no se pudieron calcular todos,
// `pendientes` es verdadero y la tienda no puede afirmar que el artículo está libre de un alérgeno.
const alergenosDe = async (productoId, opcionIds = []) => {
  if (!(await Funciones.estaActiva('VEN-ALERGENOS'))) return { aplica: false, alergenos: [], pendientes: false };
  const l = await Alergenos.calcularLinea(pool, productoId, opcionIds);
  return { aplica: true, alergenos: l.alergenos.map((a) => ({ codigo: a.codigo, nombre: a.nombre })), pendientes: !!l.pendientes, ...(l.pendientes && { leyenda: Alergenos.LEYENDA_PENDIENTE }) };
};
const gruposDe = async (productoId) => {
  if (!(await Funciones.estaActiva('VEN-MODIF'))) return [];
  const base = new Set((await alergenosDe(productoId)).alergenos.map((a) => a.codigo));
  const grupos = [];
  for (const g of await Modificadores.paraProducto(productoId)) {
    const opciones = [];
    for (const o of g.opciones) {
      const propios = (await alergenosDe(productoId, [o.id])).alergenos.filter((a) => !base.has(a.codigo));
      opciones.push({ id: o.id, nombre: o.nombre, ajuste_precio: o.ajuste_precio, alergenos: propios });
    }
    grupos.push({ id: g.id, nombre: g.nombre, obligatorio: !!g.obligatorio, minimo: g.minimo, maximo: g.maximo, opciones });
  }
  return grupos;
};
const publicado = async (productoId, ahora = new Date()) => {
  const [[f]] = await pool.query(
    `SELECT pub.*, p.nombre, p.tipo, p.agotado, p.agotado_auto, d.cantidad, d.agotado AS agotado_online FROM onl_publicados pub JOIN productos p ON p.id = pub.producto_id LEFT JOIN onl_disponibilidad d ON d.producto_id = pub.producto_id WHERE pub.producto_id = ?`, [productoId]);
  return f && visible(f, ahora) ? f : null;
};
// La ficha completa: datos, precio, disponibilidad, alérgenos y los grupos de opciones con sus ajustes y alérgenos.
const detalle = async (productoId, { listaId = null, ahora = new Date() } = {}) => {
  const f = await publicado(productoId, ahora);
  if (!f) return null;
  const x = await ficha(f, { listaId, ahora, sync: await estadoSync() });
  const a = await alergenosDe(productoId);
  return { ...x, alergenos: a.alergenos, alergenos_pendientes: a.pendientes, ...(a.leyenda && { leyenda_alergenos: a.leyenda }), grupos: await gruposDe(productoId) };
};
// Valida la elección de opciones de un artículo antes de agregarlo al carrito (RN33, EX23): un grupo obligatorio incompleto lo impide. Devuelve el precio unitario con los ajustes y los alérgenos.
const seleccion = async (productoId, opcionIds = [], { listaId = null } = {}) => {
  const f = await publicado(productoId);
  if (!f) throw invalida('El artículo no está publicado.', 404, { codigo: 'ARTICULO_NO_PUBLICADO' });
  if (!Array.isArray(opcionIds) || opcionIds.some((o) => !Number.isInteger(o))) throw invalida('Las opciones son una lista de ids.');
  let elegidas = [];
  if (await Funciones.estaActiva('VEN-MODIF')) {
    try { elegidas = await Modificadores.resolver(pool, productoId, opcionIds); } catch (err) { throw invalida(err.message, 400, { codigo: 'OPCION_INVALIDA' }); }
    for (const g of (await Modificadores.paraProducto(productoId)).filter((g) => g.obligatorio || g.minimo > 0)) {
      const n = elegidas.filter((o) => o.grupo_id === g.id).length;
      if (n < Math.max(g.minimo, g.obligatorio ? 1 : 0)) throw invalida(`Elegí ${Math.max(g.minimo, 1)} opción(es) de "${g.nombre}".`, 400, { codigo: 'GRUPO_INCOMPLETO', grupo: g.nombre });
    }
  } else if (opcionIds.length) throw invalida('Este artículo no admite opciones.', 400, { codigo: 'OPCION_INVALIDA' });
  const precio = await precioOnline(productoId, { listaId });
  const ajuste = r2(elegidas.reduce((a, o) => a + Number(o.ajuste_precio_aplicado), 0));
  const al = await alergenosDe(productoId, opcionIds);
  return { producto_id: productoId, titulo: f.titulo || f.nombre, opciones: elegidas, precio_base: precio.precio, ajuste, precio_unitario: r2(precio.precio + ajuste), lista: precio.lista_id ? { id: precio.lista_id, nombre: precio.lista } : null,
    alergenos: al.alergenos, alergenos_pendientes: al.pendientes, ...(al.leyenda && { leyenda_alergenos: al.leyenda }) };
};

module.exports = { alergenosDe, gruposDe, detalle, seleccion, publicado, publicar, despublicar, administrar, ajustes, fijarAjustes, precioOnline, fijarDisponibilidad, sincronizar, estadoSync, publicados, categoriasPublicas, ficha, visible };
