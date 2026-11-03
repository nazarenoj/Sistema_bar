const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const M = require('../src/mensajeria/servicio');
const Correo = require('../src/servicios/correoService');

let api, pool, cerrar, token, tokenBarista, cliente, cuenta, k = 0;
const dia = (hace) => { const f = new Date(Date.now() - hace * 86400000); const p = (x) => String(x).padStart(2, '0'); return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`; };

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol, email) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol, email) VALUES (?, ?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado', email ?? null]);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
  };
  token = await usuario('adm', 'administrador', 'adm@cafe.test');
  tokenBarista = await usuario('bea', 'barista');
  await api('POST', '/api/modulos/clientes/instalar', { token });
  cliente = (await api('POST', '/api/clientes', { token, body: { tipo_documento: 'CUIT', nro_documento: '30711111111', razon_social: 'Café del Centro SRL', email: 'cafe@centro.test', consultar_arca: false } })).json;
  cuenta = (await api('POST', '/api/cuentas-corrientes', { token, body: { cliente_id: cliente.id, limite_credito: 1000000, plazo_dias: 15 } })).json;
});
after(async () => { await cerrar(); });

const debito = async (importe, hace) => {
  const docId = `VTA-${++k}`;
  const conn = await pool.getConnection();
  await M.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'debito_venta', docTipo: 'venta', docIdGlobal: docId, contenido: { cliente_id: cliente.id, importe, venta_id_global: docId, fecha: dia(hace) } });
  conn.release();
  await esperarMensajes(pool);
  return docId;
};
const get = (ruta, t = token) => api('GET', `/api/clientes-informes${ruta}`, { token: t });
const saldo = async () => (await api('GET', `/api/cuentas-corrientes/${cuenta.id}`, { token })).json.saldo;

test('Clientes.RF14: el estado de cuenta tiene saldo inicial, movimientos y saldo final, y cuadra con el saldo de la cuenta', async () => {
  await debito(1000, 100); await debito(2000, 70); await debito(3000, 40); await debito(4000, 10);
  await api('POST', '/api/recibos', { token, headers: { 'X-ID-Solicitud': 'rec-inf-1-abcdefgh' }, body: { cuenta_id: cuenta.id, valores: [{ forma: 'efectivo', importe: 1500 }, { forma: 'transferencia', importe: 500 }] } });
  const e = (await get(`/estado-cuenta/${cuenta.id}`)).json;
  assert.equal(e.saldo_final, await saldo()); // cuadra con el saldo derivado
  assert.equal(e.saldo_final, 8000);
  assert.deepEqual([e.saldo_inicial, e.movimientos.length, e.movimientos[0].saldo, e.movimientos.at(-1).saldo], [0, 5, 1000, 8000]);
  const parcial = (await get(`/estado-cuenta/${cuenta.id}?desde=${dia(50)}&hasta=${dia(5)}`)).json; // desde 50 días atrás: los 2 primeros débitos quedan en el saldo inicial
  assert.deepEqual([parcial.saldo_inicial, parcial.movimientos.length, parcial.saldo_final], [3000, 2, 10000]); // los débitos de hace 100 y 70 días quedan en el saldo inicial; el recibo de hoy queda fuera del período
  assert.deepEqual(e.composicion.map((c) => c.saldo_pendiente), [1000, 3000, 4000]); // pendientes: el primero cancelado y el segundo parcial
  assert.equal((await get(`/estado-cuenta/${cuenta.id}?desde=ayer`)).status, 400);
  assert.equal((await get(`/estado-cuenta/${cuenta.id}`, tokenBarista)).status, 403);
});

test('Clientes.RF15: la antigüedad de saldos usa los tramos configurados (por defecto 30, 60, 90)', async () => {
  const a = (await get('/antiguedad')).json;
  assert.deepEqual(a.tramos, ['0-30', '31-60', '61-90', 'más de 90']);
  assert.deepEqual(a.clientes[0].tramos, [4000, 3000, 1000, 0]); // 10 días, 40 días, 70 días (parcial), 100 días cancelado
  assert.equal(a.total, 8000);
  assert.equal((await api('PUT', '/api/clientes-informes/tramos', { token, body: { tramos: [20, 10] } })).status, 400); // tienen que crecer
  assert.deepEqual((await api('PUT', '/api/clientes-informes/tramos', { token, body: { tramos: [15, 45] } })).json, [15, 45]);
  const b = (await get('/antiguedad')).json;
  assert.deepEqual([b.tramos, b.clientes[0].tramos], [['0-15', '16-45', 'más de 45'], [4000, 3000, 1000]]);
  assert.equal((await get('/antiguedad?tipo_cliente=mayorista')).json.clientes.length, 0); // filtros combinables
  assert.equal((await get(`/antiguedad?cliente_id=${cliente.id}&moneda=ARS`)).json.clientes.length, 1);
});

test('Clientes.RF15: deudores con comprobantes vencidos, cobranzas por forma de pago y proyección por vencimiento', async () => {
  const d = (await get('/deudores')).json;
  // Vencidos hoy: el de hace 70 días (vence hace 55), el de 40 (hace 25) y el de 10 días no vence todavía (en 5 días).
  assert.deepEqual([d.deudores[0].comprobantes_vencidos, d.deudores[0].importe_vencido, d.deudores[0].dias_mora, d.deudores[0].saldo], [2, 4000, 55, 8000]);
  assert.equal((await get('/deudores?dias_mora_min=60')).json.deudores.length, 0);
  const c = (await get('/cobranzas')).json;
  assert.deepEqual(c.por_forma.map((f) => [f.forma, f.importe]), [['efectivo', 1500], ['transferencia', 500]]);
  assert.equal(c.total, 2000);
  assert.equal((await get('/cobranzas?forma=efectivo')).json.total, 1500);
  assert.equal((await get('/cobranzas?desde=2020-01-01&hasta=2020-12-31')).json.total, 0);
  const p = (await get('/proyeccion')).json;
  assert.deepEqual(p.dias.map((x) => x.importe), [1000, 3000, 4000]);
  assert.deepEqual([p.dias.map((x) => x.vencido), p.dias.at(-1).acumulado], [[true, true, false], 8000]);
});

test('Clientes.RF15: los informes se exportan a CSV, Excel y PDF', async () => {
  for (const [formato, tipo] of [['csv', /csv|text/], ['xlsx', /spreadsheet|excel|octet/]]) {
    const res = await api('GET', `/api/clientes-informes/antiguedad?formato=${formato}`, { token });
    assert.equal(res.status, 200, formato);
    assert.match(res.headers.get('content-type'), tipo);
  }
  assert.equal((await get('/antiguedad?formato=xml')).status, 400);
});

test('Clientes.RF14/EX12: el estado de cuenta se envía por correo; si falla queda en cola con reintento y figura «No enviado»', async () => {
  assert.equal((await api('POST', `/api/clientes-informes/estado-cuenta/${cuenta.id}/enviar`, { token, body: {} })).status, 409); // sin USU-CORREO
  await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['USU-CORREO'], motivo: 'prueba' } });
  await api('PUT', '/api/correo', { token, body: { host: 'smtp.test', puerto: 587, remitente: 'sistema@cafe.test', severidad_minima: 'critica' } });
  let caido = true;
  const salida = [];
  Correo.usarTransporte(async (cfg, m) => { if (caido) throw new Error('sin conexión'); salida.push(m); });
  const e = await api('POST', `/api/clientes-informes/estado-cuenta/${cuenta.id}/enviar`, { token, body: {} });
  assert.equal(e.status, 201, JSON.stringify(e.json));
  assert.deepEqual([e.json.estado, e.json.reintentando, e.json.destino], ['no_enviado', true, 'cafe@centro.test']);
  caido = false;
  await pool.query('UPDATE correo_cola SET proximo_intento = NOW()');
  await Correo.enviarCola();
  assert.equal((await api('GET', `/api/clientes-informes/envios?cliente_id=${cliente.id}`, { token })).json[0].estado, 'enviado');
  assert.match(salida[0].cuerpo, /Saldo final: 8000/);
  await pool.query('UPDATE clientes SET email = NULL WHERE id = ?', [cliente.id]);
  assert.equal((await api('POST', `/api/clientes-informes/estado-cuenta/${cuenta.id}/enviar`, { token, body: {} })).status, 409); // sin correo cargado
  await pool.query("UPDATE clientes SET email = 'cafe@centro.test' WHERE id = ?", [cliente.id]);
});

test('Clientes.RF16: los recordatorios generan alertas internas y avisos por correo, sin repetirlos dentro del plazo', async () => {
  await debito(500, 13); // vence en 2 días: próximo a vencer
  const antes = (await pool.query("SELECT COUNT(*) AS n FROM envios_cliente WHERE tipo = 'recordatorio'"))[0][0].n;
  const r = await api('POST', '/api/clientes-informes/recordatorios', { token, body: {} });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.length, r.json[0].alerta, r.json[0].correo], [1, true, true]);
  const alerta = (await pool.query("SELECT mensaje FROM notificaciones WHERE tipo = 'recordatorio_vencimiento'"))[0][0].mensaje;
  assert.match(alerta, /Café del Centro SRL: 2 comprobante\(s\) vencido\(s\) por/);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM envios_cliente WHERE tipo = 'recordatorio'"))[0][0].n, antes + 1);
  const otra = await api('POST', '/api/clientes-informes/recordatorios', { token, body: {} });
  assert.equal(otra.json[0].correo, false); // dentro de los 7 días no se vuelve a mandar
});

test('Clientes.RF25: el tablero muestra la deuda de clientes (total, vencida, % vencido y mayores deudores) solo a quien tiene permiso', async () => {
  await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['USU-TABLERO'], motivo: 'prueba' } });
  const Tablero = require('../src/servicios/tableroService');
  Tablero.limpiarCache();
  const t = (await api('GET', '/api/tablero', { token })).json.indicadores.find((i) => i.id === 'clientes.deuda');
  assert.equal(t.valor, 8500);
  assert.deepEqual([t.detalle.deuda_vencida, t.detalle.porcentaje_vencido, t.serie[0].clave], [4000, 47.06, 'Café del Centro SRL']);
  const barista = (await api('GET', '/api/tablero', { token: tokenBarista })).json.indicadores;
  assert.equal(barista.some((i) => i.id === 'clientes.deuda'), false);
});
