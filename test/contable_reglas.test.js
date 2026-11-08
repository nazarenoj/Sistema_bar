const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const Periodos = require('../src/contable/periodoService');
const Reglas = require('../src/contable/reglaService');
const { fechaLocal } = require('../src/contable/comun');

let api, pool, cerrar, adm, gerente, cajero;
const hoy = fechaLocal();
let cuentas;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  cajero = await usuario(api, pool, 'cami', 'cajero');
  await api('POST', '/api/modulos/contable/instalar', { token: adm.token });
  const r = await api('POST', '/api/contable/config/iniciar', { token: gerente.token, body: { fecha_inicio: hoy, perfil: 'cafeteria' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  cuentas = (await api('GET', '/api/contable/cuentas', { token: gerente.token })).json;
});
after(async () => { await cerrar(); });

const clave = (k) => cuentas.find((c) => c.clave === k);
const h = () => ({ token: gerente.token });

test('Contable.RF02: el primer ejercicio nace con sus períodos mensuales abiertos y se pueden agregar ejercicios contiguos', async () => {
  const ej = (await api('GET', '/api/contable/ejercicios', h())).json;
  assert.equal(ej.length, 1);
  assert.equal(ej[0].desde, hoy);
  assert.equal(ej[0].hasta, `${hoy.slice(0, 4)}-12-31`);
  const per = (await api('GET', `/api/contable/periodos?ejercicio_id=${ej[0].id}`, h())).json;
  assert.ok(per.length >= 1 && per.every((p) => p.estado === 'abierto'));
  const sig = await api('POST', '/api/contable/ejercicios', { ...h(), body: {} });
  assert.equal(sig.status, 201);
  assert.equal(sig.json.desde, `${Number(hoy.slice(0, 4)) + 1}-01-01`);
  assert.equal((await api('POST', '/api/contable/ejercicios', { ...h(), body: { hasta: `${Number(hoy.slice(0, 4)) + 2}-06-15` } })).status, 400); // no termina fin de mes
  assert.equal((await api('POST', '/api/contable/ejercicios', { ...h(), body: { hasta: `${Number(hoy.slice(0, 4)) + 3}-12-31` } })).status, 400); // más de 12 meses
});

test('Contable.RN05/RN06/EX03: un período cerrado no admite asientos, desplaza a uno abierto y reabrir pide motivo y permiso', async () => {
  const [ej] = (await api('GET', '/api/contable/ejercicios', h())).json;
  const per = (await api('GET', `/api/contable/periodos?ejercicio_id=${ej.id}`, h())).json;
  const actual = per[0];
  assert.equal((await api('POST', `/api/contable/periodos/${actual.id}/cerrar`, { token: cajero.token })).status, 403);
  assert.equal((await api('POST', `/api/contable/periodos/${actual.id}/cerrar`, h())).status, 200);
  assert.equal((await api('POST', `/api/contable/periodos/${actual.id}/cerrar`, h())).status, 409);
  // Con fecha del período cerrado un movimiento de módulo va al primer período abierto; uno manual se rechaza.
  const r = await Periodos.periodoPara(pool, hoy);
  if (per.length > 1) {
    assert.equal(r.desplazado, true);
    assert.equal(r.fechaOriginal, hoy);
    assert.notEqual(r.periodo.id, actual.id);
    assert.equal(r.periodo.estado, 'abierto');
  }
  await assert.rejects(Periodos.periodoPara(pool, hoy, { exacto: true }), (e) => e.codigo === 'PERIODO_CERRADO');
  // Reabrir exige motivo.
  assert.equal((await api('POST', `/api/contable/periodos/${actual.id}/reabrir`, { ...h(), body: {} })).status, 403); // el gerente necesita autorización de un supervisor
  const re = await api('POST', `/api/contable/periodos/${actual.id}/reabrir`, { token: (await usuario(api, pool, 'cont', 'contador')).token, body: { motivo: 'Corregir un asiento mal imputado' } });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  assert.equal(re.json.estado, 'abierto');
  const log = (await api('GET', `/api/contable/periodos/${actual.id}/historial`, h())).json;
  assert.deepEqual(log.map((l) => l.accion), ['cierre', 'reapertura']);
  assert.match(log[1].motivo, /mal imputado/);
});

test('Contable.RN05: una fecha posterior al último ejercicio agrega ejercicios y una anterior al inicio se rechaza', async () => {
  const lejos = `${Number(hoy.slice(0, 4)) + 2}-03-10`;
  const r = await Periodos.periodoPara(pool, lejos);
  assert.equal(r.periodo.anio, Number(hoy.slice(0, 4)) + 2);
  assert.equal(r.desplazado, false);
  await assert.rejects(Periodos.periodoPara(pool, `${Number(hoy.slice(0, 4)) - 1}-01-01`), (e) => e.codigo === 'ANTERIOR_AL_INICIO');
});

test('Contable.RF03: al iniciar se cargan reglas predeterminadas solo de los formularios disponibles', async () => {
  const forms = (await api('GET', '/api/contable/formularios', h())).json.map((f) => f.id);
  assert.ok(forms.includes('venta') && forms.includes('nota_credito_venta') && forms.includes('venta_regularizada'));
  assert.ok(forms.includes('costo_ventas') && !forms.includes('comprobante_compra') && !forms.includes('emision_gift_card')); // módulos sin instalar
  const reglas = (await api('GET', '/api/contable/reglas', h())).json;
  const cobro = reglas.find((r) => r.formulario === 'venta' && r.componente === 'cobro');
  assert.equal(cobro.criterio, '*');
  assert.equal(cobro.activa, true);
  assert.match(cobro.cuenta_debe, /Cajas por turno/);
  assert.match(cobro.cuenta_haber, /Deudores por ventas/);
  assert.ok(reglas.some((r) => r.formulario === 'costo_ventas') && !reglas.some((r) => r.formulario === 'comprobante_compra'));
});

test('Contable.RF03: una regla de un formulario no disponible no se crea; al instalar el módulo se suman sus reglas predeterminadas', async () => {
  const r = await api('POST', '/api/contable/reglas', { ...h(), body: { formulario: 'comprobante_compra', componente: 'gasto', cuenta_debe_id: clave('caja').id, cuenta_haber_id: clave('deudores').id } });
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'FORMULARIO_NO_DISPONIBLE');
  await api('POST', '/api/modulos/compras/instalar', { token: adm.token });
  const forms = (await api('GET', '/api/contable/formularios', h())).json.map((f) => f.id);
  assert.ok(forms.includes('comprobante_compra') && forms.includes('orden_pago'));
  const s = await api('POST', '/api/contable/reglas/predeterminadas', h());
  assert.equal(s.status, 200);
  assert.ok(s.json.nuevas >= 1);
  assert.equal((await api('POST', '/api/contable/reglas/predeterminadas', h())).json.nuevas, 0); // idempotente
});

test('Contable.EX04: una regla con una cuenta inactiva o no imputable no se guarda ni se activa', async () => {
  const noImputable = cuentas.find((c) => !c.imputable && c.tipo === 'activo');
  const r1 = await api('POST', '/api/contable/reglas', { ...h(), body: { formulario: 'venta', componente: 'cobro', criterio: 'efectivo', cuenta_debe_id: noImputable.id, cuenta_haber_id: clave('deudores').id } });
  assert.equal(r1.status, 409);
  assert.equal(r1.json.codigo, 'CUENTA_NO_IMPUTABLE');
  const r2 = await api('POST', '/api/contable/reglas', { ...h(), body: { formulario: 'venta', componente: 'cobro', criterio: 'efectivo', cuenta_haber_id: clave('deudores').id } });
  assert.equal(r2.status, 400);
  assert.equal(r2.json.codigo, 'FALTA_CUENTA');
  await api('POST', `/api/contable/cuentas/${clave('bancos').id}/estado`, { ...h(), body: { activa: false } });
  const r3 = await api('POST', '/api/contable/reglas', { ...h(), body: { formulario: 'venta', componente: 'cobro', criterio: 'tarjeta', cuenta_debe_id: clave('bancos').id, cuenta_haber_id: clave('deudores').id } });
  assert.equal(r3.status, 409);
  assert.equal(r3.json.codigo, 'CUENTA_INACTIVA');
  await api('POST', `/api/contable/cuentas/${clave('bancos').id}/estado`, { ...h(), body: { activa: true } });
  // Un criterio válido y específico se crea y la resolución lo prefiere a la regla general.
  const ok = await api('POST', '/api/contable/reglas', { ...h(), body: { formulario: 'venta', componente: 'cobro', criterio: 'tarjeta', cuenta_debe_id: clave('bancos').id, cuenta_haber_id: clave('deudores').id } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal((await Reglas.resolver(pool, 'venta', 'cobro', 'tarjeta', hoy)).cuenta_debe_id, clave('bancos').id);
  assert.equal((await Reglas.resolver(pool, 'venta', 'cobro', 'efectivo', hoy)).cuenta_debe_id, clave('caja').id); // cae a la general
  // Un componente sin criterios no admite uno específico.
  assert.equal((await api('POST', '/api/contable/reglas', { ...h(), body: { formulario: 'venta', componente: 'iva', criterio: 'x', cuenta_debe_id: clave('deudores').id, cuenta_haber_id: clave('iva_debito').id } })).status, 400);
});

test('Contable.EX04: desactivar una cuenta que usan reglas vigentes advierte y lista las reglas; no se elimina', async () => {
  const caja = clave('caja');
  const r = await api('POST', `/api/contable/cuentas/${caja.id}/estado`, { ...h(), body: { activa: false } });
  assert.equal(r.status, 200);
  assert.ok(r.json.reglas.length >= 1 && r.json.advertencia);
  await api('POST', `/api/contable/cuentas/${caja.id}/estado`, { ...h(), body: { activa: true } });
  const del = await api('DELETE', `/api/contable/cuentas/${caja.id}`, h());
  assert.equal(del.status, 409);
  assert.equal(del.json.codigo, 'CON_REGLAS');
});

test('Contable.RN34: la regla que se aplica es la vigente a la fecha del documento', async () => {
  const ayer = fechaLocal(new Date(Date.now() - 86400000)), manana = fechaLocal(new Date(Date.now() + 86400000));
  const base = (await Reglas.resolver(pool, 'venta', 'iva', null, hoy));
  const nueva = await api('POST', '/api/contable/reglas', { ...h(), body: { formulario: 'venta', componente: 'iva', vigencia_desde: manana, cuenta_debe_id: clave('deudores').id, cuenta_haber_id: clave('comisiones_tarjetas').id } });
  assert.equal(nueva.status, 201, JSON.stringify(nueva.json));
  assert.equal((await Reglas.resolver(pool, 'venta', 'iva', null, hoy)).id, base.id);
  assert.equal((await Reglas.resolver(pool, 'venta', 'iva', null, manana)).id, nueva.json.id);
  assert.equal(await Reglas.resolver(pool, 'venta', 'iva', null, ayer), null); // antes de toda vigencia no hay regla
});

test('Contable.EX13: la regla de gift cards, vales o comisiones cuyo haber no es un pasivo exige confirmación', async () => {
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['VEN-COMISIONES'], motivo: 'prueba' } });
  const f = await api('GET', '/api/contable/formularios', h());
  assert.ok(f.json.some((x) => x.id === 'comision_vendedor'));
  const body = { formulario: 'comision_vendedor', componente: 'devengo', criterio: '*', cuenta_debe_id: clave('compras').id, cuenta_haber_id: clave('capital').id };
  const sin = await api('POST', '/api/contable/reglas', { ...h(), body });
  assert.equal(sin.status, 409);
  assert.equal(sin.json.codigo, 'CONFIRMAR_NO_PASIVO');
  assert.equal((await api('POST', '/api/contable/reglas', { ...h(), body: { ...body, confirmar: true } })).status, 201);
});
