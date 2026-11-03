const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const mysql = require('mysql2/promise');
const pool = require('../config/db');
const registro = require('../instancias/registro');
const Notificacion = require('../models/notificacionModel');
const { version: VERSION } = require('../../package.json');

// Copias de seguridad y restauración de la instancia completa (Usuarios RF11, RF12, RN13 a RN16, EX07 a EX09).
// La copia es un volcado lógico de todas las tablas (instantánea consistente), comprimido y cifrado con AES-256-GCM
// con una clave derivada (scrypt) de la que se define al configurarlas. La cabecera (fecha, versión, módulos) va en
// claro pero autenticada, para mostrarla antes de restaurar. La restauración es siempre de la instancia completa.
// shortcut: el volcado se arma en memoria (sirve para cafeterías, no para bases de varios GB); pasar a flujo por tabla
// si una instancia crece. Una copia se restaura en la misma instancia: subir un archivo de otra no está.
class CopiaInvalida extends Error {}
const invalida = (m, status = 400, codigo) => Object.assign(new CopiaInvalida(m), { status, codigo });

const MAGIA = Buffer.from('CHPCOP01');
const FUERA = new Set(['schema_migrations', 'copias_seguridad', 'copias_configuracion']); // ni se copian ni se pisan al restaurar
const AL_FINAL = ['pedidos']; // un trigger de pedido_productos toca pedidos al insertar: se restaura última para que no le cambie la versión
const LOTE = 500;

const carpeta = () => {
  const dir = path.join(process.env.COPIAS_DIR || path.resolve('copias'), registro.actual().codigo);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const claveDeEntorno = () => process.env[`COPIAS_CLAVE_${registro.actual().codigo}`] || process.env.COPIAS_CLAVE || null;
const kdf = (clave, salt) => crypto.scryptSync(clave, salt, 32);
const verificadorDe = (clave, saltHex) => crypto.createHash('sha256').update(kdf(clave, Buffer.from(saltHex, 'hex'))).update('verificador').digest('hex');

const parametro = async (clave, def) => Number((await pool.query('SELECT valor FROM parametros WHERE clave = ?', [clave]))[0][0]?.valor ?? def);
const fijar = (clave, valor) => pool.query('INSERT INTO parametros (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [clave, String(valor)]);

// RN13: la clave se define al configurar; solo se guarda un verificador, nunca la clave. Sin ella no se restaura.
const configurarClave = async (clave) => {
  if (typeof clave !== 'string' || clave.length < 12) throw invalida('La clave de cifrado tiene que tener al menos 12 caracteres.');
  const salt = crypto.randomBytes(16).toString('hex');
  await pool.query('INSERT INTO copias_configuracion (id, salt, verificador) VALUES (1, ?, ?) ON DUPLICATE KEY UPDATE salt = VALUES(salt), verificador = VALUES(verificador)', [salt, verificadorDe(clave, salt)]);
  return { configurada: true, advertencia: 'Guardá esta clave en un lugar seguro: sin ella las copias no se pueden restaurar y el sistema no puede recuperarla. Las copias anteriores siguen necesitando la clave con la que se hicieron.' };
};
const claveConfigurada = async () => !!(await pool.query('SELECT 1 FROM copias_configuracion WHERE id = 1'))[0].length;
// Si hay verificador, una clave distinta de la configurada se rechaza antes de hacer nada.
const resolverClave = async (clave) => {
  const k = clave || claveDeEntorno();
  if (!k) throw invalida('Falta la clave de cifrado de las copias.', 400, 'SIN_CLAVE');
  const [[cfg]] = await pool.query('SELECT * FROM copias_configuracion WHERE id = 1');
  if (cfg && verificadorDe(k, cfg.salt) !== cfg.verificador) throw invalida('La clave no es la configurada para las copias.', 400, 'CLAVE_INCORRECTA');
  return k;
};

// ---- volcado y aplicación ----
const conexionPropia = () => { const i = registro.actual(); return mysql.createConnection({ ...i.conexion, database: i.db, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true }); };
const codificar = (v) => (Buffer.isBuffer(v) ? { $b: v.toString('base64') } : v);
const decodificar = (v) => (v && typeof v === 'object' && '$b' in v ? Buffer.from(v.$b, 'base64') : (v && typeof v === 'object' ? JSON.stringify(v) : v));
const tablasDe = async (c) => (await c.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY 1"))[0].map((r) => r.t).filter((t) => !FUERA.has(t));

const volcar = async () => {
  const c = await conexionPropia();
  try {
    await c.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    const tablas = {}; let filas = 0;
    for (const t of await tablasDe(c)) {
      const [rows, fields] = await c.query({ sql: `SELECT * FROM \`${t}\``, rowsAsArray: true });
      tablas[t] = { columnas: fields.map((f) => f.name), filas: rows.map((r) => r.map(codificar)) };
      filas += rows.length;
    }
    const [[m]] = await c.query('SELECT MAX(version) AS v FROM schema_migrations');
    await c.query('COMMIT');
    return { tablas, filas, migracion: m.v };
  } finally { await c.end(); }
};

const aplicar = async (tablas) => {
  const c = await conexionPropia();
  try {
    await c.query('SET FOREIGN_KEY_CHECKS = 0');
    await c.query("SET SESSION sql_mode = REPLACE(REPLACE(@@sql_mode, 'NO_ZERO_DATE', ''), 'NO_ZERO_IN_DATE', '')");
    const actuales = await tablasDe(c);
    const orden = [...actuales.filter((t) => !AL_FINAL.includes(t)), ...actuales.filter((t) => AL_FINAL.includes(t))];
    for (const t of orden) {
      await c.query(`TRUNCATE TABLE \`${t}\``);
      const d = tablas[t];
      if (!d?.filas.length) continue;
      const [cols] = await c.query("SELECT column_name AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND extra NOT LIKE '%GENERATED%'", [t]);
      const vigentes = new Set(cols.map((x) => x.n));
      const idx = d.columnas.map((n, i) => (vigentes.has(n) ? i : -1)).filter((i) => i >= 0);
      const lista = idx.map((i) => `\`${d.columnas[i]}\``).join(', ');
      for (let o = 0; o < d.filas.length; o += LOTE)
        await c.query(`INSERT INTO \`${t}\` (${lista}) VALUES ?`, [d.filas.slice(o, o + LOTE).map((f) => idx.map((i) => decodificar(f[i])))]);
    }
    await c.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally { await c.end(); }
};

// ---- archivo ----
const modulosDe = (tablas) => ['usuarios', tablas.ventas && 'ventas', tablas.stock_movimientos && 'stock'].filter(Boolean).join(',');
const cifrar = (cabecera, payload, clave) => {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const cab = Buffer.from(JSON.stringify({ ...cabecera, salt: salt.toString('hex'), iv: iv.toString('hex') }));
  const largo = Buffer.alloc(4); largo.writeUInt32BE(cab.length);
  const cif = crypto.createCipheriv('aes-256-gcm', kdf(clave, salt), iv);
  cif.setAAD(cab);
  const cuerpo = Buffer.concat([cif.update(zlib.gzipSync(payload)), cif.final()]);
  return Buffer.concat([MAGIA, largo, cab, cif.getAuthTag(), cuerpo]);
};
const leerCabecera = (buf) => {
  if (buf.length < 12 || !buf.subarray(0, 8).equals(MAGIA)) throw invalida('El archivo no es una copia de este sistema.', 400, 'COPIA_INVALIDA');
  const largo = buf.readUInt32BE(8);
  return { cab: buf.subarray(12, 12 + largo), cabecera: JSON.parse(buf.subarray(12, 12 + largo).toString()), resto: buf.subarray(12 + largo) };
};
const descifrar = (buf, clave) => {
  const { cab, cabecera, resto } = leerCabecera(buf);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', kdf(clave, Buffer.from(cabecera.salt, 'hex')), Buffer.from(cabecera.iv, 'hex'));
    d.setAAD(cab); d.setAuthTag(resto.subarray(0, 16));
    return { cabecera, datos: JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(resto.subarray(16)), d.final()])).toString()) };
  } catch { throw invalida('La clave es incorrecta o la copia está dañada. No se modificó ningún dato.', 400, 'CLAVE_INCORRECTA'); }
};

const ruta = (c) => path.join(carpeta(), c.nombre);
const porId = async (id) => (await pool.query('SELECT * FROM copias_seguridad WHERE id = ?', [id]))[0][0] ?? null;
const sellos = (d = new Date()) => { const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

// Verifica una copia ya escrita (RF11): el archivo coincide con su huella, se descifra y trae las mismas tablas y filas.
// Si falla queda "inválida", se alerta y (si es automática) se hace una nueva (EX07).
const verificar = async (id, clave) => {
  const c = await porId(id);
  if (!c) throw invalida('Copia no encontrada.', 404);
  let ok = false, detalle = '';
  try {
    const buf = fs.readFileSync(ruta(c));
    if (crypto.createHash('sha256').update(buf).digest('hex') !== c.huella) throw new Error('la huella del archivo no coincide');
    const { datos } = descifrar(buf, await resolverClave(clave));
    const n = Object.values(datos.tablas).reduce((s, t) => s + t.filas.length, 0);
    if (Object.keys(datos.tablas).length !== c.tablas || n !== Number(c.filas)) throw new Error('el contenido no coincide con el registro');
    ok = true;
  } catch (e) { detalle = e.message; }
  await pool.query('UPDATE copias_seguridad SET estado = ? WHERE id = ?', [ok ? 'valida' : 'invalida', id]);
  if (!ok) await Notificacion.crear({ modulo: 'usuarios', tipo: 'copia_invalida', severidad: 'alta', roles: ['administrador'], clave: `copia-invalida-${id}`, mensaje: `La copia ${c.nombre} no pasó la verificación (${detalle}).` });
  return { id, valida: ok, detalle };
};

const generar = async ({ tipo = 'manual', clave, userId = null, reintento = true } = {}) => {
  const k = await resolverClave(clave);
  const { tablas, filas, migracion } = await volcar();
  const modulos = modulosDe(tablas);
  const buf = cifrar({ version_sistema: VERSION, instancia: registro.actual().codigo, fecha: new Date().toISOString(), modulos, migracion, tablas: Object.keys(tablas).length, filas }, JSON.stringify({ tablas }), k);
  const nombre = `copia-${sellos()}-${crypto.randomBytes(2).toString('hex')}.chpcopia`;
  fs.writeFileSync(path.join(carpeta(), nombre), buf);
  const [r] = await pool.query('INSERT INTO copias_seguridad (nombre, tipo, version_sistema, modulos, tablas, filas, bytes, huella, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [nombre, tipo, VERSION, modulos, Object.keys(tablas).length, filas, buf.length, crypto.createHash('sha256').update(buf).digest('hex'), userId]);
  const v = await verificar(r.insertId, k);
  if (!v.valida && tipo === 'automatica' && reintento) return generar({ tipo, clave, userId, reintento: false }); // EX07: genera una nueva
  if (!v.valida) throw invalida(`La copia se generó pero no pasó la verificación: ${v.detalle}.`, 500);
  return porId(r.insertId);
};

const listar = async () => (await pool.query('SELECT * FROM copias_seguridad ORDER BY creada_en DESC, id DESC'))[0].map((c) => ({ ...c, retenida: !!c.retenida }));

// Lo que se muestra antes de restaurar: fecha, versión y módulos (RF12). No pide clave: la cabecera está en claro.
const detalle = async (id) => {
  const c = await porId(id);
  if (!c) throw invalida('Copia no encontrada.', 404);
  const { cabecera } = leerCabecera(fs.readFileSync(ruta(c)));
  return { id: c.id, nombre: c.nombre, estado: c.estado, fecha: cabecera.fecha, version_sistema: cabecera.version_sistema, modulos: cabecera.modulos.split(','), tablas: cabecera.tablas, filas: cabecera.filas };
};

const archivo = async (id) => {
  const c = await porId(id);
  if (!c || !fs.existsSync(ruta(c))) throw invalida('Copia no encontrada.', 404);
  return { ruta: ruta(c), nombre: c.nombre };
};
const retener = async (id, retenida) => { if (!(await porId(id))) throw invalida('Copia no encontrada.', 404); await pool.query('UPDATE copias_seguridad SET retenida = ? WHERE id = ?', [retenida ? 1 : 0, id]); return porId(id); };

// Retención de las automáticas (RF11): las más nuevas de cada día, semana y mes hasta los topes configurados.
const claveSemana = (d) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.toDateString(); };
const aplicarRetencion = async () => {
  const topes = [[(d) => new Date(d).toDateString(), await parametro('copia_retener_diarias', 7)], [claveSemana, await parametro('copia_retener_semanales', 4)],
    [(d) => { const x = new Date(d); return `${x.getFullYear()}-${x.getMonth()}`; }, await parametro('copia_retener_mensuales', 12)]];
  const [autos] = await pool.query("SELECT * FROM copias_seguridad WHERE tipo = 'automatica' AND estado = 'valida' ORDER BY creada_en DESC, id DESC");
  const quedan = new Set(autos.filter((c) => c.retenida).map((c) => c.id));
  for (const [clave, n] of topes) {
    const vistas = new Set();
    for (const c of autos) { const k = clave(c.creada_en); if (vistas.has(k)) continue; if (vistas.size >= n) break; vistas.add(k); quedan.add(c.id); }
  }
  let borradas = 0;
  for (const c of autos.filter((x) => !quedan.has(x.id))) {
    try { fs.unlinkSync(ruta(c)); } catch { /* ya no estaba */ }
    await pool.query('DELETE FROM copias_seguridad WHERE id = ?', [c.id]);
    borradas++;
  }
  return borradas;
};

// Tarea periódica (a la hora configurada genera la copia automática) y alerta si pasaron más de 24 h sin una válida (RN16).
const mantenimiento = async ({ ahora = new Date() } = {}) => {
  const [[ult]] = await pool.query("SELECT MAX(creada_en) AS f FROM copias_seguridad WHERE tipo = 'automatica' AND estado = 'valida'");
  const horas = ult.f ? (ahora - new Date(ult.f)) / 3600000 : Infinity;
  const frecuencia = await parametro('copia_frecuencia_horas', 24), hora = await parametro('copia_hora', 2);
  let generada = null;
  if (horas >= frecuencia && (ahora.getHours() >= hora || horas === Infinity)) {
    try { generada = await generar({ tipo: 'automatica' }); await aplicarRetencion(); } catch (e) {
      await Notificacion.crear({ modulo: 'usuarios', tipo: 'copia_fallida', severidad: 'alta', roles: ['administrador'], clave: 'copia-fallida', mensaje: `No se pudo generar la copia automática: ${e.message}` });
    }
  }
  const [[nueva]] = await pool.query("SELECT MAX(creada_en) AS f FROM copias_seguridad WHERE tipo = 'automatica' AND estado = 'valida'");
  const atraso = nueva.f ? (ahora - new Date(nueva.f)) / 3600000 : Infinity;
  if (atraso > await parametro('copia_alerta_horas', 24))
    await Notificacion.crear({ modulo: 'usuarios', tipo: 'copia_atrasada', severidad: 'alta', roles: ['administrador'], clave: 'copia-atrasada', mensaje: 'Hace más de 24 horas que no hay una copia automática válida.' });
  else await Notificacion.resolverPorClave('copia-atrasada', 'Hay una copia automática reciente');
  return { generada, atraso_horas: atraso };
};

// ---- restauración (RF12, RN14, RN15, RN78) ----
const migracionActual = async () => (await pool.query('SELECT MAX(version) AS v FROM schema_migrations'))[0][0].v;
const posteriores = async (desde) => {
  const r = {};
  for (const t of ['ventas', 'facturas', 'stock_movimientos']) {
    const [[col]] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'created_at'", [t]);
    if (col.n) r[t] = Number((await pool.query(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE created_at > ?`, [desde]))[0][0].n);
  }
  return r;
};

const restaurar = async ({ id, clave, confirmacion, actor = {} }) => {
  if (confirmacion !== 'RESTAURAR') throw invalida('Para restaurar escribí RESTAURAR en la confirmación.', 400, 'SIN_CONFIRMACION');
  const c = await porId(id);
  if (!c || !fs.existsSync(ruta(c))) throw invalida('Copia no encontrada.', 404);
  if (c.estado !== 'valida') throw invalida('La copia está marcada como inválida: no se puede restaurar.', 409, 'COPIA_INVALIDA');
  if (await parametro('restauracion_en_curso', 0) === 1) throw invalida('Ya hay una restauración en curso.', 423, 'RESTAURACION');
  const k = await resolverClave(clave);
  // Todo lo que puede fallar sin tocar datos va antes: versión (EX08) y clave (EX09).
  const { cabecera, datos } = descifrar(fs.readFileSync(ruta(c)), k);
  if (Number(cabecera.migracion) > Number(await migracionActual()))
    throw invalida(`La copia es de la versión ${cabecera.version_sistema}, más nueva que esta (${VERSION}). Actualizá el sistema a esa versión o superior antes de restaurar.`, 409, 'VERSION_INCOMPATIBLE');
  const perdidas = await posteriores(cabecera.fecha.slice(0, 19).replace('T', ' ')).catch(() => ({}));
  const [[{ v: vAntes }]] = await pool.query('SELECT version_configuracion AS v FROM configuracion_instancia WHERE id = 1');

  await fijar('restauracion_en_curso', 1);
  let previa;
  try {
    await pool.query("UPDATE sesiones SET fin = NOW(), motivo_fin = 'forzado' WHERE fin IS NULL");
    previa = await generar({ tipo: 'previa', clave: k, userId: actor.id ?? null });
    try { await aplicar(datos.tablas); } catch (err) {
      await aplicar(descifrar(fs.readFileSync(ruta(previa)), k).datos.tablas); // vuelve a como estaba
      throw invalida(`No se pudo restaurar (${err.message}); la instancia volvió al estado anterior.`, 500);
    }
  } finally { await fijar('restauracion_en_curso', 0); }

  // RN74: la versión de configuración no retrocede. RN14: se descartan los candados de numeración y los intentos sin cerrar
  // pasan a indeterminados; no se emite fiscalmente hasta que Ventas valide la numeración con ARCA.
  await pool.query('UPDATE configuracion_instancia SET version_configuracion = GREATEST(version_configuracion, ?) WHERE id = 1', [vAntes]);
  await pool.query("UPDATE sesiones SET fin = NOW(), motivo_fin = 'forzado' WHERE fin IS NULL");
  await pool.query("UPDATE intento_emision SET estado = 'indeterminado' WHERE estado IN ('solicitado', 'indeterminado')");
  await pool.query("INSERT IGNORE INTO secuenciador_claves (clave, estado, vence_ms) SELECT DISTINCT CONCAT(punto_venta, ':', tipo_comprobante, ':CAE'), 'libre', 0 FROM facturas WHERE punto_venta IS NOT NULL");
  await pool.query("UPDATE secuenciador_claves SET estado = 'resolviendo', propietario = NULL, vence_ms = 0");
  await fijar('sincronizacion_fiscal_pendiente', 1);
  await Notificacion.crear({ modulo: 'usuarios', tipo: 'restauracion', severidad: 'alta', roles: ['administrador'], clave: 'restauracion-fiscal', mensaje: 'Se restauró una copia: la emisión fiscal queda bloqueada hasta validar la numeración con ARCA (las ventas siguen como no fiscales).' });
  return { restaurada: c.nombre, fecha_copia: cabecera.fecha, version_copia: cabecera.version_sistema, copia_previa: previa.nombre, operaciones_posteriores_perdidas: perdidas, reingresar: true, emision_fiscal_bloqueada: true };
};

module.exports = { CopiaInvalida, configurarClave, claveConfigurada, generar, verificar, listar, detalle, archivo, retener, aplicarRetencion, mantenimiento, restaurar };
