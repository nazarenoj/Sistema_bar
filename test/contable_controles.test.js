const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { preparar } = require('./ayudas_contable');
const Consultas = require('../src/modulos/consultas');

let api, pool, cerrar, c, k = 0;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  c = await preparar(api, pool, { antes: async ({ adm }) => {
    for (const m of ['compras', 'financiero', 'clientes']) assert.equal((await api('POST', `/api/modulos/${m}/instalar`, { token: adm.token })).status, 200, m);
  } });
});
after(async () => { await cerrar(); });

const g = () => ({ token: c.gerente.token });
const sol = () => ({ 'X-ID-Solicitud': `ctl-${++k}-${Math.random().toString(36).slice(2, 10)}` });
// Reemplaza la respuesta de un módulo (como si tuviera esos saldos) y devuelve cómo dejarla.
const falsear = (modulo, nombre, valor) => {
  const previo = Consultas.obtener(modulo, nombre);
  Consultas.registrar(modulo, nombre, typeof valor === 'function' ? valor : async () => valor);
  return () => Consultas.registrar(modulo, nombre, previo);
};

test('Contable.RF13: el asiento de apertura se propone con los saldos que informan los módulos y se confirma editable', async () => {
  const restaurar = [
    falsear('financiero', 'saldos', { caja: 5000, bancos: 20000, total: 25000 }),
    falsear('stock', 'inventario', { total: 12000, items: 3, sin_costo: 0 }),
    falsear('clientes', 'deudores', { total: 3000 }),
    falsear('compras', 'proveedores', { total: 8000 }),
  ];
  const p = (await api('GET', '/api/contable/apertura', g())).json;
  assert.equal(p.fecha, c.hoy);
  assert.equal(p.registrada, false);
  const por = (clave) => p.lineas.find((l) => l.cuenta_id === c.clave(clave).id);
  assert.equal(por('caja').debe, 5000);
  assert.equal(por('bancos').debe, 20000);
  assert.equal(por('insumos').debe, 12000);
  assert.equal(por('deudores').debe, 3000);
  assert.equal(por('proveedores').haber, 8000);
  assert.equal(por('capital').haber, 32000); // el patrimonio neto cierra la partida doble
  assert.equal(p.total_debe, p.total_haber);
  assert.deepEqual(p.fuentes.map((f) => f.estado), ['ok', 'ok', 'ok', 'ok']);
  // Se edita antes de registrar: Stock se corrige a mano.
  const lineas = p.lineas.map((l) => (l.cuenta_id === c.clave('insumos').id ? { ...l, debe: 11000 } : l.cuenta_id === c.clave('capital').id ? { ...l, haber: 31000 } : l));
  const mal = await api('POST', '/api/contable/apertura', { ...g(), headers: sol(), body: { lineas: lineas.map((l) => (l.cuenta_id === c.clave('capital').id ? { ...l, haber: 30000 } : l)) } });
  assert.equal(mal.status, 400);
  assert.equal(mal.json.codigo, 'ASIENTO_DESBALANCEADO');
  const ok = await api('POST', '/api/contable/apertura', { ...g(), headers: sol(), body: { lineas } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.tipo, 'apertura');
  assert.equal(ok.json.fecha, c.hoy);
  assert.equal((await api('GET', '/api/contable/config', g())).json.asiento_apertura_id, ok.json.id);
  for (const r of restaurar) r();
});

test('Contable.EX12: no se registra un segundo asiento de apertura ni se cambia la fecha de inicio', async () => {
  const otra = await api('POST', '/api/contable/apertura', { ...g(), headers: sol(), body: { lineas: [{ cuenta_id: c.clave('caja').id, debe: 1 }, { cuenta_id: c.clave('capital').id, haber: 1 }] } });
  assert.equal(otra.status, 409);
  assert.equal(otra.json.codigo, 'APERTURA_REGISTRADA');
  const manana = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  assert.equal((await api('POST', '/api/contable/config/iniciar', { ...g(), body: { fecha_inicio: manana, perfil: 'cafeteria' } })).json.codigo, 'INICIO_FIJO');
  assert.equal((await api('POST', '/api/contable/apertura', { token: c.cajero.token, headers: sol(), body: {} })).status, 403);
});

test('Contable.RF11/EX06: los controles cruzados comparan cada saldo contable con el del módulo e informan las diferencias', async () => {
  const restaurar = [
    falsear('financiero', 'saldos', { caja: 5000, bancos: 20000, total: 25000 }),
    falsear('stock', 'inventario', { total: 11500, items: 3, sin_costo: 0 }), // el contable es 11000
    falsear('clientes', 'deudores', { total: 3000 }),
    falsear('compras', 'proveedores', { total: 8000 }),
  ];
  const r = await api('POST', '/api/contable/controles/ejecutar', { ...g(), body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const por = Object.fromEntries(r.json.controles.map((x) => [x.id, x]));
  assert.equal(por.cajas_bancos.estado, 'ok');
  assert.equal(por.proveedores.estado, 'ok');
  assert.equal(por.deudores.estado, 'ok');
  assert.equal(por.insumos.estado, 'diferencia');
  assert.equal(por.insumos.saldo_contable, 11000);
  assert.equal(por.insumos.saldo_modulo, 11500);
  assert.equal(por.insumos.diferencia, -500);
  assert.equal(r.json.con_diferencias, 1);
  assert.equal(r.json.bloquea_cierre, false); // no bloquea el cierre salvo que esté configurado
  assert.equal((await api('GET', '/api/contable/controles', g())).json.id, r.json.id); // el informe queda
  await api('PUT', '/api/contable/config', { ...g(), body: { bloquear_cierre_controles: true } });
  assert.equal((await api('POST', '/api/contable/controles/ejecutar', { ...g(), body: {} })).json.bloquea_cierre, true);
  await api('PUT', '/api/contable/config', { ...g(), body: { bloquear_cierre_controles: false } });
  for (const x of restaurar) x();
});

test('Contable.RF11: un módulo caído se muestra «no disponible» y no frena la contabilidad; sin el módulo no hay control', async () => {
  const restaurar = [falsear('compras', 'proveedores', async () => { throw new Error('se cayó'); }), falsear('stock', 'inventario', { total: 11000 }), falsear('financiero', 'saldos', { total: 25000 }), falsear('clientes', 'deudores', { total: 3000 })];
  const r = (await api('POST', '/api/contable/controles/ejecutar', { ...g(), body: {} })).json;
  const prov = r.controles.find((x) => x.id === 'proveedores');
  assert.equal(prov.estado, 'no_disponible');
  assert.match(prov.motivo, /compras no respondió/);
  assert.equal(r.no_disponibles, 1);
  assert.equal(r.controles.find((x) => x.id === 'cajas_bancos').estado, 'ok'); // el resto se controla igual
  // La contabilidad sigue: se puede cargar un asiento manual.
  assert.equal((await api('POST', '/api/contable/asientos-manuales', { ...g(), headers: sol(), body: { fecha: c.hoy, leyenda: 'Sigue', lineas: [{ cuenta_id: c.clave('caja').id, debe: 1 }, { cuenta_id: c.clave('capital').id, haber: 1 }] } })).status, 201);
  // Los controles de funciones apagadas (gift cards, remitos) no aparecen.
  assert.ok(!r.controles.some((x) => x.id === 'gift_cards' || x.id === 'remitos'));
  for (const x of restaurar) x();
});

test('Contable.RF11: con la función CON-CONTROLES-CRUZADOS desactivada no se comparan saldos', async () => {
  assert.equal((await api('POST', '/api/funciones/cambiar', { token: c.adm.token, body: { desactivar: ['CON-CONTROLES-CRUZADOS'], motivo: 'prueba' } })).status, 200);
  const r = await api('POST', '/api/contable/controles/ejecutar', { ...g(), body: {} });
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'FUNCION_DESACTIVADA');
  assert.equal((await api('GET', '/api/contable/libros/diario', g())).status, 200); // los demás informes siguen
  await api('POST', '/api/funciones/cambiar', { token: c.adm.token, body: { activar: ['CON-CONTROLES-CRUZADOS'], motivo: 'prueba' } });
});

test('Contable.RF07: desde un asiento se navega al documento de origen; si el módulo no responde, queda «no disponible»', async () => {
  const id = await c.vender('efectivo');
  const a = await c.asientoDe(id);
  const o = (await api('GET', `/api/contable/asientos/${a.id}/origen`, g())).json;
  assert.equal(o.manual, false);
  assert.equal(o.documentos[0].modulo, 'ventas');
  assert.equal(o.documentos[0].disponible, true);
  assert.equal(o.documentos[0].documento.id_global, id);
  assert.equal(o.documentos[0].documento.total, 250);
  // Ventas no responde: el origen figura no disponible pero el asiento se consulta.
  const restaurar = falsear('ventas', 'documento', async () => { throw new Error('sin respuesta'); });
  const caido = (await api('GET', `/api/contable/asientos/${a.id}/origen`, g())).json;
  assert.equal(caido.documentos[0].disponible, false);
  assert.match(caido.documentos[0].motivo, /ventas no respondió/);
  restaurar();
  // Un asiento manual no tiene origen.
  const man = (await api('POST', '/api/contable/asientos-manuales', { ...g(), headers: sol(), body: { fecha: c.hoy, leyenda: 'Manual', lineas: [{ cuenta_id: c.clave('caja').id, debe: 2 }, { cuenta_id: c.clave('capital').id, haber: 2 }] } })).json;
  assert.equal((await api('GET', `/api/contable/asientos/${man.id}/origen`, g())).json.manual, true);
  assert.ok(esperarMensajes);
});

test('Contable.RF03: los orígenes de otros módulos (compras, stock, financiero) se consultan por su documento', async () => {
  const doc = async (modulo, tipo, id) => (await Consultas.invocar(modulo, 'documento', { tipo, id }));
  assert.equal(await doc('compras', 'comprobante_compra', 'NO-EXISTE'), null);
  assert.equal(await doc('financiero', 'cierre_turno', 'NO-EXISTE'), null);
  assert.equal(await doc('stock', 'costo_venta', 'NO-EXISTE'), null);
  assert.equal(await doc('clientes', 'retencion_sufrida', 'NO-EXISTE'), null);
});
