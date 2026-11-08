const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { iniciarApp } = require('./ayudas');
const { preparar } = require('./ayudas_contable');
const C = require('../src/servicios/consolidacionService');
const Consol = require('../src/contable/consolidacion');
const { version: VERSION } = require('../package.json');

let api, pool, cerrar, c, k = 0, clavePublica;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  c = await preparar(api, pool);
});
after(async () => { await cerrar(); });

const g = () => ({ token: c.gerente.token });
const adm = () => ({ token: c.adm.token });
const sol = () => ({ 'X-ID-Solicitud': `con-${++k}-${Math.random().toString(36).slice(2, 10)}` });
const mesAnterior = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const finDeMes = (m) => { const [a, n] = m.split('-').map(Number); return `${m}-${String(new Date(a, n, 0).getDate()).padStart(2, '0')}`; };
// Un paquete contable firmado como si lo hubiera publicado esa sucursal.
const sobre = async (sucursal, contenido, { periodo = finDeMes(contenido.periodo_contable), version = 1 } = {}) => {
  const [[{ clave_privada: priv }]] = await pool.query('SELECT clave_privada FROM consolidacion_config WHERE id = 1');
  const cuerpo = { sucursal, modulo: 'contable', periodo, version, version_sistema: VERSION, huella: C.huellaDe(contenido) };
  return { id_paquete: `${sucursal}-contable-${periodo}-v${version}`, ...cuerpo, contenido, firma: crypto.sign(null, Buffer.from(C.firmado(cuerpo)), priv).toString('base64') };
};
const linea = (codigo, nombre, saldo_inicial, debe, haber) => ({ codigo, nombre, saldo_inicial, debe, haber, saldo_final: Math.round((saldo_inicial + debe - haber) * 100) / 100 });
const importar = (s) => api('POST', '/api/consolidacion/importar', { ...adm(), body: s });

test('Contable.RN17/RF23: CON-CONSOL exige USU-CONSOL y, apagada, no hay equivalencias ni consolidado', async () => {
  assert.equal((await api('GET', '/api/contable/consolidacion/balance?periodo=2026-01', g())).json.codigo, 'FUNCION_DESACTIVADA');
  const sin = await api('POST', '/api/funciones/cambiar', { token: c.adm.token, body: { activar: ['CON-CONSOL'], motivo: 'prueba' } });
  assert.notEqual(sin.status, 200); // depende de USU-CONSOL
  assert.equal((await api('POST', '/api/funciones/cambiar', { token: c.adm.token, body: { activar: ['USU-CONSOL', 'CON-CONSOL'], motivo: 'prueba' } })).status, 200);
  const cfg = await api('PUT', '/api/consolidacion/configuracion', { ...adm(), body: { sucursal: true, casa_central: true } });
  assert.equal(cfg.status, 200);
  clavePublica = cfg.json.clave_publica;
  for (const [codigo, modulos] of [['SUC1', ['contable']], ['SUC2', ['contable']], ['SUC3', ['ventas']], ['SUC4', ['contable']]])
    assert.equal((await api('POST', '/api/consolidacion/sucursales', { ...adm(), body: { codigo, nombre: `Sucursal ${codigo}`, clave_publica: clavePublica, modulos, desde: '2026-01-01' } })).status, 201, codigo);
});

test('Contable.RF22: la sucursal publica su balance del período como paquete firmado de solo lectura, sin asientos ni documentos', async () => {
  assert.equal((await api('POST', '/api/contable/asientos-manuales', { ...g(), headers: sol(), body: { fecha: c.hoy, leyenda: 'Aporte', lineas: [{ cuenta_id: c.clave('caja').id, debe: 500 }, { cuenta_id: c.clave('capital').id, haber: 500 }] } })).status, 201);
  const b = await Consol.balanceMes(c.hoy);
  assert.equal(b.periodo_contable, c.hoy.slice(0, 7));
  assert.equal(b.estado, 'provisorio'); // el período está abierto
  assert.deepEqual(Object.keys(b).sort(), ['estado', 'hasta', 'lineas', 'periodo_contable']);
  const caja = b.lineas.find((l) => l.codigo === c.clave('caja').codigo);
  assert.deepEqual([caja.saldo_inicial, caja.debe, caja.haber, caja.saldo_final], [0, 500, 0, 500]);
  assert.deepEqual(Object.keys(caja).sort(), ['codigo', 'debe', 'haber', 'nombre', 'saldo_final', 'saldo_inicial']);
  // Publicar: el período tiene que haber terminado y el paquete es idempotente.
  const ayer = new Date(Date.now() - 86400000); const dia = `${ayer.getFullYear()}-${String(ayer.getMonth() + 1).padStart(2, '0')}-${String(ayer.getDate()).padStart(2, '0')}`;
  const pub = await api('POST', '/api/consolidacion/publicar', { ...adm(), body: { periodo: dia, modulo: 'contable' } });
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  assert.equal(pub.json[0].modulo, 'contable');
  assert.equal((await api('POST', '/api/consolidacion/publicar', { ...adm(), body: { periodo: dia, modulo: 'contable' } })).json[0].nuevo, false);
});

test('Contable.EX15: un paquete con cuentas sin equivalencia, con firma inválida o mal formado se rechaza completo', async () => {
  const mes = mesAnterior();
  const contenido = { periodo_contable: mes, hasta: finDeMes(mes), estado: 'definitivo', lineas: [linea('CAJA', 'Caja', 0, 1000, 0), linea('CAP', 'Capital', 0, 0, 1000)] };
  const sinEq = await importar(await sobre('SUC1', contenido));
  assert.equal(sinEq.status, 422);
  assert.match(sinEq.json.motivo, /sin equivalencia.*CAJA/);
  // Las equivalencias hacia cuentas que no existen o no son imputables no se aceptan.
  const mala = await api('PUT', '/api/contable/consolidacion/equivalencias/SUC1', { ...g(), body: { equivalencias: { CAJA: '9.9.99', CAP: c.clave('capital').codigo } } });
  assert.equal(mala.status, 400);
  assert.equal(mala.json.codigo, 'EQUIVALENCIA_INVALIDA');
  assert.equal((await api('PUT', '/api/contable/consolidacion/equivalencias/NOEXISTE', { ...g(), body: { equivalencias: { A: c.clave('caja').codigo } } })).status, 404);
  for (const s of ['SUC1', 'SUC2', 'SUC4']) assert.equal((await api('PUT', `/api/contable/consolidacion/equivalencias/${s}`, { ...g(), body: { equivalencias: { CAJA: c.clave('caja').codigo, CAP: c.clave('capital').codigo, VTA: c.clave('ventas_salon').codigo } } })).status, 200);
  assert.equal((await api('GET', '/api/contable/consolidacion/equivalencias/SUC1', g())).json.length, 3);
  // Firma alterada y formato inválido.
  const firmaMala = { ...(await sobre('SUC1', contenido)), firma: 'AAAA' };
  assert.match((await importar(firmaMala)).json.motivo, /firma/);
  const sinEstado = await sobre('SUC1', { periodo_contable: mes, lineas: [] });
  assert.match((await importar(sinEstado)).json.motivo, /formato/);
  const [[{ n }]] = await pool.query("SELECT COUNT(*) n FROM paquetes_recibidos WHERE modulo = 'contable' AND estado = 'importado'");
  assert.equal(Number(n), 0); // no se importó nada parcial
});

test('Contable.RN26/EX15: un paquete válido se importa una sola vez y el reimportado no duplica saldos', async () => {
  const mes = mesAnterior();
  const contenido = { periodo_contable: mes, hasta: finDeMes(mes), estado: 'definitivo', lineas: [linea('CAJA', 'Caja', 0, 1000, 0), linea('CAP', 'Capital', 0, 0, 1000)] };
  const s = await sobre('SUC1', contenido);
  const ok = await importar(s);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.importado, true);
  const otra = await importar(s);
  assert.equal(otra.json.ya_importado, true);
  const prov = { periodo_contable: mes, hasta: finDeMes(mes), estado: 'definitivo', lineas: [linea('CAJA', 'Caja', 0, 400, 0), linea('VTA', 'Ventas', 0, 0, 400)] };
  assert.equal((await importar(await sobre('SUC2', prov))).json.importado, true);
  const b = (await api('GET', `/api/contable/consolidacion/balance?periodo=${mes}`, g())).json;
  const caja = b.filas.find((f) => f.codigo === c.clave('caja').codigo);
  assert.equal(caja.saldo_final, 1400); // 1000 + 400, una sola vez
  assert.deepEqual(caja.sucursales, { SUC1: 1000, SUC2: 400 });
});

test('Contable.RF23/EX16/EX17: el consolidado tiene total y columna por sucursal e indica las que faltan, las provisorias y las sin Contable', async () => {
  const mes = mesAnterior();
  const b = (await api('GET', `/api/contable/consolidacion/balance?periodo=${mes}`, g())).json;
  const por = Object.fromEntries(b.sucursales.map((s) => [s.codigo, s.estado]));
  assert.equal(por.SUC1, 'ok');
  assert.equal(por.SUC2, 'ok');
  assert.equal(por.SUC3, 'sin_contable'); // EX17: no entra en los totales
  assert.equal(por.SUC4, 'falta'); // EX16
  assert.equal(b.estado, 'incompleto');
  assert.deepEqual(b.sucursales_faltantes, ['SUC4']);
  assert.deepEqual(b.sin_contable, ['SUC3']);
  assert.equal(b.cuadra, true); // debe = haber y saldos suman cero
  assert.equal(b.totales.debe, b.totales.haber);
  assert.equal(b.totales.debe, 1400);
  // Llega el paquete provisorio de la que faltaba: el informe pasa a «provisorio».
  const prov = { periodo_contable: mes, hasta: `${mes}-15`, estado: 'provisorio', lineas: [linea('CAJA', 'Caja', 0, 50, 0), linea('CAP', 'Capital', 0, 0, 50)] };
  assert.equal((await importar(await sobre('SUC4', prov, { periodo: `${mes}-15` }))).json.importado, true);
  const p = (await api('GET', `/api/contable/consolidacion/balance?periodo=${mes}`, g())).json;
  assert.equal(p.estado, 'provisorio');
  assert.deepEqual(p.sucursales_provisorias, ['SUC4']);
  // El definitivo (versión 2, más tarde en el período) reemplaza al provisorio.
  const defin = { periodo_contable: mes, hasta: finDeMes(mes), estado: 'definitivo', lineas: [linea('CAJA', 'Caja', 0, 80, 0), linea('CAP', 'Capital', 0, 0, 80)] };
  assert.equal((await importar(await sobre('SUC4', defin, { version: 2 }))).json.importado, true);
  const d = (await api('GET', `/api/contable/consolidacion/balance?periodo=${mes}`, g())).json;
  assert.equal(d.estado, 'completo');
  assert.equal(d.filas.find((f) => f.codigo === c.clave('caja').codigo).sucursales.SUC4, 80);
  assert.equal(d.cuadra, true);
});

test('Contable.RF23: el balance consolidado suma la contabilidad propia de la Casa Central y marca su período abierto como provisorio', async () => {
  const mes = c.hoy.slice(0, 7);
  const b = (await api('GET', `/api/contable/consolidacion/balance?periodo=${mes}`, g())).json;
  const propia = b.sucursales.find((s) => s.propia);
  assert.equal(propia.estado, 'provisorio');
  assert.equal(b.filas.find((f) => f.codigo === c.clave('caja').codigo).sucursales[propia.codigo], 500);
  assert.equal(b.estado, 'incompleto'); // en el mes actual no llegaron los paquetes de las sucursales
  assert.equal((await api('GET', '/api/contable/consolidacion/balance?periodo=mañana', g())).status, 400);
});

test('Contable.RF23: el consolidado se exporta con permiso y la consolidación no toca la contabilidad de la sucursal', async () => {
  const mes = mesAnterior();
  assert.equal((await api('GET', `/api/contable/consolidacion/balance?periodo=${mes}&formato=xlsx`, g())).status, 200);
  assert.equal((await api('GET', `/api/contable/consolidacion/balance?periodo=${mes}&formato=xlsx`, { token: c.cajero.token })).status, 403);
  const antes = (await pool.query('SELECT COUNT(*) n FROM con_asientos'))[0][0].n;
  await api('GET', `/api/contable/consolidacion/balance?periodo=${mes}`, g());
  assert.equal((await pool.query('SELECT COUNT(*) n FROM con_asientos'))[0][0].n, antes);
});
