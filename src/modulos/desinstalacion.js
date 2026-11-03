const pool = require('../config/db');
const Modulos = require('./registro');
const { MODULOS } = require('./catalogo');
const M = require('../mensajeria/servicio');
const Notificacion = require('../models/notificacionModel');

// Desinstalación de un módulo por etapas (Usuarios RN87, EX59): el Administrador la inicia y el módulo pasa a "En desinstalación" (ya no cuenta como
// instalado: no recibe llamadas ni mensajes nuevos y los demás funcionan sin él); se resuelven las operaciones en curso (mensajes, reservas con
// vigencia y documentos abiertos) y recién ahí se desinstala. Lo que no se resuelve dentro del plazo pasa a la Bandeja de pendientes con
// responsable. El Administrador puede cancelarla y el módulo vuelve a su estado anterior.
class DesinstalacionInvalida extends Error {}
const invalida = (m, status = 400, problemas) => Object.assign(new DesinstalacionInvalida(m), { status, problemas });

// Cada módulo dice qué documentos abiertos tiene: `async () => [{ tipo, cantidad, detalle }]`.
const documentosAbiertos = new Map();
const registrarDocumentosAbiertos = (modulo, fn) => documentosAbiertos.set(modulo, fn);

const fila = async (codigo) => (await pool.query('SELECT * FROM modulos_instalados WHERE codigo = ?', [codigo]))[0][0] ?? null;

// Lo que falta resolver. Los mensajes se intentan entregar primero (llegar a un estado final).
const pendientes = async (codigo) => {
  await M.procesarPendientes().catch(() => {});
  const [[{ n: mensajes }]] = await pool.query("SELECT COUNT(*) AS n FROM mensajes_integracion WHERE (modulo_destino = ? OR modulo_origen = ?) AND estado IN ('pendiente', 'enviado', 'rechazado', 'fallido') AND descartado = 0", [codigo, codigo]);
  const [[{ n: reservas }]] = await pool.query("SELECT COUNT(*) AS n FROM reservas WHERE modulo_receptor = ? AND estado = 'vigente' AND vence_ms > ?", [codigo, Date.now()]);
  const docs = documentosAbiertos.get(codigo) ? await documentosAbiertos.get(codigo)() : [];
  const lista = [
    ...(mensajes ? [{ tipo: 'mensajes', cantidad: Number(mensajes), detalle: 'Mensajes de integración sin llegar a un estado final.' }] : []),
    ...(reservas ? [{ tipo: 'reservas', cantidad: Number(reservas), detalle: 'Reservas con vigencia: se dejan vencer.' }] : []),
    ...docs.filter((d) => d.cantidad > 0),
  ];
  return lista;
};

const iniciar = async (codigo, actor = {}) => {
  const def = MODULOS[codigo];
  if (!def) throw invalida(`El módulo "${codigo}" no existe.`, 404);
  if (def.obligatorio) throw invalida(`${def.nombre} es obligatorio y no se desinstala.`, 400);
  const f = await fila(codigo);
  if (!f) throw invalida(`${def.nombre} no está instalado.`, 409);
  if (f.estado === 'en_desinstalacion') return estado(codigo);
  // Un módulo que otro instalado requiere sin condición no se desinstala hasta que ese se desinstale antes.
  const quedan = [...(await instalados())].filter((c) => c !== codigo);
  const problemas = Modulos.validar(MODULOS, quedan);
  if (problemas.length) throw invalida(problemas.join(' '), 400, problemas);
  await pool.query("UPDATE modulos_instalados SET estado = 'en_desinstalacion', desinstalacion_desde = NOW(), desinstalacion_user = ? WHERE codigo = ?", [actor.id ?? null, codigo]);
  Modulos.invalidar();
  return estado(codigo);
};

const instalados = async () => (await pool.query("SELECT codigo FROM modulos_instalados WHERE estado = 'instalado'"))[0].map((r) => r.codigo);

const estado = async (codigo) => {
  const f = await fila(codigo);
  if (!f) throw invalida('El módulo no está instalado.', 404);
  return { modulo: codigo, estado: f.estado, desde: f.desinstalacion_desde, pendientes: f.estado === 'en_desinstalacion' ? await pendientes(codigo) : [] };
};

// Con todo resuelto se desinstala: sus funciones pasan a Deshabilitada con su valor anterior, sus datos y permisos se conservan sin uso.
const completar = async (codigo, actor = null) => {
  const f = await fila(codigo);
  if (!f || f.estado !== 'en_desinstalacion') throw invalida('El módulo no está en desinstalación.', 409);
  const pend = await pendientes(codigo);
  if (pend.length) throw invalida('Todavía hay operaciones sin resolver: la desinstalación no se completa.', 409, pend); // EX59
  const Funciones = require('../funciones/servicio');
  const antes = (await Funciones.estado()).funciones;
  await pool.query('DELETE FROM modulos_instalados WHERE codigo = ?', [codigo]);
  Modulos.invalidar();
  await Funciones.registrarCambioDeModulo(antes, actor);
  await Notificacion.resolverPorClave(`desinstalacion-${codigo}`, 'El módulo se desinstaló');
  return { modulo: codigo, desinstalado: true };
};

const cancelar = async (codigo) => {
  const f = await fila(codigo);
  if (!f || f.estado !== 'en_desinstalacion') throw invalida('El módulo no está en desinstalación.', 409);
  await pool.query("UPDATE modulos_instalados SET estado = 'instalado', desinstalacion_desde = NULL, desinstalacion_user = NULL WHERE codigo = ?", [codigo]);
  Modulos.invalidar();
  await Notificacion.resolverPorClave(`desinstalacion-${codigo}`, 'La desinstalación se canceló');
  return { modulo: codigo, estado: 'instalado' };
};

// Tarea periódica: intenta completar las desinstalaciones y, vencido el plazo, deja lo que falta en la Bandeja de pendientes (RN85, EX59).
const mantenimiento = async () => {
  const enCurso = (await pool.query("SELECT codigo, desinstalacion_desde FROM modulos_instalados WHERE estado = 'en_desinstalacion'"))[0];
  const plazoH = Number((await pool.query("SELECT valor FROM parametros WHERE clave = 'desinstalacion_plazo_horas'"))[0][0]?.valor ?? 24);
  const salida = [];
  for (const m of enCurso) {
    const pend = await pendientes(m.codigo);
    if (!pend.length) { await completar(m.codigo).catch(() => {}); salida.push({ modulo: m.codigo, completada: true }); continue; }
    if ((Date.now() - new Date(m.desinstalacion_desde).getTime()) / 3600000 < plazoH) { salida.push({ modulo: m.codigo, esperando: pend.length }); continue; }
    for (const p of pend) {
      const motivo = `Desinstalación de ${m.codigo}: ${p.cantidad} ${p.tipo} sin resolver (${p.detalle})`.slice(0, 500);
      const [[ya]] = await pool.query("SELECT 1 AS x FROM bandeja_pendientes WHERE motivo = ? AND estado = 'abierto'", [motivo]);
      if (!ya) await pool.query("INSERT INTO bandeja_pendientes (causa, motivo, modulo_responsable, rol_responsable, ingreso_ms, limite_ms) VALUES ('diferencia', ?, ?, 'gerente', ?, ?)", [motivo, m.codigo, Date.now(), Date.now() + 72 * 3600000]);
    }
    await Notificacion.crear({ modulo: 'usuarios', tipo: 'desinstalacion_pendiente', severidad: 'alta', roles: ['administrador'], clave: `desinstalacion-${m.codigo}`, mensaje: `La desinstalación de ${m.codigo} no puede completarse: quedan operaciones sin resolver en la Bandeja de pendientes.` });
    salida.push({ modulo: m.codigo, a_bandeja: pend.length });
  }
  return salida;
};

module.exports = { DesinstalacionInvalida, registrarDocumentosAbiertos, iniciar, estado, completar, cancelar, mantenimiento, pendientes };
