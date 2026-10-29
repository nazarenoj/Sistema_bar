const pool = require('../config/db');
const { idGlobal } = require('../utils/idGlobal');
const Funciones = require('../funciones/servicio');

// Cierre de la mesa (fin de la cuenta, no del pedido/silla individual): el momento en que se
// cerró el último pedido de la misma sesión (mismo mesa_id + sesion_apertura). Si todavía queda
// algún pedido activo de esa sesión, la cuenta sigue abierta y devuelve NULL.
const HORA_CIERRE_MESA_SUBQUERY = `(
  SELECT CASE WHEN SUM(p2.estado = 'activo') > 0 THEN NULL ELSE MAX(p2.fecha_cierre) END
  FROM pedidos p2
  WHERE p2.mesa_id = p.mesa_id AND p2.sesion_apertura = p.sesion_apertura
) AS hora_cierre_mesa`;

// LEFT JOIN facturas por (mesa_id, sesion_apertura): si la cuenta de este pedido ya tiene un
// comprobante fiscal (aprobado, pendiente o rechazado), viaja pegado al pedido para mostrarlo en
// el detalle del historial sin una consulta aparte.
const FACTURA_JOIN = `
  LEFT JOIN facturas f ON f.mesa_id = p.mesa_id AND f.sesion_apertura = p.sesion_apertura AND f.devolucion_id IS NULL`;
const FACTURA_COLUMNAS = `
  f.id AS factura_id, f.tipo_comprobante, f.punto_venta AS factura_punto_venta,
  f.numero AS factura_numero, f.cae, f.cae_vencimiento, f.estado AS factura_estado,
  f.importe_neto, f.importe_iva, f.importe_total AS factura_importe_total,
  f.observaciones AS factura_observaciones`;

const getById = async (id, conn = pool) => {
  const [rows] = await conn.query(
    `SELECT p.*, m.numero_mesa, m.estado AS mesa_estado, ${HORA_CIERRE_MESA_SUBQUERY}, ${FACTURA_COLUMNAS}
     FROM pedidos p
     JOIN mesas m ON p.mesa_id = m.id
     ${FACTURA_JOIN}
     WHERE p.id = ?`,
    [id]
  );
  return rows[0] || null;
};

// La sesión (sesion_apertura) identifica la cuenta completa de la mesa: si ya hay un pedido
// activo en esa mesa, el nuevo pedido se suma a la misma sesión; si no, empieza una nueva ahora.
const create = async (mesa_id) => {
  const snap = await Funciones.instantanea('pedido'); // las reglas del pedido quedan fijas hasta cerrarlo (RN75)
  const [result] = await pool.query(
    `INSERT INTO pedidos (mesa_id, sesion_apertura, id_global, config_version, config_instantanea)
     SELECT ?, COALESCE(
       (SELECT sesion_apertura FROM pedidos WHERE mesa_id = ? AND estado = 'activo' ORDER BY id ASC LIMIT 1),
       NOW()
     ), ?, ?, ?`,
    [mesa_id, mesa_id, await idGlobal(), snap.version, JSON.stringify(snap.funciones)]
  );
  const [rows] = await pool.query('SELECT * FROM pedidos WHERE id = ?', [result.insertId]);
  return rows[0];
};

const getActivosByMesa = async (mesa_id, conn = pool) => {
  const [rows] = await conn.query(
    "SELECT id FROM pedidos WHERE mesa_id = ? AND estado = 'activo'",
    [mesa_id]
  );
  return rows;
};

// Todos los pedidos activos de una mesa, ordenados por creación (para permitir varios pedidos simultáneos)
const getActivosConDatosByMesa = async (mesa_id, conn = pool) => {
  const [rows] = await conn.query(
    "SELECT * FROM pedidos WHERE mesa_id = ? AND estado = 'activo' ORDER BY id ASC",
    [mesa_id]
  );
  return rows;
};

// Items de varios pedidos a la vez (para armar la lista agrupada por pedido y para descontar stock al cerrar)
const getItemsByPedidoIds = async (pedidoIds, conn = pool) => {
  if (!pedidoIds.length) return [];
  const placeholders = pedidoIds.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT id, pedido_id, producto_id, nombre, descripcion, cantidad, precio_unitario, entregado,
            (cantidad * precio_unitario) AS subtotal
     FROM pedido_productos
     WHERE pedido_id IN (${placeholders})
     ORDER BY id ASC`,
    pedidoIds
  );
  return rows;
};

const getTotalAcumulado = async (pedidoIds, conn) => {
  if (!pedidoIds.length) return 0;
  const placeholders = pedidoIds.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT COALESCE(SUM(cantidad * precio_unitario), 0) AS total
     FROM pedido_productos
     WHERE pedido_id IN (${placeholders})`,
    pedidoIds
  );
  return Number(rows[0].total);
};

const addProductos = async (pedido_id, productos, conn) => {
  for (const { producto_id, cantidad, nombre, descripcion, precio_unitario } of productos) {
    await conn.query(
      'INSERT INTO pedido_productos (pedido_id, producto_id, cantidad, nombre, descripcion, precio_unitario) VALUES (?, ?, ?, ?, ?, ?)',
      [pedido_id, producto_id, cantidad, nombre, descripcion ?? null, precio_unitario]
    );
  }
};

// Columnas por las que se puede ordenar el historial (whitelist: van directo a un ORDER BY
// armado con string concatenation, así que nunca se acepta el nombre de columna del cliente sin
// pasar por este mapa).
const SORT_COLUMNAS = {
  fecha_cierre: 'p.fecha_cierre',
  fecha_creacion: 'p.fecha_creacion',
  sesion_apertura: 'p.sesion_apertura',
  numero_mesa: 'm.numero_mesa',
  total: 'p.total',
};

// Armado del WHERE/ORDER BY del historial, compartido por la consulta paginada de la pantalla y
// por la del reporte exportable: si los filtros se armaran dos veces, el archivo descargado podría
// no coincidir con lo que el usuario ve en la tabla.
// filtros admitidos: desde/hasta (fecha_cierre, 'YYYY-MM-DD'), numero_mesa, metodo_pago,
// estado_factura, con_factura ('si'|'no' — si la cuenta se facturó ante ARCA o se cerró solo con
// ticket), sort (clave de SORT_COLUMNAS), order ('asc'|'desc').
const construirConsultaHistorial = (filtros = {}) => {
  const { desde, hasta, numero_mesa, metodo_pago, estado_factura, con_factura, sort, order } = filtros;

  const condiciones = [`p.estado = 'finalizado'`];
  const params = [];
  if (desde) { condiciones.push('p.fecha_cierre >= ?'); params.push(`${desde} 00:00:00`); }
  if (hasta) { condiciones.push('p.fecha_cierre <= ?'); params.push(`${hasta} 23:59:59`); }
  if (numero_mesa) { condiciones.push('m.numero_mesa = ?'); params.push(numero_mesa); }
  if (metodo_pago) { condiciones.push('p.metodo_pago = ?'); params.push(metodo_pago); }
  if (estado_factura) { condiciones.push('f.estado = ?'); params.push(estado_factura); }
  if (con_factura === 'si') condiciones.push('f.id IS NOT NULL');
  if (con_factura === 'no') condiciones.push('f.id IS NULL');

  const ordenDireccion = order === 'asc' ? 'ASC' : 'DESC';
  const ordenSql = SORT_COLUMNAS[sort]
    ? `ORDER BY ${SORT_COLUMNAS[sort]} ${ordenDireccion}`
    : `ORDER BY p.fecha_cierre DESC, p.fecha_creacion DESC`;

  return { whereSql: `WHERE ${condiciones.join(' AND ')}`, params, ordenSql };
};

// Paginado: con más uso el historial crece indefinidamente, así que nunca se trae completo.
const getHistorial = async (page, limit, filtros = {}) => {
  const offset = (page - 1) * limit;
  const { whereSql, params, ordenSql } = construirConsultaHistorial(filtros);

  const [rows] = await pool.query(
    `SELECT p.id, p.mesa_id, m.numero_mesa, p.estado, p.total, p.metodo_pago,
            p.sesion_apertura, p.fecha_creacion, p.fecha_cierre,
            ${HORA_CIERRE_MESA_SUBQUERY}, ${FACTURA_COLUMNAS}
     FROM pedidos p
     JOIN mesas m ON p.mesa_id = m.id
     ${FACTURA_JOIN}
     ${whereSql}
     ${ordenSql}
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM pedidos p
     JOIN mesas m ON p.mesa_id = m.id
     ${FACTURA_JOIN}
     ${whereSql}`,
    params
  );
  return { rows, total };
};

// Mismo resultado que getHistorial pero sin paginar, para exportar el historial filtrado completo
// (el archivo tiene que traer todas las filas que coinciden, no las 20 de la página en pantalla).
// `maxFilas` es un tope de seguridad: se pide una fila extra para que el controller pueda detectar
// que el rango elegido se pasó del límite y pedirle al usuario que lo acote, en vez de armar un
// archivo gigante en memoria.
const getHistorialCompleto = async (filtros = {}, maxFilas = 5000) => {
  const { whereSql, params, ordenSql } = construirConsultaHistorial(filtros);

  const [rows] = await pool.query(
    `SELECT p.id, p.mesa_id, m.numero_mesa, p.estado, p.total, p.metodo_pago,
            p.sesion_apertura, p.fecha_creacion, p.fecha_cierre,
            ${HORA_CIERRE_MESA_SUBQUERY}, ${FACTURA_COLUMNAS}
     FROM pedidos p
     JOIN mesas m ON p.mesa_id = m.id
     ${FACTURA_JOIN}
     ${whereSql}
     ${ordenSql}
     LIMIT ?`,
    [...params, maxFilas + 1]
  );
  return rows;
};

// Agrupa las ventas cerradas por hora (tipo='dia') o por día (tipo='semana'/'mes') para graficar.
// fecha ('YYYY-MM-DD') es la fecha ancla: para 'semana' se usa la semana (lunes a domingo) que la
// contiene, para 'mes' el mes calendario que la contiene. Se arma con componentes locales de Date
// (no parseo de ISO string, que interpreta en UTC) para no correr el día por husos horarios.
const getEstadisticas = async (tipo, fecha) => {
  const [anio, mes, dia] = fecha.split('-').map(Number);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  let desde, hasta, agruparPor;
  if (tipo === 'dia') {
    desde = hasta = fecha;
    agruparPor = 'HOUR(p.fecha_cierre)';
  } else if (tipo === 'semana') {
    const base = new Date(anio, mes - 1, dia);
    const offsetLunes = (base.getDay() + 6) % 7; // lunes=0 ... domingo=6
    const lunes = new Date(anio, mes - 1, dia - offsetLunes);
    const domingo = new Date(lunes.getFullYear(), lunes.getMonth(), lunes.getDate() + 6);
    desde = fmt(lunes);
    hasta = fmt(domingo);
    agruparPor = "DATE_FORMAT(p.fecha_cierre, '%Y-%m-%d')";
  } else {
    const primerDia = new Date(anio, mes - 1, 1);
    const ultimoDia = new Date(anio, mes, 0);
    desde = fmt(primerDia);
    hasta = fmt(ultimoDia);
    agruparPor = "DATE_FORMAT(p.fecha_cierre, '%Y-%m-%d')";
  }

  const [rows] = await pool.query(
    `SELECT ${agruparPor} AS clave, COUNT(*) AS cantidad, COALESCE(SUM(p.total), 0) AS total
     FROM pedidos p
     WHERE p.estado = 'finalizado' AND p.fecha_cierre >= ? AND p.fecha_cierre <= ?
     GROUP BY clave`,
    [`${desde} 00:00:00`, `${hasta} 23:59:59`]
  );

  return { desde, hasta, rows };
};

const getItems = async (pedido_id, conn = pool) => {
  const [rows] = await conn.query(
    `SELECT id, pedido_id, producto_id, nombre, descripcion, cantidad, precio_unitario, entregado,
            (cantidad * precio_unitario) AS subtotal
     FROM pedido_productos
     WHERE pedido_id = ?
     ORDER BY id ASC`,
    [pedido_id]
  );
  return rows;
};

// Ids de todos los pedidos (sillas) de una misma sesión de mesa, ordenados por apertura;
// sirve para saber "silla N de M" al imprimir el ticket.
const getSillasSesion = async (mesa_id, sesion_apertura, conn = pool) => {
  const [rows] = await conn.query(
    'SELECT id FROM pedidos WHERE mesa_id = ? AND sesion_apertura = ? ORDER BY id ASC',
    [mesa_id, sesion_apertura]
  );
  return rows.map((r) => r.id);
};

// sesion_apertura de la última cuenta cerrada de una mesa (para el ticket consolidado tras
// "Cerrar Cuenta"), o null si esa mesa nunca tuvo una cuenta finalizada.
const getUltimaSesionCerrada = async (mesa_id, conn = pool) => {
  const [rows] = await conn.query(
    `SELECT sesion_apertura FROM pedidos
     WHERE mesa_id = ? AND fecha_cierre IS NOT NULL
     ORDER BY fecha_cierre DESC LIMIT 1`,
    [mesa_id]
  );
  return rows[0]?.sesion_apertura ?? null;
};

// Todos los pedidos (sillas) de una sesión de mesa puntual, para armar el ticket consolidado
const getPedidosSesion = async (mesa_id, sesion_apertura, conn = pool) => {
  const [rows] = await conn.query(
    'SELECT * FROM pedidos WHERE mesa_id = ? AND sesion_apertura = ? ORDER BY id ASC',
    [mesa_id, sesion_apertura]
  );
  return rows;
};

const getItem = async (id, conn = pool) => {
  const [rows] = await conn.query('SELECT * FROM pedido_productos WHERE id = ?', [id]);
  return rows[0] || null;
};

const removeItem = async (id, conn) => {
  await conn.query('DELETE FROM pedido_productos WHERE id = ?', [id]);
};

// Marca un producto puntual como entregado o no (seguimiento de servicio, no afecta el total)
const setItemEntregado = async (id, entregado, conn = pool) => {
  await conn.query('UPDATE pedido_productos SET entregado = ? WHERE id = ?', [entregado ? 1 : 0, id]);
};

// Marca todos los productos de un pedido (silla) de una sola vez
const setPedidoEntregado = async (pedido_id, entregado, conn = pool) => {
  await conn.query('UPDATE pedido_productos SET entregado = ? WHERE pedido_id = ?', [entregado ? 1 : 0, pedido_id]);
};

// Elimina un pedido activo por completo (sus items primero, por la FK)
const remove = async (pedido_id, conn) => {
  await conn.query('DELETE FROM pedido_productos WHERE pedido_id = ?', [pedido_id]);
  await conn.query('DELETE FROM pedidos WHERE id = ?', [pedido_id]);
};

// Guarda el método de pago en todos los pedidos de la cuenta (misma mesa y sesión), incluidos los
// que se cerraron antes por silla. Vive en `pedidos` y no en `facturas` para no perderlo cuando la
// cuenta se cierra sin facturar.
const setMetodoPago = async (mesa_id, sesion_apertura, metodo_pago, conn) => {
  await conn.query(
    'UPDATE pedidos SET metodo_pago = ? WHERE mesa_id = ? AND sesion_apertura = ?',
    [metodo_pago, mesa_id, sesion_apertura]
  );
};

// Cierra un único pedido (a diferencia de cerrarPedidosMesa, que cierra todos los de la mesa a la vez)
const cerrarPedidoIndividual = async (pedido_id, conn) => {
  await conn.query(
    `UPDATE pedidos p
     LEFT JOIN (
       SELECT pedido_id, SUM(cantidad * precio_unitario) AS subtotal
       FROM pedido_productos
       WHERE pedido_id = ?
       GROUP BY pedido_id
     ) pp ON p.id = pp.pedido_id
     SET p.total  = COALESCE(pp.subtotal, 0),
         p.estado = 'finalizado',
         p.fecha_cierre = NOW()
     WHERE p.id = ?`,
    [pedido_id, pedido_id]
  );
};

// UPDATE con JOIN para calcular el total individual de cada pedido y marcarlo finalizado
const cerrarPedidosMesa = async (mesa_id, conn) => {
  await conn.query(
    `UPDATE pedidos p
     LEFT JOIN (
       SELECT pedido_id, SUM(cantidad * precio_unitario) AS subtotal
       FROM pedido_productos
       GROUP BY pedido_id
     ) pp ON p.id = pp.pedido_id
     SET p.total  = COALESCE(pp.subtotal, 0),
         p.estado = 'finalizado',
         p.fecha_cierre = NOW()
     WHERE p.mesa_id = ? AND p.estado = 'activo'`,
    [mesa_id]
  );
};

module.exports = {
  getById,
  create,
  getActivosByMesa,
  getActivosConDatosByMesa,
  getItemsByPedidoIds,
  getTotalAcumulado,
  addProductos,
  cerrarPedidosMesa,
  setMetodoPago,
  cerrarPedidoIndividual,
  getHistorial,
  getHistorialCompleto,
  getEstadisticas,
  SORT_CAMPOS_VALIDOS: Object.keys(SORT_COLUMNAS),
  getItems,
  getItem,
  getSillasSesion,
  getUltimaSesionCerrada,
  getPedidosSesion,
  setItemEntregado,
  setPedidoEntregado,
  removeItem,
  remove,
};
