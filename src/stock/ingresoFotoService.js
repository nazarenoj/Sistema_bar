const pool = require('../config/db');
const Mov = require('./movimientoService');
const Presentacion = require('../models/presentacionModel');
const { idGlobal } = require('../utils/idGlobal');

// Ingreso por foto (Stock RF05, EX03): la imagen o el PDF de una factura o remito se guarda y se lee con el servicio de Lectura de
// Comprobantes de la plataforma (Usuarios RF15). El resultado es un borrador para revisar: no toca el stock hasta que un usuario lo confirma.
// Sin servicio de lectura (hoy no existe) el borrador queda "pendiente de lectura" y se completa a mano o desde el QR fiscal.
class BorradorInvalido extends Error {}
const invalido = (m, status = 400) => Object.assign(new BorradorInvalido(m), { status });

const TIPOS = ['image/jpeg', 'image/png', 'application/pdf'];
let lector = async () => null; // shortcut: sin servicio de lectura de la plataforma; `usarLector` lo conecta cuando exista
const usarLector = (fn) => { lector = fn; };

const normalizar = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const claveEq = (cuit, descripcion) => `${cuit ?? ''}|${normalizar(descripcion)}`.slice(0, 260);

const enBorrador = (f, conImagen = false) => ({
  id: f.id, id_global: f.id_global, estado: f.estado, imagen_tipo: f.imagen_tipo, imagen_nombre: f.imagen_nombre, deposito_id: f.deposito_id,
  encabezado: f.encabezado ? JSON.parse(f.encabezado) : null, lineas: f.lineas ? JSON.parse(f.lineas) : [], ingreso_id_global: f.ingreso_id_global, created_at: f.created_at,
  ...(conImagen && { imagen: f.imagen }),
});
const cargar = async (id, conn = pool, bloquear = false) => {
  const [[f]] = await conn.query(`SELECT * FROM ingreso_borradores WHERE id = ? ${bloquear ? 'FOR UPDATE' : ''}`, [id]);
  if (!f) throw invalido('Borrador no encontrado.', 404);
  return f;
};

// Propone el ítem y la presentación de cada línea a partir de lo que ya se asoció antes con ese proveedor.
const proponer = async (encabezado, lineas) => {
  const cuit = encabezado?.cuit ?? null;
  const salida = [];
  for (const l of lineas) {
    const [[eq]] = await pool.query('SELECT item_tipo, item_id, presentacion_id FROM equivalencias_stock WHERE clave = ?', [claveEq(cuit, l.descripcion)]);
    salida.push(eq && !l.item ? { ...l, item: { tipo: eq.item_tipo, id: eq.item_id }, presentacion_id: eq.presentacion_id ?? l.presentacion_id ?? null, reconocida: true } : l);
  }
  return salida;
};

const crear = async ({ imagen, tipo, nombre, deposito_id }, { userId } = {}) => {
  if (!TIPOS.includes(tipo)) throw invalido(`El archivo debe ser una imagen JPG o PNG, o un PDF.`);
  if (!Buffer.isBuffer(imagen) || !imagen.length) throw invalido('Falta la imagen del comprobante.');
  const max = Number((await pool.query("SELECT valor FROM parametros WHERE clave = 'ingreso_foto_max_mb'"))[0][0]?.valor ?? 8);
  if (imagen.length > max * 1024 * 1024) throw invalido(`El archivo supera los ${max} MB.`, 413);
  let lectura = null;
  try { lectura = await lector({ imagen, tipo }); } catch { lectura = null; } // servicio caído: igual que sin servicio (EX03)
  const lineas = lectura ? await proponer(lectura.encabezado, lectura.lineas ?? []) : null;
  const [r] = await pool.query(
    'INSERT INTO ingreso_borradores (id_global, estado, imagen, imagen_tipo, imagen_nombre, encabezado, lineas, deposito_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [await idGlobal(), lectura ? 'borrador' : 'pendiente_lectura', imagen, tipo, nombre ?? null, lectura ? JSON.stringify(lectura.encabezado ?? {}) : null, lineas ? JSON.stringify(lineas) : null, deposito_id ?? null, userId ?? null]);
  return obtener(r.insertId);
};

const obtener = async (id) => enBorrador(await cargar(id));
const imagen = async (id) => { const f = await cargar(id); return { imagen: f.imagen, tipo: f.imagen_tipo, nombre: f.imagen_nombre }; };
const listar = async ({ estado } = {}) => (await pool.query(
  `SELECT id, id_global, estado, imagen_tipo, imagen_nombre, deposito_id, created_at FROM ingreso_borradores ${estado ? 'WHERE estado = ?' : ''} ORDER BY id DESC LIMIT 200`, estado ? [estado] : []))[0];

// Carga el resultado de la lectura (o el encabezado y las líneas a mano, o desde el QR): deja el borrador listo para revisar.
const cargarLectura = async (id, { encabezado, lineas }) => {
  const f = await cargar(id);
  if (!['pendiente_lectura', 'borrador'].includes(f.estado)) throw invalido('El borrador ya fue confirmado o descartado.', 409);
  if (!Array.isArray(lineas) || !lineas.length) throw invalido('Indicá al menos una línea.');
  for (const l of lineas) if (!(Number(l.cantidad) > 0)) throw invalido('La cantidad de cada línea debe ser mayor que cero.');
  const propuestas = await proponer(encabezado, lineas);
  await pool.query("UPDATE ingreso_borradores SET estado = 'borrador', encabezado = ?, lineas = ? WHERE id = ?", [JSON.stringify(encabezado ?? {}), JSON.stringify(propuestas), id]);
  return obtener(id);
};

// Asocia una línea no reconocida a un ítem (y presentación) y lo recuerda para las próximas lecturas de ese proveedor.
const asociar = async (id, n, { item, presentacion_id }) => {
  const f = await cargar(id);
  if (f.estado !== 'borrador') throw invalido('Solo se asocian líneas de un borrador leído.', 409);
  const b = enBorrador(f);
  const linea = b.lineas[n];
  if (!linea) throw invalido('La línea no existe.', 404);
  if (!['insumo', 'producto'].includes(item?.tipo) || !(await pool.query(`SELECT 1 FROM ${item.tipo === 'insumo' ? 'insumos' : 'productos'} WHERE id = ?`, [item.id]))[0].length) throw invalido('El ítem no existe.', 404);
  if (presentacion_id) {
    const p = await Presentacion.getById(presentacion_id);
    if (!p || item.tipo !== 'insumo' || p.insumo_id !== item.id) throw invalido('La presentación no es del ítem.');
  }
  b.lineas[n] = { ...linea, item, presentacion_id: presentacion_id ?? null, reconocida: false };
  await pool.query('UPDATE ingreso_borradores SET lineas = ? WHERE id = ?', [JSON.stringify(b.lineas), id]);
  if (linea.descripcion)
    await pool.query(
      `INSERT INTO equivalencias_stock (clave, proveedor_cuit, descripcion, item_tipo, item_id, presentacion_id) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE item_tipo = VALUES(item_tipo), item_id = VALUES(item_id), presentacion_id = VALUES(presentacion_id)`,
      [claveEq(b.encabezado?.cuit, linea.descripcion), b.encabezado?.cuit ?? null, String(linea.descripcion).slice(0, 200), item.tipo, item.id, presentacion_id ?? null]);
  return obtener(id);
};

// Recién acá se mueve el stock: todas las líneas con ítem, un solo ingreso, la imagen queda adjunta.
const confirmar = async (id, { deposito_id } = {}, { userId } = {}) => {
  const f = await cargar(id);
  if (f.estado !== 'borrador') throw invalido('El borrador no está listo para confirmar (falta la lectura, o ya se confirmó o descartó).', 409);
  const b = enBorrador(f);
  const sin = b.lineas.map((l, n) => (l.item ? null : n + 1)).filter(Boolean);
  if (sin.length) throw invalido(`Asociá un ítem a las líneas: ${sin.join(', ')}.`);
  const lineas = [];
  for (const l of b.lineas) {
    const p = l.presentacion_id ? await Presentacion.getById(l.presentacion_id) : null;
    lineas.push({ item: l.item, cantidad: l.cantidad, presentacion_id: l.presentacion_id ?? undefined, lote: l.lote ?? undefined,
      costo_unitario: l.costo === undefined || l.costo === null ? undefined : p ? Number(l.costo) / Number(p.factor) : Number(l.costo) }); // el costo del comprobante es por presentación
  }
  const e = b.encabezado ?? {};
  const r = await Mov.ingresar({ deposito_id: deposito_id ?? f.deposito_id ?? undefined, motivo: 'compra', proveedor: e.proveedor, lineas,
    comprobante: e.numero ? { cuit: e.cuit, clase: e.clase, tipo: e.tipo, punto_venta: e.punto_venta, numero: e.numero, cae: e.cae } : undefined }, { userId });
  await pool.query("UPDATE ingreso_borradores SET estado = 'confirmado', ingreso_id_global = ?, confirmado_at = NOW() WHERE id = ?", [r.id_global, id]);
  await pool.query('UPDATE stock_ingresos SET imagen_borrador_id = ? WHERE id_global = ?', [id, r.id_global]);
  return { borrador: await obtener(id), ingreso: r };
};

const descartar = async (id) => {
  const f = await cargar(id);
  if (f.estado === 'confirmado') throw invalido('El borrador ya se confirmó.', 409);
  await pool.query("UPDATE ingreso_borradores SET estado = 'descartado' WHERE id = ?", [id]);
  return obtener(id);
};

module.exports = { BorradorInvalido, usarLector, crear, obtener, imagen, listar, cargarLectura, asociar, confirmar, descartar };
