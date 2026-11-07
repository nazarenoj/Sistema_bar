const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario, terminal, vender } = require('./ayudas_financiero');
const { hashCodigo } = require('../src/utils/credenciales');

process.env.AFIP_CONDICION_IVA_EMISOR = 'monotributista';

let api, pool, cerrar, adm, gerente, cajero, term, barra, n = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  term = await terminal(pool, 'Barra 1', 'BARRA001');
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  cajero = await usuario(api, pool, 'cami', 'cajero', 'BARRA001');
  const [sup] = await pool.query("INSERT INTO users (username, password_hash, rol, pin_hash) VALUES ('sup', ?, 'admin', ?)", [await bcrypt.hash('clave-larga-1', 4), hashCodigo('2222')]);
  await pool.query("INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = 'administrador'", [sup.insertId]);
  await api('POST', '/api/modulos/financiero/instalar', { token: adm.token });
  barra = (await api('POST', '/api/financiero/cuentas', { token: adm.token, body: { tipo: 'caja_efectivo', nombre: 'Caja Barra', terminal_id: term, fondo_cambio: 1000, saldo_inicial: 1000 } })).json;
  await api('PUT', '/api/financiero/destinos', { token: adm.token, body: { forma: 'efectivo', modo: 'caja_del_turno' } });
  await api('PUT', '/api/financiero/config', { token: adm.token, body: { tolerancia_diferencia: 100 } });
});
after(async () => { await cerrar(); });

const abrir = async (fondo) => { const r = await api('POST', '/api/financiero/turnos', { token: cajero.token, body: { cuenta_id: barra.id, fondo_contado: fondo } }); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json; };
const cierre = (id, body) => api('POST', `/api/financiero/turnos/${id}/cerrar`, { token: cajero.token, body });
const reabrir = (id, body, t = gerente, headers = {}) => api('POST', `/api/financiero/turnos/${id}/reabrir`, { token: t.token, body, headers });
const saldo = async () => (await api('GET', `/api/financiero/cuentas/${barra.id}`, { token: adm.token })).json.saldo;
const movs = async (q) => (await api('GET', `/api/financiero/movimientos?${q}`, { token: adm.token })).json;
const turno = async (id) => (await api('GET', `/api/financiero/turnos/${id}`, { token: gerente.token })).json;
const vta = (importe) => vender(api, pool, cajero.token, { armar: adm.token, importe, pagos: [{ forma: 'efectivo', importe }] });
const auditoria = async (accion) => (await pool.query("SELECT detalle FROM auditoria WHERE accion = ?", [accion]))[0];
let t1, venta1;

test('Financiero.RF18/RN07: reabrir exige permiso, motivo y la autorización de otro usuario; cada intento rechazado queda auditado', async () => {
  t1 = await abrir(1000);
  venta1 = await vta(300);
  assert.equal((await cierre(t1.id, { conteo: { efectivo: 1250 }, motivo: 'faltaban 50' })).json.diferencia, -50); // faltante de 50
  assert.equal(await saldo(), 1250);

  assert.equal((await reabrir(t1.id, { motivo: 'olvidé un cobro' }, cajero)).status, 403); // sin el permiso
  assert.equal((await reabrir(t1.id, {})).status, 400); // el motivo es obligatorio
  const sin = await reabrir(t1.id, { motivo: 'olvidé un cobro' });
  assert.equal(sin.status, 403);
  assert.equal(sin.json.codigo, 'REQUIERE_AUTORIZACION');
  const propia = await reabrir(t1.id, { motivo: 'olvidé un cobro', autorizacion: { usuario: 'gero', credencial: 'clave-larga-1' } });
  assert.equal(propia.status, 403); // nadie se autoriza a sí mismo
  const mala = await reabrir(t1.id, { motivo: 'olvidé un cobro', autorizacion: { credencial: '9999' } });
  assert.equal(mala.status, 403);
  assert.equal((await turno(t1.id)).estado, 'cerrado');
  assert.ok((await auditoria('autorizacion_rechazada')).length >= 2); // los dos intentos inválidos

  const ok = await reabrir(t1.id, { motivo: 'olvidé un cobro', autorizacion: { credencial: '2222' } }, gerente, { 'X-ID-Solicitud': 'reabrir-turno-0001' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const t = ok.json;
  assert.deepEqual([t.estado, t.reaperturas], ['abierto', 1]);
  // La misma solicitud repetida no reabre nada de nuevo ni vuelve a pedir al supervisor.
  const rep = await reabrir(t1.id, { motivo: 'olvidé un cobro', autorizacion: { credencial: '2222' } }, gerente, { 'X-ID-Solicitud': 'reabrir-turno-0001' });
  assert.equal(rep.headers.get('idempotency-replayed'), 'true');
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM fin_reaperturas WHERE turno_id = ?', [t1.id]))[0][0].n, 1);
  const h = (await api('GET', `/api/financiero/turnos/${t1.id}/reaperturas`, { token: gerente.token })).json;
  assert.deepEqual([h[0].motivo, h[0].usuario, h[0].autorizante, h[0].version_cierre], ['olvidé un cobro', 'gero', 'sup', 1]);
  assert.equal((await api('GET', `/api/financiero/turnos/${t1.id}/cierre?version=1`, { token: gerente.token })).json.diferencia, -50); // el cierre anterior se conserva
});

test('Financiero.RF18/EX13: mientras está reabierto admite cobros y anulaciones dentro del mismo turno', async () => {
  const v = await vta(100);
  assert.equal(v.status, 200, JSON.stringify(v.json));
  const [cobro] = await movs(`venta=${v.id}`);
  assert.equal(cobro.turno_id, t1.id); // el cobro entra al turno reabierto
  await api('POST', '/api/devoluciones', { token: adm.token, headers: { 'X-ID-Solicitud': 'dev-reab-1' }, body: { venta_id_global: venta1.id, motivo: 'se devolvió', todo: true } });
  await esperarMensajes(pool);
  const contra = (await movs(`venta=${venta1.id}`)).find((m) => m.tipo === 'devolucion');
  assert.equal(contra.turno_id, t1.id);
  assert.equal(contra.importe, -300);
  assert.equal(await saldo(), 1250 + 100 - 300);
});

test('Financiero.RF18/RN02: al volver a cerrar se recalcula todo el turno, se compensa el faltante anterior y los dos cierres quedan en el historial', async () => {
  // El efectivo teórico ahora es 1050; se cuenta 1060.
  const c = await cierre(t1.id, { conteo: { efectivo: 1060 }, motivo: 'diez de más' });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.deepEqual([c.json.version, c.json.teorico, c.json.contado, c.json.diferencia], [2, 1050 + 50, 1060, -40]); // el teórico ya no incluye el faltante del primer cierre
  const ms = await movs(`turno_id=${t1.id}`);
  const faltante1 = ms.filter((m) => m.tipo === 'faltante').pop(); // el del primer cierre (la lista viene del más nuevo al más viejo)
  const compensacion = ms.find((m) => m.tipo === 'compensacion');
  assert.equal(compensacion.importe, 50);
  assert.equal(compensacion.vinculo_id, faltante1.id);
  assert.equal(await saldo(), 1060); // lo contado en el último cierre
  const cierres = (await api('GET', `/api/financiero/turnos/${t1.id}/cierres`, { token: gerente.token })).json;
  assert.deepEqual(cierres.map((x) => [x.version, x.diferencia]), [[1, -50], [2, -40]]);
  assert.equal((await turno(t1.id)).cierre.version, 2);
});

test('Financiero.EX13: una anulación cuando no hay turno abierto no toca el turno cerrado y entra al próximo', async () => {
  const t2 = await abrir(1060);
  const v = await vta(80);
  await cierre(t2.id, { conteo: { efectivo: 1140 } });
  const cierreAntes = (await api('GET', `/api/financiero/turnos/${t2.id}/cierre`, { token: gerente.token })).json;
  await api('POST', '/api/devoluciones', { token: adm.token, headers: { 'X-ID-Solicitud': 'dev-reab-2' }, body: { venta_id_global: v.id, motivo: 'tarde', todo: true } });
  await esperarMensajes(pool);
  const contra = (await movs(`venta=${v.id}`)).find((m) => m.tipo === 'devolucion');
  assert.deepEqual([contra.turno_id, contra.en_espera], [null, true]);
  assert.deepEqual((await api('GET', `/api/financiero/turnos/${t2.id}/cierre`, { token: gerente.token })).json, cierreAntes); // el cierre no se modifica
  const t3 = await abrir(1060);
  assert.equal((await movs(`venta=${v.id}`)).find((m) => m.tipo === 'devolucion').turno_id, t3.id);
  await cierre(t3.id, { conteo: { efectivo: 1060 } });
});

test('Financiero.RN07/EX14: no se reabre si la caja tiene otro turno abierto; se informa cuál y el intento queda auditado', async () => {
  const [{ id: viejo }] = (await pool.query("SELECT id FROM fin_turnos WHERE cuenta_id = ? AND estado = 'cerrado' ORDER BY id LIMIT 1", [barra.id]))[0];
  const abierto = await abrir(1060);
  const r = await reabrir(viejo, { motivo: 'otra vez', autorizacion: { credencial: '2222' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'TURNO_ABIERTO');
  assert.deepEqual([r.json.detalle.turno_id, r.json.detalle.usuario], [abierto.id, 'cami']);
  assert.ok((await auditoria('reapertura_rechazada')).some((a) => /abierto en la caja/.test(a.detalle)));
  await cierre(abierto.id, { conteo: { efectivo: 1060 } });
});

test('Financiero.RN43/EX32: pasada la antigüedad máxima no se reabre; con 0 días tampoco; el intento queda auditado', async () => {
  const [{ id: viejo }] = (await pool.query("SELECT id FROM fin_turnos WHERE cuenta_id = ? AND estado = 'cerrado' ORDER BY id LIMIT 1", [barra.id]))[0];
  await pool.query('UPDATE fin_cierres SET cerrado_ms = ? WHERE turno_id = ?', [Date.now() - 8 * 86400000, viejo]);
  const r = await reabrir(viejo, { motivo: 'muy tarde', autorizacion: { credencial: '2222' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'REAPERTURA_FUERA_DE_PLAZO');
  assert.deepEqual([r.json.detalle.tope_dias, r.json.detalle.antiguedad_dias > 7], [7, true]);
  await api('PUT', '/api/financiero/config', { token: adm.token, body: { antiguedad_max_reapertura_dias: 30 } });
  assert.equal((await reabrir(viejo, { motivo: 'dentro del nuevo tope', autorizacion: { credencial: '2222' } })).status, 200); // con 30 días sí
  await cierre(viejo, { conteo: { efectivo: 1060 } });
  await api('PUT', '/api/financiero/config', { token: adm.token, body: { antiguedad_max_reapertura_dias: 0 } });
  const cero = await reabrir(viejo, { motivo: 'no se permite', autorizacion: { credencial: '2222' } });
  assert.equal(cero.status, 409);
  assert.equal(cero.json.codigo, 'REAPERTURA_FUERA_DE_PLAZO'); // 0 no admite reaperturas
  assert.ok((await auditoria('reapertura_rechazada')).some((a) => /antigüedad máxima/.test(a.detalle)));
});
