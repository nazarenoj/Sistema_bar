const crypto = require('crypto');
const pool = require('../config/db');
const Pedido = require('../models/pedidoModel');
const Terminal = require('../models/terminalModel');
const Notificacion = require('../models/notificacionModel');
const Comandas = require('./comandaService');
const PedidoCtl = require('../controllers/pedidoController');
const MesaCtl = require('../controllers/mesaController');
const { auditar } = require('../utils/auditar');

// Toma de pedidos desde el dispositivo del mozo (Ventas RF39, RN37, RN66, EX26, EX50), con VEN-MOVIL. Cada operación lleva su ID_Operacion
// (idempotente), el dispositivo (una terminal registrada como "dispositivo móvil") y la versión base del pedido o del ítem. El servidor la
// evalúa contra esa versión y nunca resuelve por "el último en llegar gana": lo que no se puede aplicar se rechaza con el estado actual y
// queda como conflicto de sincronización. Las operaciones se aplican en el orden en que llegan.
class OperacionInvalida extends Error {}
const invalida = (m, status = 400) => Object.assign(new OperacionInvalida(m), { status });
// Rechazo de negocio: se guarda como conflicto y se responde con el estado actual.
class Rechazo extends Error { constructor(m, estadoActual = {}) { super(m); this.estadoActual = estadoActual; } }

const TIPOS = ['abrir_pedido', 'agregar_item', 'modificar_item', 'anular_item', 'enviar_comanda', 'mover_mesa', 'cobrar'];
const canonico = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? v.map(canonico) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonico(v[k])]))) : v);
const huella = (op) => crypto.createHash('sha1').update(JSON.stringify(canonico(op))).digest('hex');

// Llama a un handler de Express como lo haría el servidor, para no duplicar su lógica; devuelve { status, body }.
const invocar = (handler, req, { params = {}, body = {} } = {}) => new Promise((resolve, reject) => {
  const sub = Object.create(req);
  Object.assign(sub, { params, body, query: {}, method: 'POST' });
  let status = 200;
  const res = { status(c) { status = c; return res; }, json(b) { resolve({ status, body: b }); return res; }, end() { resolve({ status, body: null }); return res; }, set() { return res; }, setHeader() { return res; } };
  Promise.resolve(handler(sub, res)).catch(reject);
});
const delegado = async (handler, req, args) => {
  const r = await invocar(handler, req, args);
  if (r.status >= 400) throw new Rechazo(r.body?.error ?? 'No se pudo aplicar.', { codigo: r.body?.codigo });
  return r.body;
};

// Estado actual de un pedido para un rechazo: quién y cuándo (RN37).
const pedidoParaOperar = async (pedidoId, conn = pool) => {
  const [[p]] = await conn.query('SELECT p.id, p.estado, p.mesa_id, p.version, p.fecha_cierre, p.modalidad FROM pedidos p WHERE p.id = ?', [pedidoId]);
  if (!p) throw new Rechazo('El pedido ya no existe (se anuló).', { estado: 'anulado' });
  if (p.estado !== 'activo') {
    const [[ult]] = await conn.query('SELECT u.username, o.created_at FROM movil_operaciones o LEFT JOIN users u ON u.id = o.user_id WHERE o.pedido_id = ? AND o.estado = \'aplicada\' ORDER BY o.id DESC LIMIT 1', [pedidoId]);
    throw new Rechazo(`El pedido está ${p.estado === 'finalizado' ? 'cobrado o cerrado' : p.estado}${p.fecha_cierre ? ` desde ${p.fecha_cierre.toISOString().slice(0, 16).replace('T', ' ')}` : ''}.`,
      { estado: p.estado, desde: p.fecha_cierre, ultima_operacion_de: ult?.username ?? null, version_pedido: p.version });
  }
  return p;
};

// Bloquea el ítem y valida la versión base antes de modificarlo o anularlo (RN37 punto 2).
const conItem = async (op, fn) => {
  if (!Number.isInteger(op.item_id) || !Number.isInteger(op.version_item)) throw invalida('Falta "item_id" y la "version_item" que vio el dispositivo.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const p = await pedidoParaOperar(op.pedido_id, conn);
    const [[it]] = await conn.query('SELECT * FROM pedido_productos WHERE id = ? AND pedido_id = ? FOR UPDATE', [op.item_id, p.id]);
    if (!it) throw new Rechazo('El ítem ya no está en el pedido.', { estado: 'quitado', version_pedido: p.version });
    if (it.enviado_at) throw new Rechazo('El ítem ya se envió a producción.', { estado: 'enviado', desde: it.enviado_at, version_item: it.version });
    if (it.version !== op.version_item) throw new Rechazo('El ítem cambió desde que lo viste: refrescá el pedido.', { estado: 'cambiado', version_item: it.version });
    const r = await fn(conn, it, p);
    await conn.commit();
    return r;
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const operaciones = {
  abrir_pedido: async (req, op) => {
    const p = await delegado(PedidoCtl.create, req, { body: op.datos ?? {} });
    return { pedido_id: p.id, version_pedido: (await pedidoParaOperar(p.id)).version, pedido: p };
  },
  agregar_item: async (req, op) => {
    await pedidoParaOperar(op.pedido_id); // un ítem se agrega aunque otro dispositivo haya agregado antes: se suman (RN37.1)
    const r = await delegado(PedidoCtl.addProductos, req, { params: { id: String(op.pedido_id) }, body: { productos: op.datos?.productos } });
    return { ...r, version_pedido: (await pedidoParaOperar(op.pedido_id)).version };
  },
  modificar_item: (req, op) => conItem(op, async (conn, it) => {
    const { cantidad, observaciones } = op.datos ?? {};
    if (cantidad === undefined && observaciones === undefined) throw invalida('Indicá la "cantidad" o las "observaciones" nuevas.');
    if (cantidad !== undefined && (!Number.isInteger(cantidad) || cantidad <= 0)) throw invalida('La cantidad debe ser un entero mayor a cero.');
    if (observaciones !== undefined && (typeof observaciones !== 'string' || observaciones.length > 255)) throw invalida('Las observaciones son un texto de hasta 255 caracteres.');
    await conn.query('UPDATE pedido_productos SET cantidad = ?, observaciones = ? WHERE id = ?', [cantidad ?? it.cantidad, observaciones === undefined ? it.observaciones : observaciones.trim() || null, it.id]);
    const [[n]] = await conn.query('SELECT version FROM pedido_productos WHERE id = ?', [it.id]);
    return { item_id: it.id, version_item: n.version };
  }),
  anular_item: (req, op) => conItem(op, async (conn, it) => {
    await conn.query('INSERT INTO item_anulaciones (pedido_id, producto_id, nombre, cantidad, precio_unitario, motivo, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [it.pedido_id, it.producto_id, it.nombre, it.cantidad, it.precio_unitario, op.datos?.motivo ?? null, req.usuario?.sub ?? null]);
    await Pedido.removeItem(it.id, conn);
    return { item_id: it.id, anulado: true };
  }),
  enviar_comanda: async (req, op) => {
    const p = await pedidoParaOperar(op.pedido_id);
    try {
      const r = await Comandas.enviar(p.mesa_id, { userId: req.usuario?.sub });
      return { ya_enviado: false, comandas: r.comandas.map((c) => c.id), omitidos: r.omitidos };
    } catch (err) {
      if (!(err instanceof Comandas.ComandaInvalida)) throw err;
      if (/No hay ítems nuevos/.test(err.message)) return { ya_enviado: true }; // otro dispositivo ya los envió: no se duplica
      throw new Rechazo(err.message, { omitidos: err.omitidos });
    }
  },
  mover_mesa: async (req, op) => {
    await pedidoParaOperar(op.pedido_id);
    const p = await delegado(PedidoCtl.moverMesa, req, { params: { id: String(op.pedido_id) }, body: { mesa_id: op.datos?.mesa_id } });
    return { pedido_id: p.id, mesa_id: p.mesa_id };
  },
  cobrar: async (req, op) => {
    const [[hab]] = await pool.query("SELECT valor FROM parametros WHERE clave = 'movil_cobro'");
    if (hab?.valor !== 'si') throw new Rechazo('El cobro desde el dispositivo no está habilitado: cobrá en la terminal.');
    const p = await pedidoParaOperar(op.pedido_id);
    const r = await delegado(MesaCtl.cerrarCuenta, req, { params: { id: String(p.mesa_id) }, body: op.datos ?? {} });
    return { venta_id_global: r.venta_id_global ?? null };
  },
};

// Aplica una operación del dispositivo. Devuelve { estado: 'aplicada' | 'rechazada', ... }; una repetida devuelve el resultado original.
const aplicar = async (req, op) => {
  if (typeof op?.id_operacion !== 'string' || !/^[\w:.-]{8,64}$/.test(op.id_operacion)) throw invalida('Falta "id_operacion" (8 a 64 caracteres).');
  if (!TIPOS.includes(op.tipo)) throw invalida(`El tipo debe ser uno de: ${TIPOS.join(', ')}.`);
  if (op.tipo !== 'abrir_pedido' && !Number.isInteger(op.pedido_id)) throw invalida('Falta el "pedido_id".');
  const terminal = req.usuario?.terminal_id ? await Terminal.getById(req.usuario.terminal_id) : null;
  if (!terminal || terminal.tipo !== 'dispositivo_movil' || !terminal.activa) throw invalida('Este equipo no está registrado como dispositivo móvil.', 403);
  if (op.id_dispositivo && op.id_dispositivo !== terminal.codigo) throw invalida('El "id_dispositivo" no es el de esta sesión.');

  const { id_operacion, ...resto } = op;
  const hash = huella(resto);
  const [[previa]] = await pool.query('SELECT * FROM movil_operaciones WHERE id_operacion = ?', [id_operacion]);
  if (previa) {
    if (previa.contenido_hash !== hash) throw invalida('Esa id_operacion ya se usó con otro contenido (conflicto de idempotencia).', 409);
    return { id_operacion, estado: previa.estado, repetida: true, motivo: previa.motivo, ...JSON.parse(previa.resultado ?? '{}') };
  }

  let estado = 'aplicada';
  let motivo = null;
  let resultado;
  try {
    resultado = await operaciones[op.tipo](req, op);
  } catch (err) {
    if (!(err instanceof Rechazo)) throw err;
    estado = 'rechazada';
    motivo = err.message;
    resultado = { estado_actual: err.estadoActual };
  }
  try {
    await pool.query('INSERT INTO movil_operaciones (id_operacion, terminal_id, user_id, tipo, pedido_id, contenido_hash, estado, motivo, resultado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id_operacion, terminal.id, req.usuario?.sub ?? null, op.tipo, op.pedido_id ?? resultado?.pedido_id ?? null, hash, estado, motivo, JSON.stringify(resultado ?? {})]);
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err; // llegó el mismo ID_Operacion dos veces a la vez: gana el registro del primero
  }
  if (estado === 'rechazada')
    await auditar(req, { modulo: 'ventas', accion: 'movil_conflicto', resultado: 'denegado', entidad: 'pedido', entidad_id: String(op.pedido_id ?? ''), detalle: `${op.tipo}: ${motivo}` });
  return { id_operacion, estado, ...(motivo && { motivo }), ...resultado };
};

// Estado de una operación por su ID_Operacion: el dispositivo consulta antes de reenviar (RN66).
const estadoDe = async (idOperacion) => {
  const [[o]] = await pool.query('SELECT estado, tipo, motivo, resultado, created_at FROM movil_operaciones WHERE id_operacion = ?', [idOperacion]);
  return o ? { id_operacion: idOperacion, estado: o.estado, tipo: o.tipo, motivo: o.motivo, aplicada_at: o.created_at, ...JSON.parse(o.resultado ?? '{}') } : { id_operacion: idOperacion, estado: 'desconocida' };
};

// Conflictos de sincronización: el mozo ve los suyos; el encargado y el gerente, todos.
const conflictos = async (userId, { todos = false } = {}) => (await pool.query(
  `SELECT o.id_operacion, o.tipo, o.pedido_id, o.motivo, o.resultado, o.created_at, u.username, t.nombre AS dispositivo
   FROM movil_operaciones o LEFT JOIN users u ON u.id = o.user_id LEFT JOIN terminales t ON t.id = o.terminal_id
   WHERE o.estado = 'rechazada' ${todos ? '' : 'AND o.user_id = ?'} ORDER BY o.id DESC LIMIT 200`, todos ? [] : [userId]))[0]
  .map((o) => ({ ...o, estado_actual: JSON.parse(o.resultado ?? '{}').estado_actual ?? null, resultado: undefined }));

// Latido del dispositivo. Si estuvo más de 2 minutos sin conexión avisa al supervisor de salón (EX26).
const latido = async (terminalId) => {
  const [[t]] = await pool.query("SELECT id, nombre, ultimo_contacto, TIMESTAMPDIFF(SECOND, ultimo_contacto, NOW()) AS seg FROM terminales WHERE id = ? AND tipo = 'dispositivo_movil'", [terminalId]);
  if (!t) throw invalida('Este equipo no está registrado como dispositivo móvil.', 403);
  await pool.query('UPDATE terminales SET ultimo_contacto = NOW() WHERE id = ?', [terminalId]);
  const sinConexion = t.ultimo_contacto && Number(t.seg) > 120;
  if (sinConexion)
    await Notificacion.crear({ modulo: 'ventas', tipo: 'dispositivo_sin_conexion', severidad: 'media', roles: ['encargado', 'gerente'], clave: `movil-sin-conexion:${t.id}`,
      mensaje: `El dispositivo "${t.nombre}" estuvo ${Math.round(Number(t.seg) / 60)} minutos sin conexión: revisá los pedidos que tenía sin enviar.` });
  return { ok: true, estuvo_sin_conexion: !!sinConexion };
};

module.exports = { OperacionInvalida, TIPOS, aplicar, estadoDe, conflictos, latido };
