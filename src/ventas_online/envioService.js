const pool = require('../config/db');
const Tienda = require('./tiendaService');

// Entrega del pedido (Ventas Online RF11, RF26, RN37): retiro en barra o de vitrina y delivery propio por zonas. Se pide «lo antes posible» o para una hora programada dentro del horario de toma
// de pedidos y hasta N días adelante; cada franja de 15 minutos tiene una capacidad máxima de pedidos de elaborados. El tiempo estimado es el mayor tiempo de preparación de los ítems más una
// demora por carga. Los transportistas no están integrados (ONL-ENVIOS-TRANSPORTISTA queda apagada): solo retiro y delivery propio.
const invalida = (m, status = 400, extra = {}) => Object.assign(new Tienda.TiendaInvalida(m), { status, ...extra });
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const FRANJA_MS = 15 * 60000;
const dia = (d) => d.toISOString().slice(0, 10);

const zonaVista = (z) => ({ id: z.id, nombre: z.nombre, codigos_postales: JSON.parse(z.codigos_postales), costo: Number(z.costo), plazo_min: z.plazo_min, minimo_compra: Number(z.minimo_compra), gratis_desde: z.gratis_desde === null ? null : Number(z.gratis_desde), activa: !!z.activa });

// ---- Zonas ----

const validarZona = (d) => {
  if (typeof d.nombre !== 'string' || !d.nombre.trim() || d.nombre.length > 80) throw invalida('El nombre de la zona es obligatorio (hasta 80 caracteres).');
  const cps = [...new Set((d.codigos_postales ?? []).map((c) => String(c).trim().toUpperCase()))];
  if (!cps.length || cps.some((c) => !/^[A-Z0-9]{4,8}$/.test(c))) throw invalida('Indicá los códigos postales de la zona (4 a 8 letras o números).');
  const costo = Number(d.costo ?? 0), minimo = Number(d.minimo_compra ?? 0), plazo = d.plazo_min === undefined ? 60 : d.plazo_min;
  if (!(costo >= 0) || !(minimo >= 0)) throw invalida('El costo y el mínimo de compra no pueden ser negativos.');
  if (!Number.isInteger(plazo) || plazo < 0 || plazo > 1440) throw invalida('El plazo es un entero de minutos entre 0 y 1440.');
  if (d.gratis_desde !== undefined && d.gratis_desde !== null && !(Number(d.gratis_desde) >= 0)) throw invalida('El envío gratis desde un monto no negativo.');
  return { nombre: d.nombre.trim(), cps, costo, minimo, plazo, gratis: d.gratis_desde ?? null };
};
const zonas = async () => (await pool.query('SELECT * FROM onl_zonas ORDER BY nombre'))[0].map(zonaVista);
const guardarZona = async (id, d) => {
  const v = validarZona(d);
  for (const z of await zonas()) if (z.id !== id && z.activa && z.codigos_postales.some((c) => v.cps.includes(c))) throw invalida(`El código postal ya está en la zona "${z.nombre}".`, 409, { codigo: 'CP_EN_OTRA_ZONA' });
  try {
    if (id) {
      const [r] = await pool.query('UPDATE onl_zonas SET nombre = ?, codigos_postales = ?, costo = ?, plazo_min = ?, minimo_compra = ?, gratis_desde = ?, activa = ? WHERE id = ?', [v.nombre, JSON.stringify(v.cps), v.costo, v.plazo, v.minimo, v.gratis, d.activa === false ? 0 : 1, id]);
      if (!r.affectedRows) throw invalida('Zona no encontrada.', 404);
      return (await zonas()).find((z) => z.id === id);
    }
    const [r] = await pool.query('INSERT INTO onl_zonas (nombre, codigos_postales, costo, plazo_min, minimo_compra, gratis_desde) VALUES (?, ?, ?, ?, ?, ?)', [v.nombre, JSON.stringify(v.cps), v.costo, v.plazo, v.minimo, v.gratis]);
    return (await zonas()).find((z) => z.id === r.insertId);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida('Ya hay una zona con ese nombre.', 409);
    throw err;
  }
};
const configurar = async (d) => {
  const campos = {};
  for (const [k, min, max] of [['capacidad_franja', 1, 500], ['anticipacion_max_dias', 1, 60], ['demora_carga_min', 0, 240]]) {
    if (d[k] === undefined) continue;
    if (!Number.isInteger(d[k]) || d[k] < min || d[k] > max) throw invalida(`${k} es un entero entre ${min} y ${max}.`);
    campos[k] = d[k];
  }
  const claves = Object.keys(campos);
  if (claves.length) await pool.query(`UPDATE onl_tienda SET ${claves.map((k) => `${k} = ?`).join(', ')} WHERE id = 1`, claves.map((k) => campos[k]));
  const [[t]] = await pool.query('SELECT capacidad_franja, anticipacion_max_dias, demora_carga_min FROM onl_tienda WHERE id = 1');
  return t;
};
const fijarPreparacion = async (productoId, minutos) => {
  if (!Number.isInteger(minutos) || minutos < 0 || minutos > 480) throw invalida('El tiempo de preparación es un entero de minutos entre 0 y 480.');
  const [r] = await pool.query('UPDATE onl_publicados SET prep_min = ? WHERE producto_id = ?', [minutos, productoId]);
  if (!r.affectedRows) throw invalida('El artículo no está publicado.', 404);
  return { producto_id: productoId, prep_min: minutos };
};

// ---- Tiempos y franjas ----

const tiempoEstimado = async (lineas) => {
  if (!lineas?.length) return 0;
  const [filas] = await pool.query('SELECT MAX(prep_min) AS m FROM onl_publicados WHERE producto_id IN (?)', [lineas.map((l) => l.producto_id)]);
  const [[t]] = await pool.query('SELECT demora_carga_min FROM onl_tienda WHERE id = 1');
  const m = Number(filas[0].m ?? 0);
  return m > 0 ? m + t.demora_carga_min : 0; // el retiro de vitrina no tiene preparación
};
const ocupadas = async (franja) => Number((await pool.query("SELECT COUNT(*) AS n FROM onl_pedidos WHERE estado <> 'cancelado' AND tiempo_estimado_min > 0 AND programado_ms >= ? AND programado_ms < ?", [franja * FRANJA_MS, (franja + 1) * FRANJA_MS]))[0][0].n);

// Franjas de 15 minutos de un día con cupo: dentro del horario de toma de pedidos, a partir de ahora más el tiempo estimado.
const franjas = async ({ fecha, lineas = [], ahora = new Date() }) => {
  const [[t]] = await pool.query('SELECT horarios, capacidad_franja, anticipacion_max_dias FROM onl_tienda WHERE id = 1');
  const horarios = t.horarios ? JSON.parse(t.horarios) : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) throw invalida('La fecha va como AAAA-MM-DD.');
  const inicioDia = new Date(`${fecha}T00:00:00`);
  if (Number.isNaN(inicioDia.getTime())) throw invalida('La fecha no es válida.');
  const limite = new Date(ahora.getTime() + t.anticipacion_max_dias * 86400000);
  if (inicioDia > limite) throw invalida(`Se pide hasta ${t.anticipacion_max_dias} días adelante.`, 409, { codigo: 'FUERA_DE_PLAZO' });
  const minimo = ahora.getTime() + (await tiempoEstimado(lineas)) * 60000;
  const salida = [];
  for (let ms = inicioDia.getTime(); ms < inicioDia.getTime() + 86400000; ms += FRANJA_MS) {
    if (ms < minimo || !Tienda.abiertaAhora(horarios, new Date(ms))) continue;
    if (horarios && Object.keys(horarios).length === 0) continue;
    const usadas = await ocupadas(Math.floor(ms / FRANJA_MS));
    if (usadas < t.capacidad_franja) salida.push({ desde_ms: ms, hora: `${String(new Date(ms).getHours()).padStart(2, '0')}:${String(new Date(ms).getMinutes()).padStart(2, '0')}`, cupo: t.capacidad_franja - usadas });
  }
  return salida;
};

// ---- Cotización ----

// -> { tipo, costo, gratis, datos, programado_ms, tiempo_estimado_min }
const cotizar = async ({ entrega = { tipo: 'retiro' }, subtotal, lineas = [], ahora = new Date() }) => {
  const tipo = entrega.tipo ?? 'retiro';
  if (!['retiro', 'delivery'].includes(tipo)) throw invalida('La entrega es retiro o delivery.', 409, { codigo: 'ENTREGA_NO_DISPONIBLE' });
  const [[t]] = await pool.query('SELECT horarios, capacidad_franja, anticipacion_max_dias FROM onl_tienda WHERE id = 1');
  const horarios = t.horarios ? JSON.parse(t.horarios) : null;
  const estimado = await tiempoEstimado(lineas);
  const conPreparacion = estimado > 0;
  // Cuándo: lo antes posible o una hora programada (RN37).
  let programado = null;
  if (entrega.programado) {
    programado = new Date(entrega.programado);
    if (Number.isNaN(programado.getTime())) throw invalida('La hora programada no es válida.');
    if (programado.getTime() % FRANJA_MS !== 0) throw invalida('La hora programada va en franjas de 15 minutos.');
    if (programado.getTime() < ahora.getTime() + estimado * 60000) throw invalida(`El pedido necesita al menos ${estimado} minutos de preparación.`, 409, { codigo: 'FRANJA_PASADA' });
    if (programado.getTime() > ahora.getTime() + t.anticipacion_max_dias * 86400000) throw invalida(`Se pide hasta ${t.anticipacion_max_dias} días adelante.`, 409, { codigo: 'FUERA_DE_PLAZO' });
    if (!Tienda.abiertaAhora(horarios, programado)) throw invalida('Esa hora está fuera del horario de toma de pedidos.', 409, { codigo: 'FUERA_DE_HORARIO' });
  } else if (conPreparacion && !Tienda.abiertaAhora(horarios, ahora)) throw invalida('Fuera del horario no se toman pedidos de elaborados: programá uno para cuando abramos.', 409, { codigo: 'FUERA_DE_HORARIO' });
  const cuando = programado ?? new Date(Math.ceil((ahora.getTime() + estimado * 60000) / FRANJA_MS) * FRANJA_MS);
  if (conPreparacion && (await ocupadas(Math.floor(cuando.getTime() / FRANJA_MS))) >= t.capacidad_franja) throw invalida('Esa franja alcanzó su capacidad: elegí otra hora.', 409, { codigo: 'FRANJA_COMPLETA' });
  const base = { tipo, programado_ms: programado ? programado.getTime() : cuando.getTime(), tiempo_estimado_min: estimado, datos: { modalidad: entrega.modalidad ?? 'barra', lo_antes_posible: !programado } };
  if (tipo === 'retiro') return { ...base, costo: 0, gratis: false, datos: { ...base.datos, modalidad: ['barra', 'vitrina'].includes(entrega.modalidad) ? entrega.modalidad : 'barra' } };
  // Delivery propio: la zona sale del código postal.
  const cp = String(entrega.codigo_postal ?? '').trim().toUpperCase();
  const zona = (await zonas()).find((z) => z.activa && z.codigos_postales.includes(cp));
  if (!cp || !entrega.calle) throw invalida('Para el delivery indicá la calle y el código postal.');
  if (!zona) throw invalida('No llegamos a ese código postal: elegí retiro.', 409, { codigo: 'FUERA_DE_ZONA' });
  if (subtotal < zona.minimo_compra) throw invalida(`La zona "${zona.nombre}" pide una compra mínima de ${zona.minimo_compra}.`, 409, { codigo: 'MINIMO_ZONA', minimo: zona.minimo_compra });
  const gratis = zona.gratis_desde !== null && subtotal >= zona.gratis_desde;
  return { ...base, costo: gratis ? 0 : zona.costo, gratis, zona_id: zona.id, tiempo_estimado_min: estimado + zona.plazo_min,
    datos: { ...base.datos, zona: zona.nombre, plazo_min: zona.plazo_min, calle: String(entrega.calle).slice(0, 150), localidad: String(entrega.localidad ?? '').slice(0, 80), codigo_postal: cp, referencia: String(entrega.referencia ?? '').slice(0, 150) } };
};

// ---- Despacho ----

// Un envío no sale sin pago acreditado (RF11, RN37): el delivery se despacha y entrega por un usuario con permiso.
const despachar = async (id, { userId } = {}) => {
  const [[p]] = await pool.query('SELECT * FROM onl_pedidos WHERE id = ?', [id]);
  if (!p) throw invalida('Pedido no encontrado.', 404);
  if (p.entrega_tipo !== 'delivery') throw invalida('Solo el delivery se despacha: el retiro se entrega en barra.', 409);
  if (!p.pagado_ms || !['pagado', 'en_preparacion', 'listo'].includes(p.estado)) throw invalida(p.pagado_ms ? `El pedido está ${p.estado}.` : 'El pedido no tiene el pago acreditado: no se despacha.', 409, { codigo: 'PEDIDO_NO_PAGADO' });
  await pool.query("UPDATE onl_pedidos SET estado = 'despachado', updated_ms = ? WHERE id = ?", [Date.now(), id]);
  await pool.query('INSERT INTO onl_pedido_historial (pedido_id, estado, detalle, user_id, ts_ms) VALUES (?, ?, ?, ?, ?)', [id, 'despachado', 'Salió el delivery', userId ?? null, Date.now()]);
  return { id, estado: 'despachado' };
};

module.exports = { zonas, guardarZona, configurar, fijarPreparacion, tiempoEstimado, franjas, cotizar, despachar, r2, dia };
