const pool = require('../config/db');
const Comandas = require('./comandaService');
const Notificacion = require('../models/notificacionModel');
const { auditar } = require('../utils/auditar');

// Pantalla de cocina y barra (Ventas RF38, RN35, RN36, EX25, EX27), con VEN-KDS. Muestra las comandas por sector aunque no estén
// impresas (y la impresión sigue saliendo de la misma comanda), con su avance Pendiente → En preparación → Listo → Entregado, la hora de
// cada cambio, el tiempo transcurrido y la alerta de demora. Retroceder exige permiso y motivo. También marca agotados a mano.
class CocinaInvalida extends Error {}
const invalida = (m, status = 400) => Object.assign(new CocinaInvalida(m), { status });

const AVANCES = ['pendiente', 'en_preparacion', 'listo', 'entregado'];
const param = async (clave, defecto) => (await pool.query('SELECT valor FROM parametros WHERE clave = ?', [clave]))[0][0]?.valor ?? defecto;

// Comandas de la pantalla: las no anuladas que no se entregaron (o todas con `avance`), con tiempos y demora.
const comandas = async ({ sector_id, avance } = {}) => {
  const demora = Number(await param('kds_demora_min', 10));
  const donde = ["c.estado = 'emitida'"];
  const params = [];
  if (sector_id !== undefined) { donde.push(sector_id === 'sin' ? 'c.sector_id IS NULL' : 'c.sector_id = ?'); if (sector_id !== 'sin') params.push(Number(sector_id)); }
  if (avance) { if (!AVANCES.includes(avance)) throw invalida(`El avance debe ser uno de: ${AVANCES.join(', ')}.`); donde.push('c.avance = ?'); params.push(avance); } else donde.push("c.avance <> 'entregado'");
  const [filas] = await pool.query(`SELECT c.id, TIMESTAMPDIFF(SECOND, c.created_at, NOW()) AS seg FROM comandas c WHERE ${donde.join(' AND ')} ORDER BY c.created_at, c.id LIMIT 200`, params);
  const salida = [];
  for (const f of filas) {
    const c = await Comandas.obtener(f.id);
    const [av] = await pool.query('SELECT hasta, retroceso, created_at FROM comanda_avances WHERE comanda_id = ? ORDER BY id', [f.id]);
    const hora = (a) => av.filter((x) => x.hasta === a && !x.retroceso).pop()?.created_at ?? null;
    const minutos = Math.floor(Number(f.seg) / 60);
    salida.push({ ...c, minutos, demorada: c.avance !== 'listo' && c.avance !== 'entregado' && minutos >= demora,
      horas: { ingreso: c.created_at, en_preparacion: hora('en_preparacion'), listo: hora('listo'), entregado: hora('entregado') } });
  }
  return salida;
};

const cambiar = async (id, hasta, { userId, retroceso = false, motivo = null } = {}) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[c]] = await conn.query('SELECT id, avance, estado FROM comandas WHERE id = ? FOR UPDATE', [id]);
    if (!c) throw invalida('Comanda no encontrada.', 404);
    if (c.estado === 'anulada') throw invalida('La comanda está anulada.', 409);
    await conn.query('UPDATE comandas SET avance = ? WHERE id = ?', [hasta, id]);
    await conn.query('INSERT INTO comanda_avances (comanda_id, desde, hasta, retroceso, motivo, user_id) VALUES (?, ?, ?, ?, ?, ?)', [id, c.avance, hasta, retroceso ? 1 : 0, motivo, userId ?? null]);
    await conn.commit();
    return { id, desde: c.avance, hasta };
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

// Avanza un estado (en orden, sin saltos).
const avanzar = async (id, { userId } = {}) => {
  const [[c]] = await pool.query('SELECT avance FROM comandas WHERE id = ?', [id]);
  if (!c) throw invalida('Comanda no encontrada.', 404);
  const i = AVANCES.indexOf(c.avance);
  if (i === AVANCES.length - 1) throw invalida('La comanda ya está entregada.', 409);
  return cambiar(id, AVANCES[i + 1], { userId });
};

// Retroceder un estado exige permiso (lo valida la ruta) y motivo, y queda registrado (RN35).
const retroceder = async (id, motivo, { userId } = {}, req = null) => {
  if (typeof motivo !== 'string' || !motivo.trim()) throw invalida('El motivo es obligatorio para retroceder un estado.');
  const [[c]] = await pool.query('SELECT avance, id_global FROM comandas WHERE id = ?', [id]);
  if (!c) throw invalida('Comanda no encontrada.', 404);
  const i = AVANCES.indexOf(c.avance);
  if (i === 0) throw invalida('La comanda está en el primer estado.', 409);
  const r = await cambiar(id, AVANCES[i - 1], { userId, retroceso: true, motivo: motivo.trim().slice(0, 255) });
  await auditar(req, { modulo: 'ventas', accion: 'comanda_retroceso', entidad: 'comanda', entidad_id: c.id_global, detalle: `${r.desde} → ${r.hasta}: ${motivo.trim()}` });
  return r;
};

// Tiempos de preparación por sector en un período: del ingreso a "listo", en minutos.
const tiempos = async ({ desde, hasta } = {}) => (await pool.query(
  `SELECT COALESCE(s.nombre, 'Sin sector') AS sector, COUNT(*) AS comandas, ROUND(AVG(TIMESTAMPDIFF(SECOND, c.created_at, a.created_at)) / 60, 1) AS minutos_promedio
   FROM comandas c LEFT JOIN sectores_comanda s ON s.id = c.sector_id
   JOIN comanda_avances a ON a.comanda_id = c.id AND a.hasta = 'listo' AND a.retroceso = 0
   WHERE c.created_at >= ? AND c.created_at <= ? GROUP BY s.nombre ORDER BY s.nombre`,
  [desde ? `${desde} 00:00:00` : '1970-01-01', hasta ? `${hasta} 23:59:59` : '2999-12-31']))[0].map((r) => ({ ...r, comandas: Number(r.comandas), minutos_promedio: Number(r.minutos_promedio) }));

// ---- Pantallas (EX25): el latido de cada pantalla dice si está conectada; la comanda queda en cola y la lista no duplica ----

const latido = async (terminalId) => {
  const [r] = await pool.query("UPDATE terminales SET ultimo_contacto = NOW() WHERE id = ? AND tipo = 'pantalla_cocina'", [terminalId]);
  if (!r.affectedRows) throw invalida('La terminal no es una pantalla de cocina.', 404);
  return { ok: true };
};
const pantallas = async () => {
  const limite = Number(await param('kds_sin_contacto_seg', 60));
  return (await pool.query("SELECT id, nombre, activa, ultimo_contacto, ultimo_contacto IS NOT NULL AND TIMESTAMPDIFF(SECOND, ultimo_contacto, NOW()) <= ? AS conectada FROM terminales WHERE tipo = 'pantalla_cocina' ORDER BY nombre", [limite]))[0]
    .map((p) => ({ ...p, activa: !!p.activa, conectada: !!p.conectada }));
};

// ---- Agotados manuales (RN35, RN36, EX27) ----

// Marca o quita el agotado manual de un artículo. Al marcarlo, avisa por los pedidos abiertos que lo tienen sin enviar para ofrecer alternativa;
// lo ya enviado a producción no se anula (EX27). El que puso Stock lo revierte Stock solo (RN36).
const marcarAgotado = async (productoId, agotado, req = null) => {
  const [[p]] = await pool.query('SELECT id, nombre, agotado FROM productos WHERE id = ?', [productoId]);
  if (!p) throw invalida('Artículo no encontrado.', 404);
  await pool.query('UPDATE productos SET agotado = ? WHERE id = ?', [agotado ? 1 : 0, productoId]);
  await auditar(req, { modulo: 'ventas', accion: agotado ? 'agotado_marcar' : 'agotado_quitar', entidad: 'producto', entidad_id: String(productoId), detalle: p.nombre });
  let avisos = 0;
  if (agotado && !p.agotado) {
    const [abiertos] = await pool.query(
      `SELECT DISTINCT ped.id, m.numero_mesa, u.username AS mozo FROM pedido_productos pp JOIN pedidos ped ON ped.id = pp.pedido_id JOIN mesas m ON m.id = ped.mesa_id
       LEFT JOIN users u ON u.id = ped.mozo_id WHERE pp.producto_id = ? AND ped.estado = 'activo' AND pp.enviado_at IS NULL`, [productoId]);
    for (const a of abiertos) {
      await Notificacion.crear({ modulo: 'ventas', tipo: 'agotado_en_pedido', severidad: 'media', roles: ['mozo', 'encargado', 'gerente'], clave: `agotado:${productoId}:${a.id}`,
        mensaje: `"${p.nombre}" se agotó y está en el pedido ${a.id}${a.numero_mesa ? ` (mesa ${a.numero_mesa})` : ''}${a.mozo ? ` de ${a.mozo}` : ''}: ofrecé una alternativa.` });
      avisos++;
    }
  }
  return { producto_id: productoId, agotado: !!agotado, pedidos_avisados: avisos };
};

const configurar = async ({ demora_min, agotado_modo }) => {
  if (demora_min !== undefined) {
    if (!Number.isInteger(demora_min) || demora_min < 1) throw invalida('La demora es un entero de minutos, 1 o más.');
    await pool.query("INSERT INTO parametros (clave, valor) VALUES ('kds_demora_min', ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)", [String(demora_min)]);
  }
  if (agotado_modo !== undefined) {
    if (!['bloquear', 'advertir'].includes(agotado_modo)) throw invalida('El modo debe ser "bloquear" o "advertir".');
    await pool.query("INSERT INTO parametros (clave, valor) VALUES ('agotado_modo', ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)", [agotado_modo]);
  }
  return { demora_min: Number(await param('kds_demora_min', 10)), agotado_modo: await param('agotado_modo', 'bloquear') };
};

module.exports = { CocinaInvalida, AVANCES, comandas, avanzar, retroceder, tiempos, latido, pantallas, marcarAgotado, configurar, modoAgotado: () => param('agotado_modo', 'bloquear') };
