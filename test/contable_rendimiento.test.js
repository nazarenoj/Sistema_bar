const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { iniciarApp } = require('./ayudas');
const { preparar } = require('./ayudas_contable');
const C = require('../src/servicios/consolidacionService');
const Consol = require('../src/contable/consolidacion');
const Libros = require('../src/contable/libroService');
const { version: VERSION } = require('../package.json');

let api, pool, cerrar, c;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  c = await preparar(api, pool);
});
after(async () => { await cerrar(); });

const medir = async (fn) => { const t = Date.now(); const r = await fn(); return { r, ms: Date.now() - t }; };

test('Contable.RN16/RF22: el balance y el paquete de consolidación de un plan de 2.000 cuentas salen en menos de 10 segundos', async () => {
  const [[padre]] = await pool.query("SELECT id FROM con_cuentas WHERE codigo = '1.1'");
  const filas = Array.from({ length: 2000 }, (_, i) => [`9.${String(i).padStart(4, '0')}`, `Cuenta de prueba ${i}`, 'activo', padre.id, 1]);
  await pool.query('INSERT INTO con_cuentas (codigo, nombre, tipo, padre_id, imputable) VALUES ?', [filas]);
  const [cuentas] = await pool.query("SELECT id FROM con_cuentas WHERE codigo LIKE '9.%' ORDER BY codigo");
  // Un asiento por cuenta contra Capital, en lotes.
  const [[per]] = await pool.query('SELECT id, ejercicio_id FROM con_periodos ORDER BY anio, mes LIMIT 1');
  const [[capital]] = await pool.query("SELECT id FROM con_cuentas WHERE clave = 'capital'");
  const ahora = new Date(); const hoy = c.hoy;
  const asientos = cuentas.map((x, i) => [i + 1, per.ejercicio_id, per.id, hoy, 'manual', `Asiento ${i}`, 'registrado', Date.now()]);
  await pool.query('INSERT INTO con_asientos (numero, ejercicio_id, periodo_id, fecha, tipo, leyenda, estado, creado_ms) VALUES ?', [asientos]);
  const [ids] = await pool.query("SELECT id FROM con_asientos WHERE leyenda LIKE 'Asiento %' ORDER BY id");
  const lineas = [];
  ids.forEach((a, i) => { lineas.push([a.id, cuentas[i].id, 10, 0], [a.id, capital.id, 0, 10]); });
  await pool.query('INSERT INTO con_asiento_lineas (asiento_id, cuenta_id, debe, haber) VALUES ?', [lineas]);
  assert.ok(ahora);
  const pq = await medir(() => Consol.balanceMes(hoy));
  assert.ok(pq.r.lineas.length >= 2000);
  assert.ok(pq.ms < 10000, `paquete: ${pq.ms} ms`);
  const bal = await medir(() => Libros.balance({ periodo: hoy.slice(0, 7) }));
  assert.equal(bal.r.cuadra, true);
  assert.ok(bal.ms < 10000, `balance: ${bal.ms} ms`);
  const dia = await medir(() => Libros.diario({ periodo: hoy.slice(0, 7) }));
  assert.ok(dia.r.asientos.length >= 2000);
  assert.ok(dia.ms < 10000, `diario: ${dia.ms} ms`);
});

test('Contable.RF23: el balance consolidado con 20 sucursales sale en menos de 10 segundos', async () => {
  assert.equal((await api('POST', '/api/funciones/cambiar', { token: c.adm.token, body: { activar: ['USU-CONSOL', 'CON-CONSOL'], motivo: 'prueba' } })).status, 200);
  const cfg = await api('PUT', '/api/consolidacion/configuracion', { token: c.adm.token, body: { sucursal: true, casa_central: true } });
  assert.equal(cfg.status, 200);
  const [[{ clave_privada: priv }]] = await pool.query('SELECT clave_privada FROM consolidacion_config WHERE id = 1');
  const mes = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
  const fin = `${mes}-${String(new Date(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0).getDate()).padStart(2, '0')}`;
  const [plan] = await pool.query("SELECT codigo FROM con_cuentas WHERE codigo LIKE '9.%' ORDER BY codigo LIMIT 300");
  for (let s = 1; s <= 20; s++) {
    const codigo = `S${String(s).padStart(2, '0')}`;
    assert.equal((await api('POST', '/api/consolidacion/sucursales', { token: c.adm.token, body: { codigo, nombre: `Sucursal ${s}`, clave_publica: cfg.json.clave_publica, modulos: ['contable'], desde: '2026-01-01' } })).status, 201);
    await pool.query('INSERT INTO con_equivalencias_consol (sucursal, codigo_sucursal, codigo_central) VALUES ?', [plan.map((p, i) => [codigo, `L${i}`, p.codigo])]);
    const lineas = plan.map((p, i) => ({ codigo: `L${i}`, nombre: `L${i}`, saldo_inicial: 0, debe: 100, haber: 0, saldo_final: 100 }));
    lineas.push({ codigo: 'CAP', nombre: 'Capital', saldo_inicial: 0, debe: 0, haber: 100 * plan.length, saldo_final: -100 * plan.length });
    await pool.query('INSERT IGNORE INTO con_equivalencias_consol (sucursal, codigo_sucursal, codigo_central) VALUES (?, ?, ?)', [codigo, 'CAP', '3.1']);
    const contenido = { periodo_contable: mes, hasta: fin, estado: 'definitivo', lineas };
    const cuerpo = { sucursal: codigo, modulo: 'contable', periodo: fin, version: 1, version_sistema: VERSION, huella: C.huellaDe(contenido) };
    const sobre = { id_paquete: `${codigo}-contable-${fin}-v1`, ...cuerpo, contenido, firma: crypto.sign(null, Buffer.from(C.firmado(cuerpo)), priv).toString('base64') };
    assert.equal((await C.importar(sobre)).importado, true);
  }
  const t = await medir(() => Consol.consolidado({ periodo: mes }));
  assert.equal(t.r.estado, 'completo');
  assert.equal(t.r.sucursales.filter((x) => x.estado === 'ok').length, 21); // 20 sucursales y la propia
  assert.equal(t.r.cuadra, true);
  assert.ok(t.ms < 10000, `consolidado: ${t.ms} ms`);
});
