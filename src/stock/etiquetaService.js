const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const Alergenos = require('./alergenoService');
const Lotes = require('./loteService');

// Etiquetas (Stock RF27, RN82; Ventas RN71), con la función STK-ETIQUETAS. Dos tipos de etiqueta (góndola y elaborado) con plantilla
// por impresora, códigos internos y códigos de peso embebido de 13 dígitos: prefijo propio (2) + artículo (5) + peso (5, en la unidad
// base) + verificador EAN-13. La etiqueta lleva el peso y no el importe, así que un cambio de precio no la desactualiza (la de góndola
// sí, porque imprime el precio). Stock valida la etiqueta y devuelve artículo y peso; Ventas calcula el importe.
class EtiquetaInvalida extends Error {}
const invalida = (m, status = 400) => Object.assign(new EtiquetaInvalida(m), { status });

// Dígito verificador EAN-13 (módulo 10): impares ×1, pares ×3 sobre los 12 primeros, complemento a 10 de la suma.
const verificador = (doce) => {
  const suma = [...doce].reduce((a, d, i) => a + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (suma % 10)) % 10;
};

const prefijo = async () => {
  const [[r]] = await pool.query("SELECT valor FROM parametros WHERE clave = 'etiqueta_prefijo'");
  return r?.valor ?? '29';
};

const producto = async (id) => {
  const [[p]] = await pool.query('SELECT id, nombre, precio, codigo_barras, codigo_etiqueta, peso_porcion, conservacion FROM productos WHERE id = ?', [id]);
  if (!p) throw invalida('El artículo no existe.', 404);
  return p;
};

// El prefijo propio es un parámetro de la instancia: dos dígitos y distinto de los prefijos del catálogo (RN24).
const configurarPrefijo = async (valor) => {
  if (!/^\d{2}$/.test(String(valor))) throw invalida('El prefijo propio son 2 dígitos.');
  const [[uso]] = await pool.query('SELECT COUNT(*) AS n FROM productos WHERE codigo_barras LIKE ?', [`${valor}%`]);
  if (uso.n) throw invalida(`Hay artículos del catálogo con códigos de barras que empiezan con ${valor}: elegí otro prefijo.`, 409);
  const [[ya]] = await pool.query('SELECT COUNT(*) AS n FROM etiquetas_impresas WHERE tipo = \'peso\'');
  if (ya.n) throw invalida('Ya se imprimieron etiquetas de peso con el prefijo actual: cambiarlo las invalidaría.', 409);
  await pool.query("INSERT INTO parametros (clave, valor) VALUES ('etiqueta_prefijo', ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)", [String(valor)]);
  return { prefijo: String(valor) };
};

// Código de artículo de 5 dígitos para las etiquetas de peso: el siguiente libre, o el indicado.
const asignarCodigo = async (productoId, codigo) => {
  const p = await producto(productoId);
  if (p.codigo_etiqueta) return { producto_id: p.id, codigo_etiqueta: p.codigo_etiqueta };
  let c = codigo === undefined ? null : String(codigo).padStart(5, '0');
  if (c !== null && !/^\d{5}$/.test(c)) throw invalida('El código de artículo son 5 dígitos.');
  if (c === null) {
    const [[{ m }]] = await pool.query('SELECT MAX(CAST(codigo_etiqueta AS UNSIGNED)) AS m FROM productos WHERE codigo_etiqueta IS NOT NULL');
    const sig = Number(m ?? 0) + 1;
    if (sig > 99999) throw invalida('No quedan códigos de artículo libres.', 409);
    c = String(sig).padStart(5, '0');
  }
  try {
    await pool.query('UPDATE productos SET codigo_etiqueta = ? WHERE id = ?', [c, productoId]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalida('Ese código de artículo ya lo tiene otro artículo.', 409);
    throw err;
  }
  return { producto_id: productoId, codigo_etiqueta: c };
};

// Código de peso para la balanza: peso entero en la unidad base del artículo (por ejemplo gramos), 1 a 99999.
const generarPeso = async (productoId, peso, { userId } = {}) => {
  if (!Number.isInteger(Number(peso)) || !(Number(peso) >= 1 && Number(peso) <= 99999)) throw invalida('El peso embebido son hasta 5 dígitos enteros (1 a 99999) en la unidad base.');
  const p = await producto(productoId);
  const { codigo_etiqueta } = p.codigo_etiqueta ? p : await asignarCodigo(productoId);
  const doce = `${await prefijo()}${codigo_etiqueta}${String(Number(peso)).padStart(5, '0')}`;
  const codigo = `${doce}${verificador(doce)}`;
  await pool.query("INSERT INTO etiquetas_impresas (tipo, producto_id, codigo, user_id) VALUES ('peso', ?, ?, ?)", [productoId, codigo, userId ?? null]);
  return { codigo, producto_id: productoId, peso: Number(peso) };
};

// Código interno del artículo (sin peso): prefijo 20 + id + verificador; no choca con el prefijo propio.
const generarInterno = async (productoId) => {
  await producto(productoId);
  const doce = `20${String(productoId).padStart(10, '0')}`;
  return { codigo: `${doce}${verificador(doce)}`, producto_id: productoId };
};

// Valida una etiqueta leída (EX59): prefijo propio, verificador y artículo. No bloquea la venta: si no vale, Ventas no usa el peso.
const validar = async (codigo) => {
  const c = String(codigo ?? '').trim();
  if (!/^\d{13}$/.test(c)) return { valida: false, motivo: 'La etiqueta no tiene 13 dígitos.' };
  if (c.slice(0, 2) !== await prefijo()) return { valida: false, motivo: 'El prefijo no es el propio de la instancia.' };
  if (verificador(c.slice(0, 12)) !== Number(c[12])) return { valida: false, motivo: 'El dígito verificador no coincide.' };
  const [[p]] = await pool.query('SELECT id, nombre FROM productos WHERE codigo_etiqueta = ?', [c.slice(2, 7)]);
  if (!p) return { valida: false, motivo: 'El artículo de la etiqueta no existe.' };
  return { valida: true, producto_id: p.id, nombre: p.nombre, peso: Number(c.slice(7, 12)) };
};

// ---- Plantillas por impresora ----

const guardarPlantilla = async ({ tipo, impresora, ancho_mm = 60, alto_mm = 40, contenido }) => {
  if (!['gondola', 'elaborado'].includes(tipo)) throw invalida('El tipo debe ser "gondola" o "elaborado".');
  if (!String(impresora ?? '').trim() || !String(contenido ?? '').trim()) throw invalida('Indicá la impresora y el contenido de la plantilla.');
  await pool.query(
    `INSERT INTO plantillas_etiqueta (tipo, impresora, ancho_mm, alto_mm, contenido) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE ancho_mm = VALUES(ancho_mm), alto_mm = VALUES(alto_mm), contenido = VALUES(contenido), activa = 1`, [tipo, String(impresora).trim(), ancho_mm, alto_mm, contenido]);
  return (await pool.query('SELECT * FROM plantillas_etiqueta WHERE tipo = ? AND impresora = ?', [tipo, String(impresora).trim()]))[0][0];
};
const plantillas = async () => (await pool.query('SELECT * FROM plantillas_etiqueta WHERE activa = 1 ORDER BY tipo, impresora'))[0];

const render = (contenido, datos) => contenido.replace(/\{\{(\w+)\}\}/g, (_, k) => (datos[k] === null || datos[k] === undefined ? '' : String(datos[k])));

// ---- Etiquetas ----

const plantillaDe = async (tipo, impresora) => {
  if (!impresora) return null;
  const [[t]] = await pool.query('SELECT * FROM plantillas_etiqueta WHERE tipo = ? AND impresora = ? AND activa = 1', [tipo, impresora]);
  if (!t) throw invalida(`No hay una plantilla de etiqueta ${tipo} para la impresora "${impresora}".`, 404);
  return t;
};

const respuesta = (tipo, datos, plantilla) => ({ tipo, datos, plantilla_id: plantilla?.id ?? null, texto: plantilla ? render(plantilla.contenido, datos) : null });

// Góndola o vitrina: nombre, precio de Ventas, código de barras y tamaño o porción.
const gondola = async (productoId, { impresora } = {}, { userId } = {}) => {
  const p = await producto(productoId);
  const t = await plantillaDe('gondola', impresora);
  const datos = { nombre: p.nombre, precio: Number(p.precio).toFixed(2), codigo_barras: p.codigo_barras, porcion: p.peso_porcion === null ? null : Number(p.peso_porcion) };
  await pool.query("INSERT INTO etiquetas_impresas (tipo, producto_id, precio, codigo, plantilla_id, user_id) VALUES ('gondola', ?, ?, ?, ?, ?)", [p.id, p.precio, p.codigo_barras, t?.id ?? null, userId ?? null]);
  return respuesta('gondola', datos, t);
};

// Elaborado o envasado: nombre, lote y fechas (con STK-LOTES), alérgenos (con STK-ALERGENOS), conservación, peso neto y QR con artículo y lote.
const elaborado = async (productoId, { lote, impresora } = {}, { userId } = {}) => {
  const p = await producto(productoId);
  const t = await plantillaDe('elaborado', impresora);
  let l = null;
  if (await Funciones.estaActiva('STK-LOTES') && await Lotes.controla(pool, { tipo: 'producto', id: productoId })) {
    if (!lote) throw invalida('Este artículo controla lote: indicá el lote a imprimir.');
    l = await Lotes.porCodigo(pool, { tipo: 'producto', id: productoId }, lote);
    if (!l) throw invalida(`El lote ${lote} no existe para ese artículo.`, 404);
  }
  const fecha = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  const alerg = (await Funciones.estaActiva('STK-ALERGENOS')) ? await Alergenos.articulo(productoId) : null;
  const datos = {
    nombre: p.nombre, lote: l?.codigo ?? null, elaboracion: fecha(l?.fecha_elaboracion), vencimiento: fecha(l?.fecha_vencimiento),
    alergenos: alerg ? alerg.alergenos.map((a) => (a.tipo === 'trazas' ? `puede contener ${a.nombre}` : a.nombre)).join(', ') : null,
    alergenos_incompletos: alerg ? alerg.incompletos : null, conservacion: p.conservacion, peso_neto: p.peso_porcion === null ? null : Number(p.peso_porcion),
    qr: `P:${p.id}${l ? `|L:${l.codigo}` : ''}`, codigo_barras: p.codigo_barras,
  };
  await pool.query("INSERT INTO etiquetas_impresas (tipo, producto_id, lote_id, precio, codigo, plantilla_id, user_id) VALUES ('elaborado', ?, ?, ?, ?, ?, ?)", [p.id, l?.id ?? null, p.precio, datos.qr, t?.id ?? null, userId ?? null]);
  return respuesta('elaborado', datos, t);
};

// Etiquetas de góndola impresas a un precio que ya no es el vigente en Ventas (RN40). Las de peso no llevan precio: no se desactualizan.
const desactualizadas = async () => (await pool.query(
  `SELECT e.producto_id, p.nombre, e.precio AS precio_impreso, p.precio AS precio_vigente, e.created_at AS impresa
   FROM etiquetas_impresas e JOIN productos p ON p.id = e.producto_id
   WHERE e.tipo = 'gondola' AND e.id = (SELECT MAX(x.id) FROM etiquetas_impresas x WHERE x.producto_id = e.producto_id AND x.tipo = 'gondola') AND e.precio <> p.precio
   ORDER BY p.nombre`))[0].map((r) => ({ ...r, precio_impreso: Number(r.precio_impreso), precio_vigente: Number(r.precio_vigente) }));

module.exports = { EtiquetaInvalida, verificador, configurarPrefijo, asignarCodigo, generarPeso, generarInterno, validar, guardarPlantilla, plantillas, gondola, elaborado, desactualizadas };
