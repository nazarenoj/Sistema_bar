const pool = require('../config/db');
const registro = require('../instancias/registro');
const Modulos = require('../modulos/registro');
const Funciones = require('../funciones/servicio');
const Notificacion = require('../models/notificacionModel');
const Parametro = require('../models/parametroModel');
const { idGlobal } = require('../utils/idGlobal');
const { auditar } = require('../utils/auditar');
const logger = require('../utils/logger');

// Protocolo de mensajería e integración entre módulos (Usuarios RF25, RN48 a RN60). Un efecto de un módulo
// en otro viaja como mensaje: se graba en la bandeja de salida en la misma transacción del documento
// (`publicar`), un trabajador lo entrega (`procesarPendientes`) y el receptor lo aplica una sola vez.

const SISTEMA = { username: 'sistema' };
const RETARDOS_MS = [5000, 30000, 120000, 600000]; // 5 s, 30 s, 2 min, 10 min; después, cada 10 min (RN52)
const CADA_MS = 600000;
const HORA_MS = 3600000;

// Un rechazo de negocio (regla del receptor): no se reintenta y va a la bandeja de pendientes (RN52).
class RechazoNegocio extends Error {}

// ---- Receptores ----

const receptores = new Map(); // `${destino}:${tipo}` -> { handler, revierte }

// Registra cómo aplica un módulo un tipo de mensaje. `handler(conn, contenido, ctx)` corre dentro de la
// transacción que también marca el mensaje como procesado; devuelve el resultado (se guarda como original).
//   revierte: tipo del mensaje original al que anula o devuelve (una reversa nunca se aplica antes, RN54)
//   ctx: { idOperacion, docIdGlobal, instantanea, funciones: [ids activas al emitirse], referenciaExterna(ref) }
const registrarReceptor = (destino, tipo, handler, { revierte = null } = {}) => {
  receptores.set(`${destino}:${tipo}`, { handler, revierte });
};

// ---- Publicar (lado del módulo origen) ----

// Graba el mensaje en la bandeja de salida con la conexión de la transacción del documento (`conn`).
// Si el módulo receptor no está instalado, el efecto no existe y no se genera mensaje (RF25).
const publicar = async (conn, m) => {
  if (!(await Modulos.estaInstalado(m.destino))) return null;
  const docVersion = m.docVersion ?? 1;
  const idOperacion = `${m.origen}:${m.tipo}:${m.docIdGlobal}:${docVersion}`;
  const cfg = await Funciones.estado(conn);
  const ahora = Date.now();
  const [r] = await conn.query(
    `INSERT IGNORE INTO mensajes_integracion
       (id_global, id_operacion, modulo_origen, modulo_destino, tipo, doc_tipo, doc_id_global, doc_version, secuencia,
        ts_origen_ms, user_id, contenido, proximo_intento_ms, id_solicitud_origen, config_version, config_instantanea)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [await idGlobal(), idOperacion, m.origen, m.destino, m.tipo, m.docTipo, m.docIdGlobal, docVersion, m.secuencia ?? 1,
      ahora, m.userId ?? null, JSON.stringify(m.contenido ?? {}), ahora, m.solicitud ?? null, cfg.version,
      JSON.stringify(cfg.funciones.filter((f) => f.activa).map((f) => f.id))]
  );
  return { idOperacion, nuevo: r.affectedRows === 1 };
};

// Entrega inmediata después de confirmar la transacción del documento (RN59: menos de 2 s). Si falla, el
// trabajador lo levanta en su próxima vuelta; nada se pierde porque el mensaje ya está grabado.
const despertar = () => {
  const inst = registro.actual();
  setImmediate(() => registro.dentroDe(inst, () => procesarPendientes().catch((e) => logger.error(`[mensajeria] ${e.message}`))));
};

// ---- Entrega (lado del receptor) ----

const proximoIntento = (intentos, ahora) => ahora + (RETARDOS_MS[intentos - 1] ?? CADA_MS);

const abrirPendiente = async (mensaje, causa, motivo) => {
  const p = await Parametro.todos();
  const horas = (causa === 'diferencia' ? p.pendiente_plazo_horas_diferencias : p.pendiente_plazo_horas_efectos) ?? 24;
  // Los efectos hacia Stock son del módulo Stock y el rol Depósito; los demás, del módulo que los aplica y el Gerente (RN85).
  const [modulo, rol] = mensaje.modulo_destino === 'stock' ? ['stock', 'deposito'] : [mensaje.modulo_destino, 'gerente'];
  const ahora = Date.now();
  await pool.query(
    `INSERT INTO bandeja_pendientes (mensaje_id, causa, motivo, modulo_responsable, rol_responsable, ingreso_ms, limite_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [mensaje.id, causa, motivo?.slice(0, 500), modulo, rol, ahora, ahora + horas * HORA_MS]
  );
};

// Los rechazos abiertos se resumen en una alerta de severidad media (RN60).
const actualizarAlertaRechazos = async () => {
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM bandeja_pendientes WHERE causa = 'rechazado' AND estado = 'abierto'");
  if (n > 0) await Notificacion.crear({ modulo: 'usuarios', tipo: 'rechazos_integracion', severidad: 'media', mensaje: `Hay ${n} mensaje(s) de integración rechazado(s) en la bandeja de pendientes.`, roles: ['administrador', 'gerente'], clave: 'rechazos-abiertos' });
  else await Notificacion.resolverPorClave('rechazos-abiertos', 'Sin rechazos abiertos');
};

const confirmarMensaje = async (m, resultado) => {
  await pool.query(
    "UPDATE mensajes_integracion SET estado = 'confirmado', confirmado_ms = ?, resultado_original = ?, motivo_rechazo = NULL, retenido_por_orden = 0 WHERE id = ?",
    [Date.now(), resultado == null ? null : JSON.stringify(resultado), m.id]
  );
  await Notificacion.resolverPorClave(`mensaje-fallido:${m.id_operacion}`, 'El mensaje se confirmó');
  // Libera las reversas del mismo documento que esperaban a su original (RN54).
  await pool.query('UPDATE mensajes_integracion SET retenido_por_orden = 0, proximo_intento_ms = ? WHERE doc_id_global = ? AND retenido_por_orden = 1', [Date.now(), m.doc_id_global]);
  await pool.query("UPDATE bandeja_pendientes SET estado = 'resuelto', accion_ms = ? WHERE mensaje_id = ? AND estado IN ('abierto', 'reintentado')", [Date.now(), m.id]);
  await actualizarAlertaRechazos();
};

const rechazarMensaje = async (m, motivo) => {
  await pool.query("UPDATE mensajes_integracion SET estado = 'rechazado', motivo_rechazo = ? WHERE id = ?", [motivo.slice(0, 500), m.id]);
  await abrirPendiente(m, 'rechazado', motivo);
  await auditar(null, { modulo: 'mensajeria', accion: 'rechazado', resultado: 'error', entidad: 'mensaje', entidad_id: m.id_operacion, detalle: motivo }, SISTEMA);
  await actualizarAlertaRechazos();
};

const falloTecnico = async (m, err) => {
  const ahora = Date.now();
  const intentos = m.intentos + 1;
  const primero = m.primer_intento_ms ? Number(m.primer_intento_ms) : ahora;
  const tope = ((await Parametro.todos()).mensajeria_tope_horas ?? 24) * HORA_MS;
  if (ahora - primero >= tope) {
    await pool.query("UPDATE mensajes_integracion SET estado = 'fallido', intentos = ?, primer_intento_ms = ?, motivo_rechazo = ? WHERE id = ?", [intentos, primero, err.message.slice(0, 500), m.id]);
    await abrirPendiente(m, 'fallido', err.message);
    await Notificacion.crear({ modulo: 'usuarios', tipo: 'mensaje_fallido', severidad: 'critica', mensaje: `El mensaje ${m.id_operacion} agotó los reintentos y quedó Fallido.`, roles: ['administrador'], clave: `mensaje-fallido:${m.id_operacion}` });
    await auditar(null, { modulo: 'mensajeria', accion: 'fallido', resultado: 'error', entidad: 'mensaje', entidad_id: m.id_operacion, detalle: err.message }, SISTEMA);
    return;
  }
  await pool.query("UPDATE mensajes_integracion SET estado = 'pendiente', intentos = ?, primer_intento_ms = ?, proximo_intento_ms = ? WHERE id = ?", [intentos, primero, proximoIntento(intentos, ahora), m.id]);
};

// Entrega un mensaje. Devuelve 'confirmado' | 'rechazado' | 'retenido' | 'reintento' | 'fallido'.
const entregar = async (m) => {
  // Ya procesado: responde el resultado original sin repetir el efecto (RN51, EX34).
  const [[previa]] = await pool.query('SELECT resultado FROM operaciones_procesadas WHERE id_operacion = ?', [m.id_operacion]);
  if (previa) {
    await confirmarMensaje(m, previa.resultado ? JSON.parse(previa.resultado) : null);
    await auditar(null, { modulo: 'mensajeria', accion: 'duplicado_ignorado', entidad: 'mensaje', entidad_id: m.id_operacion }, SISTEMA);
    return 'confirmado';
  }

  const receptor = receptores.get(`${m.modulo_destino}:${m.tipo}`);
  if (!receptor || !(await Modulos.estaInstalado(m.modulo_destino))) {
    await falloTecnico(m, new Error(`El módulo ${m.modulo_destino} no está disponible para ${m.tipo}.`));
    return 'reintento';
  }

  // Una reversa espera a que su original esté Confirmada (RN54, EX35).
  if (receptor.revierte) {
    const [[original]] = await pool.query(
      'SELECT estado, descartado FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = ? AND secuencia < ? ORDER BY secuencia LIMIT 1',
      [m.doc_id_global, receptor.revierte, m.secuencia]
    );
    if (!original || original.estado !== 'confirmado') {
      await pool.query("UPDATE mensajes_integracion SET retenido_por_orden = 1, estado = 'pendiente' WHERE id = ?", [m.id]);
      return 'retenido';
    }
  }

  const funciones = m.config_instantanea ? JSON.parse(m.config_instantanea) : [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let referencia = null;
    const resultado = await receptor.handler(conn, JSON.parse(m.contenido), {
      idOperacion: m.id_operacion, docIdGlobal: m.doc_id_global, instantanea: funciones, funciones,
      referenciaExterna: (ref) => { referencia = ref; },
    });
    const p = await Parametro.todos();
    const dias = Math.max(p.mensajeria_retencion_operaciones_dias ?? 90, p.mensajeria_retencion_confirmados_dias ?? 30);
    await conn.query(
      'INSERT INTO operaciones_procesadas (id_operacion, modulo_receptor, doc_id_global, ts_ms, resultado, referencia_externa, vence_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [m.id_operacion, m.modulo_destino, m.doc_id_global, Date.now(), resultado == null ? null : JSON.stringify(resultado), referencia, Date.now() + dias * 86400000]
    );
    await conn.commit();
    await confirmarMensaje(m, resultado);
    return 'confirmado';
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY' && /uq_op_referencia/.test(err.message)) {
      await rechazarMensaje(m, 'Esa referencia externa ya se aplicó para este documento.');
      return 'rechazado';
    }
    if (err instanceof RechazoNegocio) {
      await rechazarMensaje(m, err.message);
      return 'rechazado';
    }
    await falloTecnico(m, err);
    return (await pool.query('SELECT estado FROM mensajes_integracion WHERE id = ?', [m.id]))[0][0].estado === 'fallido' ? 'fallido' : 'reintento';
  } finally {
    conn.release();
  }
};

// Entrega los mensajes que ya les toca, en orden de secuencia dentro de cada documento.
const procesarPendientes = async (limite = 50) => {
  const ahora = Date.now();
  const [filas] = await pool.query(
    `SELECT * FROM mensajes_integracion
     WHERE estado IN ('pendiente', 'enviado') AND retenido_por_orden = 0 AND proximo_intento_ms <= ?
     ORDER BY doc_id_global, secuencia, id LIMIT ?`,
    [ahora, limite]
  );
  const resultados = [];
  for (const f of filas) {
    // Se reserva el mensaje antes de entregarlo: dos trabajadores no lo toman a la vez. Si el proceso muere
    // con el mensaje reservado, a los 60 s vuelve a estar disponible.
    const [r] = await pool.query(
      "UPDATE mensajes_integracion SET estado = 'enviado', proximo_intento_ms = ?, primer_intento_ms = COALESCE(primer_intento_ms, ?) WHERE id = ? AND estado IN ('pendiente', 'enviado') AND proximo_intento_ms <= ?",
      [ahora + 60000, ahora, f.id, ahora]
    );
    if (!r.affectedRows) continue;
    resultados.push({ id_operacion: f.id_operacion, resultado: await entregar({ ...f, primer_intento_ms: f.primer_intento_ms ?? ahora }) });
  }
  return resultados;
};

// ---- Estado de integración de un documento (RN55) ----

const estadoIntegracion = async (docIdGlobal) => {
  const [filas] = await pool.query(
    'SELECT id_operacion, modulo_destino, tipo, estado, retenido_por_orden, descartado, motivo_rechazo FROM mensajes_integracion WHERE doc_id_global = ? ORDER BY secuencia, id',
    [docIdGlobal]
  );
  const pendientes = filas.filter((f) => f.estado !== 'confirmado' || f.descartado);
  return {
    estado: pendientes.length ? 'parcial' : 'completa',
    efectos: filas.map((f) => ({
      id_operacion: f.id_operacion, modulo: f.modulo_destino, tipo: f.tipo,
      estado: f.descartado ? 'descartado' : f.retenido_por_orden ? 'retenido_por_orden' : f.estado, motivo: f.motivo_rechazo,
    })),
  };
};

// ---- Bandeja de pendientes: reintento, descarte, reenvío ----

const pendientes = async ({ estado = 'abierto' } = {}) => {
  const [rows] = await pool.query(
    `SELECT b.*, m.id_operacion, m.tipo, m.doc_id_global, m.modulo_destino, m.estado AS estado_mensaje, m.retenido_por_orden
     FROM bandeja_pendientes b LEFT JOIN mensajes_integracion m ON m.id = b.mensaje_id
     WHERE b.estado = ? ORDER BY b.vencido DESC, b.limite_ms`, [estado]);
  return rows;
};

// Reintento manual: reinicia la secuencia de reintentos conservando la ID_Operacion (RN53).
const reintentar = async (pendienteId, actor) => {
  const [[b]] = await pool.query("SELECT * FROM bandeja_pendientes WHERE id = ? AND estado = 'abierto'", [pendienteId]);
  if (!b || !b.mensaje_id) return { ok: false, status: 404, error: 'El pendiente no existe o ya no está abierto.' };
  const [[m]] = await pool.query('SELECT id_operacion FROM mensajes_integracion WHERE id = ?', [b.mensaje_id]);
  await pool.query("UPDATE mensajes_integracion SET estado = 'pendiente', intentos = 0, primer_intento_ms = NULL, proximo_intento_ms = ?, motivo_rechazo = NULL WHERE id = ?", [Date.now(), b.mensaje_id]);
  await pool.query("UPDATE bandeja_pendientes SET estado = 'reintentado', user_accion = ?, accion_ms = ? WHERE id = ?", [actor.id, Date.now(), pendienteId]);
  await auditar(null, { modulo: 'mensajeria', accion: 'reintento_manual', entidad: 'mensaje', entidad_id: m.id_operacion }, actor);
  despertar();
  return { ok: true };
};

// Descarte: exige motivo y la autorización de otro usuario (la valida el permiso, RN53). El mensaje conserva
// su estado y su motivo; el documento sigue "Parcial" con el efecto "descartado".
const descartar = async (pendienteId, motivo, actor, autorizante) => {
  if (typeof motivo !== 'string' || motivo.trim().length < 3) return { ok: false, status: 400, error: 'El descarte exige un motivo.' };
  const [[b]] = await pool.query("SELECT * FROM bandeja_pendientes WHERE id = ? AND estado = 'abierto'", [pendienteId]);
  if (!b) return { ok: false, status: 404, error: 'El pendiente no existe o ya no está abierto.' };
  if (b.mensaje_id) {
    const [[m]] = await pool.query('SELECT id_operacion FROM mensajes_integracion WHERE id = ?', [b.mensaje_id]);
    await pool.query('UPDATE mensajes_integracion SET descartado = 1 WHERE id = ?', [b.mensaje_id]);
    await Notificacion.resolverPorClave(`mensaje-fallido:${m.id_operacion}`, 'El mensaje se descartó');
    await auditar(null, { modulo: 'mensajeria', accion: 'descarte', entidad: 'mensaje', entidad_id: m.id_operacion, detalle: `${motivo.trim()}${autorizante ? `; autorizó ${autorizante.username}` : ''}` }, actor);
  }
  await pool.query("UPDATE bandeja_pendientes SET estado = 'descartado', user_accion = ?, accion_ms = ?, motivo_descarte = ?, autorizante_id = ? WHERE id = ?",
    [actor.id, Date.now(), motivo.trim().slice(0, 500), autorizante?.id ?? null, pendienteId]);
  await actualizarAlertaRechazos();
  return { ok: true };
};

// Reenvío de los Confirmados desde una fecha, para reconciliar tras una restauración: el receptor deduplica
// por ID_Operacion y solo aplica lo que no tenía (RN58, EX39).
const reenviarDesde = async (desdeMs, actor) => {
  const [r] = await pool.query(
    "UPDATE mensajes_integracion SET estado = 'pendiente', intentos = 0, primer_intento_ms = NULL, proximo_intento_ms = ?, confirmado_ms = NULL WHERE estado = 'confirmado' AND confirmado_ms >= ?",
    [Date.now(), desdeMs]
  );
  await auditar(null, { modulo: 'mensajeria', accion: 'reenvio', detalle: `${r.affectedRows} mensaje(s) desde ${new Date(desdeMs).toISOString()}` }, actor);
  if (r.affectedRows) despertar();
  return r.affectedRows;
};

// ---- Mantenimiento: escalada, retención y conciliación ----

// Un pendiente que pasó su plazo se marca vencido y se avisa al Administrador (RN85).
const escalarVencidos = async () => {
  const [vencidos] = await pool.query("SELECT id, causa FROM bandeja_pendientes WHERE estado = 'abierto' AND vencido = 0 AND limite_ms < ?", [Date.now()]);
  for (const v of vencidos) {
    await pool.query('UPDATE bandeja_pendientes SET vencido = 1, escalada_ms = ? WHERE id = ?', [Date.now(), v.id]);
    await Notificacion.crear({ modulo: 'usuarios', tipo: 'pendiente_vencido', severidad: 'alta', mensaje: `El pendiente de integración ${v.id} (${v.causa}) venció su plazo y pasó al Administrador.`, roles: ['administrador'], clave: `pendiente-vencido:${v.id}` });
  }
  return vencidos.length;
};

// Los Confirmados se conservan 30 días a la vista; después se archivan (un mensaje nunca se borra, RN50).
const archivarConfirmados = async () => {
  const dias = (await Parametro.todos()).mensajeria_retencion_confirmados_dias ?? 30;
  const [r] = await pool.query("UPDATE mensajes_integracion SET archivado = 1 WHERE estado = 'confirmado' AND archivado = 0 AND confirmado_ms < ?", [Date.now() - dias * 86400000]);
  const [o] = await pool.query('DELETE FROM operaciones_procesadas WHERE vence_ms < ?', [Date.now()]);
  return { archivados: r.affectedRows, operacionesPurgadas: o.affectedRows };
};

// Conciliación (RN57, EX38): compara los efectos esperados (mensajes) con los aplicados (operaciones
// procesadas) y lista las diferencias. Genera una alerta y NO corrige sola.
const conciliar = async (tipoEjecucion, actor) => {
  const dif = [];
  const [faltantes] = await pool.query(
    `SELECT m.doc_id_global, m.modulo_destino, m.id_operacion FROM mensajes_integracion m
     LEFT JOIN operaciones_procesadas o ON o.id_operacion = m.id_operacion
     WHERE m.estado = 'confirmado' AND m.archivado = 0 AND o.id_operacion IS NULL`);
  for (const f of faltantes) dif.push({ doc: f.doc_id_global, modulo: f.modulo_destino, tipo: 'efecto_faltante', esperado: f.id_operacion, aplicado: null });
  const [huerfanos] = await pool.query(
    `SELECT o.doc_id_global, o.modulo_receptor, o.id_operacion FROM operaciones_procesadas o
     LEFT JOIN mensajes_integracion m ON m.id_operacion = o.id_operacion
     WHERE m.id IS NULL`);
  for (const h of huerfanos) dif.push({ doc: h.doc_id_global, modulo: h.modulo_receptor, tipo: 'efecto_sin_origen', esperado: null, aplicado: h.id_operacion });
  const [importes] = await pool.query(
    `SELECT m.doc_id_global, m.modulo_destino, m.id_operacion, m.contenido, o.resultado FROM mensajes_integracion m
     JOIN operaciones_procesadas o ON o.id_operacion = m.id_operacion WHERE m.archivado = 0`);
  for (const i of importes) {
    const esperado = JSON.parse(i.contenido)?.importe;
    const aplicado = i.resultado ? JSON.parse(i.resultado)?.importe : undefined;
    if (esperado !== undefined && aplicado !== undefined && Number(esperado) !== Number(aplicado))
      dif.push({ doc: i.doc_id_global, modulo: i.modulo_destino, tipo: 'importe_distinto', esperado: String(esperado), aplicado: String(aplicado) });
  }

  // Las que ya están abiertas no se repiten.
  const nuevas = [];
  for (const d of dif) {
    const [[ya]] = await pool.query(
      "SELECT id FROM conciliacion_diferencias WHERE estado = 'abierta' AND tipo = ? AND modulo_efecto = ? AND (doc_id_global <=> ?) AND (COALESCE(esperado, aplicado) <=> ?)",
      [d.tipo, d.modulo, d.doc, d.esperado ?? d.aplicado]);
    if (!ya) nuevas.push(d);
  }
  const [c] = await pool.query('INSERT INTO conciliaciones (ts_ms, tipo_ejecucion, user_id, diferencias) VALUES (?, ?, ?, ?)', [Date.now(), tipoEjecucion, actor?.id ?? null, nuevas.length]);
  for (const d of nuevas) {
    await pool.query('INSERT INTO conciliacion_diferencias (conciliacion_id, doc_id_global, modulo_efecto, tipo, esperado, aplicado) VALUES (?, ?, ?, ?, ?, ?)', [c.insertId, d.doc, d.modulo, d.tipo, d.esperado, d.aplicado]);
    const ahora = Date.now();
    const horas = (await Parametro.todos()).pendiente_plazo_horas_diferencias ?? 72;
    await pool.query("INSERT INTO bandeja_pendientes (mensaje_id, causa, motivo, modulo_responsable, rol_responsable, ingreso_ms, limite_ms) VALUES (NULL, ?, ?, ?, 'gerente', ?, ?)",
      [d.tipo === 'efecto_sin_origen' ? 'sin_origen' : 'diferencia', `${d.tipo}: ${d.esperado ?? d.aplicado}`, d.modulo, ahora, ahora + horas * HORA_MS]);
  }
  if (nuevas.length)
    await Notificacion.crear({ modulo: 'usuarios', tipo: 'conciliacion', severidad: 'alta', mensaje: `La conciliación de integración encontró ${nuevas.length} diferencia(s).`, roles: ['administrador', 'gerente'], clave: 'conciliacion-diferencias' });
  await auditar(null, { modulo: 'mensajeria', accion: tipoEjecucion === 'diaria' ? 'conciliacion_diaria' : 'conciliacion_bajo_demanda', detalle: `${nuevas.length} diferencia(s)` }, actor || SISTEMA);
  return { id: c.insertId, diferencias: nuevas };
};

module.exports = {
  RechazoNegocio, registrarReceptor, publicar, despertar, procesarPendientes, estadoIntegracion,
  pendientes, reintentar, descartar, reenviarDesde, escalarVencidos, archivarConfirmados, conciliar,
  proximoIntento, RETARDOS_MS, CADA_MS,
};
