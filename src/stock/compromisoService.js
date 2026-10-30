const pool = require('../config/db');
const R = require('../reservas/servicio');
const Deposito = require('../models/depositoModel');
const Receta = require('./recetaService');
const Lotes = require('./loteService');
const { idGlobal } = require('../utils/idGlobal');

// Compromiso de venta, "última unidad" (Stock RF36, RN59, RN60; Ventas RN63). Ventas pide, antes de confirmar, un
// compromiso por la línea vendida; Stock la expande, y compromete de forma atómica —todo o nada— cada ítem que NO permite
// stock negativo en su depósito, bajo el candado por recurso de las reservas. Vence a los 2 minutos si la venta no se
// confirma. Disponible = físico − comprometido.
const recursoDe = (tipo, id, deposito) => `${tipo}:${id}:${deposito}`;

const fisico = async (conn, tipo, id, deposito) => {
  // Con control de lote solo cuenta lo utilizable: nada de lo bloqueado ni de lo vencido que el ítem no admite.
  if (await Lotes.controla(conn, { tipo, id })) return Lotes.fisicoUtil(conn, { tipo, id }, deposito);
  const [[r]] = await conn.query(`SELECT COALESCE(SUM(cantidad), 0) AS s FROM stock_movimientos WHERE ${tipo}_id = ? AND deposito_id = ?`, [id, deposito]);
  return Number(r.s);
};

const comprometido = async (conn, recurso) => {
  const [[r]] = await conn.query("SELECT COALESCE(SUM(cantidad), 0) AS t FROM reservas WHERE recurso = ? AND tipo = 'compromiso_stock' AND estado = 'vigente' AND vence_ms > ?", [recurso, Date.now()]);
  return Number(r.t);
};

// Qué necesita cada ítem en cada depósito para cubrir las líneas (expandidas hasta las hojas, en el depósito del sector).
const requerimientos = async (conn, lineas) => {
  const req = new Map();
  for (const l of lineas) {
    const [[p]] = await conn.query('SELECT sector_id FROM productos WHERE id = ?', [l.producto_id]);
    const dep = await Deposito.depositoDeSector(p?.sector_id ?? null, conn);
    for (const [k, q] of await Receta.hojas(conn, l.producto_id, l.cantidad)) {
      const [tipo, id] = k.split(':');
      const clave = recursoDe(tipo, id, dep.id);
      const e = req.get(clave) ?? { tipo, id: Number(id), deposito_id: dep.id, deposito: dep.nombre, cantidad: 0 };
      e.cantidad += q;
      req.set(clave, e);
    }
  }
  return req;
};

// Solo se comprometen los ítems que controlan stock y no admiten negativo; los servicios no controlan stock (RN04).
const bloqueante = async (conn, e) => {
  const [[f]] = await conn.query(`SELECT nombre, controla_stock, permite_negativo${e.tipo === 'producto' ? ', tipo' : ''} FROM ${e.tipo === 'insumo' ? 'insumos' : 'productos'} WHERE id = ?`, [e.id]);
  if (!f || !f.controla_stock || f.permite_negativo || f.tipo === 'servicio') return null;
  return { ...e, nombre: f.nombre };
};

const reservasDe = async (idCompromiso, conn = pool) =>
  (await conn.query("SELECT * FROM reservas WHERE tipo = 'compromiso_stock' AND contenido LIKE ? ORDER BY creada_ms, id_reserva", [`%"compromiso":"${idCompromiso}"%`]))[0];

// Pide el compromiso. Devuelve { ok: true, id_compromiso, vence_ms } (id nulo si ningún ítem bloquea) o { ok: false, sin_disponible:
// [{ nombre, deposito, requerido, disponible }] con lo que no alcanza. Con la misma idSolicitud devuelve el mismo compromiso.
// `reemplazaA`: el compromiso anterior (cambió la cantidad o venció) se libera y se toma el nuevo.
const comprometer = async ({ idSolicitud, lineas, reemplazaA = null, userId = null }) => {
  // Lote indicado en la línea (Ventas RF48): si no sirve, se rechaza informando el motivo para elegir otro o dejar FEFO (EX57).
  const loteNo = [];
  for (const l of lineas.filter((x) => x.lote_indicado)) {
    const [[p]] = await pool.query('SELECT sector_id FROM productos WHERE id = ?', [l.producto_id]);
    const dep = await Deposito.depositoDeSector(p?.sector_id ?? null, pool);
    const item = { tipo: 'producto', id: l.producto_id };
    if (!(await Lotes.controla(pool, item))) continue; // un ítem sin control de lote ignora el lote indicado
    const motivo = await Lotes.motivoNoDisponible(pool, item, dep.id, l.lote_indicado, l.cantidad);
    if (motivo) loteNo.push({ linea: l.linea, producto_id: l.producto_id, lote: l.lote_indicado, motivo });
  }
  if (loteNo.length) return { ok: false, lote_no_disponible: loteNo };
  const [[previa]] = await pool.query('SELECT contenido FROM reservas WHERE id_solicitud = ?', [`${idSolicitud}:0`]);
  if (previa) {
    const id = JSON.parse(previa.contenido).compromiso;
    return { ok: true, id_compromiso: id, vence_ms: Math.min(...(await reservasDe(id)).map((r) => Number(r.vence_ms))) };
  }
  const bloqueantes = [];
  for (const e of (await requerimientos(pool, lineas)).values()) {
    const b = await bloqueante(pool, e);
    if (b) bloqueantes.push(b);
  }
  bloqueantes.sort((a, b) => recursoDe(a.tipo, a.id, a.deposito_id).localeCompare(recursoDe(b.tipo, b.id, b.deposito_id)));
  if (!bloqueantes.length) return { ok: true, id_compromiso: null, sin_compromiso: true };

  if (reemplazaA) await liberar(reemplazaA);
  // Primero se mira todo, para informar cuánto hay de cada ítem que no alcanza (EX41); después se compromete con el candado.
  const faltan = [];
  for (const b of bloqueantes) {
    const disponible = (await fisico(pool, b.tipo, b.id, b.deposito_id)) - (await comprometido(pool, recursoDe(b.tipo, b.id, b.deposito_id)));
    if (b.cantidad > disponible + 1e-9) faltan.push({ tipo: b.tipo, id: b.id, nombre: b.nombre, deposito: b.deposito, requerido: b.cantidad, disponible: Math.max(disponible, 0) });
  }
  if (faltan.length) return { ok: false, sin_disponible: faltan };

  const idCompromiso = await idGlobal();
  const tomadas = [];
  try {
    for (const [i, b] of bloqueantes.entries()) {
      tomadas.push(await R.reservar({
        tipo: 'compromiso_stock', modulo: 'stock', idSolicitud: `${idSolicitud}:${i}`, recurso: recursoDe(b.tipo, b.id, b.deposito_id), cantidad: b.cantidad,
        contenido: { compromiso: idCompromiso, tipo: b.tipo, id: b.id, deposito_id: b.deposito_id }, userId,
        capacidad: (conn) => fisico(conn, b.tipo, b.id, b.deposito_id),
      }));
    }
  } catch (err) {
    for (const t of tomadas) await R.liberar(t.id_reserva); // todo o nada
    if (err instanceof R.ReservaError && err.codigo === 'SIN_DISPONIBLE') {
      const b = bloqueantes[tomadas.length];
      return { ok: false, sin_disponible: [{ tipo: b.tipo, id: b.id, nombre: b.nombre, deposito: b.deposito, requerido: b.cantidad, disponible: err.disponible ?? 0 }] };
    }
    throw err;
  }
  return { ok: true, id_compromiso: idCompromiso, vence_ms: Math.min(...tomadas.map((t) => Number(t.vence_ms))) };
};

// Mientras el cierre sigue en curso se renueva (mismo ID_Compromiso, hasta 3 veces); un compromiso vencido no se renueva.
const renovar = async (idCompromiso) => {
  const rs = await reservasDe(idCompromiso);
  if (!rs.length) throw new R.ReservaError('NO_EXISTE', 'El compromiso no existe.');
  for (const r of rs) await R.renovar(r.id_reserva);
  return { id_compromiso: idCompromiso, vence_ms: Math.min(...(await reservasDe(idCompromiso)).map((r) => Number(r.vence_ms))) };
};

const liberar = async (idCompromiso) => {
  let n = 0;
  for (const r of await reservasDe(idCompromiso)) if (await R.liberar(r.id_reserva)) n++;
  return n;
};

// Al confirmarse la venta, el descuento consume el compromiso vigente con su propia operación, sin descontar dos veces
// (RN59). Si ya venció o se liberó, el descuento se aplica igual: la venta ya ocurrió y el saldo puede quedar negativo.
const consumir = async (conn, idCompromiso) => {
  let n = 0;
  for (const r of await reservasDe(idCompromiso, conn)) {
    try { await R.consumir(conn, r.id_reserva); n++; } catch (err) { if (!(err instanceof R.ReservaError)) throw err; }
  }
  return n;
};

// Comprometido por ítem y depósito (para las existencias): Map 'tipo:id:deposito' -> cantidad.
const comprometidos = async () => {
  const [rows] = await pool.query("SELECT recurso, SUM(cantidad) AS t FROM reservas WHERE tipo = 'compromiso_stock' AND estado = 'vigente' AND vence_ms > ? GROUP BY recurso", [Date.now()]);
  return new Map(rows.map((r) => [r.recurso, Number(r.t)]));
};

module.exports = { comprometer, renovar, liberar, consumir, comprometidos, recursoDe };
