const pool = require('../config/db');
const registro = require('../instancias/registro');
const Funciones = require('../funciones/servicio');
const Modulos = require('../modulos/registro');
const Permiso = require('../models/permisoModel');

// Tablero de indicadores (Usuarios RF19, RN34 a RN37, EX19). Servicio de plataforma de solo lectura: cada módulo registra sus indicadores
// con su módulo, función y permiso, y es el dueño de la fórmula (`calcular`). El tablero muestra solo los de módulos instalados, funciones
// activas y permiso del usuario, con su alcance ("propias" = solo lo que hizo él); un indicador que falla muestra "No disponible" y no frena
// a los demás ni a la operación. Los valores se guardan 30 s (RN35: el atraso es menor a 60 s).
class TableroInvalido extends Error {}
const invalida = (m, status = 400) => Object.assign(new TableroInvalido(m), { status });

const PERIODOS = ['dia', 'semana', 'mes'];
const CACHE_MS = 30000;
const LIMITE_MS = 5000;
const indicadores = new Map(); // id -> definición
const cache = new Map();

// def: { id, nombre, modulo, funcion?, algunoDe?: [módulos], permiso, alcance?, comparable?, unidad, calcular({ desde, hasta, usuarioId }) }
const registrar = (lista) => { for (const d of lista) indicadores.set(d.id, d); };

const fmt = (d) => { const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
// RN36: período de igual duración al mismo punto: el día contra el mismo día de la semana anterior, la semana contra la anterior, el mes contra el anterior.
const rangos = (periodo, ahora = new Date()) => {
  const inicio = new Date(ahora);
  inicio.setHours(0, 0, 0, 0);
  let ant, antHasta;
  if (periodo === 'semana') inicio.setDate(inicio.getDate() - ((inicio.getDay() + 6) % 7));
  if (periodo === 'mes') {
    inicio.setDate(1);
    ant = new Date(inicio.getFullYear(), inicio.getMonth() - 1, 1);
    const largo = new Date(ant.getFullYear(), ant.getMonth() + 1, 0).getDate();
    antHasta = new Date(ant.getFullYear(), ant.getMonth(), Math.min(ahora.getDate(), largo), ahora.getHours(), ahora.getMinutes(), ahora.getSeconds());
  } else {
    ant = new Date(inicio); ant.setDate(ant.getDate() - 7);
    antHasta = new Date(ahora); antHasta.setDate(antHasta.getDate() - 7);
  }
  return { actual: [fmt(inicio), fmt(ahora)], anterior: [fmt(ant), fmt(antHasta)] };
};

const visible = async (def, ctx) => {
  if (def.modulo && !(await Modulos.estaInstalado(def.modulo))) return false;
  if (def.algunoDe) { let hay = false; for (const m of def.algunoDe) if (await Modulos.estaInstalado(m)) hay = true; if (!hay) return false; }
  if (def.funcion && !(await Funciones.estaActiva(def.funcion))) return false;
  return ctx.esAdmin || (ctx.niveles[def.permiso] ?? 'denegado') !== 'denegado';
};

const conLimite = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('tardó demasiado')), LIMITE_MS).unref())]);
const calcular = async (def, desde, hasta, usuarioId) => {
  const k = `${registro.actual().codigo}|${def.id}|${desde}|${hasta}|${usuarioId ?? '*'}`;
  const previo = cache.get(k);
  if (previo && Date.now() - previo.t < CACHE_MS) return previo.r;
  try {
    const r = { ...(await conLimite(def.calcular({ desde, hasta, usuarioId }))), calculado_en: new Date().toISOString() };
    cache.set(k, { t: Date.now(), r });
    return r;
  } catch (err) {
    return previo ? { ...previo.r, atrasado: true } : { disponible: false, error: 'No disponible' };
  }
};

const comparar = (a, b) => {
  if (a.disponible === false || b.disponible === false || !b.valor) return { sin_base: true, mensaje: 'Sin base de comparación' };
  const dif = Math.round((a.valor - b.valor) * 100) / 100;
  return { anterior: b.valor, diferencia: dif, porcentaje: Math.round((dif / b.valor) * 1000) / 10 };
};

// Los indicadores que el usuario puede ver, en el orden de su tablero (o el predeterminado de su rol: todos los permitidos).
const disponibles = async (ctx) => {
  const todos = [];
  for (const d of indicadores.values()) if (await visible(d, ctx)) todos.push(d);
  return todos;
};
const contexto = async (userId, permisos) => {
  const alcances = await Permiso.alcancesDe(userId);
  return { esAdmin: permisos.esAdmin, niveles: permisos.niveles, soloPropias: alcances.some((a) => a.tipo === 'propias') };
};

const tablero = async (userId, permisos, { periodo } = {}) => {
  const ctx = await contexto(userId, permisos);
  const [[pref]] = await pool.query('SELECT periodo FROM tablero_preferencias WHERE user_id = ?', [userId]);
  const per = periodo ?? pref?.periodo ?? 'dia';
  if (!PERIODOS.includes(per)) throw invalida(`El período es uno de: ${PERIODOS.join(', ')}.`);
  const permitidos = await disponibles(ctx);
  const elegidos = (await pool.query('SELECT indicador_id FROM tablero_usuario WHERE user_id = ? ORDER BY orden', [userId]))[0].map((r) => r.indicador_id);
  const lista = elegidos.length ? elegidos.map((id) => permitidos.find((d) => d.id === id)).filter(Boolean) : permitidos;
  const r = rangos(per);
  const items = await Promise.all(lista.map(async (d) => {
    const usuarioId = d.alcance && ctx.soloPropias ? userId : null;
    const actual = await calcular(d, ...r.actual, usuarioId);
    const item = { id: d.id, nombre: d.nombre, modulo: d.modulo, unidad: d.unidad ?? null, alcance_propias: !!usuarioId, ...actual };
    if (d.comparable) item.comparacion = comparar(actual, await calcular(d, ...r.anterior, usuarioId));
    return item;
  }));
  return { periodo: per, desde: r.actual[0], hasta: r.actual[1], indicadores: items };
};

const catalogo = async (userId, permisos) => (await disponibles(await contexto(userId, permisos))).map((d) => ({ id: d.id, nombre: d.nombre, modulo: d.modulo, comparable: !!d.comparable }));

// Personaliza: indicadores elegidos y ordenados, y período por defecto. Solo se aceptan los que el usuario puede ver.
const configurar = async (userId, permisos, { indicadores: ids, periodo }) => {
  if (periodo !== undefined && !PERIODOS.includes(periodo)) throw invalida(`El período es uno de: ${PERIODOS.join(', ')}.`);
  if (ids !== undefined) {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw invalida('La lista de indicadores es inválida o tiene repetidos.');
    const ok = new Set((await disponibles(await contexto(userId, permisos))).map((d) => d.id));
    const mala = ids.find((i) => !ok.has(i));
    if (mala) throw invalida(`El indicador "${mala}" no existe o no está disponible para vos.`);
    await pool.query('DELETE FROM tablero_usuario WHERE user_id = ?', [userId]);
    if (ids.length) await pool.query('INSERT INTO tablero_usuario (user_id, indicador_id, orden) VALUES ?', [ids.map((id, i) => [userId, id, i])]);
  }
  if (periodo !== undefined) await pool.query('INSERT INTO tablero_preferencias (user_id, periodo) VALUES (?, ?) ON DUPLICATE KEY UPDATE periodo = VALUES(periodo)', [userId, periodo]);
};

const limpiarCache = () => cache.clear();

module.exports = { TableroInvalido, limpiarCache, registrar, rangos, tablero, catalogo, configurar };
