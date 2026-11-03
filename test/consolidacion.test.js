const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const C = require('../src/servicios/consolidacionService');

let api, pool, cerrar, token, n = 0, k = 0;
const dia = (hace) => { const d = new Date(Date.now() - hace * 86400000); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const AYER = dia(1);

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [r] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query("INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = 'administrador'", [r.insertId]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

const post = (ruta, body) => api('POST', `/api/consolidacion${ruta}`, { token, body });
const vender = async (precio, nombre) => {
  const p = (await api('POST', '/api/productos', { token, body: { nombre, precio } })).json;
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: p.id, cantidad: 1 }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-con-${++k}-abcdef` }, body: { pagos: [{ forma: 'efectivo', importe: precio }] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await esperarMensajes(pool);
};
// Pasa la última venta a "ayer" (las ventas son de solo lectura: se copia con otra fecha).
const copiarAyer = async () => {
  const [[v]] = await pool.query('SELECT * FROM ventas ORDER BY id DESC LIMIT 1');
  const [r] = await pool.query("INSERT INTO ventas (id_global, mesa_id, sesion_apertura, total, detalle, created_at) VALUES (?, ?, DATE_SUB(?, INTERVAL 1 DAY), ?, ?, ?)", [`AYER-${++k}-${v.id_global}`.slice(0, 40), v.mesa_id, v.sesion_apertura, v.total, v.detalle, `${AYER} 10:00:00`]);
  await pool.query("INSERT INTO pago_venta (venta_id, metodo_pago, importe) VALUES (?, 'efectivo', ?)", [r.insertId, v.total]);
};
// Un paquete publicado, rehecho como si fuera de otra sucursal: mismo contenido, firmado con la clave de esta instancia.
const comoSucursal = async (sobre, codigo, cambios = {}) => {
  const [[{ clave_privada: priv }]] = await pool.query('SELECT clave_privada FROM consolidacion_config WHERE id = 1');
  const s = { ...sobre, sucursal: codigo, ...cambios };
  s.firma = crypto.sign(null, Buffer.from(C.firmado(s)), priv).toString('base64');
  return s;
};

test('Usuarios.RN38/RF20: USU-CONSOL, marca de la instancia y publicación de paquetes agregados y firmados (Ventas RF46, Stock RF34)', async () => {
  assert.equal((await api('GET', '/api/consolidacion/configuracion', { token })).status, 409);
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['USU-CONSOL'], motivo: 'prueba' } })).status, 200);
  assert.equal((await api('PUT', '/api/consolidacion/configuracion', { token, body: { sucursal: 'si' } })).status, 400);
  const cfg = await api('PUT', '/api/consolidacion/configuracion', { token, body: { sucursal: true, casa_central: true } });
  assert.equal(cfg.status, 200);
  assert.match(cfg.json.clave_publica, /BEGIN PUBLIC KEY/);
  assert.equal(cfg.json.clave_privada, undefined);

  await vender(1500, 'Medialuna');
  await copiarAyer();
  await pool.query("INSERT INTO insumos (nombre, unidad) VALUES ('Harina', 'kg')");
  const [[ins]] = await pool.query("SELECT id FROM insumos WHERE nombre = 'Harina'");
  const [[mot]] = await pool.query("SELECT codigo FROM motivos_stock WHERE clase_contable = 'merma' LIMIT 1");
  const mov = (tipo, motivo, cant) => pool.query("INSERT INTO stock_movimientos (id_global, insumo_id, deposito_id, tipo, motivo, cantidad, costo_unitario, created_at) VALUES (?, ?, 1, ?, ?, ?, 50, ?)", [`MOV-${++k}-${crypto.randomUUID()}`.slice(0, 40), ins.id, tipo, motivo, cant, `${AYER} 09:00:00`]);
  await mov('ingreso', 'compra', 10);
  await mov('egreso', mot.codigo, -2);

  assert.equal((await post('/publicar', { periodo: dia(0) })).status, 409); // el período tiene que haber terminado
  const pub = await post('/publicar', { periodo: AYER });
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  assert.deepEqual(pub.json.map((x) => x.modulo).sort(), ['stock', 'ventas']);
  assert.deepEqual((await post('/publicar', { periodo: AYER })).json.map((x) => x.nuevo), [false, false]); // idempotente
  const lista = (await api('GET', '/api/consolidacion/publicados', { token })).json;
  const sobre = (await api('GET', `/api/consolidacion/publicados/${lista.find((x) => x.modulo === 'ventas').id}/archivo`, { token })).json;
  assert.deepEqual(Object.keys(sobre.contenido).sort(), ['anulaciones', 'devoluciones', 'importe', 'por_forma_pago', 'por_producto', 'ventas']); // RN41: solo agregados
  assert.deepEqual([sobre.contenido.ventas, sobre.contenido.importe, sobre.contenido.por_producto[0].producto, sobre.contenido.por_forma_pago[0].forma], [1, 1500, 'Medialuna', 'efectivo']);
  const stock = (await api('GET', `/api/consolidacion/publicados/${lista.find((x) => x.modulo === 'stock').id}/archivo`, { token })).json;
  assert.deepEqual([stock.contenido.existencias[0].cantidad, stock.contenido.existencias[0].valor, stock.contenido.mermas[0].cantidad], [8, 400, 2]);
});

test('Usuarios.RN39/RN40/EX20/EX21: la Casa Central importa solo con firma válida de una sucursal registrada, idempotente y de solo lectura', async () => {
  const [[{ clave_publica }]] = await pool.query('SELECT clave_publica FROM consolidacion_config WHERE id = 1');
  const suc = await post('/sucursales', { codigo: 'SUC02', nombre: 'Sucursal Norte', clave_publica, modulos: ['ventas', 'stock'], desde: AYER });
  assert.equal(suc.status, 201, JSON.stringify(suc.json));
  assert.equal((await post('/sucursales', { codigo: 'SUC02', nombre: 'x', clave_publica, modulos: ['ventas'] })).status, 409);
  assert.equal((await post('/sucursales', { codigo: 'SUC03', nombre: 'x', clave_publica: 'no-es-clave', modulos: ['ventas'] })).status, 400);

  const lista = (await api('GET', '/api/consolidacion/publicados', { token })).json;
  const original = (await api('GET', `/api/consolidacion/publicados/${lista.find((x) => x.modulo === 'ventas').id}/archivo`, { token })).json;
  const paquete = await comoSucursal(original, 'SUC02');
  const ok = await post('/importar', paquete);
  assert.deepEqual([ok.status, ok.json.importado], [200, true], JSON.stringify(ok.json));
  const otra = await post('/importar', paquete);
  assert.deepEqual([otra.json.importado, otra.json.mensaje], [false, 'Ya importado']); // EX21
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM paquetes_recibidos WHERE estado = 'importado'"))[0][0].n, 1);

  // EX20: alterado, firma de otro, sucursal desconocida.
  const alterado = { ...paquete, version: 2, contenido: { ...paquete.contenido, importe: 999999 } };
  assert.equal((await post('/importar', alterado)).status, 422);
  const sinFirma = { ...(await comoSucursal(original, 'SUC02', { version: 3 })), firma: Buffer.from('falsa').toString('base64') };
  assert.match((await post('/importar', sinFirma)).json.motivo, /firma/);
  assert.match((await post('/importar', await comoSucursal(original, 'DESCONOCIDA'))).json.motivo, /no está registrada/);
  const rechazados = (await api('GET', '/api/consolidacion/paquetes', { token })).json.filter((p) => p.estado === 'rechazado');
  assert.equal(rechazados.length, 3);
  assert.ok((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE tipo = 'paquete_rechazado'"))[0][0].n >= 3);
  // Los datos importados no se editan ni se borran (RN40).
  await assert.rejects(pool.query("UPDATE paquetes_recibidos SET contenido = '{}' WHERE estado = 'importado'"), /solo lectura/);
  await assert.rejects(pool.query('DELETE FROM paquetes_recibidos'), /solo lectura/);

  // Una versión corregida del mismo período reemplaza a la anterior y la anterior queda en el historial.
  await copiarAyer();
  const pub2 = await post('/publicar', { periodo: AYER, modulo: 'ventas' });
  assert.deepEqual(pub2.json.map((x) => [x.version, x.nuevo]), [[2, true]]);
  const v2 = (await api('GET', `/api/consolidacion/publicados/${(await api('GET', '/api/consolidacion/publicados', { token })).json.find((x) => x.modulo === 'ventas' && x.version === 2).id}/archivo`, { token })).json;
  const r2 = await post('/importar', await comoSucursal(v2, 'SUC02'));
  assert.deepEqual([r2.json.importado, r2.json.reemplaza], [true, 1]);
  const estados = (await api('GET', '/api/consolidacion/paquetes', { token })).json.filter((p) => p.estado !== 'rechazado').map((p) => [p.version, p.estado]);
  assert.deepEqual(estados.sort(), [[1, 'reemplazado'], [2, 'importado']]);
  assert.equal((await post('/importar', await comoSucursal(original, 'SUC02'))).json.mensaje, 'Ya hay una versión más nueva de este paquete.');
});

test('Usuarios.EX22: un paquete de una versión más nueva queda pendiente y se importa al actualizar', async () => {
  const lista = (await api('GET', '/api/consolidacion/publicados', { token })).json;
  const base = (await api('GET', `/api/consolidacion/publicados/${lista.find((x) => x.modulo === 'stock').id}/archivo`, { token })).json;
  const futuro = await comoSucursal(base, 'SUC02', { version_sistema: '999.0.0' });
  const r = await post('/importar', futuro);
  assert.deepEqual([r.json.importado, r.json.pendiente_version, r.json.version_necesaria], [false, true, '999.0.0']);
  assert.equal((await post('/importar', futuro)).json.pendiente_version, true); // no se duplica
  assert.deepEqual(await C.reintentarPendientes(), []); // sigue sin poder
  assert.equal((await api('GET', '/api/consolidacion/paquetes', { token })).json.filter((p) => p.estado === 'pendiente_version').length, 1);
});

test('Usuarios.RN42/EX23: el control marca faltantes y alerta; el informe consolidado marca Incompleto y suma la operación propia de la Casa Central', async () => {
  await pool.query("UPDATE sucursales SET desde = ? WHERE codigo = 'SUC02'", [dia(10)]);
  const ctl = (await api('GET', '/api/consolidacion/control', { token })).json.find((c) => c.sucursal === 'SUC02' && c.modulo === 'ventas');
  assert.equal(ctl.recibidos, 1);
  assert.ok(ctl.faltantes.length >= 8 && !ctl.faltantes.includes(AYER)); // de hace 10 días a anteanoche; ayer llegó
  assert.equal(ctl.rechazados, 2); // el alterado y el de firma falsa de esta sucursal
  await C.control({ alertar: true });
  assert.ok((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE tipo = 'paquete_faltante'"))[0][0].n >= 1);

  const inf = (await api('GET', `/api/consolidacion/informes/ventas?desde=${AYER}&hasta=${AYER}&formato=json`, { token })).json;
  const por = Object.fromEntries(inf.totales.map((t) => [t.sucursal, t]));
  assert.deepEqual([por.SUC02.ventas, por.SUC02.importe], [2, 3000]); // la versión 2 del paquete
  assert.deepEqual([por.TST01.ventas, por.TST01.importe], [2, 3000]); // la operación propia de la Casa Central, sin paquete
  assert.deepEqual(inf.incompleto, []);
  const amplio = (await api('GET', `/api/consolidacion/informes/ventas?desde=${dia(8)}&hasta=${AYER}&formato=json`, { token })).json;
  assert.equal(amplio.incompleto[0].sucursal, 'SUC02'); // faltan períodos: Incompleto
  assert.equal((await api('GET', `/api/consolidacion/informes/ventas?desde=${AYER}&hasta=${AYER}&formato=csv`, { token })).status, 200);
  assert.equal((await api('GET', '/api/consolidacion/informes/ventas?desde=2020-01-01&hasta=2026-01-01&formato=json', { token })).status, 400); // más de 12 meses
  const st = (await api('GET', `/api/consolidacion/informes/stock?desde=${AYER}&hasta=${AYER}&formato=json`, { token })).json;
  assert.equal(st.existencias.length, 1);
  assert.deepEqual(st.mermas.map((m) => [m.sucursal, m.cantidad]), [['TST01', 2]]);
});

test('Usuarios.EX24/EX25: el envío sin conexión queda en cola con reintento; sin Stock en la Casa Central el informe de Stock se oculta', async () => {
  await post('/publicar', { periodo: dia(2) });
  await pool.query("UPDATE consolidacion_config SET destino_url = 'https://casa.central.test/api/consolidacion/recibir' WHERE id = 1");
  C.usarEnvio(async () => { throw new Error('sin conexión'); });
  const falla = await post('/enviar', {});
  assert.ok(falla.json.length > 0 && falla.json.every((x) => !x.ok));
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM paquetes_publicados WHERE enviado_en IS NULL AND intentos = 1'))[0][0].n, falla.json.length);
  const recibidos = [];
  C.usarEnvio(async (url, sobre) => { recibidos.push(sobre); });
  const ok = await post('/enviar', {});
  assert.ok(ok.json.every((x) => x.ok));
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM paquetes_publicados WHERE enviado_en IS NULL'))[0][0].n, 0);
  // Recepción pública: sin sesión, pero con firma.
  const [[v]] = await pool.query("SELECT sobre FROM paquetes_publicados WHERE modulo = 'ventas' AND periodo = ?", [dia(2)]);
  const pub = await api('POST', '/api/consolidacion/recibir', { body: await comoSucursal(JSON.parse(v.sobre), 'SUC02') });
  assert.deepEqual([pub.status, pub.json.importado], [200, true]);
  assert.equal((await api('POST', '/api/consolidacion/recibir', { body: { sucursal: 'SUC02', firma: 'x' } })).status, 422);

  await pool.query("DELETE FROM modulos_instalados WHERE codigo = 'stock'");
  require('../src/modulos/registro').invalidar();
  assert.equal((await api('GET', `/api/consolidacion/informes/stock?desde=${AYER}&hasta=${AYER}&formato=json`, { token })).status, 404);
});
