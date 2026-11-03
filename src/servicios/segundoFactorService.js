const crypto = require('crypto');
const pool = require('../config/db');
const Funciones = require('../funciones/servicio');

// Segundo factor TOTP (Usuarios RF21, RN45, EX26, EX27): 6 dígitos que valen 30 s, con tolerancia de un período; el código se calcula
// en la aplicación del usuario y se valida acá, sin servicios externos. Cada paso se usa una sola vez (no se repite un código).
// Los 10 códigos de recuperación sirven una vez cada uno.
class SegundoFactorInvalido extends Error {}
const invalida = (m, status = 400) => Object.assign(new SegundoFactorInvalido(m), { status });

const PASO_S = 30;
const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const base32 = (buf) => { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += ALFABETO[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };
const desdeBase32 = (s) => { let bits = ''; for (const c of s) bits += ALFABETO.indexOf(c).toString(2).padStart(5, '0'); const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(bytes); };

const codigoDe = (secreto, paso) => {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(paso));
  const h = crypto.createHmac('sha1', desdeBase32(secreto)).update(msg).digest();
  const o = h[19] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, '0');
};
const pasoActual = (ahora = Date.now()) => Math.floor(ahora / 1000 / PASO_S);
// Devuelve el paso que coincide (ventana de ±1) o null.
const verificarTotp = (secreto, codigo, ahora = Date.now()) => {
  if (!/^\d{6}$/.test(String(codigo ?? ''))) return null;
  const p = pasoActual(ahora);
  for (const d of [0, -1, 1]) if (crypto.timingSafeEqual(Buffer.from(codigoDe(secreto, p + d)), Buffer.from(String(codigo)))) return p + d;
  return null;
};

const huella = (c) => crypto.createHash('sha256').update(String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
const rolesDe = async (userId) => (await pool.query('SELECT r.codigo FROM usuario_roles ur JOIN roles r ON r.id = ur.rol_id WHERE ur.user_id = ?', [userId]))[0].map((r) => r.codigo);
const rolesExigidos = async () => (await pool.query('SELECT rol_codigo FROM segundo_factor_roles ORDER BY rol_codigo'))[0].map((r) => r.rol_codigo);
const fila = async (userId) => (await pool.query('SELECT * FROM usuario_2fa WHERE user_id = ?', [userId]))[0][0] ?? null;

// ¿Hay que exigirlo a este usuario? Solo con la función activa y si alguno de sus roles está en la lista.
const exigido = async (user) => {
  if (!(await Funciones.estaActiva('USU-2FA'))) return false;
  const exigidos = new Set(await rolesExigidos());
  const roles = await rolesDe(user.id);
  if (user.rol === 'admin') roles.push('administrador');
  return roles.some((r) => exigidos.has(r));
};

// Enlazar: el servidor genera el secreto; la aplicación lo escanea y el usuario confirma con un código para activarlo (RF21).
const iniciar = async (user) => {
  const f = await fila(user.id);
  if (f?.confirmado) throw invalida('Ya tenés el segundo factor enlazado. Pedí a otro Administrador que lo restablezca para enlazarlo de nuevo.', 409);
  const secreto = base32(crypto.randomBytes(20));
  await pool.query('INSERT INTO usuario_2fa (user_id, secreto, confirmado) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE secreto = VALUES(secreto), confirmado = 0, ultimo_paso = NULL', [user.id, secreto]);
  return { secreto, uri: `otpauth://totp/Chepola:${encodeURIComponent(user.username)}?secret=${secreto}&issuer=Chepola&digits=6&period=${PASO_S}` };
};
const confirmar = async (user, codigo) => {
  const f = await fila(user.id);
  if (!f) throw invalida('Primero pedí el enlace del segundo factor.', 409);
  if (f.confirmado) throw invalida('Ya está enlazado.', 409);
  const paso = verificarTotp(f.secreto, codigo);
  if (paso === null) throw invalida('El código no es válido. Revisá la hora del teléfono y probá con el siguiente.');
  await pool.query('UPDATE usuario_2fa SET confirmado = 1, ultimo_paso = ? WHERE user_id = ?', [paso, user.id]);
  const codigos = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').toUpperCase().replace(/^(.{5})(.{5})$/, '$1-$2'));
  await pool.query('DELETE FROM usuario_2fa_recuperacion WHERE user_id = ?', [user.id]);
  await pool.query('INSERT INTO usuario_2fa_recuperacion (user_id, huella) VALUES ?', [codigos.map((c) => [user.id, huella(c)])]);
  return { enlazado: true, codigos_recuperacion: codigos, aviso: 'Guardá estos códigos: se muestran una sola vez y cada uno sirve una vez.' };
};

// Control del ingreso, después de la contraseña. Devuelve { ok } o { ok:false, motivo, ... } para que el controlador responda y audite.
//  - 'enlazar': el rol lo exige y todavía no lo enlazó: entra, pero la pantalla lo lleva a enlazarlo.
//  - 'falta_codigo': no mandó código (no cuenta como fallo). 'codigo_invalido': cuenta como intento fallido (RN04).
const controlarIngreso = async (user, codigo) => {
  if (!(await exigido(user))) return { ok: true };
  const f = await fila(user.id);
  if (!f?.confirmado) return { ok: true, debe_enlazar: true };
  if (codigo === undefined || codigo === null || codigo === '') return { ok: false, motivo: 'falta_codigo' };
  const texto = String(codigo).trim();
  if (/^\d{6}$/.test(texto)) {
    const paso = verificarTotp(f.secreto, texto);
    if (paso !== null && (f.ultimo_paso === null || paso > Number(f.ultimo_paso))) {
      // El paso se marca con una condición, para que dos ingresos simultáneos con el mismo código no pasen los dos.
      const [r] = await pool.query('UPDATE usuario_2fa SET ultimo_paso = ? WHERE user_id = ? AND (ultimo_paso IS NULL OR ultimo_paso < ?)', [paso, user.id, paso]);
      if (r.affectedRows) return { ok: true };
    }
    return { ok: false, motivo: 'codigo_invalido' };
  }
  const [r] = await pool.query('UPDATE usuario_2fa_recuperacion SET usado_en = NOW() WHERE user_id = ? AND huella = ? AND usado_en IS NULL LIMIT 1', [user.id, huella(texto)]);
  if (r.affectedRows) {
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM usuario_2fa_recuperacion WHERE user_id = ? AND usado_en IS NULL', [user.id]);
    return { ok: true, recuperacion: true, restantes: Number(n) };
  }
  return { ok: false, motivo: 'codigo_invalido' };
};

// EX27: otro Administrador restablece el factor del que perdió el dispositivo (la ruta pide que no sea el mismo usuario).
const restablecer = async (userId) => {
  const [r] = await pool.query('DELETE FROM usuario_2fa WHERE user_id = ?', [userId]);
  if (!r.affectedRows) throw invalida('Ese usuario no tiene segundo factor.', 404);
};
const estado = async (user) => {
  const f = await fila(user.id);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM usuario_2fa_recuperacion WHERE user_id = ? AND usado_en IS NULL', [user.id]);
  return { exigido: await exigido(user), enlazado: !!f?.confirmado, codigos_restantes: Number(n) };
};
const configurarRoles = async (roles) => {
  if (!Array.isArray(roles)) throw invalida('"roles" es una lista de códigos de rol.');
  const ok = new Set((await pool.query('SELECT codigo FROM roles'))[0].map((r) => r.codigo));
  const mala = roles.find((r) => !ok.has(r));
  if (mala) throw invalida(`El rol "${mala}" no existe.`);
  await pool.query('DELETE FROM segundo_factor_roles');
  if (roles.length) await pool.query('INSERT INTO segundo_factor_roles (rol_codigo) VALUES ?', [roles.map((r) => [r])]);
  return rolesExigidos();
};

module.exports = { SegundoFactorInvalido, codigoDe, pasoActual, verificarTotp, iniciar, confirmar, controlarIngreso, restablecer, estado, rolesExigidos, configurarRoles, base32 };
