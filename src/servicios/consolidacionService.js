const crypto = require('crypto');
const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const Modulos = require('../modulos/registro');
const Notificacion = require('../models/notificacionModel');
const { version: VERSION } = require('../../package.json');

// Consolidación de sucursales (Usuarios RF20, RN38 a RN44, EX20 a EX25). Cada módulo registra el paquete que publica; la sucursal los
// firma con Ed25519 y la Casa Central los importa de solo lectura, idempotente y con control de faltantes. No sincroniza usuarios,
// clientes ni catálogo: los paquetes llevan solo importes y cantidades agregados (RN41).
// shortcut: la clave privada de la sucursal vive en su base (sin cifrar); guardarla cifrada con la clave de las copias si se endurece. El
// envío automático es un POST con reintento; sin cola de mensajes aparte.
class ConsolidacionInvalida extends Error {}
const invalida = (m, status = 400, codigo) => Object.assign(new ConsolidacionInvalida(m), { status, codigo });
const generadores = new Map(); // modulo -> { funcion?, generar(periodo) -> contenido agregado }
const registrarPaquete = (modulo, def) => generadores.set(modulo, def);
const mayor = (v) => Number(String(v).split('.')[0]);
const esFecha = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f ?? '') && !Number.isNaN(new Date(`${f}T00:00:00`).getTime());

// JSON canónico (claves ordenadas) para que la huella y la firma no dependan del orden.
const canonico = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((c) => [c, x[c]])) : x));
const huellaDe = (contenido) => crypto.createHash('sha256').update(canonico(contenido)).digest('hex');
const firmado = (s) => canonico({ sucursal: s.sucursal, modulo: s.modulo, periodo: s.periodo, version: s.version, version_sistema: s.version_sistema, huella: s.huella });

const config = async () => (await pool.query('SELECT * FROM consolidacion_config WHERE id = 1'))[0][0];
const codigoInstancia = async () => (await pool.query('SELECT codigo_instancia AS c FROM configuracion_instancia WHERE id = 1'))[0][0]?.c;

// RN38: marcar la instancia requiere el permiso (lo pide la ruta) y queda auditado allá. Genera el par de claves al ser sucursal.
const configurar = async ({ sucursal, casa_central, destino_url }) => {
  if (typeof sucursal !== 'boolean' || typeof casa_central !== 'boolean') throw invalida('"sucursal" y "casa_central" son verdadero o falso.');
  if (destino_url && !/^https?:\/\//.test(destino_url)) throw invalida('La dirección de envío tiene que empezar con http:// o https://.');
  if (sucursal && !(await codigoInstancia())) throw invalida('La instancia todavía no tiene código: hacé el alta primero.', 409);
  const c = await config();
  let { clave_publica: pub, clave_privada: priv } = c;
  if (sucursal && !pub) {
    const par = crypto.generateKeyPairSync('ed25519');
    pub = par.publicKey.export({ type: 'spki', format: 'pem' });
    priv = par.privateKey.export({ type: 'pkcs8', format: 'pem' });
  }
  await pool.query('UPDATE consolidacion_config SET es_sucursal = ?, es_casa_central = ?, clave_publica = ?, clave_privada = ?, destino_url = ? WHERE id = 1', [sucursal ? 1 : 0, casa_central ? 1 : 0, pub, priv, destino_url || null]);
  return estado();
};
const estado = async () => { const c = await config(); return { codigo: await codigoInstancia(), sucursal: !!c.es_sucursal, casa_central: !!c.es_casa_central, clave_publica: c.clave_publica, destino_url: c.destino_url }; };

// ---------- Sucursal: generar y enviar ----------
const publicar = async ({ periodo, modulo } = {}) => {
  const c = await config();
  if (!c.es_sucursal) throw invalida('Esta instancia no está marcada como sucursal.', 409);
  if (!esFecha(periodo)) throw invalida('El período va como AAAA-MM-DD.');
  if (new Date(`${periodo}T00:00:00`) >= new Date(new Date().toDateString())) throw invalida('El período tiene que haber terminado: el paquete es del cierre.', 409);
  const codigo = await codigoInstancia();
  const hechos = [];
  for (const [mod, def] of generadores) {
    if (modulo && mod !== modulo) continue;
    if (!(await Modulos.estaInstalado(mod)) || (def.funcion && !(await Funciones.estaActiva(def.funcion)))) continue; // RN43: no se publica lo que no está instalado
    const contenido = await def.generar(periodo);
    const huella = huellaDe(contenido);
    const [[ult]] = await pool.query('SELECT version, huella FROM paquetes_publicados WHERE modulo = ? AND periodo = ? ORDER BY version DESC LIMIT 1', [mod, periodo]);
    if (ult?.huella === huella) { hechos.push({ modulo: mod, periodo, version: ult.version, nuevo: false }); continue; } // idempotente: mismo contenido, mismo paquete
    const version = (ult?.version ?? 0) + 1;
    const cuerpo = { sucursal: codigo, modulo: mod, periodo, version, version_sistema: VERSION, huella };
    const firma = crypto.sign(null, Buffer.from(firmado(cuerpo)), c.clave_privada).toString('base64');
    const id_paquete = `${codigo}-${mod}-${periodo}-v${version}`;
    await pool.query('INSERT INTO paquetes_publicados (id_paquete, modulo, periodo, version, huella, sobre) VALUES (?, ?, ?, ?, ?, ?)',
      [id_paquete, mod, periodo, version, huella, JSON.stringify({ id_paquete, ...cuerpo, contenido, firma })]);
    hechos.push({ modulo: mod, periodo, version, id_paquete, nuevo: true });
  }
  return hechos;
};
const publicados = async () => (await pool.query('SELECT id, id_paquete, modulo, periodo, version, huella, enviado_en, intentos, ultimo_error FROM paquetes_publicados ORDER BY periodo DESC, modulo, version DESC LIMIT 500'))[0];
const sobreDe = async (id) => {
  const [[p]] = await pool.query('SELECT sobre FROM paquetes_publicados WHERE id = ?', [id]);
  if (!p) throw invalida('Paquete no encontrado.', 404);
  return JSON.parse(p.sobre);
};

// Envío automático (EX24): sin conexión queda en cola con reintento y se puede exportar como archivo. `enviar` se reemplaza en las pruebas.
let enviar = async (url, sobre) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Instancia': sobre.destino ?? '' }, body: JSON.stringify(sobre), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`la Casa Central respondió ${r.status}`);
};
const usarEnvio = (fn) => { enviar = fn; };
const enviarPendientes = async () => {
  const c = await config();
  if (!c.es_sucursal || !c.destino_url) return [];
  const [pend] = await pool.query('SELECT id, sobre FROM paquetes_publicados WHERE enviado_en IS NULL ORDER BY periodo, id LIMIT 50');
  const res = [];
  for (const p of pend) {
    try { await enviar(c.destino_url, JSON.parse(p.sobre)); await pool.query('UPDATE paquetes_publicados SET enviado_en = NOW(), intentos = intentos + 1, ultimo_error = NULL WHERE id = ?', [p.id]); res.push({ id: p.id, ok: true }); } catch (err) {
      await pool.query('UPDATE paquetes_publicados SET intentos = intentos + 1, ultimo_error = ? WHERE id = ?', [String(err.message).slice(0, 255), p.id]);
      res.push({ id: p.id, ok: false, error: err.message });
    }
  }
  return res;
};

// ---------- Casa Central: sucursales e importación ----------
const registrarSucursal = async ({ codigo, nombre, clave_publica, modulos, desde }) => {
  if (!/^[A-Z0-9]{2,10}$/.test(codigo ?? '')) throw invalida('El código de la sucursal son 2 a 10 letras mayúsculas o números.');
  if (typeof nombre !== 'string' || !nombre.trim()) throw invalida('El nombre es obligatorio.');
  try { crypto.createPublicKey(clave_publica); } catch { throw invalida('La clave de verificación de firma no es una clave pública válida.'); }
  if (!Array.isArray(modulos) || !modulos.length) throw invalida('Indicá los módulos que publica la sucursal.');
  if (desde !== undefined && !esFecha(desde)) throw invalida('"desde" va como AAAA-MM-DD.');
  try {
    await pool.query('INSERT INTO sucursales (codigo, nombre, clave_publica, modulos, desde) VALUES (?, ?, ?, ?, ?)', [codigo, nombre.trim(), clave_publica, modulos.join(','), desde ?? new Date().toISOString().slice(0, 10)]);
  } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw invalida('Ya hay una sucursal con ese código.', 409); throw err; }
  return (await sucursales()).find((s) => s.codigo === codigo);
};
const sucursales = async () => (await pool.query('SELECT id, codigo, nombre, modulos, activa, desde FROM sucursales ORDER BY codigo'))[0].map((s) => ({ ...s, activa: !!s.activa, modulos: s.modulos.split(',') }));
const activarSucursal = async (codigo, activa) => {
  const [r] = await pool.query('UPDATE sucursales SET activa = ? WHERE codigo = ?', [activa ? 1 : 0, codigo]);
  if (!r.affectedRows) throw invalida('Sucursal no encontrada.', 404);
  return (await sucursales()).find((s) => s.codigo === codigo);
};

// Rechazo: no importa nada, queda registrado y alerta (EX20).
const rechazar = async (s, motivo) => {
  await pool.query("INSERT INTO paquetes_recibidos (id_paquete, sucursal, modulo, periodo, version, estado, motivo) VALUES (?, ?, ?, ?, ?, 'rechazado', ?)",
    [typeof s?.id_paquete === 'string' ? s.id_paquete.slice(0, 120) : null, typeof s?.sucursal === 'string' ? s.sucursal.slice(0, 10) : null, typeof s?.modulo === 'string' ? s.modulo.slice(0, 20) : null, esFecha(s?.periodo) ? s.periodo : null, Number.isInteger(s?.version) ? s.version : null, motivo.slice(0, 255)]);
  await Notificacion.crear({ modulo: 'usuarios', tipo: 'paquete_rechazado', severidad: 'alta', roles: ['administrador'], clave: `paquete-rechazado-${Date.now()}`, mensaje: `Se rechazó un paquete de consolidación de ${s?.sucursal ?? 'origen desconocido'}: ${motivo}` });
  return { importado: false, rechazado: true, motivo };
};

const importar = async (s) => {
  const c = await config();
  if (!c.es_casa_central) throw invalida('Esta instancia no está marcada como Casa Central.', 409);
  if (!s || typeof s !== 'object') return rechazar(s, 'el paquete no tiene el formato esperado');
  const suc = (await pool.query('SELECT * FROM sucursales WHERE codigo = ?', [s.sucursal]))[0][0];
  if (!suc || !suc.activa) return rechazar(s, 'la sucursal no está registrada o está dada de baja');
  let firmaOk = false;
  try { firmaOk = crypto.verify(null, Buffer.from(firmado(s)), suc.clave_publica, Buffer.from(String(s.firma), 'base64')); } catch { /* firma mal formada */ }
  if (!firmaOk) return rechazar(s, 'la firma no es válida');
  if (huellaDe(s.contenido) !== s.huella) return rechazar(s, 'el contenido fue alterado: la huella no coincide');
  if (!esFecha(s.periodo) || !Number.isInteger(s.version) || s.version < 1 || typeof s.modulo !== 'string') return rechazar(s, 'faltan el módulo, el período o la versión');
  if (!suc.modulos.split(',').includes(s.modulo)) return rechazar(s, `la sucursal no está registrada como publicadora de ${s.modulo}`);
  // Un módulo puede validar el paquete antes de aceptarlo (Contable: cuentas sin equivalencia, EX15); si lo rechaza no se importa nada.
  const def = generadores.get(s.modulo);
  if (def?.validar) { const motivo = await def.validar(s); if (motivo) return rechazar(s, motivo); }
  const id = `${s.sucursal}-${s.modulo}-${s.periodo}-v${s.version}`;
  const previos = (await pool.query("SELECT id, version, estado FROM paquetes_recibidos WHERE sucursal = ? AND modulo = ? AND periodo = ? AND estado IN ('importado', 'pendiente_version') ORDER BY version DESC", [s.sucursal, s.modulo, s.periodo]))[0];
  if (previos.some((p) => p.version === s.version && p.estado === 'importado')) return { importado: false, ya_importado: true, mensaje: 'Ya importado' }; // EX21
  const vigente = previos.find((p) => p.estado === 'importado');
  if (vigente && vigente.version > s.version) return { importado: false, ya_importado: true, mensaje: 'Ya hay una versión más nueva de este paquete.' };
  const guardar = async (estado, motivo = null) => pool.query('INSERT INTO paquetes_recibidos (id_paquete, sucursal, modulo, periodo, version, huella, version_sistema, contenido, sobre, estado, motivo, sin_informe) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, s.sucursal, s.modulo, s.periodo, s.version, s.huella, s.version_sistema, canonico(s.contenido), estado === 'pendiente_version' ? JSON.stringify(s) : null, estado, motivo, estado === 'importado' && !(generadores.has(s.modulo) && await Modulos.estaInstalado(s.modulo)) ? 1 : 0]);
  if (mayor(s.version_sistema) > mayor(VERSION)) { // EX22
    if (previos.some((p) => p.version === s.version && p.estado === 'pendiente_version')) return { importado: false, pendiente_version: true, version_necesaria: s.version_sistema };
    await guardar('pendiente_version', `Es de la versión ${s.version_sistema}; actualizá esta instancia (versión actual ${VERSION}) y reintentá.`);
    return { importado: false, pendiente_version: true, version_necesaria: s.version_sistema };
  }
  if (vigente) await pool.query("UPDATE paquetes_recibidos SET estado = 'reemplazado' WHERE id = ?", [vigente.id]); // RN40: el anterior queda en el historial
  await guardar('importado');
  await Notificacion.resolverPorClave(`consol-faltante-${s.sucursal}-${s.modulo}`, 'Llegó el paquete');
  return { importado: true, id_paquete: id, reemplaza: vigente?.version ?? null };
};

// Reintenta los que esperaban una versión compatible (EX22).
const reintentarPendientes = async () => {
  const hechos = [];
  for (const p of (await pool.query("SELECT id, sobre FROM paquetes_recibidos WHERE estado = 'pendiente_version'"))[0]) {
    const s = JSON.parse(p.sobre);
    if (mayor(s.version_sistema) > mayor(VERSION)) continue;
    await pool.query("UPDATE paquetes_recibidos SET estado = 'reemplazado', motivo = 'reintentado' WHERE id = ?", [p.id]);
    hechos.push(await importar(s));
  }
  return hechos;
};
const recibidos = async () => (await pool.query('SELECT id, id_paquete, sucursal, modulo, periodo, version, version_sistema, estado, motivo, sin_informe, recibido_en FROM paquetes_recibidos ORDER BY id DESC LIMIT 500'))[0];

// ---------- Control y faltantes (RN42, EX23) ----------
const dias = (desde, hasta) => { const r = []; for (let d = new Date(`${desde}T00:00:00`); d <= new Date(`${hasta}T00:00:00`); d.setDate(d.getDate() + 1)) r.push(d.toISOString().slice(0, 10)); return r; };
const iso = (d) => { const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const control = async ({ ahora = new Date(), alertar = false } = {}) => {
  const horas = Number((await pool.query("SELECT valor FROM parametros WHERE clave = 'consolidacion_faltante_horas'"))[0][0]?.valor ?? 48);
  const salida = [];
  for (const s of await sucursales()) {
    if (!s.activa) continue;
    for (const mod of s.modulos) {
      const tengo = new Set((await pool.query("SELECT periodo FROM paquetes_recibidos WHERE sucursal = ? AND modulo = ? AND estado = 'importado'", [s.codigo, mod]))[0].map((r) => iso(new Date(r.periodo))));
      const limite = new Date(ahora.getTime() - horas * 3600000); // el período D vence a las 24:00 de D, más las horas de tolerancia
      const esperados = dias(iso(new Date(s.desde)), iso(new Date(ahora.getTime() - 86400000))).filter((d) => new Date(`${d}T23:59:59`) < limite);
      const faltan = esperados.filter((d) => !tengo.has(d));
      const rech = Number((await pool.query("SELECT COUNT(*) AS n FROM paquetes_recibidos WHERE sucursal = ? AND modulo = ? AND estado = 'rechazado'", [s.codigo, mod]))[0][0].n);
      salida.push({ sucursal: s.codigo, modulo: mod, recibidos: tengo.size, rechazados: rech, faltantes: faltan });
      if (alertar && faltan.length)
        await Notificacion.crear({ modulo: 'usuarios', tipo: 'paquete_faltante', severidad: 'alta', roles: ['administrador'], clave: `consol-faltante-${s.codigo}-${mod}`, mensaje: `Faltan ${faltan.length} paquete(s) de ${mod} de la sucursal ${s.nombre} (período ${faltan[0]}${faltan.length > 1 ? ' y otros' : ''}).` });
    }
  }
  return salida;
};

// ---------- Informes consolidados ----------
const rango = async (desde, hasta) => {
  if (!esFecha(desde) || !esFecha(hasta) || desde > hasta) throw invalida('Indicá desde y hasta como AAAA-MM-DD, con desde menor o igual a hasta.');
  if (dias(desde, hasta).length > 366) throw invalida('El informe admite hasta 12 meses.');
};
// Paquetes vigentes del módulo en el rango, más la operación propia de la Casa Central (no necesita paquete).
const paquetesDe = async (modulo, desde, hasta, sucursal) => {
  const donde = ["modulo = ?", "estado = 'importado'", 'periodo >= ?', 'periodo <= ?'];
  const p = [modulo, desde, hasta];
  if (sucursal) { donde.push('sucursal = ?'); p.push(sucursal); }
  const filas = (await pool.query(`SELECT sucursal, periodo, contenido FROM paquetes_recibidos WHERE ${donde.join(' AND ')} ORDER BY sucursal, periodo`, p))[0]
    .map((r) => ({ sucursal: r.sucursal, periodo: iso(new Date(r.periodo)), contenido: JSON.parse(r.contenido) }));
  const c = await config();
  const propio = await codigoInstancia();
  if (c.es_casa_central && generadores.has(modulo) && (!sucursal || sucursal === propio) && (await Modulos.estaInstalado(modulo))) {
    const hoy = iso(new Date());
    for (const d of dias(desde, hasta)) if (d < hoy) filas.push({ sucursal: propio, periodo: d, contenido: await generadores.get(modulo).generar(d) });
  }
  return filas;
};
const incompletos = async (modulo, desde, hasta, sucursal, tengo) => {
  const ctl = (await control()).filter((c) => c.modulo === modulo && (!sucursal || c.sucursal === sucursal));
  return ctl.filter((c) => c.faltantes.some((d) => d >= desde && d <= hasta)).map((c) => ({ sucursal: c.sucursal, periodos: c.faltantes.filter((d) => d >= desde && d <= hasta) }));
};

const informeVentas = async ({ desde, hasta, sucursal }) => {
  await rango(desde, hasta);
  const filas = await paquetesDe('ventas', desde, hasta, sucursal);
  const prod = new Map(), forma = new Map(), tot = new Map();
  for (const f of filas) {
    const t = tot.get(f.sucursal) ?? { sucursal: f.sucursal, ventas: 0, importe: 0, anulaciones: 0, devoluciones: 0 };
    t.ventas += f.contenido.ventas; t.importe += f.contenido.importe; t.anulaciones += f.contenido.anulaciones; t.devoluciones += f.contenido.devoluciones;
    tot.set(f.sucursal, t);
    for (const x of f.contenido.por_producto) { const k = `${f.sucursal}|${x.producto}`; const a = prod.get(k) ?? { sucursal: f.sucursal, producto: x.producto, cantidad: 0, importe: 0 }; a.cantidad += x.cantidad; a.importe += x.importe; prod.set(k, a); }
    for (const x of f.contenido.por_forma_pago) { const k = `${f.sucursal}|${x.forma}`; const a = forma.get(k) ?? { sucursal: f.sucursal, forma: x.forma, importe: 0 }; a.importe += x.importe; forma.set(k, a); }
  }
  const r2 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 100) / 100 : v]));
  const incompleto = await incompletos('ventas', desde, hasta, sucursal);
  return { desde, hasta, totales: [...tot.values()].map(r2), por_producto: [...prod.values()].map(r2), por_forma_pago: [...forma.values()].map(r2), incompleto };
};
const informeStock = async ({ desde, hasta, sucursal }) => {
  await rango(desde, hasta);
  if (!(await Modulos.estaInstalado('stock'))) throw invalida('Esta instancia no tiene Stock instalado: el informe no está disponible.', 404); // EX25
  const filas = await paquetesDe('stock', desde, hasta, sucursal);
  const ultima = new Map(), mermas = new Map();
  for (const f of filas) {
    if (!ultima.has(f.sucursal) || ultima.get(f.sucursal).periodo < f.periodo) ultima.set(f.sucursal, f);
    for (const m of f.contenido.mermas) { const k = `${f.sucursal}|${m.motivo}`; const a = mermas.get(k) ?? { sucursal: f.sucursal, motivo: m.motivo, cantidad: 0, valor: 0 }; a.cantidad += m.cantidad; a.valor += m.valor; mermas.set(k, a); }
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    desde, hasta,
    existencias: [...ultima.values()].flatMap((f) => f.contenido.existencias.map((e) => ({ sucursal: f.sucursal, al: f.periodo, ...e }))),
    mermas: [...mermas.values()].map((m) => ({ ...m, cantidad: r2(m.cantidad), valor: r2(m.valor) })),
    incompleto: await incompletos('stock', desde, hasta, sucursal),
  };
};

module.exports = {
  ConsolidacionInvalida, registrarPaquete, configurar, estado, publicar, publicados, sobreDe, usarEnvio, enviarPendientes,
  registrarSucursal, sucursales, activarSucursal, importar, reintentarPendientes, recibidos, control, informeVentas, informeStock, canonico, huellaDe, firmado,
};
