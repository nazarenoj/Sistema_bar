const crypto = require('crypto');
const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const Notificacion = require('../models/notificacionModel');

// Identificación de comprobantes de terceros (Usuarios RF27, RN63 a RN68, RN83, RN84): forma la clave unívoca de cada comprobante recibido
// de un tercero y detecta duplicados antes de registrarlo. Servicio de plataforma, siempre vigente: lo llaman hacia abajo Stock (ingresos
// con remito o factura), Compras y Financiero. Reserva la clave (15 min), el módulo confirma con un mensaje en la misma transacción de su
// documento y la reserva que no se confirma vence sola.
class ClaveInvalida extends Error {}
const invalida = (m, campo, status = 400) => Object.assign(new ClaveInvalida(m), { status, campo, codigo: 'DATOS_INVALIDOS' });

const CLASES = ['FACTURA', 'NOTA_CREDITO', 'NOTA_DEBITO', 'REMITO', 'TICKET', 'RECIBO', 'OTRO'];
const ALIAS = { NC: 'NOTA_CREDITO', ND: 'NOTA_DEBITO', FC: 'FACTURA', FA: 'FACTURA', NOTA_DE_CREDITO: 'NOTA_CREDITO', NOTA_DE_DEBITO: 'NOTA_DEBITO' };
const LETRAS = ['A', 'B', 'C', 'M', 'X'];
const sinTildes = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');

const cuitValido = (c) => {
  if (!/^\d{11}$/.test(c)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((s, p, i) => s + p * Number(c[i]), 0);
  const dv = 11 - (suma % 11);
  return (dv === 11 ? 0 : dv === 10 ? 9 : dv) === Number(c[10]);
};
const razonNormalizada = (s) => sinTildes(s).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const relleno = (v, largo, campo) => {
  const d = String(v ?? '').replace(/[\s.\-]/g, '');
  if (!d) throw invalida(`Falta ${campo}.`, campo);
  if (!/^\d+$/.test(d) || d.length > largo) throw invalida(`${campo} no forma clave: hasta ${largo} dígitos.`, campo);
  return d.padStart(largo, '0');
};

// RN63: normaliza y forma la clave, o dice qué campo corregir (EX46).
const normalizar = (c) => {
  if (!c || typeof c !== 'object') throw invalida('Faltan los datos del comprobante.', 'comprobante');
  const cuit = String(c.cuit ?? '').replace(/[\s\-]/g, '');
  let emisor, cuitEmisor = null, razon = null;
  if (cuit) {
    if (!cuitValido(cuit)) throw invalida('El CUIT del emisor no es válido (11 dígitos con dígito verificador).', 'cuit');
    cuitEmisor = cuit; emisor = cuit;
  } else { // RN68: proveedor sin CUIT, la clave usa la razón social normalizada
    razon = razonNormalizada(c.razon_social ?? c.proveedor ?? '');
    if (!razon) throw invalida('Falta el CUIT o la razón social del emisor.', 'cuit');
    emisor = `RS:${razon.replace(/ /g, '_')}`;
  }
  let clase = sinTildes(String(c.clase ?? '')).toUpperCase().trim().replace(/[\s\-]+/g, '_');
  clase = ALIAS[clase] ?? clase;
  if (!CLASES.includes(clase)) throw invalida(`La clase no es reconocida (${CLASES.join(', ')}).`, 'clase');
  const letra = String(c.tipo ?? c.letra ?? '').trim().toUpperCase();
  if (!LETRAS.includes(letra)) throw invalida('La letra del comprobante es A, B, C, M o X.', 'tipo');
  const pv = relleno(c.punto_venta, 5, 'el punto de venta');
  const numero = relleno(c.numero, 8, 'el número');
  let cae = null, caeTipo = null;
  if (c.cae) {
    cae = String(c.cae).replace(/\D/g, '');
    if (cae.length !== 14) throw invalida('El CAE tiene 14 dígitos.', 'cae');
    caeTipo = String(c.cae_tipo ?? 'CAE').toUpperCase() === 'CAEA' ? 'CAEA' : 'CAE';
  }
  if (c.fecha && !/^\d{4}-\d{2}-\d{2}$/.test(c.fecha)) throw invalida('La fecha va como AAAA-MM-DD.', 'fecha');
  if (c.importe !== undefined && c.importe !== null && !(Number(c.importe) >= 0)) throw invalida('El importe es un número mayor o igual a cero.', 'importe');
  return { clave: `${emisor}-${clase}-${letra}-${pv}-${numero}`, emisor, cuit: cuitEmisor, razon_social: razon, clase, letra, punto_venta: pv, numero, cae, cae_tipo: caeTipo, fecha: c.fecha ?? null, importe: c.importe ?? null, sin_cuit: !cuitEmisor };
};

const vencerReservas = () => pool.query("UPDATE claves_comprobante SET estado = 'vencida' WHERE estado = 'reservada' AND reservada_hasta < NOW()");
const quien = async (c) => {
  const [[u]] = c.user_id ? await pool.query('SELECT username FROM users WHERE id = ?', [c.user_id]) : [[null]];
  return { usuario: u?.username ?? null, terminal: c.terminal ?? null, hasta: c.reservada_hasta };
};
const intento = (clave, resultado, detalle, modulo, userId) => pool.query('INSERT INTO clave_intentos (clave, resultado, detalle, modulo, user_id) VALUES (?, ?, ?, ?, ?)', [clave, resultado, detalle?.slice(0, 255) ?? null, modulo ?? null, userId ?? null]);
const publica = (r) => ({ id_clave: r.id_clave, clave: r.clave, estado: r.estado, id_reserva: r.id_reserva, reservada_hasta: r.reservada_hasta, modulo_dueno: r.modulo_dueno });

const coincidentes = async (n) => {
  const emisorSql = n.cuit ? 'cuit_emisor = ?' : 'razon_social = ?';
  const emisor = n.cuit ?? n.razon_social;
  const [rows] = await pool.query(
    `SELECT id_clave, clave, punto_venta, tipo_letra, numero, fecha_comprobante, importe FROM claves_comprobante
     WHERE estado = 'vigente' AND clave <> ? AND ${emisorSql} AND (
       (clase = ? AND numero = ? AND (punto_venta <> ? OR tipo_letra <> ?))
       OR (? IS NOT NULL AND ? IS NOT NULL AND fecha_comprobante = ? AND importe IS NOT NULL AND ABS(importe - ?) <= 0.01))
     AND NOT ((clase = 'REMITO' AND ? = 'FACTURA') OR (clase = 'FACTURA' AND ? = 'REMITO'))`, // un remito y su factura se vinculan, no se comparan (RN67)
    [n.clave, emisor, n.clase, n.numero, n.punto_venta, n.letra, n.fecha, n.importe, n.fecha, n.importe, n.clase, n.clase]);
  const out = [];
  for (const r of rows) {
    const [[par]] = await pool.query('SELECT 1 AS x FROM clave_distintas WHERE (clave_a = ? AND clave_b = ?) OR (clave_a = ? AND clave_b = ?)', [n.clave, r.clave, r.clave, n.clave]);
    if (par) continue; // ya confirmado como distinto
    out.push({ id_clave: r.id_clave, clave: r.clave, fecha: r.fecha_comprobante, importe: r.importe === null ? null : Number(r.importe), motivo: r.numero === n.numero ? 'mismo emisor y número con otro punto de venta o letra' : 'mismo emisor, fecha e importe (±0,01)' });
  }
  return out;
};

// Reservar la clave antes de confirmar el documento. Estados de la respuesta: reservada, vinculable, duplicado_exacto, en_proceso,
// casi_duplicado (pide confirmación), bloqueado_cae. `confirmar` = { motivo, autorizante_id } para seguir con un casi duplicado (RN65).
const reservar = async (datos, { modulo, userId = null, terminal = null, idSolicitud = null, idClave = null, confirmar = null } = {}) => {
  const n = normalizar(datos);
  await vencerReservas();
  if (idSolicitud) { // un reintento de la misma carga devuelve la reserva original (RN64, RN70)
    const [[previa]] = await pool.query('SELECT * FROM claves_comprobante WHERE id_solicitud = ?', [idSolicitud]);
    if (previa && previa.clave === n.clave && ['reservada', 'vigente'].includes(previa.estado)) return { ...publica(previa), reintento: true };
  }
  const [[activa]] = await pool.query("SELECT * FROM claves_comprobante WHERE clave = ? AND estado IN ('reservada', 'vigente')", [n.clave]);
  if (activa) {
    if (idClave && Number(idClave) === activa.id_clave && activa.estado === 'vigente') { // RN84: la adopta y agrega su vínculo
      const [vinc] = await pool.query("SELECT modulo, id_documento, rol FROM clave_vinculos WHERE id_clave = ? AND estado = 'vigente'", [activa.id_clave]);
      return { estado: 'vinculable', id_clave: activa.id_clave, clave: n.clave, modulo_dueno: activa.modulo_dueno, id_documento_dueno: activa.id_documento_dueno, vinculos: vinc };
    }
    if (activa.estado === 'reservada') { await intento(n.clave, 'en_proceso', null, modulo, userId); return { estado: 'en_proceso', clave: n.clave, ...(await quien(activa)) }; }
    await intento(n.clave, 'duplicado_exacto', `ya cargado en ${activa.modulo_dueno}: ${activa.id_documento_dueno ?? '-'}`, modulo, userId);
    return { estado: 'duplicado_exacto', clave: n.clave, id_clave: activa.id_clave, modulo: activa.modulo_dueno, documento: activa.id_documento_dueno };
  }
  if (n.cae && n.cae_tipo === 'CAE') { // RN66: un CAE identifica un solo comprobante
    const [[otro]] = await pool.query("SELECT * FROM claves_comprobante WHERE cae = ? AND cae_tipo = 'CAE' AND clave <> ? AND estado IN ('reservada', 'vigente') LIMIT 1", [n.cae, n.clave]);
    if (otro) {
      await intento(n.clave, 'bloqueado_cae', `el CAE ya es de ${otro.clave}`, modulo, userId);
      await Notificacion.crear({ modulo: 'usuarios', tipo: 'cae_repetido', severidad: 'alta', roles: ['administrador'], clave: `cae-${n.cae}`, mensaje: `Un comprobante intentó usar el CAE ${n.cae}, que ya pertenece a ${otro.clave}.` });
      return { estado: 'bloqueado_cae', clave: n.clave, cae: n.cae, comprobante: otro.clave, id_clave: otro.id_clave };
    }
  }
  const casi = await coincidentes(n);
  const advertencias = [...(n.sin_cuit ? [{ motivo: 'proveedor sin CUIT: no se puede asegurar la unicidad' }] : []), ...casi];
  if (advertencias.length && !confirmar) return { estado: 'casi_duplicado', clave: n.clave, coincidentes: advertencias, requiere: 'confirmacion_con_motivo' };
  if (advertencias.length) {
    if (typeof confirmar.motivo !== 'string' || !confirmar.motivo.trim()) throw invalida('Confirmar un casi duplicado exige el motivo.', 'motivo');
    for (const c of casi) await pool.query('INSERT IGNORE INTO clave_distintas (clave_a, clave_b, motivo, user_id, autorizante_id) VALUES (?, ?, ?, ?, ?)', [n.clave, c.clave, confirmar.motivo.trim().slice(0, 255), userId, confirmar.autorizante_id ?? null]);
  }
  const minutos = Number((await pool.query("SELECT valor FROM parametros WHERE clave = 'clave_reserva_minutos'"))[0][0]?.valor ?? 15);
  const idReserva = `RES-${crypto.randomUUID()}`;
  const [[vieja]] = idSolicitud ? await pool.query("SELECT id_clave FROM claves_comprobante WHERE id_solicitud = ? AND estado = 'vencida'", [idSolicitud]) : [[null]];
  if (vieja) await pool.query('UPDATE claves_comprobante SET id_solicitud = NULL WHERE id_clave = ?', [vieja.id_clave]);
  try {
    const [r] = await pool.query(
      `INSERT INTO claves_comprobante (clave, cuit_emisor, razon_social, clase, tipo_letra, punto_venta, numero, fecha_comprobante, importe, cae, cae_tipo, modulo_dueno, estado, reservada_hasta, id_reserva, reemplaza_a, motivo_confirmacion, user_id, terminal, autorizante_id, id_solicitud)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reservada', DATE_ADD(NOW(), INTERVAL ? MINUTE), ?, ?, ?, ?, ?, ?, ?)`,
      [n.clave, n.cuit, n.razon_social, n.clase, n.letra, n.punto_venta, n.numero, n.fecha, n.importe, n.cae, n.cae_tipo, modulo, minutos, idReserva, vieja?.id_clave ?? null, confirmar?.motivo?.trim() ?? null, userId, terminal, confirmar?.autorizante_id ?? null, idSolicitud]);
    return publica((await pool.query('SELECT * FROM claves_comprobante WHERE id_clave = ?', [r.insertId]))[0][0]);
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    return reservar(datos, { modulo, userId, terminal, idSolicitud: null, idClave, confirmar }); // carrera: ahora la clave ya está tomada, se informa como corresponde
  }
};

// Cancela una reserva cuyo documento no llegó a confirmarse (libera la clave sin esperar el vencimiento).
const cancelar = async (idReserva) => { await pool.query("UPDATE claves_comprobante SET estado = 'vencida' WHERE id_reserva = ? AND estado = 'reservada'", [idReserva]); };

// Confirmar: la reserva pasa a Vigente (la llama el receptor del mensaje "confirmar_clave"). Con la reserva vencida intenta tomarla de nuevo (EX57).
const confirmar = async (conn, { id_reserva: idReserva, id_documento: idDocumento, modulo, rol = 'registro_fisico', user_id: userId = null }) => {
  const [[c]] = await conn.query('SELECT * FROM claves_comprobante WHERE id_reserva = ?', [idReserva]);
  if (!c) throw new M.RechazoNegocio('La reserva de la clave no existe.');
  if (c.estado === 'vigente') return { id_clave: c.id_clave, ya_confirmada: true };
  if (c.estado !== 'reservada' && c.estado !== 'vencida') throw new M.RechazoNegocio(`La clave está ${c.estado}.`);
  const [r] = await conn.query("UPDATE claves_comprobante SET estado = 'vigente', reservada_hasta = NULL, modulo_dueno = ?, id_documento_dueno = ? WHERE id_clave = ? AND estado IN ('reservada', 'vencida')", [modulo, idDocumento, c.id_clave]).catch((err) => {
    if (err.code === 'ER_DUP_ENTRY') throw new M.RechazoNegocio('Duplicado: otra carga tomó la clave mientras la reserva estaba vencida.'); // EX57
    throw err;
  });
  if (!r.affectedRows) throw new M.RechazoNegocio('No se pudo confirmar la clave.');
  await conn.query('INSERT IGNORE INTO clave_vinculos (id_clave, modulo, id_documento, rol, user_id) VALUES (?, ?, ?, ?, ?)', [c.id_clave, modulo, idDocumento, rol, userId]);
  return { id_clave: c.id_clave, vigente: true, reservada_de_nuevo: c.estado === 'vencida' };
};
M.registrarReceptor('usuarios', 'confirmar_clave', (conn, contenido, ctx) => confirmar(conn, { ...contenido, user_id: contenido.user_id ?? null, ctx }));

// El módulo publica este mensaje dentro de la transacción de su documento (RN83).
const publicarConfirmacion = (conn, { idReserva, idDocumento, modulo, rol, userId, docTipo }) => M.publicar(conn, {
  origen: modulo, destino: 'usuarios', tipo: 'confirmar_clave', docTipo, docIdGlobal: idDocumento, userId,
  contenido: { id_reserva: idReserva, id_documento: idDocumento, modulo, rol, user_id: userId },
});

// RN84: otro módulo adopta la clave ya cargada y agrega su vínculo; Compras pasa a ser el dueño.
const vincular = async ({ id_clave: idClave, modulo, id_documento: idDocumento, rol = 'registro_fiscal', userId = null }) => {
  const [[c]] = await pool.query("SELECT * FROM claves_comprobante WHERE id_clave = ? AND estado = 'vigente'", [idClave]);
  if (!c) throw invalida('La clave no está vigente.', 'id_clave', 404);
  await pool.query('INSERT IGNORE INTO clave_vinculos (id_clave, modulo, id_documento, rol, user_id) VALUES (?, ?, ?, ?, ?)', [idClave, modulo, idDocumento, rol, userId]);
  if (modulo === 'compras') await pool.query('UPDATE claves_comprobante SET modulo_dueno = ?, id_documento_dueno = ? WHERE id_clave = ?', [modulo, idDocumento, idClave]);
  return obtener(idClave);
};

// RN64/RN84: al anularse un documento su vínculo se anula; sin vínculos vigentes, la clave queda Liberada y puede volver a cargarse.
const anular = async ({ modulo, id_documento: idDocumento }) => {
  const [vs] = await pool.query("SELECT id_clave FROM clave_vinculos WHERE modulo = ? AND id_documento = ? AND estado = 'vigente'", [modulo, idDocumento]);
  const liberadas = [];
  for (const v of vs) {
    await pool.query("UPDATE clave_vinculos SET estado = 'anulado' WHERE id_clave = ? AND modulo = ? AND id_documento = ?", [v.id_clave, modulo, idDocumento]);
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM clave_vinculos WHERE id_clave = ? AND estado = 'vigente'", [v.id_clave]);
    if (!n) {
      await pool.query("UPDATE claves_comprobante SET estado = 'liberada' WHERE id_clave = ?", [v.id_clave]);
      await pool.query('UPDATE claves_comprobante SET id_clave_vinculada = NULL WHERE id_clave_vinculada = ?', [v.id_clave]); // RN67: los remitos quedan sin vincular
      liberadas.push(v.id_clave);
    }
  }
  return { liberadas };
};

// RN67: un remito y la factura que lo cubre son claves distintas, vinculadas; una factura cubre varios remitos.
const vincularRemito = async ({ id_remito: idRemito, id_factura: idFactura }) => {
  const [[rem]] = await pool.query("SELECT * FROM claves_comprobante WHERE id_clave = ? AND estado = 'vigente'", [idRemito]);
  const [[fac]] = await pool.query("SELECT * FROM claves_comprobante WHERE id_clave = ? AND estado = 'vigente'", [idFactura]);
  if (!rem || !fac) throw invalida('El remito y la factura tienen que estar vigentes.', 'id_clave', 404);
  if (rem.clase !== 'REMITO' || fac.clase !== 'FACTURA') throw invalida('Se vincula un remito con la factura que lo cubre.', 'clase');
  if (rem.cuit_emisor !== fac.cuit_emisor || rem.razon_social !== fac.razon_social) throw invalida('El remito y la factura son del mismo emisor.', 'cuit');
  await pool.query('UPDATE claves_comprobante SET id_clave_vinculada = ? WHERE id_clave = ?', [idFactura, idRemito]);
  return obtener(idRemito);
};

// Un proveedor sin CUIT al que se le informa el CUIT después: se recalcula la clave y se vuelve a verificar (RN68).
const informarCuit = async (idClave, cuit) => {
  const [[c]] = await pool.query("SELECT * FROM claves_comprobante WHERE id_clave = ? AND estado = 'vigente'", [idClave]);
  if (!c) throw invalida('La clave no está vigente.', 'id_clave', 404);
  if (c.cuit_emisor) throw invalida('La clave ya tiene CUIT.', 'cuit', 409);
  const n = normalizar({ cuit, clase: c.clase, tipo: c.tipo_letra, punto_venta: c.punto_venta, numero: c.numero });
  const [[otra]] = await pool.query("SELECT id_clave FROM claves_comprobante WHERE clave = ? AND estado IN ('reservada', 'vigente')", [n.clave]);
  if (otra) return { estado: 'duplicado_exacto', clave: n.clave, id_clave: otra.id_clave };
  await pool.query('UPDATE claves_comprobante SET clave = ?, cuit_emisor = ?, razon_social = NULL WHERE id_clave = ?', [n.clave, n.cuit, idClave]);
  return { ...(await obtener(idClave)), recalculada: true };
};

const obtener = async (idClave) => {
  const [[c]] = await pool.query('SELECT * FROM claves_comprobante WHERE id_clave = ?', [idClave]);
  if (!c) throw invalida('Clave no encontrada.', 'id_clave', 404);
  const [vinculos] = await pool.query('SELECT modulo, id_documento, rol, estado FROM clave_vinculos WHERE id_clave = ? ORDER BY id_vinculo', [idClave]);
  return { ...c, vinculos };
};
const listar = async ({ estado, limite = 100 } = {}) => (await pool.query(`SELECT id_clave, clave, estado, modulo_dueno, id_documento_dueno, id_clave_vinculada, created_at FROM claves_comprobante ${estado ? 'WHERE estado = ?' : ''} ORDER BY id_clave DESC LIMIT ?`, estado ? [estado, Math.min(Number(limite) || 100, 500)] : [Math.min(Number(limite) || 100, 500)]))[0];

module.exports = { ClaveInvalida, normalizar, cuitValido, reservar, cancelar, confirmar, publicarConfirmacion, vincular, anular, vincularRemito, informarCuit, obtener, listar, vencerReservas };
