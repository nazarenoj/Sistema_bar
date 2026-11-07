const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario, terminal, vender } = require('./ayudas_financiero');
const { hashCodigo } = require('../src/utils/credenciales');
const M = require('../src/mensajeria/servicio');

process.env.AFIP_CONDICION_IVA_EMISOR = 'monotributista';

let api, pool, cerrar, adm, gerente, cajero, barista, term, barra, salon, fuerte, procesador, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  term = await terminal(pool, 'Barra 1', 'BARRA001');
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  cajero = await usuario(api, pool, 'cami', 'cajero', 'BARRA001');
  barista = await usuario(api, pool, 'bea', 'barista', 'BARRA001');
  const [sup] = await pool.query("INSERT INTO users (username, password_hash, rol, pin_hash) VALUES ('sup', ?, 'admin', ?)", [await bcrypt.hash('clave-larga-1', 4), hashCodigo('2222')]);
  await pool.query("INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = 'administrador'", [sup.insertId]);
  await api('POST', '/api/modulos/financiero/instalar', { token: adm.token });
  const crear = async (b) => (await api('POST', '/api/financiero/cuentas', { token: adm.token, body: b })).json;
  barra = await crear({ tipo: 'caja_efectivo', nombre: 'Caja Barra', terminal_id: term, fondo_cambio: 2000, saldo_inicial: 2000 });
  fuerte = await crear({ tipo: 'caja_fuerte', nombre: 'Caja Fuerte' });
  procesador = await crear({ tipo: 'procesador', nombre: 'Posnet' });
  await api('PUT', '/api/financiero/destinos', { token: adm.token, body: { forma: 'efectivo', modo: 'caja_del_turno' } });
  await api('PUT', '/api/financiero/destinos', { token: adm.token, body: { forma: 'tarjeta_debito', cuenta_id: procesador.id } });
});
after(async () => { await cerrar(); });

const abrir = async (fondo) => {
  const r = await api('POST', '/api/financiero/turnos', { token: cajero.token, body: { cuenta_id: barra.id, fondo_contado: fondo } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
};
const cierre = (id, body, t = cajero, headers = {}) => api('POST', `/api/financiero/turnos/${id}/cerrar`, { token: t.token, body, headers });
const cfg = (b) => api('PUT', '/api/financiero/config', { token: adm.token, body: b });
const saldo = async (id = barra.id) => (await api('GET', `/api/financiero/cuentas/${id}`, { token: adm.token })).json.saldo;
const movs = async (q) => (await api('GET', `/api/financiero/movimientos?${q}`, { token: adm.token })).json;
const vta = (importe, forma = 'efectivo') => vender(api, pool, cajero.token, { armar: adm.token, importe, pagos: [{ forma, importe }] });
const publicar = async (tipo, contenido, docId = `VTA-C${++k}`) => {
  const conn = await pool.getConnection();
  try { await M.publicar(conn, { origen: 'ventas', destino: 'financiero', tipo, docTipo: 'venta', docIdGlobal: docId, contenido }); } finally { conn.release(); }
  await esperarMensajes(pool);
  return docId;
};

test('Financiero.RF04: el arqueo parcial cuenta la caja sin cerrar el turno', async () => {
  const t = await abrir(2000);
  await vta(500);
  const r = await api('POST', `/api/financiero/turnos/${t.id}/arqueos`, { token: cajero.token, body: { conteo: { efectivo: 2450 } } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.contado, r.json.teorico, r.json.diferencia], [2450, 2500, -50]);
  assert.equal((await api('POST', `/api/financiero/turnos/${t.id}/arqueos`, { token: cajero.token, body: {} })).status, 400); // sin conteo
  assert.equal((await api('GET', `/api/financiero/turnos/${t.id}`, { token: gerente.token })).json.estado, 'abierto'); // sigue abierto
  assert.equal((await movs(`turno_id=${t.id}&tipo=faltante`)).length, 0); // un arqueo no registra diferencias
  // Cierre sin diferencia: el efectivo contado coincide con el teórico.
  assert.equal((await cierre(t.id, {}, barista)).status, 403); // quien no opera turnos no cierra
  assert.equal((await cierre(t.id, { conteo: { efectivo: -1 } })).status, 400);
  assert.equal((await cierre(t.id, { conteo: { efectivo: 2500, denominaciones: { 1000: 2, 500: 1, 100: 1 } } })).status, 400); // las denominaciones suman 2600
  assert.equal((await cierre(t.id, { conteo: { efectivo: 2500, cheques: 100 } })).status, 409); // contar cheques necesita FIN-CHEQUES
  const c = await cierre(t.id, { conteo: { efectivo: 2500, denominaciones: { 1000: 2, 500: 1 } }, fondo_siguiente: 2000 });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.deepEqual([c.json.teorico, c.json.contado, c.json.diferencia, c.json.fondo_siguiente, c.json.traslado_importe], [2500, 2500, 0, 2000, 500]);
  assert.deepEqual(c.json.propuesta_transferencia, { importe: 500, hacia: { id: fuerte.id, nombre: 'Caja Fuerte' } }); // propone pasar el resto a la caja central
  assert.equal((await movs(`turno_id=${t.id}&tipo=faltante`)).length + (await movs(`turno_id=${t.id}&tipo=sobrante`)).length, 0);
  const [[fila]] = await pool.query('SELECT estado, cuenta_abierta FROM fin_turnos WHERE id = ?', [t.id]);
  assert.deepEqual([fila.estado, fila.cuenta_abierta], ['cerrado', null]);
  assert.equal((await cierre(t.id, { conteo: { efectivo: 2500 } })).status, 409); // ya está cerrado
  // El fondo que quedó se propone al abrir el siguiente (RF03).
  const sig = await abrir(2500);
  assert.equal(sig.fondo_propuesto, 2000);
  await cierre(sig.id, { conteo: { efectivo: 2500 } });
});

test('Financiero.RN05/EX03: la diferencia se registra como faltante o sobrante; dentro de la tolerancia cierra sola y fuera pide motivo y supervisor', async () => {
  await cfg({ tolerancia_diferencia: 100 });
  const t1 = await abrir(2500);
  const dentro = await cierre(t1.id, { conteo: { efectivo: 2450 }, motivo: 'billete roto' });
  assert.equal(dentro.status, 200, JSON.stringify(dentro.json));
  assert.equal(dentro.json.diferencia, -50);
  const [f] = await movs(`turno_id=${t1.id}&tipo=faltante`);
  assert.equal(f.importe, -50);
  assert.equal(await saldo(), 2450); // la caja queda con lo realmente contado

  const t2 = await abrir(2450);
  const sinMotivo = await cierre(t2.id, { conteo: { efectivo: 2250 } }); // 200 de faltante
  assert.equal(sinMotivo.status, 409);
  assert.equal(sinMotivo.json.codigo, 'DIFERENCIA_REQUIERE_MOTIVO');
  const sinSup = await cierre(t2.id, { conteo: { efectivo: 2250 }, motivo: 'faltó un vuelto' });
  assert.equal(sinSup.status, 403);
  assert.equal(sinSup.json.codigo, 'REQUIERE_AUTORIZACION');
  const propia = await cierre(t2.id, { conteo: { efectivo: 2250 }, motivo: 'faltó un vuelto', autorizacion: { usuario: 'cami', credencial: 'clave-larga-1' } });
  assert.equal(propia.status, 403); // nadie se autoriza a sí mismo
  assert.equal((await pool.query("SELECT estado FROM fin_turnos WHERE id = ?", [t2.id]))[0][0].estado, 'abierto'); // nada se cerró a medias
  assert.equal((await movs(`turno_id=${t2.id}&tipo=faltante`)).length, 0);
  const ok = await cierre(t2.id, { conteo: { efectivo: 2250 }, motivo: 'faltó un vuelto', autorizacion: { credencial: '2222' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.diferencia, -200);
  assert.ok(ok.json.autorizante_id);
  assert.equal(ok.json.motivo, 'faltó un vuelto');
  await cfg({ tolerancia_diferencia: 0 });
});

test('Financiero.RF04/EX27: cerrar dos veces con la misma clave de solicitud produce un solo cierre y un solo faltante', async () => {
  const t = await abrir(2250);
  const clave = 'cierre-turno-0001';
  const a = await cierre(t.id, { conteo: { efectivo: 2250 } }, cajero, { 'X-ID-Solicitud': clave });
  const b = await cierre(t.id, { conteo: { efectivo: 2250 } }, cajero, { 'X-ID-Solicitud': clave });
  assert.equal(a.status, 200);
  assert.equal(b.headers.get('idempotency-replayed'), 'true');
  assert.deepEqual(b.json, a.json);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM fin_cierres WHERE turno_id = ?', [t.id]))[0][0].n, 1);
  const otro = await cierre(t.id, { conteo: { efectivo: 1 } }, cajero, { 'X-ID-Solicitud': clave }); // mismo ID con contenido distinto
  assert.equal(otro.status, 409);
  assert.equal(otro.json.codigo, 'CONFLICTO_IDEMPOTENCIA');
});

test('Financiero.RF28/RN41/EX29: un cobro con integración pendiente se resuelve o se confirma con motivo; la diferencia que explica no obliga a pedir supervisor', async () => {
  await api('DELETE', `/api/financiero/destinos/${(await api('GET', '/api/financiero/destinos', { token: adm.token })).json.destinos.find((d) => d.forma === 'efectivo').id}`, { token: adm.token });
  const t = await abrir(2250);
  // Un cobro de $100 en efectivo que Financiero rechazó (la forma de pago no tenía destino): el efectivo está en la caja pero no en el sistema.
  const doc = await publicar('cobro_registrado', { terminal_id: term, fecha_ms: Date.now(), pagos: [{ forma: 'efectivo', importe: 100 }] });
  const lista = await api('GET', `/api/financiero/turnos/${t.id}/pendientes`, { token: gerente.token });
  assert.equal(lista.json.verificado, true);
  assert.deepEqual(lista.json.pendientes.map((p) => [p.ref, p.estado]), [[doc, 'rechazado']]);

  const sin = await cierre(t.id, { conteo: { efectivo: 2350 } });
  assert.equal(sin.status, 409);
  assert.equal(sin.json.codigo, 'CIERRE_CON_PENDIENTES');
  assert.equal(sin.json.detalle.pendientes[0].ref, doc);
  assert.equal((await cierre(t.id, { conteo: { efectivo: 2350 }, pendientes: [{ ref: doc, motivo: 'x' }] })).status, 409); // el motivo es muy corto
  const c = await cierre(t.id, { conteo: { efectivo: 2350 }, pendientes: [{ ref: doc, motivo: 'se reprocesa mañana' }] }); // tolerancia 0, sin supervisor
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.deepEqual([c.json.diferencia, c.json.pendientes_importe, c.json.diferencia_evaluada], [100, 100, 0]); // sobrante completo, pero la tolerancia se evalúa sin lo pendiente
  const [sob] = await movs(`turno_id=${t.id}&tipo=sobrante`);
  assert.equal(sob.importe, 100);
  assert.equal(sob.marcas, 'explica_pendientes:100');
  assert.equal(c.json.pendientes.items[0].decision, 'se reprocesa mañana');
  assert.equal(await saldo(), 2350);

  // EX30/RN41(b): el cobro se confirma después del cierre; no modifica el turno cerrado y compensa lo que ya explicaba su sobrante.
  await api('PUT', '/api/financiero/destinos', { token: adm.token, body: { forma: 'efectivo', modo: 'caja_del_turno' } });
  const p = (await api('GET', '/api/integracion/pendientes', { token: adm.token })).json.find((x) => x.doc_id_global === doc);
  await api('POST', `/api/integracion/pendientes/${p.id}/reintentar`, { token: adm.token });
  await esperarMensajes(pool);
  const tarde = await movs(`venta=${doc}`);
  assert.deepEqual(tarde.map((m) => m.tipo).sort(), ['ajuste', 'compensacion']);
  const aj = tarde.find((m) => m.tipo === 'ajuste');
  assert.deepEqual([aj.importe, aj.en_espera, aj.turno_id, aj.marcas], [100, true, null, 'cobro_posterior_al_cierre']); // la caja no tiene turno abierto: queda en espera
  assert.equal(tarde.find((m) => m.tipo === 'compensacion').importe, -100);
  assert.equal(tarde.find((m) => m.tipo === 'compensacion').vinculo_id, sob.id);
  assert.equal(await saldo(), 2350); // el efectivo no se cuenta dos veces
  assert.equal((await pool.query('SELECT diferencia FROM fin_cierres WHERE turno_id = ?', [t.id]))[0][0].diferencia, '100.00'); // el cierre no se tocó
  // Al abrir el siguiente turno, lo que esperaba se incorpora a él.
  const sig = await abrir(2350);
  assert.equal((await movs(`turno_id=${sig.id}`)).filter((m) => ['ajuste', 'compensacion'].includes(m.tipo)).length, 2);
  await cierre(sig.id, { conteo: { efectivo: 2350 } });
});

test('Financiero.RF28: si Ventas no responde, el cierre se permite con motivo y queda marcado «pendientes no verificados»', async () => {
  const Integracion = require('../src/services/integracionVentasService');
  const original = Integracion.cobrosConIntegracionPendiente;
  Integracion.cobrosConIntegracionPendiente = async () => { throw new Error('Ventas no responde'); };
  try {
    const t = await abrir(2350);
    const lista = await api('GET', `/api/financiero/turnos/${t.id}/pendientes`, { token: gerente.token });
    assert.equal(lista.json.verificado, false);
    const sin = await cierre(t.id, { conteo: { efectivo: 2350 } });
    assert.equal(sin.status, 409);
    assert.equal(sin.json.codigo, 'PENDIENTES_NO_VERIFICADOS');
    const c = await cierre(t.id, { conteo: { efectivo: 2350 }, motivo_pendientes: 'Ventas caído al cierre' });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(c.json.pendientes_no_verificados, true);
    assert.equal(c.json.pendientes.motivo_no_verificados, 'Ventas caído al cierre');
  } finally { Integracion.cobrosConIntegracionPendiente = original; }
});

test('Financiero.RN06/RN39: el cierre ciego oculta el teórico y los importes mientras se cuenta y muestra la diferencia al confirmar; un turno abierto antes no cambia', async () => {
  const antes = await abrir(2350); // se abre sin la función: no es ciego aunque después se active (RN39)
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['FIN-CIERRE-CIEGO'], motivo: 'prueba' } });
  await api('PUT', `/api/financiero/cuentas/${barra.id}`, { token: adm.token, body: { cierre_ciego: true } });
  assert.equal((await api('GET', `/api/financiero/turnos/${antes.id}`, { token: gerente.token })).json.saldo_teorico, 2350);
  await cierre(antes.id, { conteo: { efectivo: 2350 } });

  const t = await abrir(2350);
  await vta(150);
  const ver = (await api('GET', `/api/financiero/turnos/${t.id}`, { token: gerente.token })).json;
  assert.equal(ver.cierre_ciego, true);
  assert.ok(!('saldo_teorico' in ver)); // ni siquiera el gerente lo ve mientras se cuenta
  const arq = await api('POST', `/api/financiero/turnos/${t.id}/arqueos`, { token: cajero.token, body: { conteo: { efectivo: 2000 } } });
  assert.deepEqual(Object.keys(arq.json).sort(), ['id', 'registrado']); // el arqueo tampoco revela el teórico ni la diferencia
  const c = await cierre(t.id, { conteo: { efectivo: 2490 }, motivo: 'faltan diez', autorizacion: { credencial: '2222' } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.deepEqual([c.json.ciego, c.json.teorico, c.json.diferencia], [true, 2500, -10]); // la diferencia se muestra recién ahora
  assert.equal((await api('GET', `/api/financiero/turnos/${t.id}`, { token: gerente.token })).json.cierre.diferencia, -10);
});

test('Financiero.RF04: el cierre es imprimible y el historial conserva los cierres del turno', async () => {
  const [[{ id }]] = await pool.query("SELECT id FROM fin_turnos WHERE estado = 'cerrado' ORDER BY id DESC LIMIT 1");
  const imp = await api('GET', `/api/financiero/turnos/${id}/cierre/imprimir`, { token: gerente.token });
  assert.equal(imp.status, 200);
  const lista = (await api('GET', `/api/financiero/turnos/${id}/cierres`, { token: gerente.token })).json;
  assert.equal(lista.length, 1);
  assert.equal(lista[0].version, 1);
});
