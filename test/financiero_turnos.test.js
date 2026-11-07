const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario, terminal, vender } = require('./ayudas_financiero');
const { hashCodigo } = require('../src/utils/credenciales');
const puertos = require('../src/modulos/puertos');
const Turnos = require('../src/financiero/turnoService');

process.env.AFIP_CONDICION_IVA_EMISOR = 'monotributista';

let api, pool, cerrar, adm, gerente, cajero, cajero2, termBarra, termSalon, barra, salon, fuerte;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  termBarra = await terminal(pool, 'Barra 1', 'BARRA001');
  termSalon = await terminal(pool, 'Salón 1', 'SALON001');
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  cajero = await usuario(api, pool, 'cami', 'cajero', 'BARRA001');
  cajero2 = await usuario(api, pool, 'cele', 'cajero', 'SALON001');
  // Un supervisor con PIN para autorizar (otro usuario, con la acción permitida).
  const [sup] = await pool.query("INSERT INTO users (username, password_hash, rol, pin_hash) VALUES ('sup', ?, 'admin', ?)", [await bcrypt.hash('clave-larga-1', 4), hashCodigo('2222')]);
  await pool.query("INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = 'administrador'", [sup.insertId]);
  await api('POST', '/api/modulos/financiero/instalar', { token: adm.token });
  const crear = async (b) => (await api('POST', '/api/financiero/cuentas', { token: adm.token, body: b })).json;
  barra = await crear({ tipo: 'caja_efectivo', nombre: 'Caja Barra', terminal_id: termBarra, fondo_cambio: 5000, tope_efectivo: 8000, saldo_inicial: 5000 });
  salon = await crear({ tipo: 'caja_efectivo', nombre: 'Caja Salón', terminal_id: termSalon, fondo_cambio: 3000 });
  fuerte = await crear({ tipo: 'caja_fuerte', nombre: 'Caja Fuerte' });
  await api('PUT', '/api/financiero/destinos', { token: adm.token, body: { forma: 'efectivo', modo: 'caja_del_turno' } });
  await api('PUT', '/api/financiero/destinos', { token: adm.token, body: { forma: 'tarjeta_debito', cuenta_id: fuerte.id } });
});
after(async () => { await cerrar(); });

const abrir = (b, t = cajero) => api('POST', '/api/financiero/turnos', { token: t.token, body: b });
const turno = async (id, t = gerente) => (await api('GET', `/api/financiero/turnos/${id}`, { token: t.token })).json;
const venta = (importe, forma = 'efectivo', t = cajero) => vender(api, pool, t.token, { armar: adm.token, importe, pagos: [{ forma, importe }] });
const movs = async (q) => (await api('GET', `/api/financiero/movimientos?${q}`, { token: adm.token })).json;

test('Financiero.RF03: turnos de servicio configurables y asignados por la hora de apertura, también cruzando la medianoche', async () => {
  const lista = (await api('GET', '/api/financiero/turnos-servicio', { token: gerente.token })).json;
  assert.deepEqual(lista.map((s) => s.nombre), ['Mañana', 'Tarde']);
  const post = (b, t = adm) => api('POST', '/api/financiero/turnos-servicio', { token: t.token, body: b });
  assert.equal((await post({ nombre: 'Mañana', desde: '05:00', hasta: '06:00' })).status, 409);
  assert.equal((await post({ nombre: 'X', desde: '25:00', hasta: '06:00' })).status, 400);
  assert.equal((await post({ nombre: 'X', desde: '06:00', hasta: '06:00' })).status, 400);
  assert.equal((await post({ nombre: 'Noche', desde: '23:00', hasta: '06:00' }, cajero)).status, 403);
  const noche = await post({ nombre: 'Noche', desde: '23:00', hasta: '06:00' });
  assert.equal(noche.status, 201);
  const en = async (h, m) => (await pool.query('SELECT nombre FROM fin_turnos_servicio WHERE id = ?', [await Turnos.servicioDe(new Date(2026, 0, 15, h, m))]))[0][0]?.nombre;
  assert.equal(await en(7, 30), 'Mañana');
  assert.equal(await en(14, 0), 'Tarde');
  assert.equal(await en(23, 30), 'Noche'); // la noche cruza la medianoche
  assert.equal(await en(2, 0), 'Noche');
  assert.equal(await en(5, 59), 'Noche');
});

test('Financiero.RF03/RN03: abrir un turno exige el fondo contado; solo una caja de efectivo o de reparto lleva turno; un solo turno abierto por caja', async () => {
  assert.equal((await abrir({ cuenta_id: barra.id })).status, 400); // falta el fondo contado
  assert.equal((await abrir({ cuenta_id: barra.id, fondo_contado: -1 })).status, 400);
  assert.equal((await abrir({ cuenta_id: fuerte.id, fondo_contado: 0 })).status, 400); // la caja fuerte no lleva turno
  assert.equal((await abrir({ cuenta_id: 999, fondo_contado: 0 })).status, 404);
  assert.equal((await api('POST', '/api/financiero/turnos', { token: gerente.token, body: { cuenta_id: salon.id, fondo_contado: 0 } })).status, 201); // el gerente puede operar
  await pool.query("UPDATE fin_turnos SET estado = 'cerrado', cuenta_abierta = NULL, cerrado_ms = ? WHERE cuenta_id = ?", [Date.now(), salon.id]); // se deja la caja libre para el resto

  // Dos aperturas a la vez sobre la misma caja: una gana y la otra recibe el turno que ya está abierto (RN03, EX14).
  const [a, b] = await Promise.all([abrir({ cuenta_id: barra.id, fondo_contado: 5000 }), abrir({ cuenta_id: barra.id, fondo_contado: 5000 }, adm)]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  const perdedor = a.status === 409 ? a : b;
  assert.equal(perdedor.json.codigo, 'TURNO_ABIERTO');
  assert.ok(perdedor.json.detalle.turno_id && perdedor.json.detalle.usuario);
  // Las demás cajas tienen turnos independientes.
  assert.equal((await abrir({ cuenta_id: salon.id, fondo_contado: 3000 }, cajero2)).status, 201);
  const abierto = (await api('GET', '/api/financiero/turnos/abierto', { token: cajero.token })).json;
  assert.equal(abierto.caja, 'Caja Barra');
  assert.equal(abierto.estado, 'abierto');
  assert.ok(['Mañana', 'Tarde', 'Noche', null].includes(abierto.turno_servicio));
});

test('Financiero.RF03/RN39: el turno guarda la versión de configuración y las funciones vigentes al abrirse', async () => {
  const t = (await api('GET', '/api/financiero/turnos/abierto', { token: cajero.token })).json;
  assert.equal(typeof t.version_config, 'number');
  assert.deepEqual(t.funciones, []);
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['FIN-CIERRE-CIEGO'], motivo: 'prueba' } });
  assert.deepEqual((await turno(t.id)).funciones, []); // el turno abierto no cambia a la mitad (RN39)
  await pool.query("UPDATE fin_turnos SET estado = 'cerrado', cuenta_abierta = NULL, cerrado_ms = ? WHERE id = ?", [Date.now(), t.id]);
  const nuevo = await abrir({ cuenta_id: barra.id, fondo_contado: 5000 });
  assert.deepEqual(nuevo.json.funciones, ['FIN-CIERRE-CIEGO']); // el turno siguiente ya aplica la versión nueva
});

test('Financiero.RF03/RN17: el saldo teórico solo lo ve quien tiene el permiso y el aviso de tope no bloquea la venta', async () => {
  const t = (await api('GET', '/api/financiero/turnos/abierto', { token: cajero.token })).json;
  assert.ok(!('saldo_teorico' in t)); // el cajero no ve el saldo
  const g = await turno(t.id);
  assert.equal(g.saldo_teorico, 5000);
  assert.ok(!g.aviso_tope);
  const v = await venta(4000);
  assert.equal(v.status, 200, JSON.stringify(v.json)); // supera el tope de 8000 y la venta se hace igual
  const g2 = await turno(t.id);
  assert.equal(g2.saldo_teorico, 9000);
  assert.deepEqual([g2.aviso_tope.tope, g2.aviso_tope.exceso], [8000, 1000]);
  assert.equal((await movs(`turno_id=${t.id}&tipo=cobro`)).length, 1); // el cobro quedó en el turno
});

test('Financiero.RF03/RN08/EX04: ingresos y retiros manuales con motivo; la caja no queda en negativo', async () => {
  const t = (await api('GET', '/api/financiero/turnos/abierto', { token: cajero.token })).json;
  const mov = (b, tk = gerente) => api('POST', `/api/financiero/turnos/${t.id}/movimientos`, { token: tk.token, body: b });
  assert.equal((await mov({ tipo: 'retiro', importe: 100 })).status, 400); // falta el motivo
  assert.equal((await mov({ tipo: 'retiro', importe: 0, motivo: 'excedente' })).status, 400);
  assert.equal((await mov({ tipo: 'otro', importe: 5, motivo: 'x' })).status, 400);
  const ret = await mov({ tipo: 'retiro', importe: 2000, motivo: 'Excedente a caja fuerte' });
  assert.equal(ret.status, 201, JSON.stringify(ret.json));
  assert.equal(ret.json.saldo, 7000);
  const exceso = await mov({ tipo: 'retiro', importe: 7001, motivo: 'de más' });
  assert.equal(exceso.status, 409);
  assert.equal(exceso.json.codigo, 'SALDO_INSUFICIENTE');
  assert.equal(exceso.json.detalle.saldo, 7000);
  assert.equal((await mov({ tipo: 'ingreso', importe: 500, motivo: 'Cambio traído del banco' })).json.saldo, 7500);
  // El cajero necesita la autorización de un supervisor para mover plata a mano.
  assert.equal((await mov({ tipo: 'ingreso', importe: 1, motivo: 'prueba' }, cajero)).status, 403);
  const aut = await mov({ tipo: 'ingreso', importe: 1, motivo: 'prueba', autorizacion: { credencial: '2222' } }, cajero);
  assert.equal(aut.status, 201, JSON.stringify(aut.json));
});

test('Financiero.RN04/EX01: sin turno abierto no se cobra en efectivo; los demás medios sí; sin la exigencia, el cobro espera al próximo turno', async () => {
  // La terminal del salón tiene turno abierto; se cierra y se intenta cobrar.
  await pool.query("UPDATE fin_turnos SET estado = 'cerrado', cuenta_abierta = NULL, cerrado_ms = ? WHERE cuenta_id = ?", [Date.now(), salon.id]);
  const sin = await venta(50, 'efectivo', cajero2);
  assert.equal(sin.status, 409);
  assert.equal(sin.json.codigo, 'SIN_TURNO_ABIERTO');
  assert.match(sin.json.error, /Caja Salón/);
  assert.equal((await venta(50, 'tarjeta_debito', cajero2)).status, 200); // la tarjeta no pasa por el efectivo de la caja

  // Si la instancia no lo exige, la venta se hace y el cobro queda en espera hasta que se abra un turno (RN41, EX30).
  await api('PUT', '/api/financiero/config', { token: adm.token, body: { exigir_turno_efectivo: false } });
  const libre = await venta(70, 'efectivo', cajero2);
  assert.equal(libre.status, 200, JSON.stringify(libre.json));
  const [espera] = await movs(`venta=${libre.id}`);
  assert.deepEqual([espera.en_espera, espera.turno_id], [true, null]);
  const t = await abrir({ cuenta_id: salon.id, fondo_contado: 3070 }, cajero2); // 3000 del fondo + los 70 del cobro en espera
  assert.equal(t.status, 201, JSON.stringify(t.json));
  const [asignado] = await movs(`venta=${libre.id}`);
  assert.deepEqual([asignado.en_espera, asignado.turno_id], [false, t.json.id]);
  assert.equal(t.json.fondo_apertura, 3070);
  assert.equal((await movs(`turno_id=${t.json.id}&tipo=ajuste`)).length, 0); // lo contado coincide con lo esperado: no hay ajuste de apertura
  await api('PUT', '/api/financiero/config', { token: adm.token, body: { exigir_turno_efectivo: true } });
});

test('Financiero.RF03: lo contado al abrir distinto de lo que debería haber queda como un ajuste del turno, sin editar nada', async () => {
  const [{ cuenta_id: c }] = (await pool.query("SELECT cuenta_id FROM fin_turnos WHERE cuenta_id = ? AND estado = 'abierto'", [salon.id]))[0];
  await pool.query("UPDATE fin_turnos SET estado = 'cerrado', cuenta_abierta = NULL, cerrado_ms = ? WHERE cuenta_id = ?", [Date.now(), c]);
  const saldoAntes = (await api('GET', `/api/financiero/cuentas/${salon.id}`, { token: gerente.token })).json.saldo;
  const t = await abrir({ cuenta_id: salon.id, fondo_contado: saldoAntes - 20 }, cajero2);
  const [aj] = await movs(`turno_id=${t.json.id}&tipo=ajuste`);
  assert.equal(aj.importe, -20);
  assert.match(aj.motivo, /Diferencia del fondo de cambio al abrir/);
  assert.equal((await api('GET', `/api/financiero/cuentas/${salon.id}`, { token: gerente.token })).json.saldo, saldoAntes - 20);
});

test('Financiero.EX02/RN03: el turno vive en la base (un corte de energía no lo cierra) y una caja con turno abierto no se desactiva', async () => {
  const t = (await api('GET', '/api/financiero/turnos/abierto', { token: cajero.token })).json;
  const [[fila]] = await pool.query('SELECT estado, cuenta_abierta FROM fin_turnos WHERE id = ?', [t.id]);
  assert.deepEqual([fila.estado, fila.cuenta_abierta], ['abierto', barra.id]);
  const r = await api('POST', `/api/financiero/cuentas/${barra.id}/desactivar`, { token: adm.token });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /turno abierto/);
});

test('Financiero.RF17/llamada 5: si Financiero no responde, el cobro en efectivo pide a un supervisor y la venta queda «turno no verificado»', async () => {
  const original = { registrarCobro: async () => null, turnoAbierto: ({ terminalId }) => Turnos.turnoDeTerminal(terminalId), saldoCaja: async () => null, destinoDe: async () => ({ asignado: true }) };
  puertos.registrar('cobros', { ...original, turnoAbierto: async () => { throw new Error('Financiero caído'); } });
  try {
    const sinAut = await venta(30);
    assert.equal(sinAut.status, 403); // pide la autorización de un supervisor
    assert.equal(sinAut.json.codigo, 'TURNO_NO_VERIFICADO');
    const con = await vender(api, pool, cajero.token, { armar: adm.token, importe: 30, pagos: [{ forma: 'efectivo', importe: 30 }], extra: { autorizacion: { credencial: '2222' } } });
    assert.equal(con.status, 200, JSON.stringify(con.json));
    await esperarMensajes(pool);
    const [m] = await movs(`venta=${con.id}`);
    assert.match(m.marcas, /turno_no_verificado/);
    assert.equal((await venta(30, 'tarjeta_debito')).status, 200); // sin efectivo no hace falta el turno
  } finally { puertos.registrar('cobros', original); }
});
