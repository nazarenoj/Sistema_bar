const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token, tokenCajero, tokenGerente;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
  };
  token = await usuario('adm', 'administrador');
  tokenCajero = await usuario('cami', 'cajero');
  tokenGerente = await usuario('gero', 'gerente');
});
after(async () => { await cerrar(); });

const cuenta = (b, t = token) => api('POST', '/api/financiero/cuentas', { token: t, body: b });

test('Financiero: sin instalar el módulo no hay cajas; instalado, las rutas responden', async () => {
  assert.equal((await api('GET', '/api/financiero/cuentas', { token })).status, 409);
  const r = await api('POST', '/api/modulos/financiero/instalar', { token });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await api('GET', '/api/financiero/cuentas', { token })).status, 200);
});

test('Financiero.RF01/RN08: cajas y cuentas con sus datos y sus validaciones', async () => {
  assert.equal((await cuenta({ tipo: 'valija', nombre: 'X' })).status, 400); // tipo inexistente
  assert.equal((await cuenta({ tipo: 'caja_efectivo', nombre: '  ' })).status, 400);
  assert.equal((await cuenta({ tipo: 'caja_efectivo', nombre: 'Caja Barra', saldo_inicial: -10 })).status, 400); // RN08: caja sin saldo negativo
  assert.equal((await cuenta({ tipo: 'caja_efectivo', nombre: 'Caja Barra', limite_descubierto: 100 })).status, 400); // una caja no tiene descubierto
  assert.equal((await cuenta({ tipo: 'caja_efectivo', nombre: 'Caja Barra', moneda: 'USD' })).status, 409); // necesita FIN-MONEDA-EXT
  assert.equal((await cuenta({ tipo: 'pasarela', nombre: 'Pasarela MP' })).status, 409); // necesita Ventas Online
  assert.equal((await cuenta({ tipo: 'banco', nombre: 'Banco Nación', cbu_alias: 'x' })).status, 400); // alias inválido
  assert.equal((await cuenta({ tipo: 'caja_fuerte', nombre: 'Fuerte', cbu_alias: 'cafe.chepola' })).status, 400); // el CBU solo es de cuentas
  assert.equal((await cuenta({ tipo: 'caja_efectivo', nombre: 'Caja Barra', cierre_ciego: true })).status, 409); // necesita FIN-CIERRE-CIEGO
  assert.equal((await cuenta({ tipo: 'caja_efectivo', nombre: 'Caja Barra' }, tokenCajero)).status, 403); // sin permiso
  assert.equal((await cuenta({ tipo: 'caja_efectivo', nombre: 'Caja Barra' }, tokenGerente)).status, 201); // el gerente configura

  const [t] = await pool.query("INSERT INTO terminales (nombre, codigo) VALUES ('Barra 1', 'BARRA001')");
  const salon = await cuenta({ tipo: 'caja_efectivo', nombre: 'Caja Salón', saldo_inicial: 5000, fondo_cambio: 5000, tope_efectivo: 300000, terminal_id: t.insertId });
  assert.equal(salon.status, 201, JSON.stringify(salon.json));
  assert.deepEqual([salon.json.saldo, salon.json.fondo_cambio, salon.json.tope_efectivo, salon.json.terminal_id], [5000, 5000, 300000, t.insertId]);
  assert.equal((await cuenta({ tipo: 'caja_efectivo', nombre: 'Otra', terminal_id: t.insertId })).status, 409); // una terminal, una caja
  assert.equal((await cuenta({ tipo: 'caja_efectivo', nombre: 'Caja Salón' })).status, 409); // nombre repetido
  assert.equal((await cuenta({ tipo: 'caja_fuerte', nombre: 'Fuerte', terminal_id: t.insertId })).status, 400); // solo una caja de efectivo va a una terminal
  const banco = await cuenta({ tipo: 'banco', nombre: 'Banco Nación', cbu_alias: 'cafe.chepola', limite_descubierto: 50000 });
  assert.equal(banco.status, 201, JSON.stringify(banco.json));
  assert.equal(banco.json.limite_descubierto, 50000); // una cuenta sí admite descubierto
  assert.equal((await cuenta({ tipo: 'billetera', nombre: 'Mercado Pago', cbu_alias: '0000003100012345678901' })).status, 201); // CBU de 22 dígitos
});

test('Financiero.RN17: los saldos solo los ve quien tiene el permiso', async () => {
  const sin = (await api('GET', '/api/financiero/cuentas', { token: tokenCajero })).json;
  assert.ok(sin.length >= 3);
  assert.ok(sin.every((c) => !('saldo' in c)));
  const con = (await api('GET', '/api/financiero/cuentas', { token: tokenGerente })).json;
  assert.ok(con.every((c) => typeof c.saldo === 'number'));
  assert.equal(con.find((c) => c.nombre === 'Caja Salón').saldo, 5000);
});

test('Financiero.RN02: el saldo se deriva de los movimientos, que no se editan ni se borran, y una cuenta con historia no se elimina', async () => {
  const salon = (await api('GET', '/api/financiero/cuentas', { token })).json.find((c) => c.nombre === 'Caja Salón');
  await pool.query("INSERT INTO fin_movimientos (id_global, cuenta_id, tipo, importe, fecha_ms) VALUES ('T-1', ?, 'ingreso', 1500.50, ?)", [salon.id, Date.now()]);
  await pool.query("INSERT INTO fin_movimientos (id_global, cuenta_id, tipo, importe, fecha_ms) VALUES ('T-2', ?, 'retiro', -500, ?)", [salon.id, Date.now()]);
  assert.equal((await api('GET', `/api/financiero/cuentas/${salon.id}`, { token })).json.saldo, 6000.5);
  await assert.rejects(pool.query("UPDATE fin_movimientos SET importe = 1 WHERE id_global = 'T-1'"), /no se edita/);
  await assert.rejects(pool.query("DELETE FROM fin_movimientos WHERE id_global = 'T-1'"), /no se elimina/);
  // Con movimientos, el tipo, la moneda y el saldo inicial quedan fijos; el nombre y el tope sí se cambian.
  assert.equal((await api('PUT', `/api/financiero/cuentas/${salon.id}`, { token, body: { saldo_inicial: 1 } })).status, 409);
  assert.equal((await api('PUT', `/api/financiero/cuentas/${salon.id}`, { token, body: { tipo: 'caja_reparto' } })).status, 409);
  const mod = await api('PUT', `/api/financiero/cuentas/${salon.id}`, { token, body: { nombre: 'Caja del Salón', tope_efectivo: 400000 } });
  assert.equal(mod.status, 200, JSON.stringify(mod.json));
  assert.deepEqual([mod.json.nombre, mod.json.tope_efectivo, mod.json.saldo], ['Caja del Salón', 400000, 6000.5]);
  assert.equal((await api('DELETE', `/api/financiero/cuentas/${salon.id}`, { token })).status, 409);
  const off = await api('POST', `/api/financiero/cuentas/${salon.id}/desactivar`, { token });
  assert.equal(off.json.activa, false);
  assert.equal((await api('POST', `/api/financiero/cuentas/${salon.id}/activar`, { token })).json.activa, true);
  // Sin movimientos sí se elimina.
  const tmp = (await cuenta({ tipo: 'caja_fuerte', nombre: 'Temporal' })).json;
  assert.equal((await api('DELETE', `/api/financiero/cuentas/${tmp.id}`, { token })).status, 200);
});

test('Financiero.RF11: categorías en árbol, sin repetidos ni ciclos', async () => {
  const arbol = (await api('GET', '/api/financiero/categorias', { token })).json;
  const servicios = arbol.find((c) => c.nombre === 'Servicios');
  assert.ok(servicios.hijos.some((h) => h.nombre === 'Energía'));
  assert.ok(arbol.some((c) => c.nombre === 'Comisiones de vendedores'));
  const crear = (b, t = token) => api('POST', '/api/financiero/categorias', { token: t, body: b });
  const hija = await crear({ nombre: 'Electricidad', padre_id: servicios.id });
  assert.equal(hija.status, 201);
  assert.equal((await crear({ nombre: 'Electricidad' })).status, 409); // repetida
  assert.equal((await crear({ nombre: 'Sin padre', padre_id: 99999 })).status, 404);
  assert.equal((await crear({ nombre: 'Rara', tipo: 'otro' })).status, 400);
  assert.equal((await crear({ nombre: 'Prohibida' }, tokenCajero)).status, 403);
  // Mover «Servicios» bajo su propia hija formaría un ciclo.
  assert.equal((await api('PUT', `/api/financiero/categorias/${servicios.id}`, { token, body: { padre_id: hija.json.id } })).status, 409);
  assert.equal((await api('PUT', `/api/financiero/categorias/${servicios.id}`, { token, body: { padre_id: servicios.id } })).status, 409);
  const desact = await api('PUT', `/api/financiero/categorias/${hija.json.id}`, { token, body: { activa: false } });
  assert.equal(desact.json.activa, false);
  assert.ok(!(await api('GET', '/api/financiero/categorias?activas=1', { token })).json.find((c) => c.nombre === 'Servicios').hijos.some((h) => h.nombre === 'Electricidad'));
});

test('Financiero.RN43/RN05/RN04: la configuración tiene valores por defecto y se valida', async () => {
  const c = (await api('GET', '/api/financiero/config', { token })).json;
  assert.deepEqual([c.antiguedad_max_reapertura_dias, c.tolerancia_diferencia, c.exigir_turno_efectivo, c.retencion_solicitudes_dias], [7, 0, true, 90]);
  const put = (b, t = token) => api('PUT', '/api/financiero/config', { token: t, body: b });
  assert.equal((await put({ antiguedad_max_reapertura_dias: -1 })).status, 400);
  assert.equal((await put({ tolerancia_diferencia: -5 })).status, 400);
  assert.equal((await put({ retencion_solicitudes_dias: 30 })).status, 400); // mínimo 90 días
  assert.equal((await put({ exigir_turno_efectivo: false }, tokenCajero)).status, 403);
  const r = await put({ antiguedad_max_reapertura_dias: 0, tolerancia_diferencia: 100.5, exigir_turno_efectivo: false });
  assert.deepEqual([r.json.antiguedad_max_reapertura_dias, r.json.tolerancia_diferencia, r.json.exigir_turno_efectivo], [0, 100.5, false]); // 0 no admite reaperturas
  await put({ antiguedad_max_reapertura_dias: 7, tolerancia_diferencia: 0, exigir_turno_efectivo: true });
});

test('Financiero: las acciones de configuración quedan auditadas', async () => {
  const [filas] = await pool.query("SELECT accion FROM auditoria WHERE modulo = 'financiero'");
  const acciones = new Set(filas.map((f) => f.accion));
  for (const a of ['alta_cuenta', 'modificacion_cuenta', 'desactivar_cuenta', 'baja_cuenta', 'cambio_configuracion']) assert.ok(acciones.has(a), `falta auditar ${a}`);
});
