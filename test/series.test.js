const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token, n = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

const saldo = async (id) => Number((await pool.query('SELECT stock FROM productos WHERE id = ?', [id]))[0][0].stock);
const serializado = async (nombre) => {
  const p = (await api('POST', '/api/productos', { token, body: { nombre: `${nombre} ${++n}`, precio: 1000 } })).json;
  assert.equal((await api('PUT', `/api/series/${p.id}/activar`, { token })).status, 200);
  return p;
};
const estado = async (p, numero) => (await api('GET', `/api/series/${p.id}`, { token })).json.find((s) => s.numero_serie === numero)?.estado;

test('Stock.RN71: sin STK-SERIE (y VEN-SERIE) no se serializa nada; STK-SERIE exige VEN-SERIE', async () => {
  const p = (await api('POST', '/api/productos', { token, body: { nombre: 'Notebook previa', precio: 1000 } })).json;
  assert.equal((await api('PUT', `/api/series/${p.id}/activar`, { token })).status, 409); // función apagada
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['STK-SERIE'], motivo: 'prueba' } })).status, 400); // falta VEN-SERIE
  const ok = await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['STK-SERIE', 'VEN-SERIE'], motivo: 'prueba' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});

test('Stock.RF26/RN05: la serie pasa Disponible → Comprometida → Vendida de forma atómica y cada paso queda en el historial', async () => {
  const p = await serializado('Notebook');
  const ing = await api('POST', `/api/series/${p.id}/ingresos`, { token, body: { series: ['SN1', 'SN2', 'SN3'], costo_unitario: 500, proveedor: 'Mayorista SA', comprobante: { numero: 'A-0001' } } });
  assert.equal(ing.status, 201, JSON.stringify(ing.json));
  assert.equal(await saldo(p.id), 3);
  assert.equal((await api('POST', `/api/series/${p.id}/ingresos`, { token, body: { series: ['SN2'] } })).status, 409); // repetida
  assert.equal((await api('POST', `/api/series/${p.id}/ingresos`, { token, body: { series: ['X1', 'X1'] } })).status, 409);

  assert.equal((await api('POST', `/api/series/${p.id}/SN1/vender`, { token, body: {} })).status, 409); // sin comprometer
  assert.equal((await api('POST', `/api/series/${p.id}/SN1/comprometer`, { token, body: { id_compromiso: 'C-1' } })).status, 200);
  // Dos compromisos a la vez sobre la misma serie: solo uno prospera.
  const dos = await Promise.all([1, 2].map((i) => api('POST', `/api/series/${p.id}/SN2/comprometer`, { token, body: { id_compromiso: `C-${i + 1}` } })));
  assert.deepEqual(dos.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await api('POST', `/api/series/${p.id}/SN1/comprometer`, { token, body: { id_compromiso: 'C-9' } })).status, 409);

  const v = await api('POST', `/api/series/${p.id}/SN1/vender`, { token, body: { documento: 'VTA-1', cliente: 'Cliente X', fecha_fin_garantia: '2027-10-30' } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  assert.equal(await estado(p, 'SN1'), 'vendida');
  assert.equal(await saldo(p.id), 2); // la venta egresó la unidad
  const h = (await api('GET', `/api/series/${p.id}/SN1/historial`, { token })).json;
  assert.deepEqual(h.eventos.map((e) => e.evento), ['ingreso', 'compromiso', 'venta']);
  assert.equal(h.eventos[0].detalle.proveedor, 'Mayorista SA');
  assert.equal(h.eventos[2].detalle.fecha_fin_garantia, '2027-10-30');
  assert.equal(h.serie.fecha_fin_garantia.toString().slice(0, 4) >= '2027', true);
  await assert.rejects(pool.query('UPDATE serie_historial SET evento = "baja" WHERE serie_id = ?', [h.serie.id]), /inmodificable/);
  await assert.rejects(pool.query('DELETE FROM serie_historial WHERE serie_id = ?', [h.serie.id]), /inmodificable/);

  // Liberar el compromiso devuelve la serie a Disponible.
  assert.equal((await api('POST', `/api/series/${p.id}/SN2/liberar`, { token })).status, 200);
  assert.equal(await estado(p, 'SN2'), 'disponible');
});

test('Stock.RN79/RF41: la devolución sin falla deja la serie Disponible y con falla la da de Baja con motivo', async () => {
  const p = await serializado('Monitor');
  await api('POST', `/api/series/${p.id}/ingresos`, { token, body: { series: ['M1', 'M2'], costo_unitario: 300 } });
  for (const s of ['M1', 'M2']) {
    await api('POST', `/api/series/${p.id}/${s}/comprometer`, { token, body: { id_compromiso: `C-${s}` } });
    await api('POST', `/api/series/${p.id}/${s}/vender`, { token, body: { documento: `V-${s}` } });
  }
  assert.equal(await saldo(p.id), 0);
  assert.equal((await api('POST', `/api/series/${p.id}/M1/devolver`, { token, body: { condicion: 'sin_falla' } })).json.estado, 'disponible');
  assert.equal(await saldo(p.id), 1);
  assert.equal((await api('POST', `/api/series/${p.id}/M2/devolver`, { token, body: { condicion: 'con_falla' } })).status, 400); // sin motivo
  assert.equal((await api('POST', `/api/series/${p.id}/M2/devolver`, { token, body: { condicion: 'con_falla', motivo: 'No enciende' } })).json.estado, 'baja');
  assert.equal(await saldo(p.id), 1); // entra y se da de baja
  assert.equal((await api('POST', `/api/series/${p.id}/M1/devolver`, { token, body: { condicion: 'sin_falla' } })).status, 409); // ya no está vendida
  const h = (await api('GET', `/api/series/${p.id}/M2/historial`, { token })).json;
  assert.equal(h.serie.motivo_baja, 'No enciende');
  assert.equal(h.eventos.at(-1).evento, 'devolucion');
});

test('Stock.RF37: baja con motivo, la comprometida y la vendida no se tocan; la conversión pasa las disponibles a saldo por cantidad', async () => {
  const p = await serializado('Teclado');
  await api('POST', `/api/series/${p.id}/ingresos`, { token, body: { series: ['T1', 'T2', 'T3', 'T4'], costo_unitario: 20 } });
  await api('POST', `/api/series/${p.id}/T1/comprometer`, { token, body: { id_compromiso: 'C-T1' } });
  await api('POST', `/api/series/${p.id}/T2/comprometer`, { token, body: { id_compromiso: 'C-T2' } });
  await api('POST', `/api/series/${p.id}/T2/vender`, { token, body: {} });
  assert.equal((await api('POST', `/api/series/${p.id}/baja`, { token, body: { series: ['T3'] } })).status, 400); // sin motivo
  assert.equal((await api('POST', `/api/series/${p.id}/baja`, { token, body: { series: ['T1'], motivo: 'Rotura' } })).status, 409); // comprometida
  assert.equal((await api('POST', `/api/series/${p.id}/baja`, { token, body: { series: ['T2'], motivo: 'Rotura' } })).status, 409); // vendida
  assert.equal((await api('POST', `/api/series/${p.id}/baja`, { token, body: { series: ['T3'], motivo: 'Rotura en depósito' } })).status, 200);
  assert.equal(await estado(p, 'T3'), 'baja');
  assert.equal(await saldo(p.id), 2); // 4 ingresadas − 1 vendida − 1 baja
  assert.equal((await api('POST', `/api/series/${p.id}/convertir`, { token })).status, 409); // T1 comprometida
  await api('POST', `/api/series/${p.id}/T1/liberar`, { token });
  const conv = await api('POST', `/api/series/${p.id}/convertir`, { token });
  assert.equal(conv.status, 200, JSON.stringify(conv.json));
  assert.equal(conv.json.convertidas, 2); // T1 y T4
  assert.equal(await saldo(p.id), 2);     // el saldo por cantidad no cambia
  assert.equal(await estado(p, 'T4'), 'convertida');
  const h = (await api('GET', `/api/series/${p.id}/T4/historial`, { token })).json;
  assert.equal(h.eventos.at(-1).evento, 'conversion'); // el historial se conserva
  const vig = (await api('GET', '/api/series/vigentes', { token })).json;
  assert.equal(vig.find((x) => x.producto_id === p.id).vendidas, 1); // la vendida sigue vigente por su garantía
});

test('Stock.RF14: el conteo por serie informa faltantes y sobrantes del depósito', async () => {
  const p = await serializado('Mouse');
  const dep = (await api('GET', '/api/depositos', { token })).json.find((d) => d.predeterminado);
  await api('POST', `/api/series/${p.id}/ingresos`, { token, body: { series: ['R1', 'R2', 'R3'] } });
  const c = await api('POST', `/api/series/${p.id}/conteo`, { token, body: { deposito_id: dep.id, series: ['R1', 'R3', 'R9'] } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.deepEqual([c.json.faltantes, c.json.sobrantes], [['R2'], ['R9']]);
});
