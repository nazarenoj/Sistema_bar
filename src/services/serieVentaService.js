const pool = require('../config/db');
const puertos = require('../modulos/puertos');
const llamar = require('../modulos/llamar');
const Funciones = require('../funciones/servicio');
const Notificacion = require('../models/notificacionModel');

// Artículos con número de serie en Ventas (RF33, RN05, RN79, EX33), con VEN-SERIE. Un artículo "serializado" exige indicar la serie en cada
// venta (una unidad por línea) y una misma serie no se vende dos veces sin una devolución previa. Con Stock y STK-SERIE la serie además tiene
// que estar Disponible y avanza Disponible → Comprometida → Vendida; sin ellos se captura en la venta y solo se controla su unicidad.
// Cada venta guarda la fecha de fin de garantía (fecha de venta + el plazo de ese momento, sin recalcular después, RN79).
class SerieVentaInvalida extends Error {}
const invalida = (m, status = 400, extra = {}) => Object.assign(new SerieVentaInvalida(m), { status, ...extra });

// Valida la serie de una línea que se agrega al pedido. Devuelve la serie normalizada, o null si el artículo no es serializado.
const validarEnPedido = async (conn, { producto, serie, cantidad, pedidoId }) => {
  if (producto.tipo !== 'serializado') {
    if (serie !== undefined && serie !== null) throw invalida(`"${producto.nombre}" no es un artículo con número de serie.`);
    return null;
  }
  // Un serializado sin VEN-SERIE no es vendible y se alerta: nunca se vende sin serie (EX33).
  if (!(await Funciones.estaActiva('VEN-SERIE', conn))) {
    await Notificacion.crear({ modulo: 'ventas', tipo: 'serializado_sin_funcion', severidad: 'alta', roles: ['administrador'], clave: `serializado-sin-ven-serie:${producto.id}`,
      mensaje: `"${producto.nombre}" es un artículo con número de serie y VEN-SERIE está inactiva: no se puede vender.` }).catch(() => {});
    throw invalida(`"${producto.nombre}" no es vendible: los artículos con número de serie necesitan la función VEN-SERIE.`, 409, { codigo: 'SERIALIZADO_NO_VENDIBLE' });
  }
  const numero = typeof serie === 'string' ? serie.trim() : '';
  if (!numero || numero.length > 80) throw invalida(`"${producto.nombre}" lleva número de serie: indicá la serie (hasta 80 caracteres).`, 400, { codigo: 'FALTA_SERIE' });
  if (cantidad !== 1) throw invalida('Un artículo con número de serie se carga de a una unidad por línea.');
  const [[vendida]] = await conn.query('SELECT venta_id_global FROM ventas_series WHERE producto_id = ? AND numero_serie = ? AND devuelta = 0', [producto.id, numero]);
  if (vendida) throw invalida(`La serie ${numero} ya se vendió y no tuvo una devolución.`, 409, { codigo: 'SERIE_NO_DISPONIBLE', estado: 'vendida' });
  const [[abierta]] = await conn.query("SELECT pp.pedido_id FROM pedido_productos pp JOIN pedidos p ON p.id = pp.pedido_id WHERE pp.producto_id = ? AND pp.serie = ? AND p.estado = 'activo' AND pp.pedido_id <> ? LIMIT 1", [producto.id, numero, pedidoId]);
  const [[propia]] = await conn.query('SELECT 1 AS si FROM pedido_productos WHERE producto_id = ? AND serie = ? AND pedido_id = ? LIMIT 1', [producto.id, numero, pedidoId]);
  if (abierta || propia) throw invalida(`La serie ${numero} ya está cargada en un pedido abierto.`, 409, { codigo: 'SERIE_NO_DISPONIBLE', estado: 'en_pedido' });
  // Con Stock y STK-SERIE, la serie tiene que existir y estar Disponible; se informa el estado (EX33).
  const r = await llamar(4, 'ventas', async () => (await puertos.obtener('stock')).estadoSerie(producto.id, numero));
  if (!r.fallo && r.valor?.controlada) {
    if (!r.valor.existe) throw invalida(`La serie ${numero} no existe en el inventario de "${producto.nombre}".`, 409, { codigo: 'SERIE_NO_DISPONIBLE', estado: 'inexistente' });
    if (r.valor.estado !== 'disponible') throw invalida(`La serie ${numero} no está disponible: está ${r.valor.estado}.`, 409, { codigo: 'SERIE_NO_DISPONIBLE', estado: r.valor.estado });
  }
  return numero;
};

// Al cerrar: guarda cada serie vendida con su garantía y devuelve las líneas con la fecha de fin de garantía.
const registrarVenta = async (conn, items, ventaIdGlobal) => {
  const salida = [];
  for (const i of items) {
    if (!i.serie) { salida.push(i); continue; }
    const [[p]] = await conn.query('SELECT plazo_garantia_dias AS plazo FROM productos WHERE id = ?', [i.producto_id]);
    const [[f]] = await conn.query('SELECT IF(? > 0, DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL ? DAY), \'%Y-%m-%d\'), NULL) AS fin', [p?.plazo ?? 0, p?.plazo ?? 0]);
    await conn.query('INSERT INTO ventas_series (producto_id, numero_serie, venta_id_global, nombre, fecha_venta, fecha_fin_garantia) VALUES (?, ?, ?, ?, NOW(), ?)',
      [i.producto_id, i.serie, ventaIdGlobal, i.nombre, f.fin]);
    salida.push({ ...i, fecha_fin_garantia: f.fin });
  }
  return salida;
};

// Devolución de una serie: sin falla vuelve a estar disponible; con falla se da de baja con motivo. Si la garantía venció, solo se advierte.
const devolver = async (conn, { producto_id, serie, venta_id_global, falla, motivo }) => {
  const [[s]] = await conn.query('SELECT id, fecha_fin_garantia, devuelta FROM ventas_series WHERE producto_id = ? AND numero_serie = ? AND venta_id_global = ?', [producto_id, serie, venta_id_global]);
  if (!s || s.devuelta) return { advertencia: null };
  await conn.query('UPDATE ventas_series SET devuelta = 1, con_falla = ?, motivo_falla = ?, devuelta_at = NOW() WHERE id = ?', [falla ? 1 : 0, falla ? motivo : null, s.id]);
  const fin = s.fecha_fin_garantia instanceof Date ? s.fecha_fin_garantia.toISOString().slice(0, 10) : s.fecha_fin_garantia;
  const vencida = fin && fin < new Date().toISOString().slice(0, 10);
  return { advertencia: vencida ? `La garantía de la serie ${serie} venció el ${fin}.` : null };
};

// Consulta de una serie vendida: venta, garantía y devolución (RF20, RN79).
const consultar = async (productoId, numero) => (await pool.query('SELECT * FROM ventas_series WHERE producto_id = ? AND numero_serie = ? ORDER BY id DESC', [productoId, numero]))[0];

// Datos vigentes que impiden desactivar VEN-SERIE (EX34): artículos serializados activos y series Disponibles o Comprometidas en Stock.
const datosVigentes = async () => {
  const out = [];
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM productos WHERE tipo = 'serializado'");
  if (n) out.push(`${n} artículo(s) serializado(s)`);
  const r = await llamar(4, 'ventas', async () => (await puertos.obtener('stock')).seriesVigentes());
  if (!r.fallo) for (const v of r.valor.filter((x) => x.disponibles + x.comprometidas > 0)) out.push(`${v.nombre}: ${v.disponibles} disponible(s) y ${v.comprometidas} comprometida(s)`);
  return out;
};
Funciones.registrarComprobacion('VEN-SERIE', { datosVigentes });

module.exports = { SerieVentaInvalida, validarEnPedido, registrarVenta, devolver, consultar };
