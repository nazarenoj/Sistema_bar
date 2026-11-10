const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { preparar } = require('./ayudas_contable');
const { usuario } = require('./ayudas_financiero');
const Auto = require('../src/contable/automaticos');
const Adjuntos = require('../src/contable/adjuntoService');
const Mant = require('../src/contable/mantenimientoContable');
const Monedas = require('../src/servicios/monedaService');
const M = require('../src/mensajeria/servicio');
const { fechaLocal } = require('../src/contable/comun');

let api, pool, cerrar, c, k = 0, contador;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  c = await preparar(api, pool);
  contador = await usuario(api, pool, 'cont', 'contador');
  // La fecha de inicio que se propone es el primer día del período abierto más cercano a hoy (hoy si es el primero del mes).
  const hoy = fechaLocal(); const d = new Date();
  const e = (await api('GET', '/api/contable/config', { token: c.gerente.token })).json;
  assert.equal(e.propuesta_inicio, hoy.slice(8) === '01' ? hoy : fechaLocal(new Date(d.getFullYear(), d.getMonth() + 1, 1)));
});
after(async () => { await cerrar(); });

const g = () => ({ token: c.gerente.token });
const sol = () => ({ 'X-ID-Solicitud': `man-${++k}-${Math.random().toString(36).slice(2, 10)}` });
const manual = (leyenda, lineas, fecha = c.hoy) => api('POST', '/api/contable/asientos-manuales', { ...g(), headers: sol(), body: { fecha, leyenda, lineas } });
const par = (m) => [{ cuenta_id: c.clave('caja').id, debe: m }, { cuenta_id: c.clave('capital').id, haber: m }];

test('Contable.EX18: la misma ID_Operacion con otro contenido se rechaza con alerta al Administrador; con el mismo contenido es un reenvío', async () => {
  const id = await c.vender('efectivo');
  const [[o]] = await pool.query("SELECT id_operacion, contenido FROM con_asiento_origen WHERE id_documento = ? ORDER BY id LIMIT 1", [id]);
  const original = JSON.parse(o.contenido);
  const ctx = { idOperacion: o.id_operacion, docIdGlobal: id, instantanea: [] };
  const conn = await pool.getConnection();
  try {
    assert.equal((await Auto.aplicar(conn, 'venta_confirmada', original, ctx, c.hoy)).ya_procesado, true); // mismo contenido: reenvío
    await assert.rejects(Auto.aplicar(conn, 'venta_confirmada', { ...original, total: original.total + 1 }, ctx, c.hoy), (e) => e instanceof M.RechazoNegocio && /Conflicto de idempotencia/.test(e.message));
  } finally { conn.release(); }
  const [[n]] = await pool.query("SELECT COUNT(*) n FROM notificaciones WHERE tipo = 'conflicto_idempotencia'");
  assert.equal(Number(n.n), 1);
});

test('Contable.RF05: un asiento manual admite adjuntos (JPG, PNG o PDF) que se listan y no se pierden', async () => {
  const a = (await manual('Con respaldo', par(100))).json;
  const pdf = Buffer.from('%PDF-1.4 prueba');
  const r = await Adjuntos.agregar(a.id, { nombre: 'recibo.pdf', tipo: 'application/pdf', contenido: pdf }, 1);
  assert.equal(r.bytes, pdf.length);
  await assert.rejects(Adjuntos.agregar(a.id, { nombre: 'x.exe', tipo: 'application/x-msdownload', contenido: pdf }, 1), /JPG, PNG o PDF/);
  await assert.rejects(Adjuntos.agregar(a.id, { nombre: 'vacio.pdf', tipo: 'application/pdf', contenido: Buffer.alloc(0) }, 1), /vacío/);
  const lista = (await api('GET', `/api/contable/asientos/${a.id}/adjuntos`, g())).json;
  assert.deepEqual(lista.map((x) => [x.nombre, x.tipo]), [['recibo.pdf', 'application/pdf']]);
  assert.equal((await Adjuntos.obtener(a.id, r.id)).contenido.toString(), '%PDF-1.4 prueba');
  assert.equal((await api('GET', `/api/contable/asientos/${a.id}/adjuntos/99999`, g())).status, 404);
});

test('Contable.RN08/Usuarios.RN85: un pendiente que vence su plazo se escala al Administrador una sola vez', async () => {
  const regla = (await pool.query("SELECT id FROM con_reglas WHERE formulario = 'venta' AND componente = 'iva'"))[0][0].id;
  await pool.query('UPDATE con_reglas SET activa = 0 WHERE id = ?', [regla]);
  await c.vender('efectivo');
  await pool.query('UPDATE con_reglas SET activa = 1 WHERE id = ?', [regla]);
  assert.equal(await Mant.escalar(), 0); // todavía dentro del plazo
  await pool.query("UPDATE con_pendientes SET plazo = DATE_SUB(CURDATE(), INTERVAL 1 DAY) WHERE estado = 'abierto'");
  assert.equal(await Mant.escalar(), 1);
  assert.equal(await Mant.escalar(), 0); // ya escalado
  const [[n]] = await pool.query("SELECT COUNT(*) n FROM notificaciones WHERE tipo = 'pendiente_vencido'");
  assert.equal(Number(n.n), 1);
  // Se resuelve y sale del listado.
  const [p] = (await api('GET', '/api/contable/pendientes', g())).json;
  assert.equal((await api('POST', `/api/contable/pendientes/${p.id}/reintentar`, { ...g(), body: {} })).status, 200);
  await esperarMensajes(pool);
  assert.equal((await api('GET', '/api/contable/pendientes', g())).json.length, 0);
});

test('Contable.RF04: anular un asiento resumido de varios documentos pide confirmación', async () => {
  assert.equal((await api('PUT', '/api/contable/modos/venta', { ...g(), body: { modo: 'resumido' } })).status, 200);
  const a1 = await c.vender('efectivo'); await c.vender('efectivo');
  const res = await c.asientoDe(a1);
  assert.equal(res.resumido, true);
  const sin = await api('POST', `/api/contable/asientos/${res.id}/anular`, { ...g(), headers: sol(), body: { motivo: 'Resumen mal cargado' } });
  assert.equal(sin.status, 409);
  assert.equal(sin.json.codigo, 'RESUMEN_CONFIRMAR');
  assert.ok(sin.json.documentos >= 2);
  assert.equal((await api('POST', `/api/contable/asientos/${res.id}/anular`, { ...g(), headers: sol(), body: { motivo: 'Resumen mal cargado', confirmar_resumen: true } })).status, 200);
  await api('PUT', '/api/contable/modos/venta', { ...g(), body: { modo: 'individual' } });
});

test('Contable.RN15: el plazo de conservación se informa y los libros nunca se purgan', async () => {
  const r = (await api('GET', '/api/contable/retencion', g())).json;
  assert.equal(r.retencion_anios, 10);
  assert.equal(r.se_purga, false);
  assert.equal(r.asientos_fuera_de_plazo, 0);
  assert.ok(r.asientos_total > 0);
});

test('Contable.RN19: lo que se instala o activa después de iniciar se suma al plan y a las reglas con el endpoint de actualización', async () => {
  const antes = (await api('GET', '/api/contable/cuentas', g())).json.length;
  assert.equal((await api('POST', '/api/modulos/clientes/instalar', { token: c.adm.token })).status, 200);
  assert.equal((await api('POST', '/api/funciones/cambiar', { token: c.adm.token, body: { activar: ['CLI-FIDEL'], motivo: 'prueba' } })).status, 200);
  const r = await api('POST', '/api/contable/plan/actualizar', { ...g(), body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.cuentas_nuevas >= 3); // gift cards, vales y vencimiento
  const cuentas = (await api('GET', '/api/contable/cuentas', g())).json;
  assert.equal(cuentas.length, antes + r.json.cuentas_nuevas);
  assert.ok(cuentas.some((x) => x.clave === 'gift_cards') && cuentas.some((x) => x.clave === 'vales'));
  assert.ok((await api('GET', '/api/contable/reglas?formulario=emision_gift_card', g())).json.length >= 1);
  assert.equal((await api('POST', '/api/contable/plan/actualizar', { ...g(), body: {} })).json.cuentas_nuevas, 0); // idempotente
  assert.equal((await api('POST', '/api/contable/plan/actualizar', { token: c.cajero.token, body: {} })).status, 403);
});

test('Contable.RF09: al cerrar un período con revaluación propuesta se pide registrarla o declarar que no se revalúa', async () => {
  assert.equal((await api('POST', '/api/funciones/cambiar', { token: c.adm.token, body: { activar: ['CON-REVALUACION'], motivo: 'prueba' } })).status, 200);
  const padre = (await api('GET', '/api/contable/cuentas', g())).json.find((x) => x.codigo === '1.1');
  const usd = (await api('POST', '/api/contable/cuentas', { ...g(), body: { codigo: '1.1.40', nombre: 'Dólares', tipo: 'activo', padre_id: padre.id, moneda: 'USD' } })).json;
  assert.equal((await manual('Dólares', [{ cuenta_id: usd.id, debe: 100000, importe_divisa: 100, cotizacion: 1000 }, { cuenta_id: c.clave('capital').id, haber: 100000 }])).status, 201);
  await Monedas.cargar({ moneda: 'USD', comprador: 1100, vendedor: 1150 });
  const per = (await api('GET', '/api/contable/periodos', g())).json.find((p) => p.anio === Number(c.hoy.slice(0, 4)) && p.mes === Number(c.hoy.slice(5, 7)));
  const r = await api('POST', `/api/contable/periodos/${per.id}/cerrar`, { ...g(), body: {} });
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'REVALUACION_PENDIENTE');
  assert.equal((await api('POST', `/api/contable/periodos/${per.id}/cerrar`, { ...g(), body: { sin_revaluar: true } })).status, 200);
});

test('Contable.RF11/RF12: el historial de controles se consulta y el plan de cuentas sale con las equivalencias de la plantilla', async () => {
  const modulos = await api('POST', '/api/funciones/cambiar', { token: c.adm.token, body: { activar: ['CON-EXPORT-PLANTILLAS'], motivo: 'prueba' } });
  assert.equal(modulos.status, 200);
  const eq = {};
  for (const x of (await api('GET', '/api/contable/cuentas', g())).json.filter((y) => y.imputable)) eq[x.codigo] = `X${x.codigo.replace(/\./g, '')}`;
  const parcial = { ...eq }; delete parcial[c.clave('caja').codigo];
  const p = (await api('POST', '/api/contable/plantillas', { token: contador.token, body: { nombre: 'Estudio', columnas: ['fecha', 'cuenta', 'debe'], equivalencias: parcial } })).json;
  const Plant = require('../src/contable/plantillaService');
  await assert.rejects(Plant.exportarPlan(p.id), (e) => e.codigo === 'SIN_EQUIVALENCIA');
  await api('PUT', `/api/contable/plantillas/${p.id}`, { token: contador.token, body: { ...p, equivalencias: eq } });
  const plan = await Plant.exportarPlan(p.id);
  assert.match(plan.texto, /^codigo;nombre;tipo;imputable/);
  assert.match(plan.texto, new RegExp(`X${c.clave('caja').codigo.replace(/\./g, '')};`));
  assert.equal((await api('GET', `/api/contable/exportar/plan?plantilla=${p.id}`, g())).status, 200);
  // Controles con la función activa: se guardan y se listan.
  assert.equal((await api('POST', '/api/contable/controles/ejecutar', { ...g(), body: {} })).status, 200);
  assert.equal((await api('POST', '/api/contable/controles/ejecutar', { ...g(), body: {} })).status, 200);
  const h = (await api('GET', '/api/contable/controles/historial', g())).json;
  assert.ok(h.length >= 2);
  assert.equal((await api('GET', `/api/contable/controles/${h[1].id}`, g())).json.id, h[1].id);
});
