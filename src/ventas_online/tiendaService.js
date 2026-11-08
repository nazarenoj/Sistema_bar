const pool = require('../config/db');
const registro = require('../instancias/registro');
const { cuitValido } = require('../services/padronService');

// La tienda de la instancia (Ventas Online RF01, RN01): configuración, páginas informativas y lo que la parte pública puede mostrar. Cada tienda pertenece a una sola instancia
// y se publica como subruta del dominio: /tienda/<codigo>. La parte pública jamás sale de la base de la instancia que resolvió el código.
class TiendaInvalida extends Error {}
const invalida = (m, status = 400, extra = {}) => Object.assign(new TiendaInvalida(m), { status, ...extra });

const DIAS = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'];
const RESERVADOS = ['api', 'tienda', 'admin', 'health', 'static', 'assets', 'login', 'www'];
const PAGINAS = { envios: 'Envíos', cambios: 'Cambios y devoluciones', privacidad: 'Política de privacidad', terminos: 'Términos y condiciones' };
const HEX = /^#[0-9a-fA-F]{6}$/;

const fila = async () => (await pool.query('SELECT * FROM onl_tienda WHERE id = 1'))[0][0];
const horariosDe = (t) => (t.horarios ? JSON.parse(t.horarios) : null);

const completa = (t) => ({
  codigo: t.codigo, nombre: t.nombre, activa: !!t.activa, dominio: t.dominio, logo_url: t.logo_url, color_primario: t.color_primario, color_acento: t.color_acento,
  razon_social: t.razon_social, cuit: t.cuit, domicilio: t.domicilio, telefono: t.telefono, email: t.email, horarios: horariosDe(t),
  limite_pedidos_ip_hora: t.limite_pedidos_ip_hora, vigencia_reserva_min: t.vigencia_reserva_min, timeout_reserva_segundos: t.timeout_reserva_segundos,
  impagos_horas: t.impagos_horas, disponibilidad_alerta_min: t.disponibilidad_alerta_min, prioridad_lista: t.prioridad_lista,
  url_publica: t.codigo ? `/tienda/${t.codigo}` : null,
});
const config = async () => completa(await fila());

// ---- Validación ----

const texto = (v, nombre, max, { obligatorio = false } = {}) => {
  if (v === undefined) return undefined;
  if (v === null || String(v).trim() === '') { if (obligatorio) throw invalida(`Falta ${nombre}.`); return null; }
  const s = String(v).trim();
  if (s.length > max) throw invalida(`${nombre} admite hasta ${max} caracteres.`);
  return s;
};
const hhmm = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));
const validarHorarios = (h) => {
  if (h === null) return null;
  if (typeof h !== 'object' || Array.isArray(h)) throw invalida('Los horarios van por día (lun a dom).');
  const salida = {};
  for (const [dia, tramos] of Object.entries(h)) {
    if (!DIAS.includes(dia)) throw invalida(`Día inválido: ${dia}.`);
    if (!Array.isArray(tramos)) throw invalida(`Los horarios de ${dia} son una lista de tramos.`);
    salida[dia] = tramos.map((t) => {
      if (!hhmm(t?.desde) || !hhmm(t?.hasta) || t.desde >= t.hasta) throw invalida(`Tramo inválido el ${dia}: va de HH:MM a HH:MM y el cierre es posterior a la apertura.`);
      return { desde: t.desde, hasta: t.hasta };
    });
  }
  return salida;
};
const entero = (v, nombre, min, max) => {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < min || v > max) throw invalida(`${nombre} es un entero entre ${min} y ${max}.`);
  return v;
};

// El código de la subruta es único entre todas las instancias de la app.
const codigoEnUso = async (codigo) => {
  for (const inst of registro.listar()) {
    if (inst === registro.actual()) continue;
    const hay = await registro.dentroDe(inst, async () => (await registro.poolDe(inst).query('SELECT 1 FROM onl_tienda WHERE codigo = ? LIMIT 1', [codigo]).catch(() => [[]]))[0].length > 0);
    if (hay) return true;
  }
  return false;
};

const actualizar = async (d) => {
  const t = await fila();
  const campos = {};
  const poner = (k, v) => { if (v !== undefined) campos[k] = v; };
  if (d.codigo !== undefined) {
    const c = d.codigo === null ? null : String(d.codigo).trim().toLowerCase();
    if (c !== null && (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(c) || RESERVADOS.includes(c))) throw invalida('El código de la tienda tiene de 3 a 40 letras minúsculas, números o guiones y no puede ser una palabra reservada.', 400, { codigo: 'CODIGO_INVALIDO' });
    if (c && c !== t.codigo && (await codigoEnUso(c))) throw invalida('Ese código de tienda ya está en uso.', 409, { codigo: 'CODIGO_EN_USO' });
    poner('codigo', c);
  }
  poner('nombre', texto(d.nombre, 'el nombre', 80));
  poner('dominio', texto(d.dominio, 'el dominio', 120));
  if (campos.dominio && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(campos.dominio)) throw invalida('El dominio no es válido.');
  poner('logo_url', texto(d.logo_url, 'la dirección del logo', 255));
  if (campos.logo_url && !/^(https?:\/\/|\/)/.test(campos.logo_url)) throw invalida('La dirección del logo empieza con http://, https:// o /.');
  for (const k of ['color_primario', 'color_acento']) { poner(k, texto(d[k], 'el color', 7)); if (campos[k] && !HEX.test(campos[k])) throw invalida('Los colores van como #RRGGBB.'); }
  poner('razon_social', texto(d.razon_social, 'la razón social', 150));
  poner('domicilio', texto(d.domicilio, 'el domicilio', 200));
  poner('telefono', texto(d.telefono, 'el teléfono', 40));
  poner('email', texto(d.email, 'el correo', 120));
  if (campos.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(campos.email)) throw invalida('El correo no es válido.');
  if (d.cuit !== undefined) {
    const c = d.cuit === null || d.cuit === '' ? null : String(d.cuit).replace(/\D/g, '');
    if (c !== null && !cuitValido(c)) throw invalida('El CUIT no es válido.');
    poner('cuit', c);
  }
  if (d.horarios !== undefined) { const h = validarHorarios(d.horarios); campos.horarios = h === null ? null : JSON.stringify(h); }
  poner('limite_pedidos_ip_hora', entero(d.limite_pedidos_ip_hora, 'El límite de pedidos por IP', 1, 1000));
  poner('vigencia_reserva_min', entero(d.vigencia_reserva_min, 'La vigencia de la reserva', 1, 240));
  poner('timeout_reserva_segundos', entero(d.timeout_reserva_segundos, 'El tiempo de espera de la reserva', 1, 60));
  poner('impagos_horas', entero(d.impagos_horas, 'Las horas para cancelar pedidos impagos', 1, 720));
  poner('disponibilidad_alerta_min', entero(d.disponibilidad_alerta_min, 'Los minutos de alerta de disponibilidad', 1, 1440));
  if (d.prioridad_lista !== undefined) { if (!['online', 'cliente'].includes(d.prioridad_lista)) throw invalida('La prioridad de lista es online o cliente.'); campos.prioridad_lista = d.prioridad_lista; }
  if (d.activa !== undefined) campos.activa = d.activa ? 1 : 0;

  const futuro = { ...t, ...campos };
  if (futuro.activa && !(futuro.codigo && futuro.nombre && futuro.razon_social && futuro.cuit && futuro.domicilio))
    throw invalida('Para activar la tienda hacen falta el código, el nombre y los datos legales (razón social, CUIT y domicilio).', 409, { codigo: 'TIENDA_INCOMPLETA' });
  const claves = Object.keys(campos);
  if (claves.length) {
    try { await pool.query(`UPDATE onl_tienda SET ${claves.map((k) => `${k} = ?`).join(', ')} WHERE id = 1`, claves.map((k) => campos[k])); } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw invalida('Ese código de tienda ya está en uso.', 409, { codigo: 'CODIGO_EN_USO' });
      throw err;
    }
  }
  olvidar();
  return config();
};

// ---- Páginas informativas ----

const paginas = async () => (await pool.query('SELECT slug, titulo, contenido, updated_ms FROM onl_paginas ORDER BY slug'))[0].map((p) => ({ ...p, updated_ms: Number(p.updated_ms) }));
const guardarPagina = async (slug, { titulo, contenido }) => {
  if (!PAGINAS[slug]) throw invalida(`La página es una de: ${Object.keys(PAGINAS).join(', ')}.`, 404);
  const t = texto(titulo ?? PAGINAS[slug], 'el título', 100, { obligatorio: true });
  if (typeof contenido !== 'string' || !contenido.trim()) throw invalida('Falta el contenido de la página.');
  if (contenido.length > 20000) throw invalida('El contenido admite hasta 20.000 caracteres.');
  await pool.query('INSERT INTO onl_paginas (slug, titulo, contenido, updated_ms) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE titulo = VALUES(titulo), contenido = VALUES(contenido), updated_ms = VALUES(updated_ms)', [slug, t, contenido, Date.now()]);
  return (await paginas()).find((p) => p.slug === slug);
};

// ---- Lo público ----

const abiertaAhora = (horarios, ahora = new Date()) => {
  if (!horarios || !Object.keys(horarios).length) return true; // sin horarios cargados no se limita
  const dia = DIAS[(ahora.getDay() + 6) % 7];
  const hm = `${String(ahora.getHours()).padStart(2, '0')}:${String(ahora.getMinutes()).padStart(2, '0')}`;
  return (horarios[dia] ?? []).some((t) => hm >= t.desde && hm < t.hasta);
};

// Solo lo que se puede mostrar: nada de límites internos, ids ni parámetros.
const publica = async (ahora) => {
  const t = await fila();
  const h = horariosDe(t);
  return {
    codigo: t.codigo, nombre: t.nombre, logo_url: t.logo_url, colores: { primario: t.color_primario, acento: t.color_acento }, horarios: h, abierta: abiertaAhora(h, ahora),
    comercio: { razon_social: t.razon_social, cuit: t.cuit, domicilio: t.domicilio, telefono: t.telefono, email: t.email },
    paginas: (await paginas()).map((p) => ({ slug: p.slug, titulo: p.titulo })),
  };
};
const paginaPublica = async (slug) => {
  const [[p]] = await pool.query('SELECT slug, titulo, contenido FROM onl_paginas WHERE slug = ?', [slug]);
  return p ?? null;
};

// ---- Resolución del código de la subruta (entre todas las instancias) ----

const CACHE_MS = 60000;
const cache = new Map(); // código -> { inst, t }
const olvidar = () => cache.clear();
const resolverCodigo = async (codigo, preferida) => {
  const c = String(codigo ?? '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(c)) return null;
  const hit = cache.get(c);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.inst;
  const orden = [...(preferida ? [preferida] : []), ...registro.listar().filter((i) => i !== preferida)];
  for (const inst of orden) {
    const ok = await registro.dentroDe(inst, async () => {
      try { return (await registro.poolDe(inst).query('SELECT 1 FROM onl_tienda WHERE codigo = ? AND activa = 1 LIMIT 1', [c]))[0].length > 0; } catch { return false; } // instancia sin el módulo
    });
    if (ok) { cache.set(c, { inst, t: Date.now() }); return inst; }
  }
  return null;
};

module.exports = { TiendaInvalida, PAGINAS, config, actualizar, paginas, guardarPagina, publica, paginaPublica, abiertaAhora, resolverCodigo, olvidar, fila };
