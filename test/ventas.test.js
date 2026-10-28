const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token, n = 0;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [r] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [r.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

// Abre una mesa con un pedido de 2 unidades de un producto de $100 y devuelve { mesa, producto }.
const cuentaAbierta = async () => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const producto = (await api('POST', '/api/productos', { token, body: { nombre: `Café ${n}`, precio: 100 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: producto.id, cantidad: 2 }] } });
  return { mesa, producto };
};
const cobrar = (mesa, clave) => api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': clave }, body: { metodo_pago: 'efectivo' } });
const ventas = async (mesaId) => (await pool.query('SELECT * FROM ventas WHERE mesa_id = ?', [mesaId]))[0];

test('Ventas.RF08/RN21: cerrar la cuenta crea la venta con ID_Global, su pago y una copia fija de los ítems', async () => {
  const { mesa, producto } = await cuentaAbierta();
  const r = await cobrar(mesa, 'cierre-1');
  assert.equal(r.status, 200);
  const [v] = await ventas(mesa.id);
  assert.match(v.id_global, /^TST01-/);
  assert.equal(r.json.venta_id_global, v.id_global);
  assert.equal(Number(v.total), 200);
  assert.equal(v.id_solicitud, 'cierre-1');

  await pool.query('UPDATE productos SET precio = 999, nombre = "otro" WHERE id = ?', [producto.id]);
  const venta = (await api('GET', `/api/ventas/${v.id_global}`, { token })).json;
  assert.equal(venta.detalle[0].precio_unitario, 100);
  assert.equal(venta.detalle[0].nombre, `Café ${n}`);
  assert.deepEqual(venta.pagos.map((p) => [p.metodo_pago, Number(p.importe)]), [['efectivo', 200]]);
  assert.equal(venta.integracion.estado, 'completa'); // sin otros módulos instalados no hay efectos pendientes
});

test('Ventas.RN19: la venta es de solo lectura, ni con SQL se modifica o borra', async () => {
  const [v] = (await pool.query('SELECT id FROM ventas LIMIT 1'))[0];
  await assert.rejects(pool.query('UPDATE ventas SET total = 1 WHERE id = ?', [v.id]), /solo lectura/);
  await assert.rejects(pool.query('DELETE FROM ventas WHERE id = ?', [v.id]), /solo lectura/);
  await assert.rejects(pool.query('DELETE FROM pago_venta WHERE venta_id = ?', [v.id]), /solo lectura/);
});

test('Ventas.EX49: reenviar el mismo cierre varias veces produce una sola venta', async () => {
  const { mesa } = await cuentaAbierta();
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => cobrar(mesa, 'cierre-doble')));
  assert.ok(rs.some((r) => r.status === 200));
  assert.equal((await ventas(mesa.id)).length, 1);
  assert.equal((await cobrar(mesa, 'cierre-doble')).json.venta_id_global, (await ventas(mesa.id))[0].id_global);
});

test('Ventas.RN58/EX43: si falla un efecto la venta no se revierte y queda Parcial; al confirmarse vuelve a Completa', async () => {
  const Modulos = require('../src/modulos/registro');
  const M = require('../src/mensajeria/servicio');
  const original = Modulos.estaInstalado;
  let falla = true;
  Modulos.estaInstalado = async (m) => m === 'financiero' || original(m);
  M.registrarReceptor('financiero', 'cobro_registrado', async () => { if (falla) throw new Error('caído'); return {}; });
  try {
    const { mesa } = await cuentaAbierta();
    assert.equal((await cobrar(mesa, 'cierre-parcial')).status, 200);
    const [v] = await ventas(mesa.id);
    await new Promise((res) => setTimeout(res, 300)); // la entrega inmediata corre en segundo plano
    const parcial = (await api('GET', `/api/ventas/${v.id_global}`, { token })).json;
    assert.equal(parcial.integracion.estado, 'parcial');
    assert.deepEqual(parcial.integracion.efectos.map((e) => e.modulo), ['financiero']);
    assert.equal(parcial.total, '200.00'); // la venta sigue ahí

    falla = false;
    await pool.query("UPDATE mensajes_integracion SET proximo_intento_ms = 0 WHERE doc_id_global = ? AND estado = 'pendiente'", [v.id_global]);
    await M.procesarPendientes();
    assert.equal((await api('GET', `/api/ventas/${v.id_global}`, { token })).json.integracion.estado, 'completa');
  } finally {
    Modulos.estaInstalado = original;
  }
});

test('Ventas.RN50: si el cierre falla, no queda venta ni mensajes', async () => {
  const { mesa } = await cuentaAbierta();
  const Venta = require('../src/services/ventaService');
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  await Venta.registrar(conn, { mesa_id: mesa.id, sesion_apertura: new Date(), items: [], total: 0, pagos: [{ forma: 'efectivo', importe: 0, referencia: null, recibido: null, vuelto: 0 }] });
  await conn.rollback();
  conn.release();
  assert.equal((await ventas(mesa.id)).length, 0);
});

// --- B4: formas de pago configurables, pago mixto y vuelto ---

const cobrarCon = (mesa, clave, pagos) => api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': clave }, body: { pagos } });

test('Ventas.RN16/EX11: un pago mixto cuya suma no es el total se bloquea y la cuenta sigue abierta', async () => {
  const { mesa } = await cuentaAbierta(); // total 200
  const r = await cobrarCon(mesa, 'mixto-mal', [{ forma: 'efectivo', importe: 100 }, { forma: 'transferencia', importe: 50 }]);
  assert.equal(r.status, 400);
  assert.equal(r.json.codigo, 'PAGO_INVALIDO');
  assert.equal((await ventas(mesa.id)).length, 0);
  assert.equal((await pool.query('SELECT estado FROM mesas WHERE id = ?', [mesa.id]))[0][0].estado, 'ocupado');
  assert.equal((await cobrarCon(mesa, 'mixto-forma', [{ forma: 'bitcoin', importe: 200 }])).status, 400);
});

test('Ventas.RF09: pago mixto con vuelto; se guarda cada pago y el resumen es "mixto"', async () => {
  const { mesa } = await cuentaAbierta();
  const r = await cobrarCon(mesa, 'mixto-ok', [{ forma: 'efectivo', importe: 120, recibido: 150 }, { forma: 'transferencia', importe: 80, referencia: 'T-1' }]);
  assert.equal(r.status, 200);
  const venta = (await api('GET', `/api/ventas/${r.json.venta_id_global}`, { token })).json;
  assert.deepEqual(venta.pagos.map((p) => [p.metodo_pago, Number(p.importe), Number(p.vuelto)]), [['efectivo', 120, 30], ['transferencia', 80, 0]]);
  assert.equal((await pool.query('SELECT DISTINCT metodo_pago m FROM pedidos WHERE mesa_id = ?', [mesa.id]))[0][0].m, 'mixto');
});

test('Ventas.RN16/EX13: el vuelto solo se admite en formas configuradas para ello', async () => {
  const { mesa } = await cuentaAbierta();
  const r = await cobrarCon(mesa, 'vuelto-mal', [{ forma: 'transferencia', importe: 200, recibido: 300 }]);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /no admite vuelto/);
  assert.equal((await cobrarCon(mesa, 'vuelto-bajo', [{ forma: 'efectivo', importe: 200, recibido: 100 }])).status, 400);
});

test('Ventas.RF09: una forma nueva con referencia obligatoria exige la referencia; desactivada no se acepta', async () => {
  const forma = (await api('POST', '/api/formas-pago', { token, body: { codigo: 'qr', nombre: 'QR', requiere_referencia: true } })).json;
  assert.equal(forma.requiere_referencia, 1);
  assert.equal((await api('POST', '/api/formas-pago', { token, body: { codigo: 'qr', nombre: 'otra' } })).status, 409);
  const { mesa } = await cuentaAbierta();
  { const r = await cobrarCon(mesa, 'qr-sin-referencia', [{ forma: 'qr', importe: 200 }]); assert.equal(r.json.codigo, 'PAGO_INVALIDO'); }
  { const r = await cobrarCon(mesa, 'qr-con-referencia', [{ forma: 'qr', importe: 200, referencia: 'Q-9' }]); assert.equal(r.status, 200, JSON.stringify(r.json)); }

  await api('PUT', `/api/formas-pago/${forma.id}`, { token, body: { nombre: 'QR', activa: false } });
  const otra = await cuentaAbierta();
  assert.equal((await cobrarCon(otra.mesa, 'qr-desactivada', [{ forma: 'qr', importe: 200, referencia: 'Q-10' }])).status, 400);
});

test('Ventas.RF09: el reporte discrimina lo cobrado por cada forma de pago', async () => {
  const filas = (await api('GET', '/api/ventas/por-forma-pago', { token })).json;
  const total = (f) => Number(filas.find((x) => x.forma === f)?.total ?? 0);
  assert.ok(total('efectivo') >= 120 && total('transferencia') >= 80 && total('qr') === 200);
  const suma = filas.reduce((a, f) => a + Number(f.total), 0);
  assert.equal(suma, Number((await pool.query('SELECT SUM(total) t FROM ventas'))[0][0].t));
});
