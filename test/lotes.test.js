const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');

let api, pool, cerrar, token, principal, n = 0, k = 0;
const dia = (delta) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
  principal = (await api('GET', '/api/depositos', { token })).json.find((d) => d.predeterminado);
});
after(async () => { await cerrar(); });

// Un producto de catálogo que controla lote.
const conLote = async (nombre, extra = {}) => {
  const p = (await api('POST', '/api/productos', { token, body: { nombre, precio: 100 } })).json;
  assert.equal((await api('PUT', `/api/lotes/configuracion/producto/${p.id}`, { token, body: { controla_lote: true, ...extra } })).status, 200);
  return p;
};
const ingreso = (p, cantidad, lote, extra = {}) => api('POST', '/api/stock/ingresos', { token, body: { motivo: 'compra', lineas: [{ item: { tipo: 'producto', id: p.id }, cantidad, costo_unitario: 10, lote, ...extra }] } });
const lotes = async (p) => (await api('GET', `/api/lotes?item_tipo=producto&item_id=${p.id}`, { token })).json;
const saldoLote = async (p, codigo) => (await lotes(p)).filter((l) => l.codigo === codigo).reduce((a, l) => a + l.saldo, 0);
const vender = async (p, cantidad, lote_indicado) => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: p.id, cantidad, lote_indicado }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-lote-${++k}-abcdef` }, body: { metodo_pago: 'efectivo' } });
  if (r.status === 200) { await esperarMensajes(pool); await esperarMensajes(pool); }
  return r;
};
const movsVenta = async (p) => (await pool.query("SELECT m.cantidad, m.origen_lote, m.lote_indicado, l.codigo FROM stock_movimientos m LEFT JOIN lotes l ON l.id = m.lote_id WHERE m.producto_id = ? AND m.tipo = 'venta' ORDER BY m.id", [p.id]))[0];

test('Stock.RF20: un ítem con control de lote exige código y vencimiento en el ingreso; el lote se crea o se reutiliza', async () => {
  const p = await conLote('Yogur L1');
  assert.equal((await ingreso(p, 10)).status, 400); // falta el lote
  assert.equal((await ingreso(p, 10, { codigo: 'A1' })).status, 400); // falta el vencimiento
  assert.equal((await ingreso(p, 10, { codigo: 'A1', fecha_vencimiento: dia(10) })).status, 201);
  assert.equal((await ingreso(p, 5, { codigo: 'A1', fecha_vencimiento: dia(10) })).status, 201); // mismo lote: suma
  assert.equal((await ingreso(p, 5, { codigo: 'A1', fecha_vencimiento: dia(20) })).status, 409); // el lote ya existe con otro vencimiento
  assert.deepEqual((await lotes(p)).map((l) => [l.codigo, l.saldo]), [['A1', 15]]);
  const sinControl = (await api('POST', '/api/productos', { token, body: { nombre: 'Común L1', precio: 1 } })).json;
  assert.equal((await ingreso(sinControl, 3, { codigo: 'IGNORADO' })).status, 201); // un ítem sin control ignora el lote
  assert.deepEqual(await lotes(sinControl), []);
});

test('Stock.RF20: el vencimiento de un elaborado se calcula con su vida útil', async () => {
  const p = await conLote('Torta L2', { vida_util_dias: 4 });
  assert.equal((await ingreso(p, 6, { codigo: 'T1', fecha_elaboracion: dia(-1) })).status, 201);
  assert.equal((await lotes(p))[0].fecha_vencimiento.slice(0, 10), dia(3)); // ayer + 4 días
  assert.equal((await api('PUT', `/api/lotes/configuracion/producto/${p.id}`, { token, body: { vida_util_dias: -3 } })).status, 400);
  assert.equal((await api('PUT', `/api/lotes/configuracion/producto/${p.id}`, { token, body: { vencido_politica: 'nada' } })).status, 400);
  assert.equal((await api('PUT', '/api/lotes/configuracion/raro/1', { token, body: {} })).status, 400);
});

test('Stock.RN06: FEFO: la venta descuenta primero el lote que vence antes y queda registrado como "asignado por FEFO"', async () => {
  const p = await conLote('Queso L3');
  await ingreso(p, 5, { codigo: 'TARDE', fecha_vencimiento: dia(30) });
  await ingreso(p, 5, { codigo: 'PRONTO', fecha_vencimiento: dia(5) });
  await ingreso(p, 5, { codigo: 'SIN-VENC-NO', fecha_vencimiento: dia(15) });
  assert.equal((await vender(p, 7)).status, 200);
  assert.deepEqual((await movsVenta(p)).map((m) => [m.codigo, Number(m.cantidad), m.origen_lote]), [['PRONTO', -5, 'fefo'], ['SIN-VENC-NO', -2, 'fefo']]);
  assert.deepEqual([await saldoLote(p, 'PRONTO'), await saldoLote(p, 'SIN-VENC-NO'), await saldoLote(p, 'TARDE')], [0, 3, 5]);
});

test('Stock.RN73: el lote indicado en la línea se usa si está disponible y queda como "indicado"', async () => {
  const p = await conLote('Salame L4');
  await ingreso(p, 10, { codigo: 'PRIMERO', fecha_vencimiento: dia(5) });
  await ingreso(p, 10, { codigo: 'ELEGIDO', fecha_vencimiento: dia(40) });
  assert.equal((await vender(p, 4, 'ELEGIDO')).status, 200);
  const m = (await movsVenta(p))[0];
  assert.deepEqual([m.codigo, Number(m.cantidad), m.origen_lote, m.lote_indicado], ['ELEGIDO', -4, 'indicado', 'ELEGIDO']);
  assert.equal(await saldoLote(p, 'PRIMERO'), 10); // FEFO no tocó el otro
  // La confirmación informa el lote real a Ventas.
  const v = (await pool.query("SELECT detalle FROM lineas_costo ORDER BY id DESC LIMIT 1"))[0][0];
  assert.deepEqual(JSON.parse(v.detalle)[0].lotes, [{ lote: 'ELEGIDO', cantidad: 4, origen: 'indicado' }]);
});

test('Stock.EX57: un lote indicado no disponible se rechaza en el compromiso; si deja de estarlo antes del descuento, se asigna por FEFO con alerta', async () => {
  const p = await conLote('Jamón L5');
  await api('PUT', `/api/stock/configuracion/producto/${p.id}`, { token, body: { permite_negativo: false } });
  await ingreso(p, 10, { codigo: 'BUENO', fecha_vencimiento: dia(20) });
  await ingreso(p, 10, { codigo: 'VIEJO', fecha_vencimiento: dia(-2) });
  const bloqueado = (await lotes(p)).find((l) => l.codigo === 'BUENO');
  for (const [codigo, motivo] of [['NOEXISTE', /inexistente/], ['VIEJO', /vencido/]]) {
    const r = await vender(p, 1, codigo);
    assert.equal(r.status, 409, codigo);
    assert.equal(r.json.codigo, 'LOTE_NO_DISPONIBLE');
    assert.match(r.json.detalle[0].motivo, motivo);
  }
  assert.equal((await api('PUT', `/api/lotes/${bloqueado.id}/bloqueo`, { token, body: { bloqueado: true } })).status, 400); // sin motivo
  assert.equal((await api('PUT', `/api/lotes/${bloqueado.id}/bloqueo`, { token, body: { bloqueado: true, motivo: 'retiro por contaminación' } })).status, 200);
  assert.match((await vender(p, 1, 'BUENO')).json.detalle[0].motivo, /bloqueado/);
  await api('PUT', `/api/lotes/${bloqueado.id}/bloqueo`, { token, body: { bloqueado: false } });

  // El lote deja de estar disponible después del compromiso, antes del descuento: la venta no se revierte.
  const Desc = require('../src/stock/descuentoReceptor');
  assert.ok(Desc || true);
  const M = require('../src/mensajeria/servicio');
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  await M.publicar(conn, { origen: 'ventas', destino: 'stock', tipo: 'descuento_stock', docTipo: 'venta', docIdGlobal: 'TST01-LOTEFEFO0000000000000001', contenido: { doc_tipo: 'venta', items: [{ linea: 0, producto_id: p.id, cantidad: 3, lote_indicado: 'VIEJO' }] } });
  await conn.commit();
  conn.release();
  await esperarMensajes(pool);
  const m = (await pool.query("SELECT l.codigo, m.origen_lote, m.lote_indicado FROM stock_movimientos m JOIN lotes l ON l.id = m.lote_id WHERE m.documento = 'TST01-LOTEFEFO0000000000000001'"))[0];
  assert.deepEqual(m.map((x) => [x.codigo, x.origen_lote, x.lote_indicado]), [['BUENO', 'fefo', 'VIEJO']]);
  assert.equal((await pool.query("SELECT COUNT(*) n FROM notificaciones WHERE tipo = 'lote_indicado_no_respetado'"))[0][0].n, 1);
});

test('Stock.RN06: un lote vencido no se usa si el ítem lo bloquea; si solo advierte, sí', async () => {
  const estricto = await conLote('Leche L6'); // vencido_politica: bloquear (por defecto)
  await ingreso(estricto, 5, { codigo: 'VENCIDA', fecha_vencimiento: dia(-1) });
  await ingreso(estricto, 5, { codigo: 'VIGENTE', fecha_vencimiento: dia(9) });
  await vender(estricto, 3);
  assert.deepEqual((await movsVenta(estricto)).map((m) => m.codigo), ['VIGENTE']); // saltea la vencida aunque vence antes

  const laxo = await conLote('Pan L6', { vencido_politica: 'advertir' });
  await ingreso(laxo, 5, { codigo: 'VENCIDO', fecha_vencimiento: dia(-1) });
  await vender(laxo, 2);
  assert.deepEqual((await movsVenta(laxo)).map((m) => m.codigo), ['VENCIDO']);
});

test('Stock.RF13/RF12: la transferencia conserva el lote; el egreso manual usa FEFO o el lote que se nombra', async () => {
  const p = await conLote('Manteca L7');
  const cocina = (await api('POST', '/api/depositos', { token, body: { nombre: 'Cocina L7' } })).json;
  await ingreso(p, 6, { codigo: 'M1', fecha_vencimiento: dia(8) });
  await ingreso(p, 6, { codigo: 'M2', fecha_vencimiento: dia(3) });
  const tr = await api('POST', '/api/stock/transferencias', { token, body: { origen_id: principal.id, destino_id: cocina.id, lineas: [{ item: { tipo: 'producto', id: p.id }, cantidad: 8 }] } });
  assert.equal(tr.status, 201);
  const enCocina = (await lotes(p)).filter((l) => l.deposito_id === cocina.id).map((l) => [l.codigo, l.saldo]).sort();
  assert.deepEqual(enCocina, [['M1', 2], ['M2', 6]]); // M2 vence antes: salió completo primero
  const e = await api('POST', '/api/stock/egresos', { token, body: { motivo: 'consumo_interno', lineas: [{ item: { tipo: 'producto', id: p.id }, cantidad: 1, lote: 'M1' }] } });
  assert.equal(e.status, 201);
  assert.equal((await api('POST', '/api/stock/egresos', { token, body: { motivo: 'consumo_interno', lineas: [{ item: { tipo: 'producto', id: p.id }, cantidad: 1, lote: 'NO' }] } })).status, 404);
});

test('Stock.RN74/EX56: la devolución reingresa al mismo lote; si el lote está bloqueado, solo se admite la merma', async () => {
  const p = await conLote('Dulce L8');
  await ingreso(p, 10, { codigo: 'D1', fecha_vencimiento: dia(30) });
  const v1 = await vender(p, 4);
  const dev = (id, body) => api('POST', '/api/devoluciones', { token, headers: { 'X-ID-Solicitud': `devol-lote-${++k}-abcdef` }, body: { venta_id_global: id, motivo: 'prueba', ...body } });
  assert.equal((await dev(v1.json.venta_id_global, { items: [{ linea: 0, cantidad: 2 }] })).status, 201);
  await esperarMensajes(pool);
  assert.equal(await saldoLote(p, 'D1'), 8); // 10 − 4 + 2, en el mismo lote
  const d = (await pool.query("SELECT l.codigo FROM stock_movimientos m JOIN lotes l ON l.id = m.lote_id WHERE m.producto_id = ? AND m.tipo = 'devolucion'", [p.id]))[0];
  assert.deepEqual(d.map((x) => x.codigo), ['D1']);

  const lote = (await lotes(p))[0];
  await api('PUT', `/api/lotes/${lote.id}/bloqueo`, { token, body: { bloqueado: true, motivo: 'retiro' } });
  assert.equal((await dev(v1.json.venta_id_global, { items: [{ linea: 0, cantidad: 2 }] })).status, 201); // pide reingresar
  await esperarMensajes(pool);
  assert.equal(await saldoLote(p, 'D1'), 8); // no vuelve a stock: el ingreso se compensa con el egreso "Devolución a merma"
  const merma = (await pool.query("SELECT motivo FROM stock_movimientos WHERE producto_id = ? AND motivo = 'devolucion_merma'", [p.id]))[0];
  assert.equal(merma.length, 1);
});

test('Stock.RF20: la merma de fin de día propone los lotes vencidos o que vencen hoy y se confirma con el usuario', async () => {
  const p = await conLote('Medialuna L9');
  await ingreso(p, 6, { codigo: 'HOY', fecha_vencimiento: dia(0) });
  await ingreso(p, 4, { codigo: 'AYER', fecha_vencimiento: dia(-1) });
  await ingreso(p, 9, { codigo: 'MAÑANA', fecha_vencimiento: dia(1) });
  const propuesta = (await api('GET', '/api/lotes/merma-fin-dia', { token })).json.filter((x) => x.producto_id === p.id);
  assert.deepEqual(propuesta.map((x) => [x.codigo, x.saldo, x.vencido]).sort(), [['AYER', 4, true], ['HOY', 6, false]]);
  const conf = await api('POST', '/api/lotes/merma-fin-dia', { token, body: { lotes: propuesta.filter((x) => x.codigo === 'HOY').map((x) => x.id) } });
  assert.equal(conf.status, 201);
  assert.deepEqual([await saldoLote(p, 'HOY'), await saldoLote(p, 'AYER'), await saldoLote(p, 'MAÑANA')], [0, 4, 9]);
  const mermas = (await api('GET', '/api/stock/mermas', { token })).json.find((m) => m.motivo === 'merma_fin_dia');
  assert.ok(mermas.cantidad >= 6);
  await api('POST', '/api/lotes/merma-fin-dia', { token, body: {} }); // el resto, sin elegir
  assert.equal(await saldoLote(p, 'AYER'), 0);
});

test('Stock.RF16/RF20: avisa los lotes vencidos o por vencer y la alerta se resuelve al agotarse; el informe los lista', async () => {
  const p = await conLote('Crema L10');
  await ingreso(p, 5, { codigo: 'C1', fecha_vencimiento: dia(2) });
  await ingreso(p, 5, { codigo: 'C2', fecha_vencimiento: dia(60) });
  const informe = (await api('GET', '/api/lotes/vencimientos?dias=3', { token })).json.filter((x) => x.producto_id === p.id);
  assert.deepEqual(informe.map((x) => x.codigo), ['C1']);
  await api('POST', '/api/inventario/alertas/evaluar', { token });
  const abiertas = (await pool.query("SELECT mensaje FROM notificaciones WHERE tipo = 'lote_por_vencer' AND estado <> 'resuelta'"))[0].filter((a) => a.mensaje.includes('Crema L10'));
  assert.equal(abiertas.length, 1);
  await api('POST', '/api/stock/egresos', { token, body: { motivo: 'consumo_interno', lineas: [{ item: { tipo: 'producto', id: p.id }, cantidad: 5, lote: 'C1' }] } });
  await api('POST', '/api/inventario/alertas/evaluar', { token });
  assert.equal((await pool.query("SELECT mensaje FROM notificaciones WHERE tipo = 'lote_por_vencer' AND estado <> 'resuelta'"))[0].filter((a) => a.mensaje.includes('Crema L10')).length, 0);
});

test('Stock.RF20: sin la función STK-LOTES los ítems se manejan por cantidad, sin FEFO, y los lotes ya cargados se conservan', async () => {
  const p = await conLote('Helado L11');
  await ingreso(p, 5, { codigo: 'H1', fecha_vencimiento: dia(10) });
  // (La desactivación por la API exige autorización sanitaria y confirmar la cascada: eso se prueba en funciones.test.js.)
  const F = require('../src/funciones/servicio');
  const original = F.estaActiva;
  F.estaActiva = async (id, db) => (id === 'STK-LOTES' ? false : original(id, db));
  try {
    assert.equal((await ingreso(p, 5)).status, 201); // sin lote: ya no se exige
    assert.equal((await vender(p, 2, 'H1')).status, 200); // el lote indicado se ignora
    const m = (await movsVenta(p))[0];
    assert.deepEqual([m.codigo, m.origen_lote], [null, null]);
    assert.deepEqual((await lotes(p)).map((l) => [l.codigo, l.saldo]), [['H1', 5]]); // el lote ya registrado sigue ahí
  } finally {
    F.estaActiva = original;
  }
});
