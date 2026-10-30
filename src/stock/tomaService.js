const pool = require('../config/db');
const Mov = require('./movimientoService');
const Compromiso = require('./compromisoService');
const Parametro = require('../models/parametroModel');
const Notificacion = require('../models/notificacionModel');
const { enAlcance, TomaBloqueada } = require('./tomaAlcance');
const { idGlobal } = require('../utils/idGlobal');

// Toma de inventario (Stock RF14, RN20, RN67, RN68, EX50 a EX52). Se cuenta, se ve la diferencia contra el stock teórico del
// momento del conteo y, al aprobar, cada línea genera un AJUSTE DELTA (contado − teórico al conteo) sobre el saldo vigente:
// nunca se fija el saldo en lo contado, así se conservan los movimientos ocurridos entre el conteo y la aprobación.
const invalida = (m, status = 400, detalle = null) => new TomaBloqueada(m, detalle, status);
const COL = { insumo: 'insumo_id', producto: 'producto_id' };
const TABLA = { insumo: 'insumos', producto: 'productos' };

const crear = async ({ alcance = {}, congelar_manual = false }, { userId } = {}) => {
  if (alcance.deposito_id !== undefined && alcance.deposito_id !== null) {
    const [[d]] = await pool.query('SELECT id FROM depositos WHERE id = ? AND activo = 1', [alcance.deposito_id]);
    if (!d) throw invalida('El depósito del alcance no existe o está inactivo.');
  }
  if (alcance.items !== undefined && (!Array.isArray(alcance.items) || !alcance.items.length || alcance.items.some((i) => !COL[i.tipo] || !Number.isInteger(i.id))))
    throw invalida('"items" debe ser una lista de { tipo: insumo | producto, id }.');
  const id_global = await idGlobal();
  const [r] = await pool.query('INSERT INTO tomas_inventario (id_global, alcance, congelar_manual, creada_por) VALUES (?, ?, ?, ?)', [id_global, JSON.stringify(alcance), congelar_manual ? 1 : 0, userId ?? null]);
  return obtener(r.insertId);
};

const obtener = async (id) => {
  const [[t]] = await pool.query(typeof id === 'number' ? 'SELECT * FROM tomas_inventario WHERE id = ?' : 'SELECT * FROM tomas_inventario WHERE id_global = ?', [id]);
  if (!t) return null;
  const [lineas] = await pool.query(
    `SELECT l.*, d.nombre AS deposito, COALESCE(i.nombre, p.nombre) AS nombre FROM toma_lineas l JOIN depositos d ON d.id = l.deposito_id
     LEFT JOIN insumos i ON l.item_tipo = 'insumo' AND i.id = l.item_id LEFT JOIN productos p ON l.item_tipo = 'producto' AND p.id = l.item_id WHERE l.toma_id = ? ORDER BY l.id`, [t.id]);
  return {
    ...t, alcance: JSON.parse(t.alcance), resultado: t.resultado ? JSON.parse(t.resultado) : null,
    lineas: lineas.map((l) => ({ ...l, cantidad_contada: Number(l.cantidad_contada), stock_teorico: Number(l.stock_teorico), diferencia: Number(l.cantidad_contada) - Number(l.stock_teorico) })),
  };
};

const listar = async (estado) => (await pool.query(`SELECT id, id_global, estado, alcance, congelar_manual, created_at, aprobada_at FROM tomas_inventario ${estado ? 'WHERE estado = ?' : ''} ORDER BY id DESC LIMIT 100`, estado ? [estado] : []))[0]
  .map((t) => ({ ...t, alcance: JSON.parse(t.alcance) }));

// Carga (o recarga: recontar) la cantidad contada de un ítem en un depósito. Guarda el stock teórico y la marca del último
// movimiento de ese ítem y depósito en este momento.
const cargarLinea = async (tomaId, { item, deposito_id: depositoId, cantidad }) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[t]] = await conn.query('SELECT * FROM tomas_inventario WHERE id = ? FOR UPDATE', [tomaId]);
    if (!t) throw invalida('Toma no encontrada.', 404);
    if (t.estado !== 'en_curso') throw invalida(`La toma está ${t.estado}.`, 409);
    if (!item || !COL[item.tipo] || !Number.isInteger(item.id)) throw invalida('Ítem inválido: indicá { tipo: "insumo" | "producto", id }.');
    if (!(Number(cantidad) >= 0) || !Number.isFinite(Number(cantidad))) throw invalida('La cantidad contada debe ser un número mayor o igual a cero.');
    const [[existe]] = await conn.query(`SELECT id FROM ${TABLA[item.tipo]} WHERE id = ?`, [item.id]);
    if (!existe) throw invalida(`El ${item.tipo} ${item.id} no existe.`, 404);
    const [[dep]] = await conn.query('SELECT id FROM depositos WHERE id = ? AND activo = 1', [depositoId]);
    if (!dep) throw invalida('El depósito no existe o está inactivo.');
    if (!(await enAlcance(conn, JSON.parse(t.alcance), item.tipo, item.id, depositoId))) throw invalida('Ese ítem o depósito no está en el alcance de la toma.');
    const [[s]] = await conn.query(`SELECT COALESCE(SUM(cantidad), 0) AS saldo, COALESCE(MAX(id), 0) AS ultimo FROM stock_movimientos WHERE ${COL[item.tipo]} = ? AND deposito_id = ?`, [item.id, depositoId]);
    await conn.query(
      `INSERT INTO toma_lineas (toma_id, item_tipo, item_id, deposito_id, cantidad_contada, stock_teorico, ultimo_movimiento_id, contado_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE cantidad_contada = VALUES(cantidad_contada), stock_teorico = VALUES(stock_teorico), ultimo_movimiento_id = VALUES(ultimo_movimiento_id),
         contado_at = NOW(), motivo_confirmacion = NULL, marcas = NULL`, [t.id, item.tipo, item.id, depositoId, cantidad, s.saldo, s.ultimo]);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  return obtener(tomaId);
};

const cancelar = async (tomaId) => {
  const [r] = await pool.query("UPDATE tomas_inventario SET estado = 'cancelada' WHERE id = ? AND estado = 'en_curso'", [tomaId]);
  return r.affectedRows > 0;
};

// Mensajes de integración sin aplicar que hacen que los saldos todavía no sean los reales (EX51).
const pendientesDeIntegracion = async (conn) => (await conn.query(
  `SELECT id_operacion, tipo, estado, retenido_por_orden FROM mensajes_integracion
   WHERE modulo_destino = 'stock' AND descartado = 0 AND (estado <> 'confirmado' OR retenido_por_orden = 1) ORDER BY id LIMIT 50`))[0];

// Aprueba la toma (una sola vez). `confirmaciones`: { [lineaId]: motivo } para las líneas que lo exigen; `aceptarPendientes`:
// motivo para aprobar con mensajes de integración sin aplicar; `autorizar`: callback que valida a un supervisor (ajustes que
// dejan el físico por debajo de lo comprometido).
const aprobar = async (tomaId, { confirmaciones = {}, aceptarPendientes = null, autorizar = null, userId = null } = {}) => {
  const conn = await pool.getConnection();
  let resultado;
  try {
    await conn.beginTransaction();
    const [[t]] = await conn.query('SELECT * FROM tomas_inventario WHERE id = ? FOR UPDATE', [tomaId]);
    if (!t) throw invalida('Toma no encontrada.', 404);
    if (t.estado === 'aprobada') { await conn.rollback(); return { ...JSON.parse(t.resultado), repetida: true }; } // aprobación única (RN68)
    if (t.estado !== 'en_curso') throw invalida(`La toma está ${t.estado}.`, 409);
    const [lineas] = await conn.query('SELECT * FROM toma_lineas WHERE toma_id = ? ORDER BY id', [t.id]);
    if (!lineas.length) throw invalida('La toma no tiene líneas contadas.');

    const p = await Parametro.todos();
    const maxMs = (p.toma_horas_max_antiguedad ?? 24) * 3600000;
    const analisis = [];
    for (const l of lineas) {
      const col = COL[l.item_tipo];
      const [[post]] = await conn.query(
        `SELECT COALESCE(SUM(CASE WHEN tipo = 'ajuste' AND motivo = 'toma_inventario' THEN 0 ELSE cantidad END), 0) AS neto,
                COALESCE(SUM(CASE WHEN tipo = 'ajuste' AND motivo = 'toma_inventario' THEN cantidad ELSE 0 END), 0) AS ajustes
         FROM stock_movimientos WHERE ${col} = ? AND deposito_id = ? AND id > ?`, [l.item_id, l.deposito_id, l.ultimo_movimiento_id]);
      const [[cfg]] = await conn.query(`SELECT ${l.item_tipo === 'insumo' ? 'control_estricto, ' : ''}permite_negativo FROM ${TABLA[l.item_tipo]} WHERE id = ?`, [l.item_id]);
      const [[{ saldo }]] = await conn.query(`SELECT COALESCE(SUM(cantidad), 0) AS saldo FROM stock_movimientos WHERE ${col} = ? AND deposito_id = ?`, [l.item_id, l.deposito_id]);
      const ajustesOtros = Number(post.ajustes);
      const teorico = Number(l.stock_teorico) + ajustesOtros; // una toma aprobada antes ya corrigió parte de esa diferencia (RN68)
      const delta = Number(l.cantidad_contada) - teorico;
      const resultadoFisico = Number(saldo) + delta;
      const tolerancia = l.item_tipo === 'insumo' && cfg.control_estricto ? 0 : (p.toma_tolerancia_general ?? 0);
      const motivos = [];
      if (Date.now() - new Date(l.contado_at).getTime() > maxMs) motivos.push('conteo_antiguo');
      if (Math.abs(Number(post.neto)) > tolerancia) motivos.push('con_movimientos_posteriores');
      if (ajustesOtros !== 0) motivos.push('superpuesta');
      const negativo = resultadoFisico < 0 && delta < 0;
      if (negativo && !cfg.permite_negativo) motivos.push('dejaria_negativo_bloqueado');
      else if (negativo) motivos.push('dejaria_negativo');
      const comprometido = delta < 0 ? (await Compromiso.comprometidos()).get(Compromiso.recursoDe(l.item_tipo, l.item_id, l.deposito_id)) ?? 0 : 0;
      const bajoReservado = delta < 0 && comprometido > 0 && resultadoFisico < comprometido;
      if (bajoReservado) motivos.push('bajo_reservado');
      analisis.push({ linea: l, delta, teorico, posteriores: Number(post.neto), motivos, resultadoFisico, comprometido, bajoReservado });
    }

    // Líneas que no se aprueban tal cual: recontar o confirmar con motivo (EX50, EX52).
    // ("bajo lo comprometido" no se confirma con un motivo: lo autoriza un supervisor, más abajo)
    const sinConfirmar = analisis.filter((a) => a.motivos.some((m) => m !== 'bajo_reservado') && !confirmaciones[a.linea.id]);
    const bloqueadas = analisis.filter((a) => a.motivos.includes('dejaria_negativo_bloqueado'));
    if (bloqueadas.length) throw invalida('Hay líneas que dejarían el físico negativo en ítems que no lo admiten: recontalas.', 409, { lineas: bloqueadas.map((a) => ({ linea_id: a.linea.id, motivos: a.motivos })) });
    if (sinConfirmar.length) throw invalida('Hay líneas con conteo antiguo, movimientos posteriores o superpuestas: recontalas o confirmalas con motivo.', 409, { lineas: sinConfirmar.map((a) => ({ linea_id: a.linea.id, item: `${a.linea.item_tipo}:${a.linea.item_id}`, teorico: a.teorico, posteriores: a.posteriores, motivos: a.motivos })) });

    const pendientes = await pendientesDeIntegracion(conn);
    if (pendientes.length && !aceptarPendientes) throw invalida('Hay mensajes de integración sin aplicar: se aprueba al aplicarse o confirmando con motivo que se aceptan.', 409, { pendientes });

    if (analisis.some((a) => a.bajoReservado)) {
      const a = autorizar ? await autorizar() : null;
      if (!a?.ok) throw invalida('Un ajuste dejaría el físico por debajo de lo comprometido: necesita la autorización de un supervisor.', 403, { codigo: 'REQUIERE_AUTORIZACION' });
    }

    const ajustes = [];
    for (const a of analisis) {
      const l = a.linea;
      if (Math.abs(a.delta) > 1e-9) {
        const m = await Mov.registrar(conn, {
          item: { tipo: l.item_tipo, id: l.item_id }, deposito_id: l.deposito_id, tipo: 'ajuste', motivo: 'toma_inventario', cantidad: Math.round(a.delta * 1000) / 1000,
          documento_tipo: 'toma', documento: t.id_global, user_id: userId, observacion: confirmaciones[l.id] ?? null,
        });
        ajustes.push({ linea_id: l.id, item: `${l.item_tipo}:${l.item_id}`, deposito_id: l.deposito_id, delta: Math.round(a.delta * 1000) / 1000, movimiento_id: m.id });
      }
      await conn.query("UPDATE toma_lineas SET estado = 'aprobada', marcas = ?, motivo_confirmacion = ?, delta_aplicado = ? WHERE id = ?", [a.motivos.join(',') || null, confirmaciones[l.id] ?? null, Math.round(a.delta * 1000) / 1000, l.id]);
    }
    resultado = {
      toma: t.id_global, lineas: analisis.length, ajustes, con_marcas: analisis.filter((a) => a.motivos.length).map((a) => ({ linea_id: a.linea.id, motivos: a.motivos })),
      pendientes_aceptados: pendientes.length ? aceptarPendientes : null,
    };
    await conn.query("UPDATE tomas_inventario SET estado = 'aprobada', aprobada_por = ?, aprobada_at = NOW(), resultado = ? WHERE id = ?", [userId, JSON.stringify(resultado), t.id]);
    await conn.commit();
    for (const a of analisis.filter((x) => x.bajoReservado))
      await Notificacion.crear({ modulo: 'stock', tipo: 'reserva_comprometida', severidad: 'critica', roles: ['administrador'], clave: `reserva-comprometida:${a.linea.item_tipo}:${a.linea.item_id}:${a.linea.deposito_id}`,
        mensaje: `Un ajuste de toma dejó el físico (${a.resultadoFisico}) por debajo de lo comprometido (${a.comprometido}) en ${a.linea.item_tipo} ${a.linea.item_id}.` });
    return resultado;
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

module.exports = { crear, obtener, listar, cargarLinea, cancelar, aprobar };
