const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const registro = require('../instancias/registro');
const Funciones = require('../funciones/servicio');
const Correo = require('../servicios/correoService');
const { cuitValido } = require('../services/padronService');
const { TiendaInvalida } = require('./tiendaService');

// Cuentas de cliente de la tienda (Ventas Online RF08): correo y contraseña, direcciones, datos fiscales y recuperación de la contraseña. Con ONL-CUENTA-CLIENTE apagada solo se compra
// como invitado. El token de una cuenta solo sirve en la tienda de su instancia y no abre ninguna ruta administrativa (otra audiencia).
const invalida = (m, status = 400, extra = {}) => Object.assign(new TiendaInvalida(m), { status, ...extra });
const FALSO = bcrypt.hashSync('no-existe', 10);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const exigir = async () => { if (!(await Funciones.estaActiva('ONL-CUENTA-CLIENTE'))) throw invalida('Las cuentas de cliente no están habilitadas: comprá como invitado.', 409, { codigo: 'FUNCION_INACTIVA' }); };

const publica = (c) => ({ id: c.id, email: c.email, nombre: c.nombre, telefono: c.telefono, direcciones: c.direcciones ? JSON.parse(c.direcciones) : [], datos_fiscales: c.datos_fiscales ? JSON.parse(c.datos_fiscales) : null, vinculada: !!c.cliente_id });
const fila = async (id) => (await pool.query('SELECT * FROM onl_clientes WHERE id = ? AND activo = 1', [id]))[0][0] ?? null;

const firmar = (c) => jwt.sign({ aud: 'tienda', cid: c.id, inst: registro.actual().codigo }, process.env.JWT_SECRET, { expiresIn: '30d' });
// -> cuenta o null. Un token de otra instancia, de otra audiencia (por ejemplo, el del personal) o vencido no sirve.
const verificar = async (token) => {
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET);
    if (p.aud !== 'tienda' || p.inst !== registro.actual().codigo) return null;
    return await fila(p.cid);
  } catch { return null; }
};

const validarPassword = (p) => { if (typeof p !== 'string' || p.length < 8 || p.length > 72) throw invalida('La contraseña tiene entre 8 y 72 caracteres.'); };

const registrar = async ({ email, password, nombre, telefono }) => {
  await exigir();
  const e = String(email ?? '').trim().toLowerCase();
  if (!EMAIL.test(e) || e.length > 120) throw invalida('El correo no es válido.');
  validarPassword(password);
  if (typeof nombre !== 'string' || !nombre.trim() || nombre.length > 100) throw invalida('Falta el nombre.');
  try {
    const [r] = await pool.query('INSERT INTO onl_clientes (email, password_hash, nombre, telefono, creado_ms) VALUES (?, ?, ?, ?, ?)', [e, await bcrypt.hash(password, 10), nombre.trim(), telefono ? String(telefono).slice(0, 40) : null, Date.now()]);
    const c = await fila(r.insertId);
    return { token: firmar(c), cuenta: publica(c) };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida('Ya hay una cuenta con ese correo.', 409, { codigo: 'EMAIL_EN_USO' });
    throw err;
  }
};

const ingresar = async ({ email, password }) => {
  await exigir();
  const [[c]] = await pool.query('SELECT * FROM onl_clientes WHERE email = ? AND activo = 1', [String(email ?? '').trim().toLowerCase()]);
  const ok = c ? await bcrypt.compare(String(password ?? ''), c.password_hash) : await bcrypt.compare(String(password ?? ''), FALSO).then(() => false); // tiempo parecido si no existe
  if (!c || !ok) throw invalida('Correo o contraseña incorrectos.', 401, { codigo: 'CREDENCIALES' });
  return { token: firmar(c), cuenta: publica(c) };
};

const actualizar = async (id, d) => {
  const c = await fila(id);
  const campos = {};
  if (d.nombre !== undefined) { if (typeof d.nombre !== 'string' || !d.nombre.trim() || d.nombre.length > 100) throw invalida('El nombre no es válido.'); campos.nombre = d.nombre.trim(); }
  if (d.telefono !== undefined) campos.telefono = d.telefono ? String(d.telefono).slice(0, 40) : null;
  if (d.direcciones !== undefined) {
    if (!Array.isArray(d.direcciones) || d.direcciones.length > 10) throw invalida('Las direcciones son una lista de hasta 10.');
    campos.direcciones = JSON.stringify(d.direcciones.map((x) => ({ etiqueta: String(x.etiqueta ?? '').slice(0, 40), calle: String(x.calle ?? '').slice(0, 150), localidad: String(x.localidad ?? '').slice(0, 80), referencia: String(x.referencia ?? '').slice(0, 150) })));
  }
  if (d.datos_fiscales !== undefined) {
    if (d.datos_fiscales === null) campos.datos_fiscales = null;
    else {
      const f = d.datos_fiscales, doc = String(f.documento ?? '').replace(/\D/g, '');
      if (f.tipo_documento === 'cuit' && !cuitValido(doc)) throw invalida('El CUIT no es válido: podés pedir factura como consumidor final.', 400, { codigo: 'CUIT_INVALIDO' }); // EX14
      if (!['cuit', 'dni'].includes(f.tipo_documento) || !doc) throw invalida('Indicá el tipo de documento (cuit o dni) y el número.');
      campos.datos_fiscales = JSON.stringify({ tipo_documento: f.tipo_documento, documento: doc, razon_social: String(f.razon_social ?? '').slice(0, 150), condicion_iva: String(f.condicion_iva ?? '').slice(0, 40), domicilio: String(f.domicilio ?? '').slice(0, 200) });
    }
  }
  const claves = Object.keys(campos);
  if (claves.length) await pool.query(`UPDATE onl_clientes SET ${claves.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...claves.map((k) => campos[k]), id]);
  return publica((await fila(id)) ?? c);
};

// Recuperar la contraseña: siempre responde igual (no revela si el correo existe) y el aviso sale por la cola de correo.
const solicitarReset = async (email) => {
  await exigir();
  const e = String(email ?? '').trim().toLowerCase();
  const [[c]] = await pool.query('SELECT id, nombre FROM onl_clientes WHERE email = ? AND activo = 1', [e]);
  if (c) {
    const token = crypto.randomBytes(24).toString('hex');
    await pool.query('UPDATE onl_clientes SET reset_hash = ?, reset_vence_ms = ? WHERE id = ?', [crypto.createHash('sha256').update(token).digest('hex'), Date.now() + 3600000, c.id]);
    await Correo.encolar({ para: e, asunto: 'Recuperá tu contraseña', cuerpo: `Hola ${c.nombre}, tu código para elegir una contraseña nueva es: ${token}\nVale una hora.` }).catch(() => {});
  }
  return { mensaje: 'Si el correo tiene una cuenta, le mandamos las instrucciones.' };
};
const restablecer = async ({ token, password }) => {
  await exigir();
  validarPassword(password);
  const h = crypto.createHash('sha256').update(String(token ?? '')).digest('hex');
  const [[c]] = await pool.query('SELECT id FROM onl_clientes WHERE reset_hash = ? AND reset_vence_ms > ? AND activo = 1', [h, Date.now()]);
  if (!c) throw invalida('El código no es válido o venció.', 400, { codigo: 'RESET_INVALIDO' });
  await pool.query('UPDATE onl_clientes SET password_hash = ?, reset_hash = NULL, reset_vence_ms = NULL WHERE id = ?', [await bcrypt.hash(password, 10), c.id]);
  return { ok: true };
};

// Administración: ver y vincular con la ficha de Clientes y CC (lista de precios del cliente, RN47).
const listar = async () => (await pool.query('SELECT id, email, nombre, telefono, cliente_id, creado_ms FROM onl_clientes ORDER BY id DESC LIMIT 300'))[0].map((c) => ({ ...c, creado_ms: Number(c.creado_ms) }));
const vincular = async (id, clienteId) => {
  if (!(await fila(id))) throw invalida('Cuenta no encontrada.', 404);
  if (clienteId !== null) {
    const [[ok]] = await pool.query('SELECT id FROM clientes WHERE id = ?', [clienteId]).catch(() => [[null]]);
    if (!ok) throw invalida('La ficha de Clientes y CC no existe.', 404);
  }
  await pool.query('UPDATE onl_clientes SET cliente_id = ? WHERE id = ?', [clienteId, id]);
  return publica(await fila(id));
};
// Lista de precios de una cuenta vinculada (la copia local de Ventas), con la prioridad «cliente» de la tienda (RN47).
const listaDe = async (cuenta) => {
  if (!cuenta?.cliente_id) return null;
  const [[t]] = await pool.query('SELECT prioridad_lista FROM onl_tienda WHERE id = 1');
  if (t.prioridad_lista !== 'cliente') return null;
  const [[a]] = await pool.query('SELECT resultante_id FROM ventas_cliente_alias WHERE alias_id = ?', [cuenta.cliente_id]);
  const [[c]] = await pool.query('SELECT lista_precio_id FROM ventas_clientes_copia WHERE cliente_id = ?', [a?.resultante_id ?? cuenta.cliente_id]);
  return c?.lista_precio_id ?? null;
};

module.exports = { registrar, ingresar, verificar, actualizar, solicitarReset, restablecer, listar, vincular, listaDe, publica, fila };
