const pool = require('../config/db');
const Tablero = require('../servicios/tableroService');
const Modulos = require('../modulos/registro');
const Funciones = require('../funciones/servicio');
const Catalogo = require('./catalogoService');
const { TiendaInvalida } = require('./tiendaService');

// Informes (Ventas Online RF17) e indicadores para el tablero (RF28) de la tienda. Todo sale de los datos de la instancia; las visitas y los carritos abandonados, de los registros de la tienda pública.
const invalida = (m, status = 400) => Object.assign(new TiendaInvalida(m), { status });
const r2 = (x) => Math.round(Number(x ?? 0) * 100) / 100;
const dia = (ms) => new Date(Number(ms)).toISOString().slice(0, 10);
const VENDIDOS = "p.pagado_ms IS NOT NULL AND p.estado NOT IN ('cancelado', 'devuelto')";

const rango = (q = {}) => {
  const f = (v, n, fin) => { if (v === undefined || v === '') return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw invalida(`"${n}" va como AAAA-MM-DD.`); return new Date(`${v}T${fin ? '23:59:59.999' : '00:00:00'}`).getTime(); };
  return { desde: f(q.desde, 'desde', false), hasta: f(q.hasta, 'hasta', true) };
};
const donde = (q, campo = 'p.created_ms') => { const { desde, hasta } = rango(q), w = [], par = []; if (desde !== null) { w.push(`${campo} >= ?`); par.push(desde); } if (hasta !== null) { w.push(`${campo} <= ?`); par.push(hasta); } return { w, par }; };
const col = (key, label, tipo = 'texto') => ({ key, label, tipo, ancho: tipo === 'texto' ? 28 : 16 });

const INFORMES = {
  ventas: { titulo: 'Ventas online por período', columnas: [col('dia', 'Día'), col('pedidos', 'Pedidos', 'numero'), col('total', 'Total', 'moneda'), col('ticket', 'Ticket promedio', 'moneda')],
    corrida: async (q) => {
      const { w, par } = donde(q);
      return (await pool.query(`SELECT FROM_UNIXTIME(p.created_ms / 1000, '%Y-%m-%d') AS dia, COUNT(*) AS pedidos, SUM(p.total) AS total FROM onl_pedidos p WHERE ${[VENDIDOS, ...w].join(' AND ')} GROUP BY dia ORDER BY dia`, par))[0]
        .map((x) => ({ dia: x.dia, pedidos: Number(x.pedidos), total: r2(x.total), ticket: r2(Number(x.total) / Number(x.pedidos)) }));
    } },
  conversion: { titulo: 'Conversión (visitas, carritos y pedidos)', columnas: [col('dia', 'Día'), col('visitas', 'Visitas', 'numero'), col('carritos', 'Carritos', 'numero'), col('pedidos', 'Pedidos', 'numero'), col('conversion', 'Conversión %', 'numero')],
    corrida: async (q) => {
      const { desde, hasta } = rango(q);
      const w = [], par = [];
      if (desde !== null) { w.push('dia >= ?'); par.push(dia(desde)); }
      if (hasta !== null) { w.push('dia <= ?'); par.push(dia(hasta)); }
      const visitas = new Map((await pool.query(`SELECT dia, visitas FROM onl_visitas ${w.length ? `WHERE ${w.join(' AND ')}` : ''}`, par))[0].map((v) => [dia(v.dia instanceof Date ? v.dia.getTime() : new Date(v.dia).getTime()), Number(v.visitas)]));
      const c = donde(q, 'creado_ms'), p = donde(q);
      const carritos = new Map((await pool.query(`SELECT FROM_UNIXTIME(creado_ms / 1000, '%Y-%m-%d') AS d, COUNT(*) AS n FROM onl_carritos ${c.w.length ? `WHERE ${c.w.join(' AND ')}` : ''} GROUP BY d`, c.par))[0].map((x) => [x.d, Number(x.n)]));
      const pedidos = new Map((await pool.query(`SELECT FROM_UNIXTIME(p.created_ms / 1000, '%Y-%m-%d') AS d, COUNT(*) AS n FROM onl_pedidos p WHERE p.origen = 'tienda' ${p.w.length ? `AND ${p.w.join(' AND ')}` : ''} GROUP BY d`, p.par))[0].map((x) => [x.d, Number(x.n)]));
      const dias = [...new Set([...visitas.keys(), ...carritos.keys(), ...pedidos.keys()])].sort();
      return dias.map((d) => { const v = visitas.get(d) ?? 0, ca = (carritos.get(d) ?? 0) + (pedidos.get(d) ?? 0), pe = pedidos.get(d) ?? 0; return { dia: d, visitas: v, carritos: ca, pedidos: pe, conversion: v ? r2(pe / v * 100) : 0 }; });
    } },
  'mas-vendidos': { titulo: 'Artículos más vendidos', columnas: [col('articulo', 'Artículo'), col('cantidad', 'Cantidad', 'numero'), col('importe', 'Importe', 'moneda')],
    corrida: async (q) => {
      const { w, par } = donde(q);
      return (await pool.query(`SELECT l.titulo AS articulo, SUM(l.cantidad) AS cantidad, SUM(l.importe) AS importe FROM onl_pedido_lineas l JOIN onl_pedidos p ON p.id = l.pedido_id WHERE ${[VENDIDOS, ...w].join(' AND ')} GROUP BY l.producto_id, l.titulo ORDER BY cantidad DESC LIMIT 100`, par))[0]
        .map((x) => ({ articulo: x.articulo, cantidad: Number(x.cantidad), importe: r2(x.importe) }));
    } },
  'carritos-abandonados': { titulo: 'Carritos abandonados', columnas: [col('token', 'Carrito'), col('lineas', 'Líneas', 'numero'), col('importe', 'Importe', 'moneda'), col('cuenta', 'Cuenta'), col('creado', 'Creado')],
    corrida: async () => {
      const [cs] = await pool.query('SELECT c.token, c.items, c.creado_ms, k.email FROM onl_carritos c LEFT JOIN onl_clientes k ON k.id = c.cliente_online_id WHERE c.actualizado_ms < ? AND c.items <> ? ORDER BY c.actualizado_ms DESC LIMIT 300', [Date.now() - 24 * 3600000, '[]']);
      return cs.map((c) => { const it = JSON.parse(c.items); return { token: c.token.slice(0, 8), lineas: it.length, importe: r2(it.reduce((a, i) => a + i.cantidad * (i.precio_visto ?? 0), 0)), cuenta: c.email ?? 'invitado', creado: dia(c.creado_ms) }; });
    } },
  cupones: { titulo: 'Uso de cupones', funcion: 'ONL-CUPONES', columnas: [col('codigo', 'Cupón'), col('usos', 'Usos', 'numero'), col('descuento', 'Descuento dado', 'moneda')],
    corrida: async (q) => {
      const { w, par } = donde(q, 'u.ts_ms');
      return (await pool.query(`SELECT c.codigo, COUNT(u.id) AS usos, COALESCE(SUM(u.importe), 0) AS descuento FROM onl_cupones c LEFT JOIN onl_cupon_usos u ON u.cupon_id = c.id ${w.length ? `AND ${w.join(' AND ')}` : ''} GROUP BY c.id, c.codigo ORDER BY usos DESC`, par))[0]
        .map((x) => ({ codigo: x.codigo, usos: Number(x.usos), descuento: r2(x.descuento) }));
    } },
  plataformas: { titulo: 'Pedidos y comisiones por plataforma', funcion: 'ONL-MARKETPLACES', columnas: [col('plataforma', 'Plataforma'), col('pedidos', 'Pedidos', 'numero'), col('bruto', 'Bruto', 'moneda'), col('comision', 'Comisión', 'moneda')],
    corrida: async (q) => require('./conectorService').comisionesEstimadas(q) },
};
const tipos = () => Object.keys(INFORMES);
const ejecutar = async (tipo, q = {}) => {
  const inf = INFORMES[tipo];
  if (!inf) throw invalida(`El informe es uno de: ${tipos().join(', ')}.`, 404);
  if (inf.funcion && !(await Funciones.estaActiva(inf.funcion))) throw Object.assign(invalida(`Este informe necesita la función ${inf.funcion}.`, 409), { codigo: 'FUNCION_INACTIVA' });
  return { tipo, titulo: inf.titulo, columnas: inf.columnas, filas: await inf.corrida(q) };
};
const registrarVisita = () => pool.query('INSERT INTO onl_visitas (dia, visitas) VALUES (CURDATE(), 1) ON DUPLICATE KEY UPDATE visitas = visitas + 1');

// ---- Indicadores (RF28) ----

const entre = (desde, hasta) => [new Date(desde).getTime(), new Date(hasta).getTime()];
Tablero.registrar([
  { id: 'online.pedidos', nombre: 'Pedidos online', modulo: 'ventas_online', permiso: 'ventas_online.pedidos.ver', comparable: true, unidad: 'pedidos',
    calcular: async ({ desde, hasta }) => {
      const [a, b] = entre(desde, hasta);
      const [orig] = await pool.query(`SELECT p.origen AS clave, COUNT(*) AS valor FROM onl_pedidos p WHERE ${VENDIDOS} AND p.created_ms BETWEEN ? AND ? GROUP BY p.origen`, [a, b]);
      return { valor: orig.reduce((s, x) => s + Number(x.valor), 0), serie: orig.map((x) => ({ clave: x.clave, valor: Number(x.valor) })) };
    } },
  { id: 'online.ventas', nombre: 'Ventas online', modulo: 'ventas_online', permiso: 'ventas_online.pedidos.ver', comparable: true, unidad: '$',
    calcular: async ({ desde, hasta }) => {
      const [a, b] = entre(desde, hasta);
      const [[r]] = await pool.query(`SELECT COALESCE(SUM(total), 0) AS t, COUNT(*) AS n FROM onl_pedidos p WHERE ${VENDIDOS} AND p.created_ms BETWEEN ? AND ?`, [a, b]);
      const [horas] = await pool.query(`SELECT HOUR(FROM_UNIXTIME(p.created_ms / 1000)) AS clave, SUM(total) AS valor FROM onl_pedidos p WHERE ${VENDIDOS} AND p.created_ms BETWEEN ? AND ? GROUP BY clave ORDER BY clave`, [a, b]);
      return { valor: r2(r.t), detalle: { pedidos: Number(r.n) }, serie: horas.map((h) => ({ clave: `${String(h.clave).padStart(2, '0')}h`, valor: r2(h.valor) })) };
    } },
  { id: 'online.ticket', nombre: 'Ticket promedio online', modulo: 'ventas_online', permiso: 'ventas_online.pedidos.ver', comparable: true, unidad: '$',
    calcular: async ({ desde, hasta }) => { const [a, b] = entre(desde, hasta); const [[r]] = await pool.query(`SELECT COALESCE(AVG(total), 0) AS t FROM onl_pedidos p WHERE ${VENDIDOS} AND p.created_ms BETWEEN ? AND ?`, [a, b]); return { valor: r2(r.t) }; } },
  { id: 'online.preparar', nombre: 'Pedidos online por preparar', modulo: 'ventas_online', permiso: 'ventas_online.pedidos.ver', unidad: 'pedidos',
    calcular: async () => {
      const [[r]] = await pool.query("SELECT COUNT(*) AS n FROM onl_pedidos WHERE estado IN ('pagado', 'en_preparacion')");
      const [[t]] = await pool.query("SELECT COALESCE(AVG((listo_ms - pagado_ms) / 60000), 0) AS real_min, COALESCE(AVG(tiempo_estimado_min), 0) AS prometido FROM onl_pedidos WHERE listo_ms IS NOT NULL AND pagado_ms IS NOT NULL AND created_ms > ?", [Date.now() - 7 * 86400000]);
      return { valor: Number(r.n), detalle: { preparacion_real_min: r2(t.real_min), prometido_min: r2(t.prometido) } };
    } },
  { id: 'online.sincronizacion', nombre: 'Minutos desde la última sincronización', modulo: 'ventas_online', permiso: 'ventas_online.catalogo.ver', unidad: 'min',
    calcular: async () => { const s = await Catalogo.estadoSync(); return { valor: s.ultima_ms ? Math.round((Date.now() - s.ultima_ms) / 60000) : 0, detalle: { desactualizada: s.desactualizada } }; } },
  { id: 'online.faltantes', nombre: 'Pedidos online con faltante o con reserva pendiente', modulo: 'ventas_online', permiso: 'ventas_online.pedidos.ver', unidad: 'pedidos',
    calcular: async () => {
      const [[r]] = await pool.query("SELECT SUM(estado = 'con_faltante') AS faltante, SUM(estado = 'reserva_pendiente') AS pendiente FROM onl_pedidos");
      return { valor: Number(r.faltante ?? 0) + Number(r.pendiente ?? 0), detalle: { con_faltante: Number(r.faltante ?? 0), reserva_pendiente: Number(r.pendiente ?? 0) } };
    } },
  { id: 'online.agotados', nombre: 'Artículos publicados agotados', modulo: 'ventas_online', permiso: 'ventas_online.catalogo.ver', unidad: 'artículos',
    calcular: async () => { const l = await Catalogo.publicados({}); return { valor: l.filter((x) => !x.vendible).length, detalle: { publicados: l.length } }; } },
  { id: 'online.comisiones', nombre: 'Comisiones de plataformas del período', modulo: 'ventas_online', funcion: 'ONL-MARKETPLACES', permiso: 'ventas_online.plataformas.gestionar', unidad: '$',
    calcular: async ({ desde, hasta }) => {
      if (!(await Modulos.estaInstalado('financiero'))) return { disponible: false };
      const [[r]] = await pool.query('SELECT COALESCE(SUM(comision), 0) AS t FROM fin_plataforma_comisiones WHERE fecha BETWEEN ? AND ?', [dia(new Date(desde).getTime()), dia(new Date(hasta).getTime())]);
      return { valor: r2(r.t) };
    } },
  { id: 'online.conversion', nombre: 'Visitas y conversión de la tienda', modulo: 'ventas_online', permiso: 'ventas_online.informes.ver', unidad: '%',
    calcular: async ({ desde, hasta }) => {
      const [[v]] = await pool.query('SELECT COALESCE(SUM(visitas), 0) AS n FROM onl_visitas WHERE dia BETWEEN ? AND ?', [dia(new Date(desde).getTime()), dia(new Date(hasta).getTime())]);
      const [[p]] = await pool.query("SELECT COUNT(*) AS n FROM onl_pedidos p WHERE p.origen = 'tienda' AND p.created_ms BETWEEN ? AND ?", [new Date(desde).getTime(), new Date(hasta).getTime()]);
      return { valor: Number(v.n) ? r2(Number(p.n) / Number(v.n) * 100) : 0, detalle: { visitas: Number(v.n), pedidos: Number(p.n) } };
    } },
]);

module.exports = { tipos, ejecutar, registrarVisita };
