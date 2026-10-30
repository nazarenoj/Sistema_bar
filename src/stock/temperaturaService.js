const pool = require('../config/db');
const Notificacion = require('../models/notificacionModel');
const Funciones = require('../funciones/servicio');
const { idGlobal } = require('../utils/idGlobal');

// Temperaturas e inocuidad (Stock RF25, EX26), con la función STK-TEMP. Un punto de control tiene rango y frecuencia; una lectura
// fuera de rango, o un registro omitido pasada la frecuencia, alerta en el Centro de Notificaciones y deja el control "pendiente de
// acción correctiva" hasta cargarla.
class TemperaturaInvalida extends Error {}
const invalida = (m, status = 400) => Object.assign(new TemperaturaInvalida(m), { status });

const ROLES = ['administrador', 'gerente', 'encargado', 'deposito'];
const TIPOS = ['heladera', 'camara', 'freezer', 'vitrina', 'otro'];
const ACCIONES = ['mover_mercaderia', 'egreso_vencimiento', 'retiro_lote', 'otra'];
const ORIGENES = ['terminal', 'app'];
const num = (x) => Number(x);

const punto = async (id) => (await pool.query('SELECT * FROM puntos_control WHERE id = ?', [id]))[0][0] ?? null;

const crearPunto = async ({ nombre, tipo = 'heladera', rango_min, rango_max, frecuencia_horas = 12 }) => {
  if (!String(nombre ?? '').trim()) throw invalida('El nombre del punto de control es obligatorio.');
  if (!TIPOS.includes(tipo)) throw invalida(`El tipo debe ser uno de: ${TIPOS.join(', ')}.`);
  if (!Number.isFinite(num(rango_min)) || !Number.isFinite(num(rango_max)) || rango_min === null || rango_max === null || num(rango_min) > num(rango_max)) throw invalida('El rango aceptable necesita un mínimo y un máximo (mínimo ≤ máximo).');
  if (!(num(frecuencia_horas) > 0)) throw invalida('La frecuencia de registro debe ser mayor que cero.');
  try {
    const [r] = await pool.query('INSERT INTO puntos_control (nombre, tipo, rango_min, rango_max, frecuencia_horas) VALUES (?, ?, ?, ?, ?)', [String(nombre).trim(), tipo, num(rango_min), num(rango_max), num(frecuencia_horas)]);
    return punto(r.insertId);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida('Ya existe un punto de control con ese nombre.', 409);
    throw err;
  }
};

// Puntos con su última lectura y si el registro está omitido (pasó más que la frecuencia sin registrar).
const listarPuntos = async () => {
  const [filas] = await pool.query(
    `SELECT p.*, (SELECT MAX(r.created_at) FROM registros_temperatura r WHERE r.punto_id = p.id) AS ultimo_registro,
            (SELECT COUNT(*) FROM registros_temperatura r WHERE r.punto_id = p.id AND r.accion_estado = 'pendiente') AS acciones_pendientes
     FROM puntos_control p ORDER BY p.nombre`);
  const ahora = Date.now();
  return filas.map((f) => {
    const desde = new Date(f.ultimo_registro ?? f.created_at).getTime();
    return { ...f, omitido: !!f.activo && ahora - desde > num(f.frecuencia_horas) * 3600000 };
  });
};

const modificarPunto = async (id, c) => {
  const campos = ['rango_min', 'rango_max', 'frecuencia_horas', 'activo'].filter((k) => c[k] !== undefined);
  if (!campos.length) throw invalida('No hay nada para cambiar.');
  const p = await punto(id);
  if (!p) throw invalida('Punto de control no encontrado.', 404);
  const nuevo = { ...p, ...c };
  if (num(nuevo.rango_min) > num(nuevo.rango_max)) throw invalida('El mínimo no puede superar al máximo.');
  if (!(num(nuevo.frecuencia_horas) > 0)) throw invalida('La frecuencia de registro debe ser mayor que cero.');
  await pool.query(`UPDATE puntos_control SET ${campos.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...campos.map((k) => (k === 'activo' ? (c[k] ? 1 : 0) : c[k])), id]);
  return punto(id);
};

const claveFuera = (registroId) => `temp-fuera:${registroId}`;
const claveOmitido = (puntoId) => `temp-omitido:${puntoId}`;

const registro = async (id) => (await pool.query('SELECT r.*, p.nombre AS punto FROM registros_temperatura r JOIN puntos_control p ON p.id = r.punto_id WHERE r.id = ?', [id]))[0][0] ?? null;

const registrar = async (puntoId, valor, { userId, origen = 'terminal' } = {}) => {
  if (valor === null || valor === undefined || valor === '' || !Number.isFinite(num(valor))) throw invalida('El valor de la lectura es obligatorio.');
  if (!ORIGENES.includes(origen)) throw invalida('Origen inválido.');
  const p = await punto(puntoId);
  if (!p || !p.activo) throw invalida('El punto de control no existe o está inactivo.', 404);
  const fuera = num(valor) < num(p.rango_min) || num(valor) > num(p.rango_max);
  const id_global = await idGlobal();
  const [r] = await pool.query(
    'INSERT INTO registros_temperatura (id_global, punto_id, valor, fuera_de_rango, origen, user_id, accion_estado) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id_global, puntoId, num(valor), fuera ? 1 : 0, origen, userId ?? null, fuera ? 'pendiente' : 'no_requiere']);
  await Notificacion.resolverPorClave(claveOmitido(puntoId), 'Se registró una lectura');
  if (fuera) {
    await Notificacion.crear({ modulo: 'stock', tipo: 'temperatura_fuera_de_rango', severidad: 'alta', roles: ROLES, clave: claveFuera(r.insertId),
      mensaje: `${p.nombre}: ${num(valor)} °C fuera del rango ${num(p.rango_min)} a ${num(p.rango_max)} °C. Cargá la acción correctiva.` });
  }
  return registro(r.insertId);
};

// Acción correctiva de una lectura fuera de rango (mover mercadería, egreso por vencimiento, retiro de lote, otra).
const accionCorrectiva = async (registroId, { tipo, detalle } = {}, { userId } = {}) => {
  if (!ACCIONES.includes(tipo)) throw invalida(`La acción debe ser una de: ${ACCIONES.join(', ')}.`);
  if (!String(detalle ?? '').trim()) throw invalida('Describí la acción correctiva realizada.');
  const r = await registro(registroId);
  if (!r) throw invalida('Registro no encontrado.', 404);
  if (r.accion_estado !== 'pendiente') throw invalida(r.accion_estado === 'cargada' ? 'La acción correctiva ya fue cargada.' : 'Esa lectura no requiere acción correctiva.', 409);
  await pool.query("UPDATE registros_temperatura SET accion_estado = 'cargada', accion_tipo = ?, accion_detalle = ?, accion_user_id = ?, accion_at = NOW() WHERE id = ?", [tipo, String(detalle).trim().slice(0, 255), userId ?? null, registroId]);
  await Notificacion.resolverPorClave(claveFuera(registroId), 'Se cargó la acción correctiva');
  return registro(registroId);
};

const registros = async ({ punto_id, fuera_de_rango, pendientes, desde, hasta } = {}) => {
  const donde = [];
  const params = [];
  if (punto_id) { donde.push('r.punto_id = ?'); params.push(punto_id); }
  if (fuera_de_rango) donde.push('r.fuera_de_rango = 1');
  if (pendientes) donde.push("r.accion_estado = 'pendiente'");
  if (desde) { donde.push('r.created_at >= ?'); params.push(`${desde} 00:00:00`); }
  if (hasta) { donde.push('r.created_at <= ?'); params.push(`${hasta} 23:59:59`); }
  return (await pool.query(`SELECT r.*, p.nombre AS punto FROM registros_temperatura r JOIN puntos_control p ON p.id = r.punto_id ${donde.length ? `WHERE ${donde.join(' AND ')}` : ''} ORDER BY r.id DESC LIMIT 500`, params))[0];
};

// Trabajo periódico: alerta por cada punto con el registro omitido; la alerta se cierra con la próxima lectura.
const evaluar = async () => {
  if (!(await Funciones.estaActiva('STK-TEMP'))) return 0;
  let omitidos = 0;
  for (const p of await listarPuntos()) {
    if (!p.omitido) { await Notificacion.resolverPorClave(claveOmitido(p.id), 'Registro al día'); continue; }
    omitidos++;
    await Notificacion.crear({ modulo: 'stock', tipo: 'temperatura_omitida', severidad: 'media', roles: ROLES, clave: claveOmitido(p.id),
      mensaje: `${p.nombre}: sin registro de temperatura hace más de ${num(p.frecuencia_horas)} h.` });
  }
  return omitidos;
};

// ---- Listas de verificación de inocuidad (limpieza, recepción de mercadería) ----

const lista = async (id) => { const l = (await pool.query('SELECT * FROM listas_verificacion WHERE id = ?', [id]))[0][0]; return l ? { ...l, items: JSON.parse(l.items) } : null; };
const listas = async () => (await pool.query('SELECT * FROM listas_verificacion WHERE activo = 1 ORDER BY nombre'))[0].map((l) => ({ ...l, items: JSON.parse(l.items) }));

const crearLista = async ({ nombre, tipo = 'otra', items }) => {
  if (!String(nombre ?? '').trim()) throw invalida('El nombre de la lista es obligatorio.');
  if (!['limpieza', 'recepcion', 'otra'].includes(tipo)) throw invalida('Tipo de lista inválido.');
  if (!Array.isArray(items) || !items.length || items.some((i) => !String(i).trim())) throw invalida('La lista necesita al menos un ítem de control, sin vacíos.');
  try {
    const [r] = await pool.query('INSERT INTO listas_verificacion (nombre, tipo, items) VALUES (?, ?, ?)', [String(nombre).trim(), tipo, JSON.stringify(items.map((i) => String(i).trim()))]);
    return lista(r.insertId);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida('Ya existe una lista con ese nombre.', 409);
    throw err;
  }
};

// respuestas: [{ ok: boolean, observacion? }] en el orden de la lista. Un "no" exige observación.
const verificar = async (listaId, respuestas, { userId, origen = 'terminal' } = {}) => {
  const l = await lista(listaId);
  if (!l || !l.activo) throw invalida('Lista no encontrada.', 404);
  if (!ORIGENES.includes(origen)) throw invalida('Origen inválido.');
  if (!Array.isArray(respuestas) || respuestas.length !== l.items.length) throw invalida(`Respondé los ${l.items.length} ítems de la lista.`);
  if (respuestas.some((r) => r.ok !== true && !String(r.observacion ?? '').trim())) throw invalida('Un ítem no cumplido exige una observación.');
  const guardadas = l.items.map((texto, i) => ({ texto, ok: respuestas[i].ok === true, observacion: respuestas[i].observacion ?? null }));
  const completa = guardadas.every((g) => g.ok);
  const [r] = await pool.query('INSERT INTO verificaciones (lista_id, user_id, respuestas, completa, origen) VALUES (?, ?, ?, ?, ?)', [listaId, userId ?? null, JSON.stringify(guardadas), completa ? 1 : 0, origen]);
  return { id: r.insertId, lista_id: listaId, completa, respuestas: guardadas };
};

module.exports = { TemperaturaInvalida, crearPunto, listarPuntos, modificarPunto, registrar, accionCorrectiva, registros, evaluar, crearLista, listas, verificar };
