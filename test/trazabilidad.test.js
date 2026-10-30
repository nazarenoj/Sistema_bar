const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');

let api, pool, cerrar, token, n = 0, k = 0;
const dia = (delta) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

const vender = async (p, cantidad, lote_indicado) => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: p.id, cantidad, lote_indicado }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-traza-${++k}-abcdef` }, body: { metodo_pago: 'efectivo' } });
  if (r.status === 200) { await esperarMensajes(pool); await esperarMensajes(pool); }
  return r;
};
const lote = async (tipo, id, codigo) => (await api('GET', `/api/lotes?item_tipo=${tipo}&item_id=${id}`, { token })).json.find((l) => l.codigo === codigo);

test('Stock.RF21/RN73/RN83: trazabilidad hacia arriba y hacia abajo, retiro con bloqueo en cascada, aviso y recupero', async () => {
  // Insumo con lote y proveedor → elaborado de producción previa con lote → ventas.
  const harina = (await api('POST', '/api/insumos', { token, body: { nombre: 'Harina T', unidad: 'kg' } })).json;
  assert.equal((await api('PUT', `/api/lotes/configuracion/insumo/${harina.id}`, { token, body: { controla_lote: true } })).status, 200);
  const ing = await api('POST', '/api/stock/ingresos', { token, body: { motivo: 'compra', proveedor: 'Molino SA', lineas: [{ item: { tipo: 'insumo', id: harina.id }, cantidad: 50, costo_unitario: 10, lote: { codigo: 'H1', fecha_vencimiento: dia(60) } }] } });
  assert.equal(ing.status, 201, JSON.stringify(ing.json));
  const masa = (await api('POST', '/api/productos', { token, body: { nombre: 'Masa T', precio: 100, tipo: 'elaborado' } })).json;
  await api('PUT', `/api/recetas/${masa.id}`, { token, body: { lineas: [{ insumo_id: harina.id, cantidad_consumida: 0.5 }] } });
  await api('PUT', `/api/produccion/ficha/${masa.id}`, { token, body: { modo_produccion: 'previa' } });
  assert.equal((await api('PUT', `/api/lotes/configuracion/producto/${masa.id}`, { token, body: { controla_lote: true, vida_util_dias: 5 } })).status, 200);
  const o = (await api('POST', '/api/produccion/ordenes', { token, body: { producto_id: masa.id, cantidad: 10 } })).json;
  const c = await api('POST', `/api/produccion/ordenes/${o.id}/confirmar`, { token, body: { lote_codigo: 'M1' } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const lH = await lote('insumo', harina.id, 'H1');
  const lM = await lote('producto', masa.id, 'M1');
  assert.ok(lH && lM);

  assert.equal((await vender(masa, 2)).status, 200);         // lote asignado por FEFO
  assert.equal((await vender(masa, 1, 'M1')).status, 200);   // lote indicado

  const asc = (await api('GET', `/api/trazabilidad/lotes/${lM.id}/ascendente`, { token })).json;
  assert.equal(asc.insumos[0].lote.codigo, 'H1');
  assert.deepEqual([asc.insumos[0].origen.tipo, asc.insumos[0].origen.proveedor], ['ingreso', 'Molino SA']);
  assert.deepEqual(asc.incompleto, []);

  const desc = (await api('GET', `/api/trazabilidad/lotes/${lH.id}/descendente`, { token })).json;
  assert.equal(desc.elaborados[0].lote.codigo, 'M1');
  assert.deepEqual(desc.elaborados[0].ventas.map((v) => [v.cantidad, v.no_confirmado]), [[2, true], [1, false]]);

  // Retiro del insumo con sus derivados: bloquea H1 y M1 y lista las ventas alcanzadas.
  assert.equal((await api('POST', `/api/trazabilidad/lotes/${lH.id}/retirar`, { token, body: { incluir_derivados: true } })).status, 400); // sin motivo
  const ret = await api('POST', `/api/trazabilidad/lotes/${lH.id}/retirar`, { token, body: { motivo: 'Aviso del proveedor', incluir_derivados: true } });
  assert.equal(ret.status, 201, JSON.stringify(ret.json));
  assert.equal(ret.json.lineas.length, 2);
  assert.deepEqual(ret.json.lineas.map((l) => l.no_confirmado), [1, 0]);
  assert.deepEqual(ret.json.lotes.map((l) => l.bloqueado), [1, 1]);
  const m1 = ret.json.lotes.find((l) => l.codigo === 'M1');
  assert.deepEqual([m1.en_stock, m1.vendidas, m1.consumidas], [7, 3, 0]);
  assert.equal((await api('POST', `/api/trazabilidad/lotes/${lM.id}/retirar`, { token, body: { motivo: 'otra vez' } })).status, 409);
  assert.match((await vender(masa, 1, 'M1')).json.detalle[0].motivo, /bloqueado/); // el lote bloqueado no se vende

  // Aviso y recupero (EX61: no más de lo alcanzado).
  const [l1, l2] = ret.json.lineas;
  assert.equal((await api('POST', `/api/trazabilidad/retiros/lineas/${l1.id}/avisar`, { token })).status, 200);
  assert.equal((await api('POST', `/api/trazabilidad/retiros/lineas/${l1.id}/recuperar`, { token, body: { cantidad: 3 } })).status, 409);
  const rec = await api('POST', `/api/trazabilidad/retiros/lineas/${l2.id}/recuperar`, { token, body: { cantidad: 1 } });
  assert.equal(rec.status, 200, JSON.stringify(rec.json));
  const lineas = rec.json.lineas;
  assert.deepEqual(lineas.map((l) => l.estado_aviso), ['avisado', 'recuperado']);
  const [movs] = await pool.query("SELECT motivo FROM stock_movimientos WHERE documento = ? ORDER BY id", [ret.json.id_global]);
  assert.deepEqual(movs.map((m) => m.motivo), ['devolucion', 'devolucion_merma']); // el producto devuelto es merma del lote
  assert.equal((await api('GET', `/api/trazabilidad/retiros/${ret.json.id}?formato=csv`, { token })).status, 200);

  // Liberar desbloquea; después ya no se registran recuperos.
  assert.equal((await api('POST', `/api/trazabilidad/retiros/${ret.json.id}/liberar`, { token, body: {} })).status, 400);
  const lib = await api('POST', `/api/trazabilidad/retiros/${ret.json.id}/liberar`, { token, body: { motivo: 'Falsa alarma' } });
  assert.equal(lib.status, 200);
  assert.deepEqual(lib.json.lotes.map((l) => l.bloqueado), [0, 0]);
  assert.equal((await api('POST', `/api/trazabilidad/retiros/lineas/${l1.id}/recuperar`, { token, body: { cantidad: 1 } })).status, 409);
  assert.equal((await vender(masa, 1)).status, 200);
});

test('Stock.EX20: consumos sin lote cortan la cadena y la trazabilidad figura incompleta', async () => {
  const sal = (await api('POST', '/api/insumos', { token, body: { nombre: 'Sal T', unidad: 'kg' } })).json; // sin control de lote
  await api('POST', '/api/stock/ingresos', { token, body: { motivo: 'compra', lineas: [{ item: { tipo: 'insumo', id: sal.id }, cantidad: 10, costo_unitario: 1 }] } });
  const pan = (await api('POST', '/api/productos', { token, body: { nombre: 'Pan T', precio: 10, tipo: 'elaborado' } })).json;
  await api('PUT', `/api/recetas/${pan.id}`, { token, body: { lineas: [{ insumo_id: sal.id, cantidad_consumida: 0.1 }] } });
  await api('PUT', `/api/lotes/configuracion/producto/${pan.id}`, { token, body: { controla_lote: true, vida_util_dias: 2 } });
  const o = (await api('POST', '/api/produccion/ordenes', { token, body: { producto_id: pan.id, cantidad: 5 } })).json;
  assert.equal((await api('POST', `/api/produccion/ordenes/${o.id}/confirmar`, { token, body: { lote_codigo: 'P1' } })).status, 200);
  const l = await lote('producto', pan.id, 'P1');
  const asc = (await api('GET', `/api/trazabilidad/lotes/${l.id}/ascendente`, { token })).json;
  assert.equal(asc.insumos.length, 0);
  assert.equal(asc.incompleto.length, 1);
});
