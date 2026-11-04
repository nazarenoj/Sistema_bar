const pool = require('../config/db');
const Mov = require('./movimientoService');
const Deposito = require('../models/depositoModel');
const Funciones = require('../funciones/servicio');
const Claves = require('../servicios/comprobanteTerceroService');
const M = require('../mensajeria/servicio');
const { idGlobal } = require('../utils/idGlobal');

// Artículos con número de serie (Stock RF26, RF37, RF41, RN05, RN71, RN79). Cada unidad es una serie: Disponible → Comprometida →
// Vendida (cada paso atómico, con un UPDATE condicionado al estado), o Baja. El stock por cantidad sigue saliendo de los movimientos;
// la serie suma su estado, su historial inmodificable y la garantía. La baja y la conversión (RF37) rigen aun con STK-SERIE inactiva.
class SerieInvalida extends Error {}
const invalida = (m, status = 400) => Object.assign(new SerieInvalida(m), { status });

const nuevoConn = async (fn, externa = null) => {
  if (externa) return fn(externa); // dentro de la transacción de quien llama (el descuento de una venta)
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const r = await fn(conn);
    await conn.commit();
    return r;
  } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
};

const evento = (conn, serieId, ev, { detalle, documento, userId } = {}) =>
  conn.query('INSERT INTO serie_historial (serie_id, evento, detalle, documento, user_id) VALUES (?, ?, ?, ?, ?)', [serieId, ev, detalle ? JSON.stringify(detalle) : null, documento ?? null, userId ?? null]);

const producto = async (conn, id, bloquear = false) => {
  const [[p]] = await conn.query(`SELECT id, nombre, controla_serie FROM productos WHERE id = ?${bloquear ? ' FOR UPDATE' : ''}`, [id]);
  if (!p) throw invalida('El producto no existe.', 404);
  return p;
};

// El artículo serializado solo se maneja con la función activa (RN71); la baja y la conversión no la necesitan.
const exigirSerializado = async (conn, id) => {
  const p = await producto(conn, id);
  if (!p.controla_serie) throw invalida('Ese artículo no controla número de serie.', 409);
  if (!(await Funciones.estaActiva('STK-SERIE'))) throw invalida('Un artículo serializado no es operable sin la función STK-SERIE (y VEN-SERIE): no se vende sin serie.', 409);
  return p;
};

const serie = async (conn, productoId, numero, bloquear = false) => {
  const [[s]] = await conn.query(`SELECT * FROM series WHERE producto_id = ? AND numero_serie = ?${bloquear ? ' FOR UPDATE' : ''}`, [productoId, String(numero ?? '').trim()]);
  if (!s) throw invalida('La serie no existe para ese artículo.', 404);
  return s;
};

// Activa o desactiva el control de serie del artículo. Apagarlo es la conversión (RF37b): convertir().
const activar = async (productoId) => {
  await producto(pool, productoId);
  if (!(await Funciones.estaActiva('STK-SERIE'))) throw invalida('Activá STK-SERIE (requiere VEN-SERIE) para controlar series.', 409);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM stock_movimientos WHERE producto_id = ?', [productoId]);
  const [[{ s }]] = await pool.query('SELECT COALESCE(SUM(cantidad), 0) AS s FROM stock_movimientos WHERE producto_id = ?', [productoId]);
  if (n && Number(s) !== 0) throw invalida('El artículo tiene existencias por cantidad: egresalas o convertilas antes de serializarlo.', 409);
  await pool.query('UPDATE productos SET controla_serie = 1 WHERE id = ?', [productoId]);
  return { producto_id: productoId, controla_serie: 1 };
};

// Ingreso de unidades con su número de serie: un movimiento de ingreso por la cantidad y una serie Disponible por cada número.
// Con comprobante, reserva su clave (Usuarios RF27) y la confirma en la misma transacción del ingreso; un casi duplicado no se puede confirmar desde acá (shortcut: usar el ingreso común).
const ingresar = async ({ producto_id, deposito_id, series, costo_unitario, proveedor, comprobante }, { userId, idSolicitud } = {}) => {
  if (!Array.isArray(series) || !series.length) throw invalida('Indicá los números de serie.');
  const numeros = series.map((s) => String(s ?? '').trim());
  if (numeros.some((s) => !s)) throw invalida('Hay un número de serie vacío.');
  if (new Set(numeros).size !== numeros.length) throw invalida('Hay números de serie repetidos en el ingreso.', 409);
  let reserva;
  try { reserva = await Mov.reservarClave(comprobante && { ...comprobante, confirmar_casi_duplicado: undefined }, proveedor, { userId, idSolicitud }); } catch (err) { throw err instanceof Mov.MovimientoInvalido ? Object.assign(invalida(err.message, err.status), { clave: err.clave }) : err; }
  try {
  const r = await nuevoConn(async (conn) => {
    await exigirSerializado(conn, producto_id);
    const dep = deposito_id ? await Deposito.getById(deposito_id, conn) : await Deposito.getPredeterminado(conn);
    if (!dep?.activo) throw invalida('El depósito no existe o está inactivo.');
    const [dup] = await conn.query('SELECT numero_serie FROM series WHERE producto_id = ? AND numero_serie IN (?)', [producto_id, numeros]);
    if (dup.length) throw invalida(`Ya existen las series: ${dup.map((d) => d.numero_serie).join(', ')}.`, 409);
    const documento = await idGlobal();
    await Mov.registrar(conn, { item: { tipo: 'producto', id: producto_id }, deposito_id: dep.id, tipo: 'ingreso', motivo: 'compra', cantidad: numeros.length, costo_unitario: costo_unitario ?? null, documento_tipo: 'ingreso_series', documento, user_id: userId });
    for (const n of numeros) {
      const [r] = await conn.query('INSERT INTO series (id_global, producto_id, numero_serie, deposito_id, costo_unitario) VALUES (?, ?, ?, ?, ?)', [await idGlobal(), producto_id, n, dep.id, costo_unitario ?? null]);
      await evento(conn, r.insertId, 'ingreso', { detalle: { proveedor: proveedor ?? null, comprobante: comprobante ?? null }, documento, userId });
    }
    if (reserva?.id_reserva) await Claves.publicarConfirmacion(conn, { idReserva: reserva.id_reserva, idDocumento: documento, modulo: 'stock', rol: 'registro_fisico', userId, docTipo: 'ingreso_series' });
    return { documento, deposito_id: dep.id, series: numeros };
  });
  if (reserva) M.despertar();
  if (reserva?.estado === 'vinculable') await Claves.vincular({ id_clave: reserva.id_clave, modulo: 'stock', id_documento: r.documento, rol: 'registro_fisico', userId });
  return r;
  } catch (err) {
    if (reserva?.id_reserva) await Claves.cancelar(reserva.id_reserva); // el ingreso no se hizo: la clave queda libre
    throw err;
  }
};

// Un paso de estado atómico: el UPDATE solo prospera si la serie sigue en el estado de origen.
const pasar = async (conn, s, de, a, set = {}) => {
  const campos = Object.keys(set);
  const [r] = await conn.query(`UPDATE series SET estado = ?${campos.map((c) => `, ${c} = ?`).join('')} WHERE id = ? AND estado = ?`, [a, ...campos.map((c) => set[c]), s.id, de]);
  if (!r.affectedRows) throw invalida(`La serie ${s.numero_serie} está "${s.estado}", no "${de}".`, 409);
};

const comprometer = async (productoId, numero, idCompromiso, { userId, conn: externa } = {}) => nuevoConn(async (conn) => {
  await exigirSerializado(conn, productoId);
  const s = await serie(conn, productoId, numero, true);
  await pasar(conn, s, 'disponible', 'comprometida', { id_compromiso: idCompromiso ?? null });
  await evento(conn, s.id, 'compromiso', { documento: idCompromiso, userId });
  return { numero_serie: s.numero_serie, estado: 'comprometida' };
}, externa);

const liberar = async (productoId, numero, { userId } = {}) => nuevoConn(async (conn) => {
  const s = await serie(conn, productoId, numero, true);
  await pasar(conn, s, 'comprometida', 'disponible', { id_compromiso: null });
  await evento(conn, s.id, 'liberacion', { documento: s.id_compromiso, userId });
  return { numero_serie: s.numero_serie, estado: 'disponible' };
});

// Venta de una serie comprometida: egresa la unidad y guarda la garantía que informa Ventas (Stock no la calcula, RN79).
const vender = async (productoId, numero, { documento, cliente, fecha_fin_garantia } = {}, { userId, conn: externa } = {}) => nuevoConn(async (conn) => {
  await exigirSerializado(conn, productoId);
  const s = await serie(conn, productoId, numero, true);
  await pasar(conn, s, 'comprometida', 'vendida', { fecha_fin_garantia: fecha_fin_garantia ?? null, id_compromiso: null });
  await Mov.registrar(conn, { item: { tipo: 'producto', id: productoId }, deposito_id: s.deposito_id, tipo: 'venta', motivo: 'venta', cantidad: -1, costo_unitario: s.costo_unitario, documento_tipo: 'venta', documento: documento ?? null, user_id: userId });
  await evento(conn, s.id, 'venta', { detalle: { cliente: cliente ?? null, fecha_fin_garantia: fecha_fin_garantia ?? null }, documento, userId });
  return { numero_serie: s.numero_serie, estado: 'vendida', fecha_fin_garantia: fecha_fin_garantia ?? null, costo_unitario: s.costo_unitario === null ? null : Number(s.costo_unitario) };
}, externa);

// Devolución (RN79): sin falla vuelve Disponible; con falla pasa a Baja con motivo (reingreso y baja de la unidad).
const devolver = async (productoId, numero, { condicion, motivo, documento } = {}, { userId, conn: externa } = {}) => {
  if (!['sin_falla', 'con_falla'].includes(condicion)) throw invalida('La condición debe ser "sin_falla" o "con_falla".');
  if (condicion === 'con_falla' && !String(motivo ?? '').trim()) throw invalida('Una devolución con falla exige el motivo de la baja.');
  return nuevoConn(async (conn) => {
    const s = await serie(conn, productoId, numero, true);
    const item = { tipo: 'producto', id: productoId };
    const comun = { item, deposito_id: s.deposito_id, costo_unitario: s.costo_unitario, documento_tipo: 'devolucion', documento: documento ?? null, user_id: userId };
    await pasar(conn, s, 'vendida', condicion === 'sin_falla' ? 'disponible' : 'baja', { condicion_devolucion: condicion, motivo_baja: condicion === 'con_falla' ? String(motivo).trim() : null });
    await Mov.registrar(conn, { ...comun, tipo: 'devolucion', motivo: 'devolucion_venta', cantidad: 1 });
    if (condicion === 'con_falla') await Mov.registrar(conn, { ...comun, tipo: 'egreso', motivo: 'baja_serie', cantidad: -1, observacion: String(motivo).trim() });
    await evento(conn, s.id, 'devolucion', { detalle: { condicion, motivo: motivo ?? null }, documento, userId });
    return { numero_serie: s.numero_serie, estado: condicion === 'sin_falla' ? 'disponible' : 'baja' };
  }, externa);
};

// Baja de series Disponibles con motivo (RF37a): egreso de motivo "Baja de serie". Una comprometida se consume o vence antes; una vendida no se toca.
const baja = async (productoId, numeros, motivo, { userId } = {}) => {
  if (!String(motivo ?? '').trim()) throw invalida('El motivo de la baja es obligatorio.');
  if (!Array.isArray(numeros) || !numeros.length) throw invalida('Indicá las series a dar de baja.');
  return nuevoConn(async (conn) => {
    await producto(conn, productoId);
    const documento = await idGlobal();
    for (const n of numeros) {
      const s = await serie(conn, productoId, n, true);
      if (s.estado === 'comprometida') throw invalida(`La serie ${s.numero_serie} está comprometida: debe consumirse o vencer su compromiso.`, 409);
      if (s.estado !== 'disponible') throw invalida(`La serie ${s.numero_serie} está "${s.estado}" y no se puede dar de baja.`, 409);
      await pasar(conn, s, 'disponible', 'baja', { motivo_baja: String(motivo).trim() });
      await Mov.registrar(conn, { item: { tipo: 'producto', id: productoId }, deposito_id: s.deposito_id, tipo: 'egreso', motivo: 'baja_serie', cantidad: -1, costo_unitario: s.costo_unitario, documento_tipo: 'baja_series', documento, user_id: userId, observacion: String(motivo).trim() });
      await evento(conn, s.id, 'baja', { detalle: { motivo: String(motivo).trim() }, documento, userId });
    }
    return { documento, series: numeros };
  });
};

// Conversión a no serializado (RF37b): las series Disponibles pasan a saldo por cantidad (sin mover el costo ni el stock) y el historial se conserva.
const convertir = async (productoId, { userId } = {}) => nuevoConn(async (conn) => {
  const p = await producto(conn, productoId, true);
  if (!p.controla_serie) throw invalida('Ese artículo no es serializado.', 409);
  const [comp] = await conn.query("SELECT numero_serie FROM series WHERE producto_id = ? AND estado = 'comprometida'", [productoId]);
  if (comp.length) throw invalida(`Hay series comprometidas (${comp.map((c) => c.numero_serie).join(', ')}): deben consumirse o vencer su compromiso.`, 409);
  const [disp] = await conn.query("SELECT id FROM series WHERE producto_id = ? AND estado = 'disponible' FOR UPDATE", [productoId]);
  for (const s of disp) {
    await conn.query("UPDATE series SET estado = 'convertida' WHERE id = ?", [s.id]);
    await evento(conn, s.id, 'conversion', { userId });
  }
  await conn.query('UPDATE productos SET controla_serie = 0 WHERE id = ?', [productoId]);
  return { producto_id: productoId, convertidas: disp.length };
});

// Series vigentes por artículo (RF37c): lo que Usuarios y Auditoría consulta para validar la desactivación de VEN-SERIE.
const vigentes = async () => (await pool.query(
  `SELECT s.producto_id, p.nombre, SUM(s.estado = 'disponible') AS disponibles, SUM(s.estado = 'comprometida') AS comprometidas, SUM(s.estado = 'vendida') AS vendidas
   FROM series s JOIN productos p ON p.id = s.producto_id WHERE s.estado IN ('disponible', 'comprometida', 'vendida') GROUP BY s.producto_id, p.nombre`))[0]
  .map((r) => ({ ...r, disponibles: Number(r.disponibles), comprometidas: Number(r.comprometidas), vendidas: Number(r.vendidas) }));

const listar = async (productoId, estado) => (await pool.query(
  `SELECT s.*, d.nombre AS deposito FROM series s JOIN depositos d ON d.id = s.deposito_id WHERE s.producto_id = ? ${estado ? 'AND s.estado = ?' : ''} ORDER BY s.numero_serie`, estado ? [productoId, estado] : [productoId]))[0];

// Historial de una serie, para consultar compra, venta con garantía, devolución y baja (RF41).
const historial = async (productoId, numero) => {
  const s = await serie(pool, productoId, numero);
  const [h] = await pool.query('SELECT evento, detalle, documento, user_id, created_at FROM serie_historial WHERE serie_id = ? ORDER BY id', [s.id]);
  return { serie: s, eventos: h.map((e) => ({ ...e, detalle: e.detalle ? JSON.parse(e.detalle) : null })) };
};

// Conteo por serie (RF14): compara lo contado con las Disponibles del depósito y deja la constancia en cada historial.
const contar = async (productoId, depositoId, contadas, { userId } = {}) => nuevoConn(async (conn) => {
  const [disp] = await conn.query("SELECT id, numero_serie FROM series WHERE producto_id = ? AND deposito_id = ? AND estado = 'disponible'", [productoId, depositoId]);
  const vistas = new Set((contadas ?? []).map((c) => String(c).trim()));
  const faltantes = disp.filter((s) => !vistas.has(s.numero_serie));
  const sobrantes = [...vistas].filter((c) => !disp.some((s) => s.numero_serie === c));
  for (const s of disp) await evento(conn, s.id, 'conteo', { detalle: { encontrada: vistas.has(s.numero_serie) }, userId });
  return { faltantes: faltantes.map((s) => s.numero_serie), sobrantes };
});

// ---- La venta de una serie (Ventas RF33, RN05, EX33): compromiso al cerrar, venta en el descuento y devolución ----

// ¿Se maneja esa serie con Stock? Con STK-SERIE activa y el artículo serializado.
const controla = async (conn, productoId) => (await Funciones.estaActiva('STK-SERIE', conn)) && !!(await producto(conn, productoId).catch(() => null))?.controla_serie;

// Estado de una serie para decirle al vendedor por qué no se puede vender (EX33).
const estadoParaVenta = async (productoId, numero) => {
  if (!(await controla(pool, productoId))) return { controlada: false };
  const [[s]] = await pool.query('SELECT estado FROM series WHERE producto_id = ? AND numero_serie = ?', [productoId, String(numero ?? '').trim()]);
  return { controlada: true, existe: !!s, estado: s?.estado ?? null };
};

// Compromete las series de las líneas del cierre (Disponible → Comprometida, atómico por serie). Si alguna no sirve, libera las que tomó.
const comprometerParaVenta = async (lineas, idCompromiso, { userId } = {}) => {
  const tomadas = [];
  for (const l of lineas.filter((x) => x.serie)) {
    if (!(await controla(pool, l.producto_id))) continue;
    try { await comprometer(l.producto_id, l.serie, idCompromiso, { userId }); tomadas.push(l); } catch (err) {
      if (!(err instanceof SerieInvalida)) throw err;
      for (const t of tomadas) await liberar(t.producto_id, t.serie, { userId }).catch(() => {});
      const e = await estadoParaVenta(l.producto_id, l.serie);
      return { ok: false, no_disponible: [{ producto_id: l.producto_id, serie: l.serie, existe: e.existe, estado: e.estado, motivo: e.existe ? `está ${e.estado}` : 'no existe' }] };
    }
  }
  return { ok: true, comprometidas: tomadas.length };
};
// Libera lo comprometido por un cierre que no se completó.
const liberarPorCompromiso = async (idCompromiso, { userId } = {}) => {
  const [filas] = await pool.query("SELECT producto_id, numero_serie FROM series WHERE estado = 'comprometida' AND id_compromiso = ?", [idCompromiso]);
  for (const s of filas) await liberar(s.producto_id, s.numero_serie, { userId }).catch(() => {});
  return filas.length;
};

// Venta de la serie en el descuento (idempotente: una serie ya vendida no se vuelve a vender). Devuelve el costo con que salió.
const venderEnDescuento = async (conn, { producto_id, serie: numero, documento, fecha_fin_garantia, cliente }, { userId } = {}) => {
  const s = await serie(conn, producto_id, numero, true);
  if (s.estado === 'vendida') return { costo_unitario: s.costo_unitario === null ? null : Number(s.costo_unitario), repetida: true };
  if (s.estado === 'disponible') await comprometer(producto_id, numero, documento, { userId, conn });
  else if (s.estado !== 'comprometida') throw invalida(`La serie ${numero} está ${s.estado}: no se puede vender.`, 409);
  const r = await vender(producto_id, numero, { documento, cliente, fecha_fin_garantia }, { userId, conn });
  return { costo_unitario: r.costo_unitario, repetida: false };
};

// Devolución de la serie (idempotente): sin falla vuelve Disponible; con falla se da de baja con el motivo.
const devolverEnReingreso = async (conn, { producto_id, serie: numero, condicion, motivo, documento }, { userId } = {}) => {
  const s = await serie(conn, producto_id, numero, true);
  if (s.estado !== 'vendida') return { sin_efecto: true };
  await devolver(producto_id, numero, { condicion, motivo, documento }, { userId, conn });
  return { sin_efecto: false };
};

module.exports = { SerieInvalida, controla, estadoParaVenta, comprometerParaVenta, liberarPorCompromiso, venderEnDescuento, devolverEnReingreso, activar, ingresar, comprometer, liberar, vender, devolver, baja, convertir, vigentes, listar, historial, contar };
