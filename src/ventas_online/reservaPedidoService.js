const pool = require('../config/db');
const puertos = require('../modulos/puertos');
const llamar = require('../modulos/llamar');
const { idGlobal } = require('../utils/idGlobal');

// Reserva de stock de un pedido online (Ventas Online RN07, RN45, EX27 a EX30). Se pide ANTES del cobro, por todos los ítems que controlan stock y todo o nada, con la vigencia de la tienda
// (15 minutos por defecto) y una espera máxima de 5 segundos (llamada n.º 7). Cada intento lleva su propia clave de solicitud; un intento nuevo reemplaza al anterior en una sola operación.
// Si Stock no está instalado no hay reserva; si no responde, el pedido se acepta contra la disponibilidad publicada y la reserva queda pendiente de confirmación.
const MAX_RENOVACIONES = 3;
const config = async () => (await pool.query('SELECT vigencia_reserva_min, timeout_reserva_segundos FROM onl_tienda WHERE id = 1'))[0][0];
const items = (lineas) => lineas.map((l) => ({ producto_id: l.producto_id, cantidad: Number(l.cantidad) }));

// -> { estado: 'confirmada' | 'pendiente' | 'no_aplica' | 'rechazada', id, vence_ms, sin_disponible? }
// Un elaborado que se produce al venderse (modo de producción «venta») no se reserva: sus insumos se consumen al vender y la disponibilidad que se publica ya sale de ellos (Ventas Online RN07).
const sinElaboradosEnVenta = async (lineas) => {
  const ids = [...new Set(lineas.map((l) => l.producto_id))];
  if (!ids.length) return lineas;
  const [prod] = await pool.query("SELECT id FROM productos WHERE id IN (?) AND tipo = 'elaborado' AND modo_produccion = 'venta'", [ids]);
  const fuera = new Set(prod.map((x) => x.id));
  return lineas.filter((l) => !fuera.has(l.producto_id));
};

const reservar = async ({ lineas: todas, solicitud, reemplazaA = null }) => {
  const c = await config();
  const lineas = await sinElaboradosEnVenta(todas);
  const r = await llamar(7, 'ventas_online', async () => (await puertos.obtener('stock')).comprometer(items(lineas), { idSolicitud: solicitud, reemplazaA, vigenciaMs: c.vigencia_reserva_min * 60000 }), { esperaMs: c.timeout_reserva_segundos * 1000 });
  if (r.fallo) return /no instalado/.test(r.motivo ?? '') ? { estado: 'no_aplica' } : { estado: 'pendiente', motivo: r.motivo };
  const v = r.valor;
  if (v.ok === false) return { estado: 'rechazada', sin_disponible: v.sin_disponible ?? [], lote_no_disponible: v.lote_no_disponible, serie_no_disponible: v.serie_no_disponible };
  if (!v.id_compromiso) return { estado: 'no_aplica' }; // ningún ítem controla stock
  return { estado: 'confirmada', id: v.id_compromiso, vence_ms: Number(v.vence_ms) };
};

// Pedidos que reservan stock sin pago aprobado (transferencia con confirmación manual, pago al retirar, efectivo contra entrega): por artículo no pueden reservar más que un porcentaje del disponible
// (parámetro `online_reserva_sin_pago_pct`, 30 % por defecto), sumando las reservas sin pago vigentes (Ventas Online RN56). Sin Stock no hay reserva ni tope.
const SIN_PAGO = ['transferencia', 'pago_al_retirar', 'efectivo_contra_entrega'];
const excedeTopeSinPago = async (todas, { excluirPedido = null } = {}) => {
  const lineas = await sinElaboradosEnVenta(todas);
  let puerto;
  try { puerto = await puertos.obtener('stock'); } catch { return null; }
  if (!puerto?.disponibleUnidades) return null;
  const pct = Number((await pool.query("SELECT valor FROM parametros WHERE clave = 'online_reserva_sin_pago_pct'"))[0][0]?.valor ?? 30);
  if (!(pct > 0 && pct < 100)) return null;
  const pedidos = new Map();
  for (const l of lineas) pedidos.set(l.producto_id, (pedidos.get(l.producto_id) ?? 0) + Number(l.cantidad));
  const exceden = [];
  for (const [productoId, cantidad] of pedidos) {
    const disp = await puerto.disponibleUnidades(productoId).catch(() => null);
    if (!disp || disp.cantidad === null || disp.cantidad === undefined) continue; // no controla stock
    const [[{ vigente }]] = await pool.query(`SELECT COALESCE(SUM(l.cantidad), 0) AS vigente FROM onl_pedido_lineas l JOIN onl_pedidos p ON p.id = l.pedido_id
      WHERE l.producto_id = ? AND p.reserva_estado = 'confirmada' AND p.medio_pago IN (?) AND p.pagado_ms IS NULL AND p.estado NOT IN ('cancelado', 'entregado') ${excluirPedido ? 'AND p.id <> ?' : ''}`,
    excluirPedido ? [productoId, SIN_PAGO, excluirPedido] : [productoId, SIN_PAGO]);
    const base = Number(disp.cantidad) + Number(vigente); // lo que había antes de las reservas sin pago
    const tope = Math.floor(base * pct / 100);
    if (Number(vigente) + cantidad > tope) exceden.push({ producto_id: productoId, pedido: cantidad, reservado_sin_pago: Number(vigente), tope, porcentaje: pct });
  }
  return exceden.length ? exceden : null;
};

const liberar = async (id) => { if (id) await llamar(7, 'ventas_online', async () => (await puertos.obtener('stock')).liberarCompromiso(id)).catch(() => {}); };

// Mientras el cliente sigue en el checkout se renueva la misma reserva, hasta 3 veces (RN07).
const renovar = async (pedido) => {
  if (!pedido.reserva_id || pedido.reserva_estado !== 'confirmada') return null;
  if (pedido.reserva_renovaciones >= MAX_RENOVACIONES) return { renovada: false, motivo: 'RENOVACIONES_AGOTADAS' };
  const c = await config();
  const r = await llamar(7, 'ventas_online', async () => (await puertos.obtener('stock')).renovarCompromiso(pedido.reserva_id, c.vigencia_reserva_min * 60000));
  if (r.fallo) return { renovada: false, motivo: r.motivo };
  await pool.query('UPDATE onl_pedidos SET reserva_vence_ms = ?, reserva_renovaciones = reserva_renovaciones + 1, updated_ms = ? WHERE id = ?', [Number(r.valor.vence_ms), Date.now(), pedido.id]);
  return { renovada: true, vence_ms: Number(r.valor.vence_ms) };
};

// Un intento nuevo (el carrito cambió o la reserva venció): clave nueva y reemplazo de la anterior.
const reintentar = async (pedido, lineas) => {
  const intento = pedido.reserva_intento + 1;
  const r = await reservar({ lineas, solicitud: `${pedido.id_global}:reserva:${intento}`, reemplazaA: pedido.reserva_estado === 'confirmada' ? pedido.reserva_id : null });
  await pool.query('UPDATE onl_pedidos SET reserva_intento = ?, reserva_id = ?, reserva_estado = ?, reserva_vence_ms = ?, reserva_renovaciones = 0, updated_ms = ? WHERE id = ?',
    [intento, r.id ?? null, r.estado === 'rechazada' ? 'vencida' : r.estado, r.vence_ms ?? null, Date.now(), pedido.id]);
  return r;
};

// La reserva vence sola en Stock; acá se marca el pedido para que la tienda lo sepa (EX28).
const marcarVencidas = async () => {
  const [r] = await pool.query("UPDATE onl_pedidos SET reserva_estado = 'vencida', updated_ms = ? WHERE reserva_estado = 'confirmada' AND reserva_vence_ms < ? AND estado IN ('pendiente_pago')", [Date.now(), Date.now()]);
  return r.affectedRows;
};

// RN45: cuando Stock vuelve a responder se piden las reservas pendientes, la más antigua primero; cada una es idempotente por su clave.
const confirmarPendientes = async () => {
  const [pend] = await pool.query("SELECT * FROM onl_pedidos WHERE reserva_estado = 'pendiente' AND estado NOT IN ('cancelado', 'entregado') ORDER BY created_ms, id");
  const salida = { confirmadas: 0, rechazadas: 0, sin_respuesta: 0 };
  for (const p of pend) {
    const [lineas] = await pool.query('SELECT producto_id, cantidad FROM onl_pedido_lineas WHERE pedido_id = ?', [p.id]);
    const r = await reservar({ lineas, solicitud: `${p.id_global}:reserva:${p.reserva_intento}` });
    if (r.estado === 'pendiente') { salida.sin_respuesta++; break; } // Stock sigue sin responder
    if (r.estado === 'rechazada') {
      salida.rechazadas++;
      await pool.query("UPDATE onl_pedidos SET reserva_estado = 'rechazada', estado = IF(estado IN ('pagado', 'reserva_pendiente'), 'con_faltante', estado), updated_ms = ? WHERE id = ?", [Date.now(), p.id]);
      await pool.query('INSERT INTO onl_pedido_historial (pedido_id, estado, detalle, ts_ms) VALUES (?, ?, ?, ?)', [p.id, 'reserva_rechazada', 'Stock no pudo confirmar la reserva', Date.now()]);
    } else {
      salida.confirmadas++;
      await pool.query("UPDATE onl_pedidos SET reserva_estado = ?, reserva_id = ?, reserva_vence_ms = ?, estado = IF(estado = 'reserva_pendiente', 'pagado', estado), pagado_ms = IF(estado = 'reserva_pendiente', ?, pagado_ms), updated_ms = ? WHERE id = ?", [r.estado, r.id ?? null, r.vence_ms ?? null, Date.now(), Date.now(), p.id]);
      if (p.estado === 'reserva_pendiente') await require('./eventos').pagado(p.id); // con la reserva confirmada recién ahora pasa a Ventas y a la comanda (RN45)
    }
  }
  return salida;
};

module.exports = { SIN_PAGO, excedeTopeSinPago, reservar, liberar, renovar, reintentar, marcarVencidas, confirmarPendientes, MAX_RENOVACIONES, idGlobal };
