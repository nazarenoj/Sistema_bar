const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario, terminal, vender } = require('./ayudas_financiero');
const { hashCodigo } = require('../src/utils/credenciales');

process.env.AFIP_CONDICION_IVA_EMISOR = 'monotributista';

let api, pool, cerrar, adm, gerente, cajero, administrativo, term, barra, fuerte, banco, posnet, billetera, turno;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  term = await terminal(pool, 'Barra 1', 'BARRA001');
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  cajero = await usuario(api, pool, 'cami', 'cajero', 'BARRA001');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  const [sup] = await pool.query("INSERT INTO users (username, password_hash, rol, pin_hash) VALUES ('sup', ?, 'admin', ?)", [await bcrypt.hash('clave-larga-1', 4), hashCodigo('2222')]);
  await pool.query("INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = 'administrador'", [sup.insertId]);
  await api('POST', '/api/modulos/financiero/instalar', { token: adm.token });
  const crear = async (b) => (await api('POST', '/api/financiero/cuentas', { token: adm.token, body: b })).json;
  barra = await crear({ tipo: 'caja_efectivo', nombre: 'Caja Barra', terminal_id: term, fondo_cambio: 1000, saldo_inicial: 1000 });
  fuerte = await crear({ tipo: 'caja_fuerte', nombre: 'Caja Fuerte' });
  banco = await crear({ tipo: 'banco', nombre: 'Banco', saldo_inicial: 500, limite_descubierto: 1000 });
  posnet = await crear({ tipo: 'procesador', nombre: 'Posnet' });
  billetera = await crear({ tipo: 'billetera', nombre: 'Mercado Pago' });
  const destino = (b) => api('PUT', '/api/financiero/destinos', { token: adm.token, body: b });
  await destino({ forma: 'efectivo', modo: 'caja_del_turno' });
  await destino({ forma: 'tarjeta_debito', cuenta_id: posnet.id, plazo_acreditacion_dias: 2, comision_pct: 1.5 });
  await destino({ forma: 'tarjeta_credito', cuenta_id: posnet.id, plazo_acreditacion_dias: 18, comision_pct: 3 });
  await destino({ forma: 'transferencia', cuenta_id: billetera.id, plazo_acreditacion_dias: 0, comision_pct: 0 });
  turno = (await api('POST', '/api/financiero/turnos', { token: cajero.token, body: { cuenta_id: barra.id, fondo_contado: 1000 } })).json;
});
after(async () => { await cerrar(); });

const saldo = async (id) => (await api('GET', `/api/financiero/cuentas/${id}`, { token: adm.token })).json.saldo;
const movs = async (q) => (await api('GET', `/api/financiero/movimientos?${q}`, { token: adm.token })).json;
const transf = (b, t = gerente) => api('POST', '/api/financiero/transferencias', { token: t.token, body: b });
const vta = (importe, forma, referencia) => vender(api, pool, cajero.token, { armar: adm.token, importe, pagos: [{ forma, importe, ...(referencia && { referencia }) }] });
const acred = async (q = '') => (await api('GET', `/api/financiero/acreditaciones?${q}`, { token: adm.token })).json;
const hoyMas = (dias) => new Date(Date.now() + dias * 86400000).toISOString().slice(0, 10);

test('Financiero.RF05/RN02: una transferencia son dos movimientos vinculados; el retiro a la caja fuerte y el depósito se reconocen', async () => {
  const mal = (b) => transf(b);
  assert.equal((await mal({ origen_id: barra.id, destino_id: barra.id, importe: 10, motivo: 'x1x' })).status, 400); // mismo origen y destino
  assert.equal((await mal({ origen_id: barra.id, destino_id: fuerte.id, importe: 0, motivo: 'excedente' })).status, 400);
  assert.equal((await mal({ origen_id: barra.id, destino_id: fuerte.id, importe: 10 })).status, 400); // el motivo es obligatorio
  assert.equal((await mal({ origen_id: barra.id, destino_id: 9999, importe: 10, motivo: 'excedente' })).status, 404);

  const r = await transf({ origen_id: barra.id, destino_id: fuerte.id, importe: 300, motivo: 'Excedente a caja fuerte' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.clase, r.json.saldo_origen, r.json.saldo_destino], ['retiro_fuerte', 700, 300]);
  const [mD, mO] = await Promise.all([movs(`cuenta_id=${fuerte.id}`), movs(`cuenta_id=${barra.id}&tipo=transferencia`)]).then(([a, b]) => [a[0], b[0]]);
  assert.deepEqual([mO.importe, mD.importe, mD.vinculo_id], [-300, 300, mO.id]); // el destino queda vinculado al origen
  assert.equal(mO.turno_id, turno.id); // la salida es del turno de la caja
  const dep = await transf({ origen_id: fuerte.id, destino_id: banco.id, importe: 100, motivo: 'Depósito bancario' });
  assert.equal(dep.json.clase, 'deposito'); // de la caja fuerte al banco también es un depósito
  const dep2 = await transf({ origen_id: barra.id, destino_id: banco.id, importe: 50, motivo: 'Depósito de la barra' });
  assert.equal(dep2.json.clase, 'deposito');
  assert.equal((await api('GET', '/api/financiero/transferencias?clase=retiro_fuerte', { token: gerente.token })).json.length, 1);
});

test('Financiero.RN08/EX04: una caja no queda en negativo y una cuenta solo hasta su descubierto; nada queda a medias', async () => {
  const antes = [await saldo(barra.id), await saldo(fuerte.id)];
  const r = await transf({ origen_id: barra.id, destino_id: fuerte.id, importe: antes[0] + 1, motivo: 'de más' });
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'SALDO_INSUFICIENTE');
  assert.equal(r.json.detalle.saldo, antes[0]);
  assert.deepEqual([await saldo(barra.id), await saldo(fuerte.id)], antes); // ni un movimiento
  // El banco (saldo 500 + 100 + 50 = 650) llega a su descubierto de 1000: se puede sacar hasta 1650.
  const s = await saldo(banco.id);
  assert.equal((await transf({ origen_id: banco.id, destino_id: fuerte.id, importe: s + 1001, motivo: 'pasa el tope' })).status, 409);
  assert.equal((await transf({ origen_id: banco.id, destino_id: fuerte.id, importe: s + 1000, motivo: 'todo el descubierto' })).status, 201);
  assert.equal(await saldo(banco.id), -1000);
  assert.equal((await transf({ origen_id: banco.id, destino_id: fuerte.id, importe: 1, motivo: 'un peso más' })).status, 409);
  // Dos retiros simultáneos que juntos no entran: uno pasa y el otro no (la caja se bloquea mientras se mueve).
  const disp = await saldo(barra.id);
  const rs = await Promise.all([1, 2].map(() => transf({ origen_id: barra.id, destino_id: fuerte.id, importe: Math.ceil(disp * 0.6), motivo: 'simultáneo' })));
  assert.deepEqual(rs.map((x) => x.status).sort(), [201, 409]);
  assert.ok((await saldo(barra.id)) >= 0);
  // Moneda distinta: necesita FIN-MONEDA-EXT.
  const [usd] = [(await pool.query("INSERT INTO fin_cuentas (id_global, tipo, nombre, moneda) VALUES ('USD-1', 'caja_fuerte', 'Fuerte USD', 'USD')"))[0].insertId];
  const mon = await transf({ origen_id: fuerte.id, destino_id: usd, importe: 5, motivo: 'cambio' });
  assert.equal(mon.status, 409);
  assert.equal(mon.json.codigo, 'MONEDA_DISTINTA');
});

test('Financiero.RN17: el cajero necesita un supervisor para mover plata entre cajas; la transferencia a otra cuenta de turno exige el turno abierto', async () => {
  const b = { origen_id: barra.id, destino_id: fuerte.id, importe: 10, motivo: 'retiro chico' };
  assert.equal((await transf(b, cajero)).status, 403);
  assert.equal((await transf({ ...b, autorizacion: { credencial: '2222' } }, cajero)).status, 201);
  assert.equal((await transf(b, administrativo)).status, 403); // sin el permiso
  // Cerrar el turno y transferir desde la caja: no hay turno abierto.
  const c = await api('POST', `/api/financiero/turnos/${turno.id}/cerrar`, { token: cajero.token, body: { conteo: { efectivo: await saldo(barra.id) }, fondo_siguiente: 100 } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const sinTurno = await transf({ ...b, importe: 1 });
  assert.equal(sinTurno.status, 409);
  assert.equal(sinTurno.json.codigo, 'SIN_TURNO_ABIERTO');
});

test('Financiero.RF04/RF05: el cierre puede transferir el resto a la caja central en la misma operación', async () => {
  const sub = (await api('POST', '/api/financiero/turnos', { token: cajero.token, body: { cuenta_id: barra.id, fondo_contado: await saldo(barra.id) } })).json;
  const antesFuerte = await saldo(fuerte.id);
  const contado = await saldo(barra.id);
  const c = await api('POST', `/api/financiero/turnos/${sub.id}/cerrar`, { token: cajero.token, body: { conteo: { efectivo: contado }, fondo_siguiente: 200, transferir_a: fuerte.id } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.transferencia.importe, contado - 200);
  assert.ok(!c.json.propuesta_transferencia); // ya se hizo
  assert.equal(await saldo(barra.id), 200); // queda el fondo de cambio
  assert.equal(await saldo(fuerte.id), antesFuerte + contado - 200);
  const t = (await api('POST', '/api/financiero/turnos', { token: cajero.token, body: { cuenta_id: barra.id, fondo_contado: 200 } })).json;
  assert.equal(t.fondo_propuesto, 200);
  turno = t;
});

test('Financiero.RF06: cada cobro con tarjeta o billetera genera su crédito a acreditar con fecha estimada; el efectivo no; una devolución lo reduce', async () => {
  const efectivo = await vta(100, 'efectivo');
  assert.equal(efectivo.status, 200);
  assert.equal((await acred()).acreditaciones.length, 0);
  const deb = await vta(1000, 'tarjeta_debito', 'CUP-1');
  const cred = await vta(2000, 'tarjeta_credito', 'CUP-2');
  const bil = await vta(500, 'transferencia', 'MP-1');
  const l = (await acred()).acreditaciones;
  assert.equal(l.length, 3);
  const a1 = l.find((a) => a.referencia === 'CUP-1'), a2 = l.find((a) => a.referencia === 'CUP-2'), a3 = l.find((a) => a.referencia === 'MP-1');
  assert.deepEqual([a1.bruto, a1.comision_estimada, a1.fecha_estimada, a1.cuenta], [1000, 15, hoyMas(2), 'Posnet']);
  assert.deepEqual([a2.bruto, a2.comision_estimada, a2.fecha_estimada], [2000, 60, hoyMas(18)]);
  assert.deepEqual([a3.cuenta, a3.fecha_estimada], ['Mercado Pago', hoyMas(0)]);
  assert.equal((await acred()).total, 3500);
  assert.equal((await acred(`hasta=${hoyMas(5)}`)).acreditaciones.length, 2); // las que se esperan en los próximos 5 días
  // La devolución total de una venta anula su crédito pendiente.
  await api('POST', '/api/devoluciones', { token: adm.token, headers: { 'X-ID-Solicitud': 'dev-liq-1' }, body: { venta_id_global: bil.id, motivo: 'error', todo: true } });
  await esperarMensajes(pool);
  assert.equal((await acred()).acreditaciones.find((a) => a.referencia === 'MP-1'), undefined);
  assert.equal((await acred('estado=anulada')).acreditaciones.length, 1);
  void deb; void cred;
});

test('Financiero.RF06/RN15/EX11: la liquidación concilia los cupones y registra comisión, IVA, retenciones, percepciones y el neto; un cupón no se liquida dos veces', async () => {
  const liq = (b, t = administrativo) => api('POST', '/api/financiero/liquidaciones', { token: t.token, body: { cuenta_id: posnet.id, destino_id: banco.id, fecha: hoyMas(0), ...b } });
  const base = { referencia: 'LIQ-001', cupones: [{ referencia: 'CUP-1', importe: 1000 }, { referencia: 'CUP-9', importe: 300 }, { referencia: 'CUP-2', importe: 1999 }], comision: 40, iva_comision: 8.4, retenciones: 20, percepciones: 5 };
  assert.equal((await liq(base, cajero)).status, 403);
  assert.equal((await liq({ ...base, cupones: [] })).status, 400);
  assert.equal((await liq({ ...base, fecha: '07/11/2026' })).status, 400);
  assert.equal((await liq({ ...base, neto: 100 })).status, 400); // el neto informado no cuadra
  assert.equal((await liq({ ...base, cupones: [{ referencia: 'CUP-1', importe: 5 }, { referencia: 'CUP-1', importe: 5 }] })).status, 400); // un cupón repetido
  const saldoPosnet = await saldo(posnet.id), saldoBanco = await saldo(banco.id);
  const r = await liq(base);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  // 1000 + 300 + 1999 = 3299 de bruto; menos 40 + 8,4 + 20 + 5 = 73,4 → neto 3225,6
  assert.deepEqual([r.json.bruto, r.json.neto], [3299, 3225.6]);
  assert.deepEqual(r.json.cupones.map((c) => [c.referencia, c.estado]), [['CUP-1', 'conciliado'], ['CUP-9', 'sin_cobro_asociado'], ['CUP-2', 'sin_cobro_asociado']]);
  assert.match(r.json.cupones[1].motivo, /no está en el sistema/);
  assert.match(r.json.cupones[2].motivo, /difiere del cobro registrado \(2000\)/); // el importe de CUP-2 no coincide
  assert.equal(r.json.comision_estimada, 15);
  assert.equal(r.json.diferencia_comision, 33.4); // 48,4 liquidados contra 15 estimados
  // Movimientos: sale de Posnet lo conciliado y el banco recibe el bruto menos cada descuento.
  assert.equal(await saldo(posnet.id), saldoPosnet - 1000);
  assert.equal(await saldo(banco.id), Math.round((saldoBanco + 3225.6) * 100) / 100);
  const tipos = (await movs(`cuenta_id=${banco.id}`)).filter((m) => m.doc_id_global === `LIQ-${r.json.id}`).map((m) => [m.tipo, m.importe]).sort();
  assert.deepEqual(tipos, [['acreditacion', 1000], ['acreditacion_sin_cobro', 2299], ['comision', -40], ['comision_iva', -8.4], ['percepcion', -5], ['retencion', -20]].sort());
  assert.equal((await acred('estado=liquidada')).acreditaciones.length, 1);

  assert.equal((await liq(base)).json.codigo, 'LIQUIDACION_DUPLICADA'); // la misma liquidación otra vez
  const otra = await liq({ referencia: 'LIQ-002', cupones: [{ referencia: 'CUP-1', importe: 1000 }] }); // el cupón ya se liquidó
  assert.equal(otra.status, 409);
  assert.equal(otra.json.codigo, 'CUPON_YA_LIQUIDADO');
  assert.equal((await api('GET', '/api/financiero/liquidaciones', { token: gerente.token })).json.length, 1);
});
