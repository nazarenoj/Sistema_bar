const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
process.env.AFIP_CONDICION_IVA_EMISOR = 'monotributista';
process.env.AFIP_PUNTO_VENTA = '1';
const { iniciarApp } = require('./ayudas');
const { hashCodigo } = require('../src/utils/credenciales');

let api, pool, cerrar, token, wsfe, n = 0;
let ultimo = 0, items = [], caido = false;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const nuevo = async (username, pin) => {
    const [u] = await pool.query("INSERT INTO users (username, password_hash, rol, pin_hash) VALUES (?, ?, 'admin', ?)", [username, await bcrypt.hash('clave-larga-1', 4), pin ? hashCodigo(pin) : null]);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  };
  await nuevo('adm', '1111');
  await nuevo('adm2', '2222');
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
  wsfe = require('../src/afip/wsfeClient');
  wsfe.compUltimoAutorizado = async () => { if (caido) throw new Error('ARCA caído'); return ultimo; };
  wsfe.solicitarCAE = async ({ item }) => { items.push(item); ultimo = item.CbteDesde; return { FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CAE: '70000000000001', CAEFchVto: '20261231' }] } }; };
});
after(async () => { await cerrar(); });

// Cuenta de 250: 2 x $100 de A y 1 x $50 de B. Devuelve { mesa, a, b }.
const cuenta = async () => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const a = (await api('POST', '/api/productos', { token, body: { nombre: `A ${n}`, precio: 100, stock: 10 } })).json;
  const b = (await api('POST', '/api/productos', { token, body: { nombre: `B ${n}`, precio: 50, stock: 10 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: a.id, cantidad: 2 }, { producto_id: b.id, cantidad: 1 }] } });
  return { mesa, a, b };
};
const vender = async (extra = {}) => {
  const c = await cuenta();
  const r = await api('POST', `/api/mesas/${c.mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `venta-${n}-${Math.random().toString(36).slice(2, 8)}` }, body: { metodo_pago: 'efectivo', ...extra } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { ...c, id: r.json.venta_id_global, factura: r.json.factura };
};
let k = 0;
const devolver = (id, body, headers = {}) => api('POST', '/api/devoluciones', { token, headers: { 'X-ID-Solicitud': `devol-${++k}-${Math.random().toString(36).slice(2, 8)}`, ...headers }, body: { venta_id_global: id, motivo: 'el cliente se arrepintió', ...body } });
const stock = async (id) => Number((await pool.query('SELECT stock FROM productos WHERE id = ?', [id]))[0][0].stock);
const venta = async (id) => (await api('GET', `/api/ventas/${id}`, { token })).json;

test('Ventas.RF15: una devolución parcial reintegra lo cobrado, reingresa al stock y deja la venta sin tocar', async () => {
  const v = await vender();
  assert.equal(await stock(v.a.id), 8);
  const r = await devolver(v.id, { items: [{ linea: 0, cantidad: 1 }] });
  assert.equal(r.status, 201);
  assert.equal(r.json.devolucion.total, 100);
  assert.deepEqual(r.json.reintegros, [{ forma: 'efectivo', importe: 100 }]);
  assert.equal(r.json.nota_credito, null); // la venta no tenía factura
  assert.equal(await stock(v.a.id), 9);
  const despues = await venta(v.id);
  assert.equal(despues.estado, 'devuelta_parcial');
  assert.equal(despues.devuelto, 100);
  assert.equal(Number(despues.total), 250);
  assert.equal((await api('GET', `/api/devoluciones?venta=${v.id}`, { token })).json[0].items[0].nombre, `A ${v.mesa.numero_mesa}`);
});

test('Ventas.RF15: no se devuelve más de lo vendido ni dos veces lo mismo; anular devuelve lo que queda', async () => {
  const v = await vender();
  assert.equal((await devolver(v.id, { items: [{ linea: 0, cantidad: 3 }] })).status, 400);
  assert.equal((await devolver(v.id, { items: [{ linea: 7, cantidad: 1 }] })).status, 400);
  assert.equal((await devolver(v.id, { items: [{ linea: 0, cantidad: 2 }] })).status, 201);
  assert.equal((await devolver(v.id, { items: [{ linea: 0, cantidad: 1 }] })).status, 400); // ya se devolvió
  const anula = await devolver(v.id, { todo: true });
  assert.equal(anula.status, 201);
  assert.equal(anula.json.devolucion.total, 50);
  assert.equal(anula.json.devolucion.tipo, 'total');
  assert.equal((await venta(v.id)).estado, 'anulada');
  assert.equal((await devolver(v.id, { todo: true })).status, 400);
  assert.equal((await devolver(v.id, { todo: true, motivo: '' })).status, 400); // el motivo es obligatorio
});

test('Ventas.RN19: la devolución nunca borra ni modifica el movimiento original', async () => {
  const v = await vender();
  await devolver(v.id, { todo: true });
  await assert.rejects(pool.query('UPDATE devoluciones SET total = 1'), /solo lectura/);
  await assert.rejects(pool.query('DELETE FROM devolucion_items'), /solo lectura/);
  await assert.rejects(pool.query('DELETE FROM devolucion_reintegros'), /solo lectura/);
  assert.equal(Number((await venta(v.id)).total), 250);
});

test('Ventas.RN76: un pago mixto se devuelve respetando el reparto original', async () => {
  const c = await cuenta();
  const r = await api('POST', `/api/mesas/${c.mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': 'mixta-venta-01' }, body: { pagos: [{ forma: 'efectivo', importe: 150 }, { forma: 'transferencia', importe: 100 }] } });
  const d = await devolver(r.json.venta_id_global, { items: [{ linea: 0, cantidad: 1 }] }); // 100 de 250
  assert.deepEqual(d.json.reintegros, [{ forma: 'efectivo', importe: 60 }, { forma: 'transferencia', importe: 40 }]);
});

test('Ventas.RN76/EX58: devolver con otra forma de pago exige la autorización de un supervisor distinto', async () => {
  const v = await vender();
  const otra = [{ forma: 'transferencia', importe: 100 }];
  const sin = await devolver(v.id, { items: [{ linea: 0, cantidad: 1 }], reintegro: otra });
  assert.equal(sin.status, 403);
  assert.equal(sin.json.codigo, 'REQUIERE_AUTORIZACION');
  const propio = await devolver(v.id, { items: [{ linea: 0, cantidad: 1 }], reintegro: otra, autorizacion: { credencial: '1111' } }); // su propio PIN
  assert.equal(propio.status, 403);
  const ok = await devolver(v.id, { items: [{ linea: 0, cantidad: 1 }], reintegro: otra, autorizacion: { credencial: '2222' } });
  assert.equal(ok.status, 201);
  assert.equal((await api('GET', `/api/devoluciones?venta=${v.id}`, { token })).json[0].autorizado_por > 0, true);
  // La misma forma con otro reparto no necesita autorización; una forma inexistente o una suma que no cierra, se rechazan.
  assert.equal((await devolver(v.id, { items: [{ linea: 1, cantidad: 1 }], reintegro: [{ forma: 'efectivo', importe: 50 }] })).status, 201);
  assert.equal((await devolver(v.id, { items: [{ linea: 0, cantidad: 1 }], reintegro: [{ forma: 'efectivo', importe: 5 }] })).status, 400);
});

test('Ventas.RF15: la merma no reingresa al stock', async () => {
  const v = await vender();
  assert.equal((await devolver(v.id, { items: [{ linea: 0, cantidad: 2 }], reingreso: 'merma' })).status, 201);
  assert.equal(await stock(v.a.id), 8);
});

test('Ventas.RN64/EX49: reenviar la misma devolución varias veces produce un solo efecto', async () => {
  const v = await vender();
  const clave = { 'X-ID-Solicitud': 'devolucion-repetida-1' };
  const rs = await Promise.all([1, 2, 3].map(() => devolver(v.id, { items: [{ linea: 0, cantidad: 1 }] }, clave)));
  assert.ok(rs.some((r) => r.status === 201));
  assert.equal((await venta(v.id)).devuelto, 100);
  assert.equal(await stock(v.a.id), 9);
});

test('Ventas.RF15: dos anulaciones simultáneas no devuelven dos veces lo mismo', async () => {
  const v = await vender();
  const rs = await Promise.all([devolver(v.id, { todo: true }), devolver(v.id, { todo: true })]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 400]);
  assert.equal((await venta(v.id)).devuelto, 250);
  assert.equal(await stock(v.a.id), 10);
});

test('Ventas.RF15: una venta facturada genera la nota de crédito, que referencia la factura', async () => {
  const v = await vender({ tipo_comprobante: 11, doc_tipo: 99, doc_nro: '0', condicion_iva_receptor_id: 5 });
  assert.equal(v.factura.estado, 'aprobada');
  items = [];
  const r = await devolver(v.id, { items: [{ linea: 0, cantidad: 1 }] });
  assert.equal(r.status, 201);
  assert.equal(r.json.nota_credito.tipo_comprobante, 13); // Nota de Crédito C
  assert.equal(r.json.nota_credito.estado, 'aprobada');
  assert.equal(Number(r.json.nota_credito.importe_total), 100);
  assert.deepEqual(items[0].CbtesAsoc.CbteAsoc[0], { Tipo: 11, PtoVta: 1, Nro: v.factura.numero });
  // La factura original sigue siendo la de la cuenta (el historial no se duplica).
  const hist = (await api('GET', '/api/pedidos/historial?limit=100', { token })).json;
  const filas = (hist.pedidos ?? hist.rows ?? []).filter((p) => p.mesa_id === v.mesa.id);
  assert.ok(filas.length > 0 && filas.every((p) => p.factura_id === v.factura.id));
});

test('Ventas.EX61: si la nota de crédito falla, la devolución queda y se reintenta con la factura referenciada', async () => {
  const v = await vender({ tipo_comprobante: 11, doc_tipo: 99, doc_nro: '0', condicion_iva_receptor_id: 5 });
  caido = true;
  const r = await devolver(v.id, { todo: true });
  caido = false;
  assert.equal(r.status, 201);
  assert.equal(r.json.nota_credito.estado, 'error');
  assert.equal((await venta(v.id)).estado, 'anulada');
  items = [];
  const re = await api('POST', `/api/facturas/${r.json.nota_credito.id}/reintentar`, { token, headers: { 'X-ID-Solicitud': 'reintento-nota-01' } });
  assert.equal(re.status, 200);
  assert.equal(re.json.factura.estado, 'aprobada');
  assert.equal(items[0].CbtesAsoc.CbteAsoc[0].Nro, v.factura.numero);
});

test('Ventas.RN84: la devolución de una venta no fiscal no genera nota de crédito ni evento contable', async () => {
  const v = await vender({ modalidad: 'no_fiscal' });
  const r = await devolver(v.id, { todo: true });
  assert.equal(r.status, 201);
  assert.equal(r.json.nota_credito, null);
  assert.equal((await pool.query("SELECT COUNT(*) n FROM mensajes_integracion WHERE doc_id_global = ? AND modulo_destino = 'contable'", [r.json.devolucion.id_global]))[0][0].n, 0);
});
