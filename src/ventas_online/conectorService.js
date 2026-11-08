const crypto = require('crypto');
const pool = require('../config/db');
const Modulos = require('../modulos/registro');
const Funciones = require('../funciones/servicio');
const Mensajeria = require('../mensajeria/servicio');
const Notificacion = require('../models/notificacionModel');
const { idGlobal } = require('../utils/idGlobal');
const Catalogo = require('./catalogoService');
const Tienda = require('./tiendaService');
const Checkout = require('./checkoutService');
const Eventos = require('./eventos');
const { TiendaInvalida } = require('./tiendaService');

// Marketplaces y plataformas de delivery (Ventas Online RF18, RF19, RN25 a RN28, EX15 a EX18, con ONL-MARKETPLACES, que exige Financiero). Cada conector publica a su plataforma los artículos
// vinculados con el precio de su lista (o con su ajuste) y la disponibilidad; descarga los pedidos como pedidos de origen «plataforma», idempotentes por el ID externo de cada plataforma; los
// acepta o rechaza; le informa los cambios de estado, y entrega a Financiero la comisión de cada pedido entregado y las liquidaciones recibidas. El cobro lo hizo la plataforma: Ventas lo registra como
// «Cobro por plataforma».
// shortcut: el transporte hacia cada plataforma (enviar menú y estados) es un punto de enchufe sin cliente real (`usarTransporte`); sin él el conector figura «desconectado» y los eventos quedan en cola.
const invalida = (m, status = 400, extra = {}) => Object.assign(new TiendaInvalida(m), { status, ...extra });
const r2 = (x) => Math.round(Number(x) * 100) / 100;
let transporte = null;
const usarTransporte = (fn) => { transporte = fn; };

const exigir = async () => { if (!(await Funciones.estaActiva('ONL-MARKETPLACES'))) throw invalida('Los conectores de plataformas necesitan la función ONL-MARKETPLACES.', 409, { codigo: 'FUNCION_INACTIVA' }); };
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const vista = (c) => ({ id: c.id, codigo: c.codigo, nombre: c.nombre, comision_pct: Number(c.comision_pct), lista_precio_id: c.lista_precio_id, ajuste_pct: Number(c.ajuste_pct), aceptacion_auto: !!c.aceptacion_auto, acepta_minutos: c.acepta_minutos,
  pausado: !!c.pausado, pausa_motivo: c.pausa_motivo, conexion: c.conexion, ultima_publicacion_ms: c.ultima_publicacion_ms ? Number(c.ultima_publicacion_ms) : null, activo: !!c.activo });
const fila = async (idOCodigo) => {
  const [[c]] = await pool.query(`SELECT * FROM onl_conectores WHERE ${Number.isInteger(idOCodigo) ? 'id' : 'codigo'} = ?`, [idOCodigo]);
  if (!c) throw invalida('Conector no encontrado.', 404);
  return c;
};

// ---- Administración ----

const crear = async (d) => {
  await exigir();
  if (!/^[a-z0-9-]{3,30}$/.test(String(d.codigo ?? ''))) throw invalida('El código del conector tiene de 3 a 30 letras minúsculas, números o guiones.');
  if (typeof d.nombre !== 'string' || !d.nombre.trim()) throw invalida('Falta el nombre de la plataforma.');
  const com = Number(d.comision_pct ?? 0), aj = Number(d.ajuste_pct ?? 0);
  if (!(com >= 0 && com <= 100) || !(aj >= -90 && aj <= 500)) throw invalida('La comisión es un porcentaje entre 0 y 100 y el ajuste entre -90 y 500.');
  const token = crypto.randomBytes(24).toString('hex');
  try {
    const [r] = await pool.query('INSERT INTO onl_conectores (codigo, nombre, comision_pct, lista_precio_id, ajuste_pct, aceptacion_auto, acepta_minutos, token_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [d.codigo, d.nombre.trim().slice(0, 80), com, d.lista_precio_id ?? null, aj, d.aceptacion_auto === false ? 0 : 1, d.acepta_minutos ?? 2, hash(token)]);
    return { ...vista(await fila(r.insertId)), token }; // el secreto se muestra una sola vez
  } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw invalida('Ya hay un conector con ese código.', 409); throw err; }
};
const listar = async () => (await pool.query('SELECT * FROM onl_conectores ORDER BY nombre'))[0].map(vista);
const editar = async (id, d) => {
  const c = await fila(id);
  const campos = {};
  if (d.nombre !== undefined) campos.nombre = String(d.nombre).trim().slice(0, 80);
  if (d.comision_pct !== undefined) { if (!(Number(d.comision_pct) >= 0 && Number(d.comision_pct) <= 100)) throw invalida('La comisión es un porcentaje entre 0 y 100.'); campos.comision_pct = Number(d.comision_pct); }
  if (d.ajuste_pct !== undefined) { if (!(Number(d.ajuste_pct) >= -90 && Number(d.ajuste_pct) <= 500)) throw invalida('El ajuste es un porcentaje entre -90 y 500.'); campos.ajuste_pct = Number(d.ajuste_pct); }
  if (d.lista_precio_id !== undefined) campos.lista_precio_id = d.lista_precio_id;
  if (d.aceptacion_auto !== undefined) campos.aceptacion_auto = d.aceptacion_auto ? 1 : 0;
  if (d.activo !== undefined) campos.activo = d.activo ? 1 : 0;
  const k = Object.keys(campos);
  if (k.length) await pool.query(`UPDATE onl_conectores SET ${k.map((x) => `${x} = ?`).join(', ')} WHERE id = ?`, [...k.map((x) => campos[x]), c.id]);
  return vista(await fila(id));
};
// La pausa manual queda registrada con su motivo (RN26).
const pausar = async (id, pausado, motivo) => {
  if (pausado && (typeof motivo !== 'string' || motivo.trim().length < 3)) throw invalida('Indicá el motivo de la pausa.');
  await pool.query('UPDATE onl_conectores SET pausado = ?, pausa_motivo = ? WHERE id = ?', [pausado ? 1 : 0, pausado ? motivo.trim().slice(0, 160) : null, id]);
  return vista(await fila(id));
};
const vincularArticulo = async (id, { producto_id: productoId, id_externo: externo }) => {
  const c = await fila(id);
  if (!(await Catalogo.publicado(Number(productoId)))) throw invalida('El artículo no está publicado en la tienda.', 409, { codigo: 'ARTICULO_NO_PUBLICADO' });
  if (typeof externo !== 'string' || !externo.trim()) throw invalida('Falta el ID del artículo en la plataforma.');
  try { await pool.query('INSERT INTO onl_conector_articulos (conector_id, producto_id, id_externo) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE id_externo = VALUES(id_externo)', [c.id, productoId, externo.trim()]); } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida('Ese ID de la plataforma ya está vinculado a otro artículo.', 409);
    throw err;
  }
  return articulos(c.id);
};
const articulos = async (id) => (await pool.query('SELECT a.producto_id, a.id_externo, p.nombre FROM onl_conector_articulos a JOIN productos p ON p.id = a.producto_id WHERE a.conector_id = ? ORDER BY p.nombre', [id]))[0];

// ---- Publicación: menú, precio y disponibilidad ----

const precioDe = async (c, productoId) => {
  if (c.lista_precio_id && (await Funciones.estaActiva('VEN-LISTAS'))) return (await Catalogo.precioOnline(productoId, { listaId: c.lista_precio_id })).precio;
  const [[p]] = await pool.query('SELECT precio FROM productos WHERE id = ?', [productoId]);
  return r2(Number(p.precio) * (1 + Number(c.ajuste_pct) / 100));
};
// Lo que se manda a la plataforma. Con la disponibilidad desactualizada se pausan los elaborados en todos los conectores (RN26); un conector pausado a mano no publica.
const menu = async (id) => {
  const c = await fila(id);
  const sync = await Catalogo.estadoSync();
  const items = [];
  for (const a of await articulos(c.id)) {
    const f = await Catalogo.publicado(a.producto_id);
    if (!f) continue;
    const ficha = await Catalogo.ficha(f, {});
    const elaborado = f.tipo === 'elaborado';
    items.push({ id_externo: a.id_externo, titulo: ficha.titulo, precio: await precioDe(c, a.producto_id), disponible: ficha.vendible && !(elaborado && sync.desactualizada) ? ficha.disponible : 0, vendible: ficha.vendible && !(elaborado && sync.desactualizada) });
  }
  return { conector: c.codigo, pausado: !!c.pausado, items };
};
const publicar = async (id) => {
  const c = await fila(id);
  if (c.pausado) throw invalida(`El conector está pausado: ${c.pausa_motivo ?? ''}`, 409, { codigo: 'CONECTOR_PAUSADO' });
  const m = await menu(id);
  if (!transporte) { await pool.query("UPDATE onl_conectores SET conexion = 'desconectado' WHERE id = ?", [c.id]); throw invalida('No hay conexión con la plataforma: queda desconectada y se reintenta.', 409, { codigo: 'DESCONECTADO' }); } // EX15
  try { await transporte('menu', c.codigo, m); } catch (err) {
    await pool.query("UPDATE onl_conectores SET conexion = 'desconectado' WHERE id = ?", [c.id]);
    await Notificacion.crear({ modulo: 'ventas_online', tipo: 'conector_desconectado', severidad: 'alta', roles: ['gerente'], clave: `conector-${c.id}`, mensaje: `El conector ${c.nombre} quedó desconectado: ${err.message}` }).catch(() => {});
    throw invalida(`La plataforma no respondió: ${err.message}`, 409, { codigo: 'DESCONECTADO' });
  }
  await pool.query("UPDATE onl_conectores SET conexion = 'conectado', ultima_publicacion_ms = ? WHERE id = ?", [Date.now(), c.id]);
  return { publicados: m.items.length };
};

// ---- Pedidos de la plataforma ----

const FORMA_CF = JSON.stringify({ tipo: 'consumidor_final' });
const recibirPedido = async (codigoConector, token, d) => {
  await exigir();
  const c = await fila(codigoConector);
  if (!c.activo || hash(token ?? '') !== c.token_hash) throw invalida('Credenciales del conector inválidas.', 401, { codigo: 'CONECTOR_NO_AUTORIZADO' });
  const externo = String(d.id_externo ?? '').trim();
  if (!externo || externo.length > 80) throw invalida('Falta el ID externo del pedido.');
  const [[previo]] = await pool.query('SELECT id, estado FROM onl_pedidos WHERE conector_id = ? AND id_externo = ?', [c.id, externo]);
  if (previo) return { ...(await Checkout.vista(previo.id)), repetido: true }; // una descarga repetida no duplica el pedido (RN27)
  if (!Array.isArray(d.items) || !d.items.length) throw invalida('El pedido no tiene artículos.');
  const mapa = new Map((await articulos(c.id)).map((a) => [a.id_externo, a]));
  let faltaVincular = false, suma = 0;
  const lineas = d.items.map((i, n) => {
    const a = mapa.get(String(i.id_externo_articulo));
    if (!a) faltaVincular = true;
    const cant = Number(i.cantidad), precio = Number(i.precio);
    if (!(cant > 0) || !(precio >= 0)) throw invalida(`El artículo ${n + 1} tiene cantidad o precio inválido.`);
    suma += cant * precio;
    return { producto_id: a?.producto_id ?? null, titulo: a?.nombre ?? String(i.titulo ?? i.id_externo_articulo).slice(0, 160), cantidad: cant, precio, externo: String(i.id_externo_articulo) };
  });
  const total = r2(d.total ?? suma);
  if (Math.abs(total - r2(suma)) > 0.01) throw invalida(`El total (${total}) no coincide con la suma de los artículos (${r2(suma)}).`, 400, { codigo: 'TOTAL_NO_CIERRA' });
  const comision = d.comision !== undefined ? r2(d.comision) : r2(total * Number(c.comision_pct) / 100); // por porcentaje o por el importe que informe la plataforma
  const fact = d.cuit_comprador && /^\d{11}$/.test(String(d.cuit_comprador).replace(/\D/g, '')) ? JSON.stringify({ tipo: 'factura_a', cuit: String(d.cuit_comprador).replace(/\D/g, ''), razon_social: d.nombre_comprador ?? 'Comprador', condicion_iva: d.condicion_iva ?? 'Responsable Inscripto' }) : FORMA_CF;
  const estado = faltaVincular ? 'pendiente_vinculacion' : c.aceptacion_auto ? 'pagado' : 'pendiente_aceptacion';
  const ahora = Date.now();
  const conn = await pool.getConnection();
  let id;
  try {
    await conn.beginTransaction();
    const cfg = await Funciones.estado(conn);
    const [r] = await conn.query(
      `INSERT INTO onl_pedidos (id_global, id_solicitud, estado, nombre, email, telefono, facturacion, entrega_tipo, entrega_datos, medio_pago, subtotal, descuento, envio, total, a_pagar, reserva_estado, config_version, config_instantanea, terminos_ms, created_ms, updated_ms, origen, conector_id, id_externo, comision, pagado_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'plataforma', ?, 0, 0, ?, ?, 'no_aplica', ?, ?, ?, ?, ?, 'plataforma', ?, ?, ?, ?)`,
      [await idGlobal(), `plat:${c.codigo}:${externo}`.slice(0, 64), estado, String(d.nombre_comprador ?? 'Comprador de plataforma').slice(0, 100), String(d.email_comprador ?? `${externo}@${c.codigo}.plataforma`).slice(0, 120), d.telefono_comprador ?? null, fact,
        d.entrega === 'delivery' ? 'delivery' : 'retiro', JSON.stringify({ direccion: d.direccion ?? null, plataforma: c.nombre }), total, total, total, cfg.version, JSON.stringify([]), ahora, ahora, ahora, c.id, externo, comision, estado === 'pagado' ? ahora : null]);
    id = r.insertId;
    for (const [n, l] of lineas.entries()) await conn.query('INSERT INTO onl_pedido_lineas (pedido_id, linea, producto_id, titulo, cantidad, precio_unitario, importe, opciones, alergenos, observaciones) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, n + 1, l.producto_id ?? 0, l.titulo, l.cantidad, l.precio, r2(l.cantidad * l.precio), '[]', '[]', l.producto_id ? null : `ext:${l.externo}`]);
    await Checkout.historial(conn, id, estado, `Pedido ${externo} de ${c.nombre}`);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') { const [[p]] = await pool.query('SELECT id FROM onl_pedidos WHERE conector_id = ? AND id_externo = ?', [c.id, externo]); if (p) return { ...(await Checkout.vista(p.id)), repetido: true }; }
    throw err;
  } finally { conn.release(); }
  if (faltaVincular) await Notificacion.crear({ modulo: 'ventas_online', tipo: 'pedido_sin_vincular', severidad: 'alta', roles: ['gerente'], clave: `pv-${id}`, mensaje: `El pedido ${externo} de ${c.nombre} trae artículos sin vincular: vinculalos o rechazá el pedido.` }).catch(() => {}); // EX16
  if (estado === 'pagado') await Eventos.pagado(id);
  return { ...(await Checkout.vista(id)), repetido: false };
};

const pedidoDe = async (id) => {
  const [[p]] = await pool.query("SELECT * FROM onl_pedidos WHERE id = ? AND origen = 'plataforma'", [id]);
  if (!p) throw invalida('Pedido de plataforma no encontrado.', 404);
  return p;
};
const aceptar = async (id) => {
  const p = await pedidoDe(id);
  if (p.estado !== 'pendiente_aceptacion') throw invalida(`El pedido está ${p.estado}.`, 409);
  await pool.query("UPDATE onl_pedidos SET estado = 'pagado', pagado_ms = ?, updated_ms = ? WHERE id = ?", [Date.now(), Date.now(), id]);
  await Checkout.historial(pool, id, 'pagado', 'Aceptado por el comercio');
  await Eventos.estado(id, 'pagado');
  await Eventos.pagado(id);
  return Checkout.vista(id);
};
const rechazar = async (id, { motivo }) => {
  if (typeof motivo !== 'string' || motivo.trim().length < 3) throw invalida('El motivo es obligatorio.');
  const p = await pedidoDe(id);
  if (!['pendiente_aceptacion', 'pendiente_vinculacion'].includes(p.estado)) throw invalida(`El pedido está ${p.estado}.`, 409);
  await pool.query("UPDATE onl_pedidos SET estado = 'cancelado', motivo_cancelacion = ?, updated_ms = ? WHERE id = ?", [motivo.trim().slice(0, 255), Date.now(), id]);
  await Checkout.historial(pool, id, 'cancelado', motivo.trim().slice(0, 255));
  await Eventos.estado(id, 'cancelado', motivo);
  return Checkout.vista(id);
};
// Vincula los artículos de un pedido que quedó pendiente (EX16): `vinculos` = [{ id_externo, producto_id }].
const vincularPedido = async (id, vinculos) => {
  const p = await pedidoDe(id);
  if (p.estado !== 'pendiente_vinculacion') throw invalida(`El pedido está ${p.estado}.`, 409);
  for (const v of vinculos ?? []) await vincularArticulo(p.conector_id, { producto_id: v.producto_id, id_externo: v.id_externo });
  const mapa = new Map((await articulos(p.conector_id)).map((a) => [a.id_externo, a]));
  // Las líneas sin vincular guardan el ID externo en sus observaciones hasta vincularse.
  for (const l of (await pool.query('SELECT id, observaciones FROM onl_pedido_lineas WHERE pedido_id = ? AND producto_id = 0', [id]))[0]) {
    const a = mapa.get(String(l.observaciones ?? '').replace(/^ext:/, ''));
    if (a) await pool.query('UPDATE onl_pedido_lineas SET producto_id = ?, titulo = ?, observaciones = NULL WHERE id = ?', [a.producto_id, a.nombre, l.id]);
  }
  const [[{ falta }]] = await pool.query('SELECT COUNT(*) AS falta FROM onl_pedido_lineas WHERE pedido_id = ? AND producto_id = 0', [id]);
  if (falta) throw invalida('Quedan artículos sin vincular.', 409, { codigo: 'FALTAN_VINCULOS' });
  const c = await fila(p.conector_id);
  await pool.query('UPDATE onl_pedidos SET estado = ?, updated_ms = ? WHERE id = ?', [c.aceptacion_auto ? 'pagado' : 'pendiente_aceptacion', Date.now(), id]);
  if (c.aceptacion_auto) { await pool.query('UPDATE onl_pedidos SET pagado_ms = ? WHERE id = ?', [Date.now(), id]); await Eventos.pagado(id); }
  return Checkout.vista(id);
};
// Alerta de los pedidos que nadie aceptó dentro del plazo (RN27).
const alertarSinAceptar = async () => {
  const [peds] = await pool.query("SELECT p.id, p.id_externo, c.nombre, c.acepta_minutos FROM onl_pedidos p JOIN onl_conectores c ON c.id = p.conector_id WHERE p.estado = 'pendiente_aceptacion' AND p.created_ms < ?", [Date.now() - 2 * 60000]);
  let n = 0;
  for (const p of peds) if (Date.now() - 0 > 0) { await Notificacion.crear({ modulo: 'ventas_online', tipo: 'pedido_sin_aceptar', severidad: 'alta', roles: ['gerente', 'encargado'], clave: `psa-${p.id}`, mensaje: `El pedido ${p.id_externo} de ${p.nombre} espera aceptación.` }).catch(() => {}); n++; }
  return n;
};

// ---- Estados hacia la plataforma y comisión a Financiero ----

const AVISABLES = ['en_preparacion', 'listo', 'despachado', 'entregado', 'cancelado'];
const informarEstado = async (pedidoId, estado) => {
  const [[p]] = await pool.query("SELECT id, conector_id FROM onl_pedidos WHERE id = ? AND origen = 'plataforma'", [pedidoId]);
  if (!p || !AVISABLES.includes(estado)) return;
  const c = await fila(p.conector_id);
  const [r] = await pool.query('INSERT INTO onl_conector_eventos (conector_id, pedido_id, evento, ts_ms) VALUES (?, ?, ?, ?)', [c.id, pedidoId, estado, Date.now()]);
  if (transporte) await enviarEvento(r.insertId);
  if (estado === 'entregado') await entregarComision(pedidoId);
};
const enviarEvento = async (id) => {
  const [[e]] = await pool.query("SELECT e.*, c.codigo, p.id_externo FROM onl_conector_eventos e JOIN onl_conectores c ON c.id = e.conector_id JOIN onl_pedidos p ON p.id = e.pedido_id WHERE e.id = ? AND e.estado <> 'enviado'", [id]);
  if (!e) return;
  try { await transporte('estado', e.codigo, { id_externo: e.id_externo, estado: e.evento }); await pool.query("UPDATE onl_conector_eventos SET estado = 'enviado', intentos = intentos + 1, error = NULL WHERE id = ?", [id]); } catch (err) {
    await pool.query("UPDATE onl_conector_eventos SET estado = 'fallido', intentos = intentos + 1, error = ? WHERE id = ?", [String(err.message).slice(0, 255), id]);
    await pool.query("UPDATE onl_conectores SET conexion = 'desconectado' WHERE id = ?", [e.conector_id]);
  }
};
const reintentarEventos = async () => {
  if (!transporte) return { enviados: 0, pendientes: 0 };
  const [ids] = await pool.query("SELECT id FROM onl_conector_eventos WHERE estado <> 'enviado' ORDER BY id LIMIT 200");
  let enviados = 0;
  for (const { id } of ids) { await enviarEvento(id); enviados += (await pool.query("SELECT estado FROM onl_conector_eventos WHERE id = ?", [id]))[0][0].estado === 'enviado' ? 1 : 0; }
  if (enviados) await pool.query("UPDATE onl_conectores SET conexion = 'conectado'");
  return { enviados, pendientes: ids.length - enviados };
};
// La comisión de cada pedido entregado va a Financiero (idempotente por el pedido, RN28). Sin Financiero queda el informe de estimadas.
const entregarComision = async (pedidoId) => {
  if (!(await Modulos.estaInstalado('financiero'))) return false;
  const [[p]] = await pool.query('SELECT p.*, c.codigo AS conector FROM onl_pedidos p JOIN onl_conectores c ON c.id = p.conector_id WHERE p.id = ?', [pedidoId]);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await Mensajeria.publicar(conn, { origen: 'ventas_online', destino: 'financiero', tipo: 'comision_plataforma', docTipo: 'pedido_plataforma', docIdGlobal: p.id_global,
      contenido: { plataforma: p.conector, pedido_global: p.id_global, id_externo: p.id_externo, bruto: Number(p.total), comision: Number(p.comision), fecha: new Date().toISOString().slice(0, 10) } });
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  Mensajeria.despertar();
  return true;
};
// La liquidación que recibió la plataforma se entrega a Financiero, que la concilia con los pedidos entregados del período (EX18).
const enviarLiquidacion = async (codigo, d) => {
  await exigir();
  if (!(await Modulos.estaInstalado('financiero'))) throw invalida('Sin Financiero solo hay un informe de comisiones estimadas.', 409, { codigo: 'SIN_FINANCIERO' });
  const c = await fila(codigo);
  if (!d.id_liquidacion || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.desde)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.hasta)) || !(Number(d.bruto) > 0)) throw invalida('Indicá el ID de la liquidación, el período y el bruto.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await Mensajeria.publicar(conn, { origen: 'ventas_online', destino: 'financiero', tipo: 'liquidacion_plataforma', docTipo: 'liquidacion', docIdGlobal: `${c.codigo}:${d.id_liquidacion}`,
      contenido: { id_liquidacion: `${c.codigo}:${d.id_liquidacion}`, plataforma: c.codigo, desde: d.desde, hasta: d.hasta, bruto: r2(d.bruto), comision: r2(d.comision ?? 0), neto: r2(d.neto ?? Number(d.bruto) - Number(d.comision ?? 0)) } });
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  Mensajeria.despertar();
  return { enviada: true };
};
// Sin Financiero: solo la comisión estimada por pedido y plataforma.
const comisionesEstimadas = async ({ desde, hasta } = {}) => {
  const w = ["p.origen = 'plataforma'", "p.estado NOT IN ('cancelado', 'pendiente_aceptacion', 'pendiente_vinculacion')"], par = [];
  if (desde) { w.push('p.created_ms >= ?'); par.push(new Date(`${desde}T00:00:00`).getTime()); }
  if (hasta) { w.push('p.created_ms <= ?'); par.push(new Date(`${hasta}T23:59:59`).getTime()); }
  return (await pool.query(`SELECT c.codigo AS plataforma, COUNT(*) AS pedidos, SUM(p.total) AS bruto, SUM(p.comision) AS comision FROM onl_pedidos p JOIN onl_conectores c ON c.id = p.conector_id WHERE ${w.join(' AND ')} GROUP BY c.codigo`, par))[0]
    .map((x) => ({ ...x, pedidos: Number(x.pedidos), bruto: Number(x.bruto), comision: Number(x.comision) }));
};

Eventos.suscribirEstado(async (id, estado) => { await informarEstado(id, estado).catch(() => {}); }, 20);
void Tienda;

module.exports = { usarTransporte, crear, listar, editar, pausar, vincularArticulo, articulos, menu, publicar, recibirPedido, aceptar, rechazar, vincularPedido, alertarSinAceptar, reintentarEventos, enviarLiquidacion, comisionesEstimadas, entregarComision };
