process.env.AFIP_CONDICION_IVA_EMISOR = 'responsable_inscripto';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const M = require('../src/mensajeria/servicio');
const Mov = require('../src/stock/movimientoService');

let api, pool, cerrar, adm, administrativo, deposito, dep, harina, bolsa, leche, lechuga, tele, k = 0;
const CUIT = '30711111111';
const hoyMas = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  deposito = await usuario(api, pool, 'dani', 'deposito');
  await api('POST', '/api/modulos/compras/instalar', { token: adm.token });
  await api('POST', '/api/compras/proveedores', { token: administrativo.token, body: { cuit: CUIT, razon_social: 'Molino del Sur SA', condicion_iva: 'Responsable Inscripto', consultar_arca: false } });
  dep = (await api('GET', '/api/depositos', { token: adm.token })).json[0].id;
  const insumo = async (nombre, extra = '') => { const i = (await api('POST', '/api/insumos', { token: adm.token, body: { nombre, unidad: 'kg' } })).json; if (extra) await pool.query(`UPDATE insumos SET ${extra} WHERE id = ?`, [i.id]); return i; };
  harina = await insumo('Harina 000');
  bolsa = (await api('POST', '/api/presentaciones', { token: adm.token, body: { insumo_id: harina.id, nombre: 'bolsa 25 kg', factor: 25, usos: ['compra'] } })).json;
  leche = await insumo('Leche entera', 'controla_lote = 1, vida_util_dias = 10');
  lechuga = await insumo('Condimento sin vida útil', 'controla_lote = 1');
  tele = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Molinillo eléctrico', precio: 50000 } })).json;
  await pool.query('UPDATE productos SET controla_serie = 1 WHERE id = ?', [tele.id]);
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['VEN-SERIE', 'STK-LOTES', 'STK-SERIE'], motivo: 'prueba' } });
});
after(async () => { await cerrar(); });

const factura = (lineas, extra = {}, t = administrativo) => {
  const neto = lineas.reduce((s, l) => s + Math.round(l.cantidad * l.precio_unitario * 100) / 100, 0);
  const iva = Math.round(neto * 21) / 100;
  return api('POST', '/api/compras/comprobantes', { token: t.token, body: { cuit: CUIT, clase: 'FACTURA', tipo: 'A', punto_venta: 1, numero: String(++k), fecha: hoyMas(0), alicuotas: [{ alicuota: 21, neto, iva }], otros_tributos: k, total: Math.round((neto + iva + k) * 100) / 100, lineas, ...extra } }); // otros tributos distintos: dos facturas del mismo día e importe serían casi duplicadas
};
const item = (i, extra = {}) => ({ tipo: 'mercaderia', item: { tipo: 'insumo', id: i.id }, descripcion: 'x', cantidad: 4, precio_unitario: 260, ...extra });
const op = (id, ruta, body = {}, t = administrativo) => api('POST', `/api/compras/comprobantes/${id}/${ruta}`, { token: t.token, body });
const vinculos = async (id) => (await api('GET', `/api/compras/comprobantes/${id}/vinculos`, { token: adm.token })).json;
const existencias = async (col, id) => Number((await pool.query(`SELECT COALESCE(SUM(cantidad), 0) AS n FROM stock_movimientos WHERE ${col} = ?`, [id]))[0][0].n);
// Un ingreso físico de Stock (por ejemplo de un remito) que todavía no tiene factura.
const ingresoStock = async (cantidad, costo = 10.4, remito = ++k) => (await Mov.ingresar({ deposito_id: dep, motivo: 'compra', proveedor: 'Molino del Sur SA',
  comprobante: { cuit: CUIT, clase: 'REMITO', tipo: 'X', punto_venta: '1', numero: String(remito) }, lineas: [{ item: { tipo: 'insumo', id: harina.id }, cantidad, costo_unitario: costo }] }, { userId: 1 })).id_global;

test('Compras.RN13: una factura de mercadería con Stock queda «Pendiente de recepción»; una de servicios queda registrada', async () => {
  const m = await factura([item(harina, { presentacion_id: bolsa.id })]);
  assert.equal(m.status, 201, JSON.stringify(m.json));
  assert.equal(m.json.estado, 'pendiente_recepcion');
  const s = await factura([{ tipo: 'concepto', descripcion: 'Gas', cantidad: 1, precio_unitario: 700 }]);
  assert.equal(s.json.estado, 'registrado');
});

test('Compras.RF04/RN33/EX06: la factura se vincula con ingresos «Pendientes de factura»; el vínculo viaja a Stock y las diferencias dejan el comprobante «Con diferencias» y un reclamo', async () => {
  const f = (await factura([item(harina, { presentacion_id: bolsa.id })])).json; // 4 bolsas de 25 kg a $260 = 100 kg a $10,40
  const ingreso = await ingresoStock(100);
  const pend = (await api('GET', `/api/compras/comprobantes/${f.id}/ingresos-pendientes`, { token: administrativo.token })).json;
  assert.equal(pend.disponible, true);
  assert.ok(pend.ingresos.some((i) => i.ingreso_id_global === ingreso));
  assert.equal((await op(f.id, 'vincular', { ingreso_ids: [] })).status, 400);
  assert.equal((await op(f.id, 'vincular', { ingreso_ids: ['NO-EXISTE'] })).json.codigo, 'INGRESO_NO_PENDIENTE');
  assert.equal((await op(f.id, 'vincular', { ingreso_ids: [ingreso] }, { token: (await usuario(api, pool, 'cami', 'cajero')).token })).status, 403);
  const v = await op(f.id, 'vincular', { ingreso_ids: [ingreso] });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  assert.equal(v.json.estado, 'registrado'); // 100 kg a $10,40: coincide
  assert.deepEqual(v.json.diferencias, []);
  await esperarMensajes(pool);
  const vs = await vinculos(f.id);
  assert.deepEqual([vs[0].integracion, vs[0].ingreso_id_global, vs[0].origen], ['confirmado', ingreso, 'vinculado']);
  assert.equal((await pool.query('SELECT compras_comprobante FROM stock_ingresos WHERE id_global = ?', [ingreso]))[0][0].compras_comprobante, f.id_global); // Stock marca el ingreso
  // El ingreso ya vinculado deja de estar pendiente.
  const otra = (await factura([item(harina, { presentacion_id: bolsa.id })])).json;
  assert.ok(!(await api('GET', `/api/compras/comprobantes/${otra.id}/ingresos-pendientes`, { token: administrativo.token })).json.ingresos.some((i) => i.ingreso_id_global === ingreso));
  assert.equal((await op(otra.id, 'vincular', { ingreso_ids: [ingreso] })).json.codigo, 'INGRESO_NO_PENDIENTE');
  // Diferencias: llegaron 90 kg a $11 y se facturaron 100 kg a $10,40 (EX06).
  const corto = await ingresoStock(90, 11);
  const dif = await op(otra.id, 'vincular', { ingreso_ids: [corto] });
  assert.equal(dif.status, 200, JSON.stringify(dif.json));
  assert.equal(dif.json.estado, 'con_diferencias');
  assert.deepEqual(dif.json.diferencias.map((d) => d.tipo).sort(), ['cantidad', 'precio']);
  const rec = (await api('GET', '/api/compras/reclamos', { token: administrativo.token })).json;
  assert.equal(rec.length, 1);
  assert.equal(rec[0].comprobante_id, otra.id);
  await esperarMensajes(pool);
  // EX19: un ingreso que otra factura tomó mientras tanto es un rechazo de negocio del receptor, con su motivo, y no se reintenta.
  const conn = await pool.getConnection();
  const libre = await ingresoStock(10);
  await pool.query("UPDATE stock_ingresos SET compras_comprobante = 'OTRA-FACTURA' WHERE id_global = ?", [libre]);
  try { await M.publicar(conn, { origen: 'compras', destino: 'stock', tipo: 'vincular_ingreso', docTipo: 'comprobante', docIdGlobal: f.id_global, docVersion: 99, contenido: { ingreso_id_global: libre, comprobante_id_global: f.id_global } }); } finally { conn.release(); }
  await esperarMensajes(pool);
  const [[msg]] = await pool.query("SELECT estado, motivo_rechazo FROM mensajes_integracion WHERE id_operacion = ?", [`compras:vincular_ingreso:${f.id_global}:99`]);
  assert.deepEqual([msg.estado, msg.motivo_rechazo], ['rechazado', 'El ingreso ya está vinculado a otra factura.']);
});

test('Compras.RN08/RN34: una factura con ingresos vinculados no se anula; se desvincula con motivo (después del vínculo original) y vuelve a «Pendiente de recepción»', async () => {
  const f = (await factura([item(harina, { presentacion_id: bolsa.id })])).json;
  const ingreso = await ingresoStock(100);
  await op(f.id, 'vincular', { ingreso_ids: [ingreso] });
  const anular = (id) => api('POST', `/api/compras/comprobantes/${id}/anular`, { token: adm.token, body: { motivo: 'cargada de más' } });
  const bloqueada = await anular(f.id);
  assert.equal(bloqueada.status, 409);
  assert.equal(bloqueada.json.codigo, 'TIENE_INGRESOS');
  const [vinc] = await vinculos(f.id);
  assert.equal((await op(f.id, 'desvincular', { vinculo_id: vinc.id })).status, 400); // falta el motivo
  const des = await op(f.id, 'desvincular', { vinculo_id: vinc.id, motivo: 'era de otra entrega' });
  assert.equal(des.status, 200, JSON.stringify(des.json));
  assert.equal(des.json.estado, 'pendiente_recepcion');
  await esperarMensajes(pool);
  assert.equal((await pool.query('SELECT compras_comprobante FROM stock_ingresos WHERE id_global = ?', [ingreso]))[0][0].compras_comprobante, null); // el ingreso volvió a estar pendiente de factura
  assert.equal((await op(f.id, 'desvincular', { vinculo_id: vinc.id, motivo: 'otra vez' })).status, 404);
  assert.equal((await anular(f.id)).json.estado, 'anulado');
});

test('Compras.RF04: sin ingreso, la factura lo genera en Stock en el mismo acto, con la presentación, el costo por unidad base y la clave de la factura', async () => {
  const f = (await factura([item(harina, { presentacion_id: bolsa.id })])).json;
  assert.equal((await op(f.id, 'generar-ingreso', {})).status, 400); // falta el depósito
  const antes = await existencias('insumo_id', harina.id);
  const g = await op(f.id, 'generar-ingreso', { deposito_id: dep });
  assert.equal(g.status, 201, JSON.stringify(g.json));
  assert.equal(g.json.estado, 'registrado');
  await esperarMensajes(pool);
  const [vinc] = await vinculos(f.id);
  assert.deepEqual([vinc.origen, vinc.integracion], ['generado', 'confirmado']);
  assert.ok(vinc.ingreso_id_global);
  assert.equal(await existencias('insumo_id', harina.id) - antes, 100); // 4 bolsas × 25 kg
  const [mv] = (await pool.query("SELECT costo_unitario, presentacion_id, cantidad_presentacion FROM stock_movimientos WHERE documento = ?", [vinc.ingreso_id_global]))[0];
  assert.deepEqual([Number(mv.costo_unitario), mv.presentacion_id, Number(mv.cantidad_presentacion)], [10.4, bolsa.id, 4]);
  assert.equal((await pool.query('SELECT compras_comprobante FROM stock_ingresos WHERE id_global = ?', [vinc.ingreso_id_global]))[0][0].compras_comprobante, f.id_global);
  const [{ n }] = (await pool.query("SELECT COUNT(*) AS n FROM clave_vinculos WHERE modulo = 'stock' AND id_clave = (SELECT id_clave FROM claves_comprobante WHERE clave = ?)", [f.clave]))[0];
  assert.equal(n, 1); // Stock agregó su vínculo a la clave de la factura, sin reservarla de nuevo
  assert.equal((await op(f.id, 'generar-ingreso', { deposito_id: dep })).json.codigo, 'YA_VINCULADA');
  assert.equal((await op((await factura([{ tipo: 'concepto', descripcion: 'Gas', cantidad: 1, precio_unitario: 100 }])).json.id, 'generar-ingreso', { deposito_id: dep })).status, 409); // sin líneas de mercadería
});

test('Compras.RF19/RN25/EX14/EX15: un ítem con lote exige lote y vencimiento por línea, que suman la cantidad y no vencen antes de la recepción; si faltan, la factura queda «Pendiente de recepción»', async () => {
  const f = (await factura([item(leche, { cantidad: 10, precio_unitario: 100 })])).json;
  const gen = (b, t = administrativo) => op(f.id, 'generar-ingreso', { deposito_id: dep, ...b }, t);
  const sin = await gen({});
  assert.equal(sin.status, 409);
  assert.equal(sin.json.codigo, 'RECEPCION_INCOMPLETA');
  assert.equal(sin.json.detalle.lineas[0].codigo, 'LOTE_FALTANTE');
  const pend = await gen({ pendiente_recepcion: true });
  assert.equal(pend.status, 201);
  assert.deepEqual([pend.json.estado, pend.json.pendiente_recepcion], ['pendiente_recepcion', true]);
  const l = (lotes) => ({ lineas: [{ linea: 1, lotes }] });
  assert.equal((await gen(l([{ codigo: 'L1', cantidad: 6, fecha_vencimiento: hoyMas(5) }, { codigo: 'L2', cantidad: 3, fecha_vencimiento: hoyMas(7) }]))).json.detalle.lineas[0].codigo, 'LOTES_NO_SUMAN'); // suman 9 y la línea es 10
  assert.equal((await gen(l([{ codigo: 'L1', cantidad: 10, fecha_vencimiento: hoyMas(-1) }]))).json.detalle.lineas[0].codigo, 'VENCIMIENTO_ANTERIOR'); // EX15
  assert.equal((await gen(l([{ codigo: '', cantidad: 10, fecha_vencimiento: hoyMas(5) }]))).json.detalle.lineas[0].codigo, 'LOTE_FALTANTE');
  assert.equal((await gen(l([{ codigo: 'L1', cantidad: 10, fecha_vencimiento: hoyMas(5) }]), { token: (await usuario(api, pool, 'cele', 'contador')).token })).status, 403);
  const ok = await gen(l([{ codigo: 'LCH-1', cantidad: 6, fecha_vencimiento: hoyMas(5) }, { codigo: 'LCH-2', cantidad: 4, fecha_vencimiento: hoyMas(9) }]));
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  await esperarMensajes(pool);
  const lotes = (await pool.query('SELECT codigo, fecha_vencimiento FROM lotes WHERE insumo_id = ? ORDER BY codigo', [leche.id]))[0];
  assert.deepEqual(lotes.map((x) => x.codigo), ['LCH-1', 'LCH-2']); // Stock creó cada lote
  assert.equal(await existencias('insumo_id', leche.id), 10);
});

test('Compras.RN39: con CMP-RECEPCION-LOTES inactiva el ingreso viaja sin lote y Stock crea uno automático por vida útil; sin vida útil el mensaje se rechaza y el ingreso queda «Pendiente de lote»', async () => {
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { desactivar: ['CMP-RECEPCION-LOTES'], motivo: 'prueba' } });
  const f = (await factura([item(leche, { cantidad: 5, precio_unitario: 100 })])).json;
  assert.equal((await op(f.id, 'generar-ingreso', { deposito_id: dep })).status, 201); // no pide lotes
  await esperarMensajes(pool);
  assert.equal((await vinculos(f.id))[0].integracion, 'confirmado');
  const auto = (await pool.query("SELECT codigo, fecha_vencimiento FROM lotes WHERE insumo_id = ? AND codigo LIKE 'AUTO-%'", [leche.id]))[0];
  assert.equal(auto.length, 1);
  assert.equal(new Date(auto[0].fecha_vencimiento).toISOString().slice(0, 10), hoyMas(10)); // hoy + 10 días de vida útil
  const g = (await factura([item(lechuga, { cantidad: 2, precio_unitario: 100 })])).json;
  assert.equal((await op(g.id, 'generar-ingreso', { deposito_id: dep })).status, 201);
  await esperarMensajes(pool);
  const [vg] = await vinculos(g.id);
  assert.equal(vg.integracion, 'rechazado'); // sin vida útil: queda pendiente de lote y se completa en Stock
  assert.match(vg.motivo_rechazo, /fecha de vencimiento/);
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['CMP-RECEPCION-LOTES'], motivo: 'prueba' } });
});

test('Compras.RF24/RN37/EX23: un ítem serializado exige una serie distinta por unidad; Stock las crea Disponibles; faltantes dejan el comprobante pendiente de recepción', async () => {
  const f = (await factura([{ tipo: 'mercaderia', item: { tipo: 'producto', id: tele.id }, descripcion: 'Molinillo', cantidad: 3, precio_unitario: 1000 }])).json;
  const gen = (b) => op(f.id, 'generar-ingreso', { deposito_id: dep, ...b });
  const falta = await gen({ lineas: [{ linea: 1, series: ['S1', 'S2'] }] });
  assert.equal(falta.status, 409);
  assert.equal(falta.json.detalle.lineas[0].codigo, 'SERIES_INVALIDAS'); // 2 series para 3 unidades
  assert.equal((await gen({ lineas: [{ linea: 1, series: ['S1', 'S2', 'S2'] }] })).json.detalle.lineas[0].codigo, 'SERIES_INVALIDAS'); // repetida en el documento
  assert.equal((await gen({ pendiente_recepcion: true })).json.estado, 'pendiente_recepcion');
  const ok = await gen({ lineas: [{ linea: 1, series: ['MOL-1', 'MOL-2', 'MOL-3'] }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  await esperarMensajes(pool);
  const series = (await pool.query("SELECT numero_serie, estado FROM series WHERE producto_id = ? ORDER BY numero_serie", [tele.id]))[0];
  assert.deepEqual(series.map((s) => [s.numero_serie, s.estado]), [['MOL-1', 'disponible'], ['MOL-2', 'disponible'], ['MOL-3', 'disponible']]);
  // Otra factura con una serie que ya existe en Stock: el mensaje se rechaza (EX23).
  const g = (await factura([{ tipo: 'mercaderia', item: { tipo: 'producto', id: tele.id }, descripcion: 'Molinillo', cantidad: 1, precio_unitario: 500 }])).json;
  assert.equal((await op(g.id, 'generar-ingreso', { deposito_id: dep, lineas: [{ linea: 1, series: ['MOL-1'] }] })).status, 201);
  await esperarMensajes(pool);
  const [vg] = await vinculos(g.id);
  assert.equal(vg.integracion, 'rechazado');
  assert.match(vg.motivo_rechazo, /Ya existen las series: MOL-1/);
});

test('Compras.RF04: sin Stock la factura se registra sin vínculo ni ingreso y queda «Registrada»', async () => {
  const Modulos = require('../src/modulos/registro');
  const original = Modulos.estaInstalado;
  Modulos.estaInstalado = async (m) => (m === 'stock' ? false : original(m));
  try {
    const f = await factura([{ tipo: 'concepto', item: { tipo: 'insumo', id: harina.id }, descripcion: 'Harina', cantidad: 2, precio_unitario: 100 }]);
    assert.equal(f.status, 201, JSON.stringify(f.json));
    assert.equal(f.json.estado, 'registrado');
    const m = await factura([item(harina, { descripcion: 'Harina' })]);
    assert.equal(m.json.estado, 'registrado'); // sin Stock no existe «Pendiente de recepción»
    assert.equal((await op(m.json.id, 'vincular', { ingreso_ids: ['X'] })).json.codigo, 'SIN_STOCK');
    assert.equal((await op(m.json.id, 'generar-ingreso', { deposito_id: dep })).json.codigo, 'SIN_STOCK');
    assert.equal((await api('GET', `/api/compras/comprobantes/${m.json.id}/ingresos-pendientes`, { token: administrativo.token })).json.disponible, false);
  } finally { Modulos.estaInstalado = original; }
});
