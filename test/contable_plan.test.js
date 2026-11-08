const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const Config = require('../src/contable/configService');
const { fechaLocal } = require('../src/contable/comun');

let api, pool, cerrar, adm, gerente, cajero;
const hoy = fechaLocal();
const manana = fechaLocal(new Date(Date.now() + 86400000));
const ayer = fechaLocal(new Date(Date.now() - 86400000));

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  cajero = await usuario(api, pool, 'cami', 'cajero');
  await api('POST', '/api/modulos/stock/instalar', { token: adm.token });
  // Ventas ya opera: una venta anterior al alta de Contable no se reconstruye.
  const p = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Cafe', precio: 500, stock: 10 } })).json;
  globalThis.__prod = p;
});
after(async () => { await cerrar(); });

test('Contable.RF13: se instala con Ventas operando y exige permiso', async () => {
  assert.equal((await api('GET', '/api/contable/config', { token: gerente.token })).status, 409); // sin instalar
  assert.equal((await api('POST', '/api/modulos/contable/instalar', { token: adm.token })).status, 200);
  const e = (await api('GET', '/api/contable/config', { token: gerente.token })).json;
  assert.equal(e.iniciada, false);
  assert.equal(e.propuesta_inicio, hoy);
  assert.equal((await api('GET', '/api/contable/config', { token: cajero.token })).status, 403);
});

test('Contable.RN18/EX12: la contabilidad no empieza antes de hoy', async () => {
  const r = await api('POST', '/api/contable/config/iniciar', { token: gerente.token, body: { fecha_inicio: ayer, perfil: 'cafeteria' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'INICIO_ANTERIOR');
  assert.equal((await api('POST', '/api/contable/config/iniciar', { token: gerente.token, body: { fecha_inicio: 'mañana', perfil: 'cafeteria' } })).status, 400);
  assert.equal((await api('POST', '/api/contable/config/iniciar', { token: gerente.token, body: { fecha_inicio: hoy, perfil: 'otro' } })).status, 400);
});

test('Contable.EX11: un movimiento anterior al inicio queda en «Movimientos anteriores al inicio» y no genera asiento', async () => {
  // Antes de iniciar, todo evento va a la lista de previos.
  const M = require('../src/mensajeria/servicio');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await M.publicar(conn, { origen: 'ventas', destino: 'contable', tipo: 'venta_confirmada', docTipo: 'venta', docIdGlobal: 'T-VENTA-PREVIA', docVersion: 1, secuencia: 1, contenido: { venta_id_global: 'T-VENTA-PREVIA', fecha: ayer, total: 500 } });
    await conn.commit();
  } finally { conn.release(); }
  M.despertar();
  await esperarMensajes(pool);
  const previos = (await api('GET', '/api/contable/movimientos-previos', { token: gerente.token })).json;
  assert.equal(previos.length, 1);
  assert.equal(previos[0].id_documento, 'T-VENTA-PREVIA');
  assert.equal((await pool.query('SELECT COUNT(*) n FROM con_asientos'))[0][0].n, 0);
});

test('Contable.RF01: al iniciar se arma el primer ejercicio, sus períodos y el plan del perfil según lo instalado', async () => {
  const r = await api('POST', '/api/contable/config/iniciar', { token: gerente.token, body: { fecha_inicio: manana, perfil: 'cafeteria' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.fecha_inicio, manana);
  const [ej] = (await pool.query('SELECT * FROM con_ejercicios'))[0];
  assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM con_periodos WHERE ejercicio_id = ?', [ej.id]))[0][0].n) >= 1, true);
  const cuentas = (await api('GET', '/api/contable/cuentas', { token: gerente.token })).json;
  const claves = new Set(cuentas.map((c) => c.clave));
  assert.ok(claves.has('iva_debito') && claves.has('caja') && claves.has('costo_insumos')); // Stock instalado
  assert.ok(!claves.has('productos_elaborados')); // perfil sin producción
  assert.ok(!claves.has('plataformas_a_cobrar') && !claves.has('gift_cards')); // funciones apagadas
  assert.ok(!claves.has('ventas_mayorista'));
  // Solo los rubros con hijas no son imputables.
  assert.equal(cuentas.find((c) => c.codigo === '1').imputable, false);
  assert.equal(cuentas.find((c) => c.clave === 'caja').imputable, true);
});

test('Contable.EX12: la fecha de inicio se corrige antes del asiento de apertura y queda fija después', async () => {
  const otra = fechaLocal(new Date(Date.now() + 3 * 86400000));
  const r = await api('POST', '/api/contable/config/iniciar', { token: gerente.token, body: { fecha_inicio: otra, perfil: 'cafeteria' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.fecha_inicio, otra);
  await pool.query('UPDATE con_config SET asiento_apertura_id = 1 WHERE id = 1');
  const r2 = await api('POST', '/api/contable/config/iniciar', { token: gerente.token, body: { fecha_inicio: manana, perfil: 'cafeteria' } });
  assert.equal(r2.status, 409);
  assert.equal(r2.json.codigo, 'INICIO_FIJO');
  await pool.query('UPDATE con_config SET asiento_apertura_id = NULL WHERE id = 1');
});

test('Contable.RN03/RN09: cuentas jerárquicas, solo las imputables reciben movimientos y las que tienen movimientos no se eliminan', async () => {
  const h = { token: gerente.token };
  const cuentas = (await api('GET', '/api/contable/cuentas', h)).json;
  const caja = cuentas.find((c) => c.clave === 'caja');
  const activoCorriente = cuentas.find((c) => c.codigo === '1.1');
  // Una imputable no puede ser padre.
  const malo = await api('POST', '/api/contable/cuentas', { ...h, body: { codigo: '1.1.01.1', nombre: 'Sub', tipo: 'activo', padre_id: caja.id } });
  assert.equal(malo.status, 409);
  assert.equal(malo.json.codigo, 'PADRE_IMPUTABLE');
  const ok = await api('POST', '/api/contable/cuentas', { ...h, body: { codigo: '1.1.20', nombre: 'Valores a depositar', tipo: 'activo', padre_id: activoCorriente.id } });
  assert.equal(ok.status, 201);
  assert.equal((await api('POST', '/api/contable/cuentas', { ...h, body: { codigo: '1.1.20', nombre: 'Repetida', tipo: 'activo', padre_id: activoCorriente.id } })).status, 409);
  assert.equal((await api('POST', '/api/contable/cuentas', { ...h, body: { codigo: '1.1.21', nombre: 'Mal tipo', tipo: 'pasivo', padre_id: activoCorriente.id } })).status, 409);
  // Sin movimientos se elimina; con movimientos solo se desactiva y no cambia de tipo.
  assert.equal((await api('DELETE', `/api/contable/cuentas/${ok.json.id}`, h)).status, 200);
  const [ej] = (await pool.query('SELECT id FROM con_ejercicios'))[0];
  const [per] = (await pool.query('SELECT id FROM con_periodos WHERE ejercicio_id = ? LIMIT 1', [ej.id]))[0];
  const [a] = await pool.query("INSERT INTO con_asientos (numero, ejercicio_id, periodo_id, fecha, tipo, leyenda, creado_ms) VALUES (1, ?, ?, ?, 'manual', 'x', 0)", [ej.id, per.id, manana]);
  await pool.query('INSERT INTO con_asiento_lineas (asiento_id, cuenta_id, debe) VALUES (?, ?, 10)', [a.insertId, caja.id]);
  const del = await api('DELETE', `/api/contable/cuentas/${caja.id}`, h);
  assert.equal(del.status, 409);
  assert.equal(del.json.codigo, 'CON_MOVIMIENTOS');
  assert.equal((await api('PUT', `/api/contable/cuentas/${caja.id}`, { ...h, body: { tipo: 'pasivo' } })).status, 409);
  assert.equal((await api('POST', `/api/contable/cuentas/${caja.id}/estado`, { ...h, body: { activa: false } })).status, 200);
  await api('POST', `/api/contable/cuentas/${caja.id}/estado`, { ...h, body: { activa: true } });
  await pool.query('DELETE FROM con_asiento_lineas'); await pool.query('DELETE FROM con_asientos');
});

test('Contable.EX10: la importación del plan es completa o no se aplica, y se informan las filas con error', async () => {
  const h = { token: gerente.token };
  const antes = (await api('GET', '/api/contable/cuentas', h)).json.length;
  const mala = await api('POST', '/api/contable/cuentas/importar', { ...h, body: { cuentas: [
    { codigo: '1', nombre: 'Activo', tipo: 'activo', imputable: 0 },
    { codigo: '1.1', nombre: 'Caja', tipo: 'activo', padre: '1', imputable: 1 },
    { codigo: '1.1', nombre: 'Repetida', tipo: 'activo', padre: '1', imputable: 1 },
    { codigo: '2.1', nombre: 'Huerfana', tipo: 'pasivo', padre: '2', imputable: 1 },
  ] } });
  assert.equal(mala.status, 400);
  assert.equal(mala.json.codigo, 'PLAN_INVALIDO');
  assert.deepEqual(mala.json.errores.map((e) => e.fila), [3, 4]);
  assert.equal((await api('GET', '/api/contable/cuentas', h)).json.length, antes); // nada cambió
  const buena = await api('POST', '/api/contable/cuentas/importar', { ...h, body: { cuentas: [
    { codigo: '1', nombre: 'Activo', tipo: 'activo', imputable: 0 },
    { codigo: '1.1', nombre: 'Caja', tipo: 'activo', padre: '1', imputable: 1, clave: 'caja' },
    { codigo: '4', nombre: 'Ingresos', tipo: 'resultado_positivo', imputable: 1 },
  ] } });
  assert.equal(buena.status, 200);
  assert.equal((await api('GET', '/api/contable/cuentas', h)).json.length, 3);
  const exp = (await api('GET', '/api/contable/cuentas/exportar', h)).json;
  assert.deepEqual(exp.map((c) => c.codigo), ['1', '1.1', '4']);
  assert.equal(exp[1].padre, '1');
});

test('Contable.RF13: el momento del costo no fiscal y la retención se configuran con permiso', async () => {
  const r = await api('PUT', '/api/contable/config', { token: gerente.token, body: { momento_costo_no_fiscal: 'regularizar', retencion_anios: 12 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.momento_costo_no_fiscal, 'regularizar');
  assert.equal((await api('PUT', '/api/contable/config', { token: gerente.token, body: { momento_costo_no_fiscal: 'ya' } })).status, 400);
  assert.equal((await api('PUT', '/api/contable/config', { token: cajero.token, body: { retencion_anios: 3 } })).status, 403);
  assert.equal((await Config.config()).retencion_anios, 12);
});
