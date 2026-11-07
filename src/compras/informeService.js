const pool = require('../config/db');
const Tablero = require('../servicios/tableroService');
const Funciones = require('../funciones/servicio');
const { invalida, r2, hoy, iso } = require('./comun');

// Consultas e informes de Compras (RF16) e indicadores para el tablero (RF22). Todo se calcula con los datos de la instancia, sin servicios externos.
// Las compras cuentan facturas, tickets y notas de débito y restan las notas de crédito; lo anulado y los borradores no cuentan.
const VIGENTE = "c.estado IN ('registrado', 'pendiente_recepcion', 'con_diferencias')";
const SIGNO = "CASE WHEN c.clase = 'NOTA_CREDITO' THEN -1 ELSE 1 END";
const COMPRA = "c.clase IN ('FACTURA', 'TICKET', 'NOTA_DEBITO', 'NOTA_CREDITO')";

const rango = (q = {}) => {
  const f = (v, n) => { if (v === undefined || v === '') return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw invalida(`"${n}" va como AAAA-MM-DD.`); return v; };
  return { desde: f(q.desde, 'desde'), hasta: f(q.hasta, 'hasta') };
};
const filtros = (q, campo = 'c.fecha') => {
  const { desde, hasta } = rango(q), w = [], p = [];
  if (desde) { w.push(`${campo} >= ?`); p.push(desde); }
  if (hasta) { w.push(`${campo} <= ?`); p.push(hasta); }
  if (q.proveedor_id) { w.push('c.proveedor_id = ?'); p.push(Number(q.proveedor_id)); }
  return { w, p };
};
const donde = (w) => (w.length ? ` AND ${w.join(' AND ')}` : '');
const num = (x) => r2(x ?? 0);

const nombreItem = "COALESCE((SELECT nombre FROM insumos WHERE id = l.item_id AND l.item_tipo = 'insumo'), (SELECT nombre FROM productos WHERE id = l.item_id AND l.item_tipo = 'producto'), l.descripcion)";

const INFORMES = {
  deuda: {
    titulo: 'Deuda por proveedor', columnas: [['proveedor', 'Proveedor', 'texto'], ['moneda', 'Moneda', 'texto'], ['cuotas', 'Cuotas', 'numero'], ['deuda', 'Deuda', 'moneda'], ['vencida', 'Vencida', 'moneda']],
    corrida: async (q) => {
      const { w, p } = filtros({ proveedor_id: q.proveedor_id });
      return (await pool.query(`SELECT pr.razon_social AS proveedor, c.moneda, COUNT(*) AS cuotas, SUM(v.saldo) AS deuda, SUM(CASE WHEN v.fecha < CURDATE() THEN v.saldo ELSE 0 END) AS vencida
        FROM cmp_vencimientos v JOIN cmp_comprobantes c ON c.id = v.comprobante_id JOIN cmp_proveedores pr ON pr.id = c.proveedor_id WHERE v.estado = 'pendiente' AND ${VIGENTE}${donde(w)} GROUP BY pr.id, pr.razon_social, c.moneda ORDER BY deuda DESC`, p))[0]
        .map((x) => ({ ...x, cuotas: Number(x.cuotas), deuda: num(x.deuda), vencida: num(x.vencida) }));
    },
  },
  vencimientos: {
    titulo: 'Vencimientos por período', columnas: [['periodo', 'Período', 'texto'], ['moneda', 'Moneda', 'texto'], ['cuotas', 'Cuotas', 'numero'], ['importe', 'A pagar', 'moneda']],
    corrida: async (q) => {
      const { w, p } = filtros(q, 'v.fecha');
      return (await pool.query(`SELECT DATE_FORMAT(v.fecha, '%Y-%m') AS periodo, c.moneda, COUNT(*) AS cuotas, SUM(v.saldo) AS importe FROM cmp_vencimientos v JOIN cmp_comprobantes c ON c.id = v.comprobante_id
        WHERE v.estado = 'pendiente' AND ${VIGENTE}${donde(w)} GROUP BY periodo, c.moneda ORDER BY periodo`, p))[0].map((x) => ({ ...x, cuotas: Number(x.cuotas), importe: num(x.importe) }));
    },
  },
  'compras-proveedor': {
    titulo: 'Compras por proveedor', columnas: [['proveedor', 'Proveedor', 'texto'], ['comprobantes', 'Comprobantes', 'numero'], ['neto', 'Neto', 'moneda'], ['iva', 'IVA', 'moneda'], ['total', 'Total', 'moneda']],
    corrida: async (q) => {
      const { w, p } = filtros(q);
      return (await pool.query(`SELECT pr.razon_social AS proveedor, COUNT(*) AS comprobantes, SUM(${SIGNO} * (c.neto_gravado + c.no_gravado + c.exento)) AS neto, SUM(${SIGNO} * c.iva) AS iva, SUM(${SIGNO} * c.total) AS total
        FROM cmp_comprobantes c JOIN cmp_proveedores pr ON pr.id = c.proveedor_id WHERE ${VIGENTE} AND ${COMPRA}${donde(w)} GROUP BY pr.id, pr.razon_social ORDER BY total DESC`, p))[0]
        .map((x) => ({ ...x, comprobantes: Number(x.comprobantes), neto: num(x.neto), iva: num(x.iva), total: num(x.total) }));
    },
  },
  'compras-rubro': {
    titulo: 'Compras por rubro de proveedor', columnas: [['rubro', 'Rubro', 'texto'], ['comprobantes', 'Comprobantes', 'numero'], ['total', 'Total', 'moneda']],
    corrida: async (q) => {
      const { w, p } = filtros(q);
      return (await pool.query(`SELECT COALESCE(r.nombre, 'Sin rubro') AS rubro, COUNT(*) AS comprobantes, SUM(${SIGNO} * c.total) AS total FROM cmp_comprobantes c JOIN cmp_proveedores pr ON pr.id = c.proveedor_id
        LEFT JOIN cmp_rubros r ON r.id = pr.rubro_id WHERE ${VIGENTE} AND ${COMPRA}${donde(w)} GROUP BY rubro ORDER BY total DESC`, p))[0].map((x) => ({ ...x, comprobantes: Number(x.comprobantes), total: num(x.total) }));
    },
  },
  'compras-articulo': {
    titulo: 'Compras por artículo', columnas: [['articulo', 'Artículo', 'texto'], ['cantidad', 'Cantidad (base)', 'numero'], ['importe', 'Importe', 'moneda']],
    corrida: async (q) => {
      const { w, p } = filtros(q);
      return (await pool.query(`SELECT ${nombreItem} AS articulo, SUM(${SIGNO} * l.cantidad * COALESCE(l.factor_aplicado, 1)) AS cantidad, SUM(${SIGNO} * l.importe) AS importe FROM cmp_comprobante_lineas l JOIN cmp_comprobantes c ON c.id = l.comprobante_id
        WHERE l.tipo = 'mercaderia' AND ${VIGENTE} AND ${COMPRA}${donde(w)} GROUP BY l.item_tipo, l.item_id, articulo ORDER BY importe DESC`, p))[0].map((x) => ({ ...x, cantidad: Number(x.cantidad), importe: num(x.importe) }));
    },
  },
  'compras-categoria': {
    titulo: 'Compras por categoría', columnas: [['categoria', 'Categoría', 'texto'], ['importe', 'Importe', 'moneda']],
    corrida: async (q) => {
      const { w, p } = filtros(q);
      return (await pool.query(`SELECT COALESCE(l.categoria, 'Sin categoría') AS categoria, SUM(${SIGNO} * l.importe) AS importe FROM cmp_comprobante_lineas l JOIN cmp_comprobantes c ON c.id = l.comprobante_id
        WHERE ${VIGENTE} AND ${COMPRA}${donde(w)} GROUP BY categoria ORDER BY importe DESC`, p))[0].map((x) => ({ ...x, importe: num(x.importe) }));
    },
  },
  'evolucion-costos': {
    titulo: 'Evolución de costos', columnas: [['fecha', 'Fecha', 'texto'], ['articulo', 'Artículo', 'texto'], ['costo', 'Costo', 'moneda'], ['moneda', 'Moneda', 'texto'], ['fuente', 'Fuente', 'texto']],
    corrida: async (q) => {
      const { desde, hasta } = rango(q), w = [], p = [];
      if (desde) { w.push('h.fecha >= ?'); p.push(desde); }
      if (hasta) { w.push('h.fecha <= ?'); p.push(hasta); }
      if (q.item_tipo && q.item_id) { w.push('h.item_tipo = ? AND h.item_id = ?'); p.push(q.item_tipo, Number(q.item_id)); }
      return (await pool.query(`SELECT h.fecha, COALESCE((SELECT nombre FROM insumos WHERE id = h.item_id AND h.item_tipo = 'insumo'), (SELECT nombre FROM productos WHERE id = h.item_id AND h.item_tipo = 'producto')) AS articulo, h.costo, h.moneda, h.fuente
        FROM cmp_costos_historial h ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY h.id DESC LIMIT 1000`, p))[0].map((x) => ({ ...x, fecha: iso(x.fecha), costo: Number(x.costo) }));
    },
  },
  retenciones: {
    titulo: 'Retenciones practicadas', funcion: 'CMP-RETENCIONES', columnas: [['fecha', 'Fecha', 'texto'], ['proveedor', 'Proveedor', 'texto'], ['regimen', 'Régimen', 'texto'], ['certificado', 'Certificado', 'numero'], ['base', 'Base', 'moneda'], ['importe', 'Retenido', 'moneda']],
    corrida: async (q) => {
      const { desde, hasta } = rango(q), w = ['r.anulado = 0'], p = [];
      if (desde) { w.push('r.fecha >= ?'); p.push(desde); }
      if (hasta) { w.push('r.fecha <= ?'); p.push(hasta); }
      if (q.proveedor_id) { w.push('o.proveedor_id = ?'); p.push(Number(q.proveedor_id)); }
      return (await pool.query(`SELECT r.fecha, pr.razon_social AS proveedor, g.codigo AS regimen, r.certificado, r.base, r.importe FROM cmp_op_retenciones r JOIN cmp_ordenes_pago o ON o.id = r.orden_id AND o.estado <> 'anulada'
        JOIN cmp_proveedores pr ON pr.id = o.proveedor_id JOIN cmp_regimenes_retencion g ON g.id = r.regimen_id WHERE ${w.join(' AND ')} ORDER BY r.fecha DESC, r.id DESC LIMIT 1000`, p))[0]
        .map((x) => ({ ...x, fecha: iso(x.fecha), base: Number(x.base), importe: Number(x.importe) }));
    },
  },
  percepciones: {
    titulo: 'Percepciones sufridas', funcion: 'CMP-RETENCIONES', columnas: [['proveedor', 'Proveedor', 'texto'], ['percepciones_iva', 'Percepciones de IVA', 'moneda'], ['percepciones_iibb', 'Percepciones de IIBB', 'moneda']],
    corrida: async (q) => {
      const { w, p } = filtros(q);
      return (await pool.query(`SELECT pr.razon_social AS proveedor, SUM(${SIGNO} * c.percepciones_iva) AS percepciones_iva, SUM(${SIGNO} * c.percepciones_iibb) AS percepciones_iibb FROM cmp_comprobantes c JOIN cmp_proveedores pr ON pr.id = c.proveedor_id
        WHERE ${VIGENTE} AND ${COMPRA}${donde(w)} GROUP BY pr.id, pr.razon_social HAVING percepciones_iva <> 0 OR percepciones_iibb <> 0 ORDER BY pr.razon_social`, p))[0].map((x) => ({ ...x, percepciones_iva: num(x.percepciones_iva), percepciones_iibb: num(x.percepciones_iibb) }));
    },
  },
};

const tipos = () => Object.keys(INFORMES);
const ejecutar = async (tipo, q = {}) => {
  const inf = INFORMES[tipo];
  if (!inf) throw invalida(`El informe es uno de: ${tipos().join(', ')}.`, 404);
  if (inf.funcion && !(await Funciones.estaActiva(inf.funcion))) throw invalida(`Este informe necesita la función ${inf.funcion}.`, 409, { codigo: 'FUNCION_INACTIVA' });
  return { tipo, titulo: inf.titulo, columnas: inf.columnas.map(([key, label, t]) => ({ key, label, tipo: t, ancho: t === 'texto' ? 28 : 16 })), filas: await inf.corrida(q) };
};

// ---- Indicadores del tablero (RF22) ----

const f = (d) => new Date(d).toISOString().slice(0, 10);
const comprasDe = async (desde, hasta, groupBy) => {
  const campo = groupBy === 'rubro' ? "COALESCE(r.nombre, 'Sin rubro')" : 'pr.razon_social';
  return (await pool.query(`SELECT ${campo} AS clave, SUM(${SIGNO} * c.total) AS total FROM cmp_comprobantes c JOIN cmp_proveedores pr ON pr.id = c.proveedor_id LEFT JOIN cmp_rubros r ON r.id = pr.rubro_id
    WHERE ${VIGENTE} AND ${COMPRA} AND c.fecha BETWEEN ? AND ? GROUP BY clave ORDER BY total DESC`, [f(desde), f(hasta)]))[0].map((x) => ({ clave: x.clave, valor: num(x.total) }));
};

Tablero.registrar([
  { id: 'compras.deuda', nombre: 'Deuda con proveedores', modulo: 'compras', permiso: 'compras.cuentas.ver', unidad: '$',
    calcular: async () => {
      const [[r]] = await pool.query(`SELECT COALESCE(SUM(v.saldo), 0) AS deuda, COALESCE(SUM(CASE WHEN v.fecha < CURDATE() THEN v.saldo ELSE 0 END), 0) AS vencida FROM cmp_vencimientos v JOIN cmp_comprobantes c ON c.id = v.comprobante_id WHERE v.estado = 'pendiente' AND ${VIGENTE}`);
      return { valor: num(r.deuda), detalle: { vencida: num(r.vencida) } };
    } },
  { id: 'compras.vencimientos', nombre: 'Vencimientos de los próximos 7 días', modulo: 'compras', permiso: 'compras.cuentas.ver', unidad: '$',
    calcular: async () => {
      const dias = Number((await pool.query("SELECT valor FROM parametros WHERE clave = 'cmp_tablero_dias'"))[0][0]?.valor ?? 7);
      const [[r]] = await pool.query(`SELECT COALESCE(SUM(v.saldo), 0) AS importe, COUNT(*) AS cuotas FROM cmp_vencimientos v JOIN cmp_comprobantes c ON c.id = v.comprobante_id WHERE v.estado = 'pendiente' AND ${VIGENTE} AND v.fecha BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)`, [dias]);
      return { valor: num(r.importe), detalle: { cuotas: Number(r.cuotas), dias } };
    } },
  { id: 'compras.periodo', nombre: 'Compras del período', modulo: 'compras', permiso: 'compras.comprobantes.ver', comparable: true, unidad: '$',
    calcular: async ({ desde, hasta }) => { const s = await comprasDe(desde, hasta, 'proveedor'); return { valor: num(s.reduce((a, x) => a + x.valor, 0)), serie: s.slice(0, 5) }; } },
  { id: 'compras.rubros', nombre: 'Compras del período por rubro', modulo: 'compras', permiso: 'compras.comprobantes.ver', comparable: true, unidad: '$',
    calcular: async ({ desde, hasta }) => { const s = await comprasDe(desde, hasta, 'rubro'); return { valor: num(s.reduce((a, x) => a + x.valor, 0)), serie: s.slice(0, 5) }; } },
  // La variación del costo de los insumos principales (los de más compras en 90 días): el costo vigente contra el que regía al empezar el período.
  { id: 'compras.costos', nombre: 'Variación del costo de los insumos principales', modulo: 'compras', permiso: 'compras.costos.ver', unidad: '%',
    calcular: async ({ desde }) => {
      const [top] = await pool.query(`SELECT l.item_tipo, l.item_id, SUM(l.importe) AS imp FROM cmp_comprobante_lineas l JOIN cmp_comprobantes c ON c.id = l.comprobante_id
        WHERE l.tipo = 'mercaderia' AND l.item_id IS NOT NULL AND ${VIGENTE} AND c.clase <> 'NOTA_CREDITO' AND c.fecha >= DATE_SUB(CURDATE(), INTERVAL 90 DAY) GROUP BY l.item_tipo, l.item_id ORDER BY imp DESC LIMIT 5`);
      const serie = [];
      for (const t of top) {
        const [[ahora]] = await pool.query('SELECT costo FROM cmp_costos_reposicion WHERE item_tipo = ? AND item_id = ?', [t.item_tipo, t.item_id]);
        const [[antes]] = await pool.query('SELECT costo FROM cmp_costos_historial WHERE item_tipo = ? AND item_id = ? AND ts_ms < ? ORDER BY id DESC LIMIT 1', [t.item_tipo, t.item_id, new Date(desde).getTime()]);
        if (!ahora || !antes || !Number(antes.costo)) continue;
        const [[x]] = await pool.query(`SELECT COALESCE((SELECT nombre FROM insumos WHERE id = ? AND ? = 'insumo'), (SELECT nombre FROM productos WHERE id = ? AND ? = 'producto')) AS nombre`, [t.item_id, t.item_tipo, t.item_id, t.item_tipo]);
        serie.push({ clave: x?.nombre ?? `${t.item_tipo}:${t.item_id}`, valor: r2((Number(ahora.costo) - Number(antes.costo)) / Number(antes.costo) * 100) });
      }
      return { valor: serie.length ? r2(serie.reduce((a, s) => a + s.valor, 0) / serie.length) : 0, serie };
    } },
]);

module.exports = { tipos, ejecutar, hoy };
