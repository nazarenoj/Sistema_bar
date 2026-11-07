const pool = require('../config/db');
const M = require('../mensajeria/servicio');
const llamar = require('../modulos/llamar');
const Claves = require('../servicios/comprobanteTerceroService');
const Lectura = require('../servicios/lecturaComprobanteService');
const Funciones = require('../funciones/servicio');
const { idGlobal } = require('../utils/idGlobal');
const Cuentas = require('./cuentaService');
const Turnos = require('./turnoService');
const { invalida, r2, movimiento } = require('./comun');

// Gastos (Financiero RF10): fecha, categoría, importe, caja o cuenta de pago y comprobante adjunto. Con comprobante fiscal se calcula su clave unívoca con el servicio de
// la plataforma (Usuarios RF27) antes de guardar (RN13, EX26) y se publica el evento «Gasto con comprobante fiscal» (Compras, si está instalado, lo toma para el Libro
// IVA). Si el servicio de claves no responde, el gasto fiscal queda en borrador sin movimiento (llamada n.º 10, política «cerrar»).
const ESTADOS_CLAVE = {
  duplicado_exacto: ['El comprobante ya está cargado (duplicado exacto): un comprobante se registra una sola vez.', 'DUPLICADO_EXACTO'],
  en_proceso: ['Otra carga de este comprobante está en proceso.', 'EN_PROCESO'],
  bloqueado_cae: ['Ese CAE ya pertenece a otro comprobante: corregí los datos.', 'CAE_REPETIDO'],
};
const TIPOS_ADJUNTO = ['image/jpeg', 'image/png', 'application/pdf'];
const TOPE_ADJUNTO = 4 * 1024 * 1024;

const fechaISO = (f, nombre = 'La fecha') => {
  const v = f ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(new Date(`${v}T00:00:00`).getTime())) throw invalida(`${nombre} debe tener el formato AAAA-MM-DD.`);
  return String(v);
};

const vista = (g) => ({
  id: g.id, id_global: g.id_global, fecha: g.fecha instanceof Date ? g.fecha.toISOString().slice(0, 10) : g.fecha, categoria_id: g.categoria_id, cuenta_id: g.cuenta_id, importe: Number(g.importe), moneda: g.moneda,
  descripcion: g.descripcion, proveedor: g.proveedor, estado: g.estado, origen: g.origen, fiscal: !!g.fiscal, comprobante: g.comprobante ? JSON.parse(g.comprobante) : null, clave: g.clave,
  adjunto: g.adjunto_nombre ? { nombre: g.adjunto_nombre, tipo: g.adjunto_tipo } : null, recurrente_id: g.recurrente_id, movimiento_id: g.movimiento_id === null ? null : Number(g.movimiento_id),
  motivo_anulacion: g.motivo_anulacion, user_id: g.user_id, ts_ms: Number(g.ts_ms),
});

const fila = async (id, db = pool) => {
  const [[g]] = await db.query('SELECT id, id_global, fecha, categoria_id, cuenta_id, importe, moneda, descripcion, proveedor, estado, origen, fiscal, comprobante, clave, id_reserva, adjunto_nombre, adjunto_tipo, recurrente_id, movimiento_id, motivo_anulacion, user_id, ts_ms FROM fin_gastos WHERE id = ?', [id]);
  if (!g) throw invalida('Gasto no encontrado.', 404);
  return g;
};
const obtener = async (id) => vista(await fila(id));

// Reserva la clave del comprobante fiscal con el servicio de plataforma. Devuelve la reserva, o `null` si el servicio no respondió (el gasto queda en borrador).
const reservarClave = async (comprobante, { proveedor, userId, idSolicitud, confirmar, auditar }) => {
  let r;
  try {
    const llamada = await llamar(10, 'financiero', () => Claves.reservar({ ...comprobante, razon_social: comprobante.razon_social ?? proveedor }, { modulo: 'financiero', userId, idSolicitud, idClave: comprobante.id_clave, confirmar }));
    r = llamada.valor;
  } catch (err) {
    // Un dato mal cargado no es un servicio caído: se devuelve para corregir (EX46).
    if (err.codigo === 'LLAMADA_CERRADA' && err.causa instanceof Claves.ClaveInvalida) throw invalida(err.causa.message, 400, { codigo: 'DATOS_INVALIDOS', detalle: { campo: err.causa.campo } });
    if (err.codigo === 'LLAMADA_CERRADA') return null;
    throw err;
  }
  if (r.estado === 'vinculable') return r;
  if (ESTADOS_CLAVE[r.estado]) {
    await auditar?.(`gasto_${r.estado}`, `${r.clave}: ${ESTADOS_CLAVE[r.estado][0]}`);
    throw invalida(ESTADOS_CLAVE[r.estado][0], 409, { codigo: ESTADOS_CLAVE[r.estado][1], detalle: { clave: r.clave, existente: r.documento ?? r.comprobante ?? null, modulo: r.modulo ?? null } });
  }
  if (r.estado === 'casi_duplicado')
    throw invalida('Hay un comprobante muy parecido ya cargado: revisalo y, si es distinto, confirmá con el motivo.', 409, { codigo: 'CASI_DUPLICADO', detalle: { clave: r.clave, coincidentes: r.coincidentes } });
  return r;
};

// Registra un gasto: lo paga una caja o cuenta (una caja no queda en negativo, EX04) y deja su movimiento (RN02).
const registrar = async (d, { userId, idSolicitud = null, autorizanteId = null, auditar = null } = {}) => {
  const importe = Number(d.importe);
  if (!(importe > 0)) throw invalida('El importe debe ser mayor a cero.');
  const fecha = fechaISO(d.fecha);
  const [[cat]] = await pool.query('SELECT id, activa FROM fin_categorias WHERE id = ?', [Number(d.categoria_id)]);
  if (!cat) throw invalida('Elegí la categoría del gasto.', 400);
  if (!cat.activa) throw invalida('La categoría está desactivada.', 409);
  const cuenta = await Cuentas.obtenerFila(Number(d.cuenta_id));
  if (!cuenta.activa) throw invalida('La caja o cuenta de pago está desactivada.', 409);
  const origen = d.origen ?? 'manual';
  const fiscal = !!d.comprobante;
  let adjunto = null;
  if (d.adjunto) {
    if (!TIPOS_ADJUNTO.includes(d.adjunto.tipo)) throw invalida('El adjunto debe ser JPG, PNG o PDF.');
    adjunto = Buffer.from(String(d.adjunto.imagen ?? ''), 'base64');
    if (!adjunto.length || adjunto.length > TOPE_ADJUNTO) throw invalida('El adjunto está vacío o supera los 4 MB.');
  }
  let reserva = null, borrador = false;
  if (fiscal) {
    reserva = await reservarClave(d.comprobante, { proveedor: d.proveedor, userId, idSolicitud, auditar,
      confirmar: d.confirmar_casi_duplicado ? { motivo: d.confirmar_casi_duplicado.motivo, autorizante_id: autorizanteId } : null });
    borrador = reserva === null; // RN13: si el servicio no responde, el gasto fiscal queda en borrador
    if (reserva?.estado === 'vinculable') reserva = { ...reserva, id_reserva: null };
    if (d.confirmar_casi_duplicado) await auditar?.('gasto_casi_duplicado_confirmado', `${reserva?.clave ?? ''}: ${d.confirmar_casi_duplicado.motivo}`);
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const idGasto = await idGlobal();
    let movId = null;
    if (!borrador) {
      await conn.query('SELECT id FROM fin_cuentas WHERE id = ? FOR UPDATE', [cuenta.id]);
      const saldo = await Cuentas.saldoDe(cuenta.id, conn);
      const piso = Cuentas.ES_CAJA(cuenta.tipo) ? 0 : -Number(cuenta.limite_descubierto);
      if (r2(saldo - importe) < piso) throw invalida(`El gasto dejaría "${cuenta.nombre}" ${Cuentas.ES_CAJA(cuenta.tipo) ? 'en negativo' : 'por debajo de su descubierto'}: el saldo disponible es ${r2(saldo - piso)}.`, 409, { codigo: 'SALDO_INSUFICIENTE', detalle: { saldo: r2(saldo - piso) } });
      const t = await Turnos.paraContramovimiento(conn, cuenta);
      if (Turnos.llevaTurno(cuenta) && !t.turnoId) throw invalida(`Abrí el turno de la caja "${cuenta.nombre}" antes de pagar un gasto con ella.`, 409, { codigo: 'SIN_TURNO_ABIERTO' });
      movId = await movimiento(conn, { cuentaId: cuenta.id, turnoId: t.turnoId, tipo: 'gasto', importe: -importe, moneda: cuenta.moneda, categoriaId: cat.id, motivo: d.descripcion ?? d.proveedor ?? 'Gasto', docIdGlobal: idGasto, userId });
    }
    const [r] = await conn.query(
      `INSERT INTO fin_gastos (id_global, fecha, categoria_id, cuenta_id, importe, moneda, descripcion, proveedor, estado, origen, fiscal, comprobante, clave, id_reserva, adjunto_nombre, adjunto_tipo, adjunto,
         recurrente_id, recurrente_fecha, movimiento_id, user_id, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [idGasto, fecha, cat.id, cuenta.id, importe, cuenta.moneda, d.descripcion ? String(d.descripcion).slice(0, 255) : null, d.proveedor ? String(d.proveedor).slice(0, 150) : null, borrador ? 'borrador' : 'confirmado', origen, fiscal ? 1 : 0,
        fiscal ? JSON.stringify(d.comprobante) : null, reserva?.clave ?? null, reserva?.id_reserva ?? null, d.adjunto?.nombre ? String(d.adjunto.nombre).slice(0, 120) : null, d.adjunto?.tipo ?? null, adjunto,
        d.recurrente_id ?? null, d.recurrente_fecha ?? null, movId, userId ?? null, Date.now()]);
    if (fiscal && !borrador) await publicarFiscal(conn, { id: r.insertId, idGasto, reserva, d, importe, fecha, userId });
    await conn.commit();
    M.despertar();
    const g = await obtener(r.insertId);
    return borrador ? { ...g, aviso: 'El servicio de identificación de comprobantes no respondió: el gasto quedó en borrador, sin pago, hasta confirmarlo.' } : g;
  } catch (err) {
    await conn.rollback();
    if (reserva?.id_reserva) await Claves.cancelar(reserva.id_reserva); // el gasto no se guardó: la clave queda libre sin esperar el vencimiento
    if (err.code === 'ER_DUP_ENTRY' && /uq_fin_gasto_recurrente/.test(err.message)) throw invalida('Ese gasto recurrente ya se generó para esa fecha.', 409, { codigo: 'RECURRENTE_YA_GENERADO' });
    throw err;
  } finally { conn.release(); }
};

// El evento «Gasto con comprobante fiscal» (idempotente por el ID del gasto) y la confirmación de la clave, en la misma transacción del gasto (RN13).
const publicarFiscal = async (conn, { id, idGasto, reserva, d, importe, fecha, userId }) => {
  if (reserva?.id_reserva) await Claves.publicarConfirmacion(conn, { idReserva: reserva.id_reserva, idDocumento: idGasto, modulo: 'financiero', rol: 'registro_fiscal', userId, docTipo: 'gasto' });
  await M.publicar(conn, { origen: 'financiero', destino: 'compras', tipo: 'gasto_con_comprobante_fiscal', docTipo: 'gasto', docIdGlobal: idGasto, userId,
    contenido: { gasto_id_global: idGasto, clave: reserva?.clave ?? null, comprobante: d.comprobante, proveedor: d.proveedor ?? null, importe, neto: d.comprobante.neto ?? null, iva: d.comprobante.iva ?? null, fecha } });
};

// Confirma un gasto fiscal que quedó en borrador porque el servicio de claves no respondió (RN13).
const confirmarBorrador = async (id, ctx) => {
  const g = await fila(id);
  if (g.estado !== 'borrador') throw invalida('El gasto no está en borrador.', 409);
  await pool.query('DELETE FROM fin_gastos WHERE id = ? AND estado = ?', [id, 'borrador']); // se vuelve a cargar completo, con su clave y su pago
  try {
    return await registrar({ fecha: g.fecha instanceof Date ? g.fecha.toISOString().slice(0, 10) : g.fecha, categoria_id: g.categoria_id, cuenta_id: g.cuenta_id, importe: Number(g.importe), descripcion: g.descripcion, proveedor: g.proveedor,
      comprobante: JSON.parse(g.comprobante), origen: g.origen, ...(ctx.confirmar_casi_duplicado && { confirmar_casi_duplicado: ctx.confirmar_casi_duplicado }) }, ctx);
  } catch (err) {
    // No se pudo: el borrador vuelve a existir tal cual estaba.
    await pool.query(
      `INSERT INTO fin_gastos (id_global, fecha, categoria_id, cuenta_id, importe, moneda, descripcion, proveedor, estado, origen, fiscal, comprobante, user_id, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'borrador', ?, 1, ?, ?, ?)`,
      [g.id_global, g.fecha, g.categoria_id, g.cuenta_id, g.importe, g.moneda, g.descripcion, g.proveedor, g.origen, g.comprobante, g.user_id, g.ts_ms]);
    throw err;
  }
};

// Anula un gasto con un contramovimiento (RN02, nunca se borra) y libera la clave de su comprobante.
const anular = async (id, { motivo }, userId) => {
  const g = await fila(id);
  if (g.estado === 'anulado') throw invalida('El gasto ya está anulado.', 409);
  if (typeof motivo !== 'string' || motivo.trim().length < 3) throw invalida('El motivo es obligatorio.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (g.movimiento_id !== null) {
      const cuenta = await Cuentas.obtenerFila(g.cuenta_id, conn);
      const t = await Turnos.paraContramovimiento(conn, cuenta);
      await movimiento(conn, { cuentaId: g.cuenta_id, turnoId: t.turnoId, enEspera: t.enEspera, tipo: 'anulacion_gasto', importe: Number(g.importe), moneda: g.moneda, categoriaId: g.categoria_id, vinculoId: g.movimiento_id,
        motivo: motivo.trim(), docIdGlobal: g.id_global, userId });
    }
    await conn.query("UPDATE fin_gastos SET estado = 'anulado', motivo_anulacion = ? WHERE id = ?", [motivo.trim().slice(0, 255), id]);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  if (g.fiscal && g.clave) await Claves.anular({ modulo: 'financiero', id_documento: g.id_global }).catch(() => {});
  return obtener(id);
};

const listar = async ({ desde, hasta, categoriaId, cuentaId, estado, limite = 100 } = {}) => {
  const w = [], p = [];
  if (desde) { w.push('fecha >= ?'); p.push(desde); }
  if (hasta) { w.push('fecha <= ?'); p.push(hasta); }
  if (categoriaId) { w.push('categoria_id = ?'); p.push(Number(categoriaId)); }
  if (cuentaId) { w.push('cuenta_id = ?'); p.push(Number(cuentaId)); }
  if (estado) { w.push('estado = ?'); p.push(estado); }
  const [filas] = await pool.query(`SELECT id, id_global, fecha, categoria_id, cuenta_id, importe, moneda, descripcion, proveedor, estado, origen, fiscal, comprobante, clave, adjunto_nombre, adjunto_tipo, recurrente_id, movimiento_id, motivo_anulacion, user_id, ts_ms FROM fin_gastos ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, [...p, Math.min(Number(limite) || 100, 500)]);
  return filas.map(vista);
};

const adjuntoDe = async (id) => {
  const [[g]] = await pool.query('SELECT adjunto_nombre, adjunto_tipo, adjunto FROM fin_gastos WHERE id = ?', [id]);
  if (!g?.adjunto) throw invalida('El gasto no tiene adjunto.', 404);
  return g;
};

// Carga por foto (FIN-FOTO-GASTOS): la imagen se lee con el servicio de la plataforma. Si es ilegible o el servicio no responde, se ofrece la carga manual con la imagen adjunta (EX12).
const leerFoto = async ({ imagen, tipo, nombre }) => {
  if (!(await Funciones.estaActiva('FIN-FOTO-GASTOS'))) throw invalida('La carga por foto necesita la función FIN-FOTO-GASTOS.', 409, { codigo: 'FUNCION_INACTIVA' });
  if (!TIPOS_ADJUNTO.includes(tipo)) throw invalida('La imagen debe ser JPG, PNG o PDF.');
  const adjunto = { nombre: nombre ?? 'comprobante', tipo };
  try {
    const r = await Lectura.leer({ imagen, tipo });
    if (r.estado === 'ok' && r.encabezado) return { estado: 'leido', comprobante: r.encabezado, adjunto };
  } catch { /* ilegible o sin servicio: se ofrece la carga manual */ }
  return { estado: 'ilegible', ofrecer: 'carga_manual', adjunto };
};

// Adjunta el comprobante (JPG, PNG o PDF) a un gasto ya cargado.
const adjuntar = async (id, { imagen, tipo, nombre }) => {
  await fila(id);
  if (!TIPOS_ADJUNTO.includes(tipo)) throw invalida('El adjunto debe ser JPG, PNG o PDF.');
  if (!Buffer.isBuffer(imagen) || !imagen.length || imagen.length > TOPE_ADJUNTO) throw invalida('El adjunto está vacío o supera los 4 MB.');
  await pool.query('UPDATE fin_gastos SET adjunto = ?, adjunto_tipo = ?, adjunto_nombre = ? WHERE id = ?', [imagen, tipo, String(nombre ?? 'comprobante').slice(0, 120), id]);
  return obtener(id);
};

module.exports = { adjuntar, registrar, confirmarBorrador, anular, obtener, listar, adjuntoDe, leerFoto, fechaISO };
