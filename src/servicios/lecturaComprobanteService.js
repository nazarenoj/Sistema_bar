const pool = require('../config/db');
const Funciones = require('../funciones/servicio');
const Claves = require('./comprobanteTerceroService');

// Lectura de comprobantes por foto (Usuarios RF15, RN18, RN19, EX11; función USU-FOTO): recibe una imagen o un PDF y devuelve una PROPUESTA de
// datos con confianza por campo; nunca registra nada (RN18). Si el servicio no responde, contesta "pendiente" y quien lo pidió guarda la imagen
// (EX11). El código QR fiscal de ARCA se lee sin conexión. Toda propuesta se verifica como si se cargara a mano (clave de RF27).
// shortcut: el proveedor es una dirección https configurable que recibe {imagen_base64, tipo} y devuelve {encabezado, lineas, confianza};
// no hay un proveedor concreto elegido (decisión de contratación pendiente).
class LecturaInvalida extends Error {}
const invalida = (m, status = 400) => Object.assign(new LecturaInvalida(m), { status });

let proveedor = async ({ imagen, tipo }, { url, timeoutS }) => {
  const r = await fetch(url, {
    method: 'POST', signal: AbortSignal.timeout(timeoutS * 1000),
    headers: { 'Content-Type': 'application/json', ...(process.env.FOTO_API_KEY && { Authorization: `Bearer ${process.env.FOTO_API_KEY}` }) },
    body: JSON.stringify({ imagen_base64: imagen.toString('base64'), tipo }),
  });
  if (!r.ok) throw new Error(`el servicio respondió ${r.status}`);
  return r.json();
};
let inyectado = false;
const usarProveedor = (fn) => { proveedor = fn; inyectado = true; };

const config = async () => (await pool.query('SELECT url, timeout_s FROM lectura_comprobantes_config WHERE id = 1'))[0][0];
const configurar = async ({ url, timeout_s: timeoutS = 20 }) => {
  if (url !== null && url !== undefined && url !== '') {
    let u;
    try { u = new URL(url); } catch { throw invalida('La dirección del servicio no es válida.'); }
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw invalida('El servicio de lectura tiene que ser https: las imágenes viajan cifradas.'); // RN19
  }
  if (!(Number(timeoutS) >= 1 && Number(timeoutS) <= 120)) throw invalida('El tiempo de espera es de 1 a 120 segundos.');
  await pool.query('UPDATE lectura_comprobantes_config SET url = ?, timeout_s = ? WHERE id = 1', [url || null, Number(timeoutS)]);
  return config();
};

const CAMPOS = ['cuit', 'clase', 'tipo', 'punto_venta', 'numero', 'fecha', 'importe', 'cae', 'proveedor'];
// Verifica el encabezado propuesto con las mismas reglas que una carga manual y dice qué hay que corregir.
const verificar = (encabezado) => {
  try { return { clave_valida: true, clave: Claves.normalizar({ ...encabezado, razon_social: encabezado.proveedor }).clave }; } catch (err) {
    if (err instanceof Claves.ClaveInvalida) return { clave_valida: false, corregir: err.campo, motivo: err.message };
    throw err;
  }
};

const propuesta = (crudo, origen) => {
  const encabezado = crudo.encabezado ?? {};
  const confianza = Object.fromEntries(CAMPOS.filter((c) => encabezado[c] !== undefined && encabezado[c] !== null).map((c) => [c, Math.max(0, Math.min(1, Number(crudo.confianza?.[c] ?? 0)))]));
  return {
    estado: 'ok', origen, propuesta: true, // RN18: solo una propuesta, el módulo pide confirmación
    encabezado, lineas: Array.isArray(crudo.lineas) ? crudo.lineas : [], confianza,
    faltan: CAMPOS.filter((c) => c !== 'proveedor' && (encabezado[c] === undefined || encabezado[c] === null || encabezado[c] === '')),
    verificacion: verificar(encabezado),
  };
};

const leer = async ({ imagen, tipo }) => {
  if (!(await Funciones.estaActiva('USU-FOTO'))) return { estado: 'no_disponible', motivo: 'La lectura por foto no está activada: cargá el comprobante a mano.' };
  if (!['image/jpeg', 'image/png', 'application/pdf'].includes(tipo)) throw invalida('El archivo debe ser JPG, PNG o PDF.');
  if (!Buffer.isBuffer(imagen) || !imagen.length) throw invalida('Falta la imagen.');
  const c = await config();
  if (!c.url && !inyectado) return { estado: 'pendiente', motivo: 'No hay un servicio de lectura configurado.' };
  try {
    return propuesta(await proveedor({ imagen, tipo }, { url: c.url, timeoutS: c.timeout_s }), 'servicio');
  } catch (err) {
    return { estado: 'pendiente', motivo: `El servicio de lectura no respondió (${err.message}). La imagen queda guardada para procesarla después.` }; // EX11
  }
};

// Código QR fiscal de ARCA: la dirección lleva un JSON en base64 con el encabezado. Se lee sin conexión.
const TIPOS_CBTE = {
  1: ['FACTURA', 'A'], 6: ['FACTURA', 'B'], 11: ['FACTURA', 'C'], 51: ['FACTURA', 'M'], 2: ['NOTA_DEBITO', 'A'], 7: ['NOTA_DEBITO', 'B'], 12: ['NOTA_DEBITO', 'C'],
  52: ['NOTA_DEBITO', 'M'], 3: ['NOTA_CREDITO', 'A'], 8: ['NOTA_CREDITO', 'B'], 13: ['NOTA_CREDITO', 'C'], 53: ['NOTA_CREDITO', 'M'], 4: ['RECIBO', 'A'], 9: ['RECIBO', 'B'], 15: ['RECIBO', 'C'],
};
const leerQr = async (texto) => {
  if (!(await Funciones.estaActiva('USU-FOTO'))) return { estado: 'no_disponible', motivo: 'La lectura por foto no está activada: cargá el comprobante a mano.' };
  let datos;
  try {
    const p = new URL(String(texto)).searchParams.get('p');
    datos = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
  } catch { throw invalida('El código QR no es el de un comprobante fiscal de ARCA.'); }
  const [clase, letra] = TIPOS_CBTE[datos.tipoCmp] ?? [null, null];
  const enc = {
    cuit: String(datos.cuit ?? ''), clase, tipo: letra, punto_venta: datos.ptoVta, numero: datos.nroCmp, fecha: datos.fecha, importe: datos.importe,
    cae: datos.codAut ? String(datos.codAut) : undefined, cae_tipo: datos.tipoCodAut === 'A' ? 'CAEA' : 'CAE',
  };
  const confianza = Object.fromEntries(CAMPOS.filter((c) => enc[c] !== undefined && enc[c] !== null).map((c) => [c, 1]));
  return { ...propuesta({ encabezado: enc, lineas: [], confianza }, 'qr'), moneda: datos.moneda, cotizacion: datos.ctz };
};

module.exports = { LecturaInvalida, usarProveedor, configurar, config, leer, leerQr, verificar };
