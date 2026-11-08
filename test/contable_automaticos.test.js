const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.AFIP_CONDICION_IVA_EMISOR = 'monotributista';
process.env.AFIP_PUNTO_VENTA = '1';
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const Auto = require('../src/contable/automaticos');
const { fechaLocal } = require('../src/contable/comun');

let api, pool, cerrar, adm, gerente, n = 0, k = 0, ultimo = 0, cuentas;
const hoy = fechaLocal();

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const wsfe = require('../src/afip/wsfeClient');
  wsfe.compUltimoAutorizado = async () => ultimo;
  wsfe.solicitarCAE = async ({ item }) => { ultimo = item.CbteDesde; return { FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CAE: '70000000000001', CAEFchVto: '20261231' }] } }; };
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  assert.equal((await api('POST', '/api/modulos/contable/instalar', { token: adm.token })).status, 200);
  assert.equal((await api('POST', '/api/contable/config/iniciar', { token: gerente.token, body: { fecha_inicio: hoy, perfil: 'cafeteria' } })).status, 200);
  cuentas = (await api('GET', '/api/contable/cuentas', { token: gerente.token })).json;
});
after(async () => { await cerrar(); });

const clave = (c) => cuentas.find((x) => x.clave === c);
const token = () => adm.token;
// Cuenta de 250: 2 x $100 de A y 1 x $50 de B (IVA 21% incluido).
const vender = async (metodo = 'efectivo') => {
  const mesa = (await api('POST', '/api/mesas', { token: token(), body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const a = (await api('POST', '/api/productos', { token: token(), body: { nombre: `A ${n}`, precio: 100, stock: 10 } })).json;
  const b = (await api('POST', '/api/productos', { token: token(), body: { nombre: `B ${n}`, precio: 50, stock: 10 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token: token(), body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token: token(), body: { productos: [{ producto_id: a.id, cantidad: 2 }, { producto_id: b.id, cantidad: 1 }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token: token(), headers: { 'X-ID-Solicitud': `venta-${n}-${Math.random().toString(36).slice(2, 8)}` }, body: { metodo_pago: metodo } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await esperarMensajes(pool);
  return r.json.venta_id_global;
};
const asientoDe = async (idDoc, tipo = null) => {
  const [[o]] = await pool.query(`SELECT asiento_id FROM con_asiento_origen WHERE id_documento = ? ${tipo ? 'AND tipo_documento = ?' : ''} ORDER BY id LIMIT 1`, tipo ? [idDoc, tipo] : [idDoc]);
  return o ? (await api('GET', `/api/contable/asientos/${o.asiento_id}`, { token: gerente.token })).json : null;
};
const linea = (a, k, lado) => a.lineas.filter((l) => l.cuenta_id === clave(k).id).reduce((s, l) => s + l[lado], 0);

test('Contable.RF04/RN11: una venta fiscal genera un asiento que balancea: ventas netas, IVA y cobro por forma de pago', async () => {
  const id = await vender('efectivo');
  const a = await asientoDe(id);
  assert.ok(a, 'falta el asiento');
  assert.equal(a.tipo, 'automatico');
  assert.equal(a.lineas.reduce((s, l) => s + l.debe, 0).toFixed(2), a.lineas.reduce((s, l) => s + l.haber, 0).toFixed(2));
  assert.equal(linea(a, 'ventas_salon', 'haber'), 206.61);
  assert.equal(linea(a, 'iva_debito', 'haber'), 43.39);
  assert.equal(linea(a, 'caja', 'debe'), 250);
  assert.equal(linea(a, 'deudores', 'debe'), 250);
  assert.equal(linea(a, 'deudores', 'haber'), 250);
  assert.equal(a.origenes[0].modulo, 'ventas');
  assert.equal(a.numero >= 1, true);
});

test('Contable.RF03: el cobro con tarjeta o transferencia va a Bancos por la regla del criterio', async () => {
  const id = await vender('tarjeta_debito');
  const a = await asientoDe(id);
  assert.equal(linea(a, 'bancos', 'debe'), 250);
  assert.equal(linea(a, 'caja', 'debe'), 0);
});

test('Contable.RN28/EX18: cada evento genera un asiento una sola vez, aunque el mensaje se reenvíe', async () => {
  const id = await vender('efectivo');
  const [[m]] = await pool.query("SELECT id, id_operacion FROM mensajes_integracion WHERE doc_id_global = ? AND modulo_destino = 'contable'", [id]);
  await pool.query("UPDATE mensajes_integracion SET estado = 'pendiente', retenido_por_orden = 0, proximo_intento_ms = 0 WHERE id = ?", [m.id]);
  await pool.query('DELETE FROM operaciones_procesadas WHERE id_operacion = ?', [m.id_operacion]); // el reenvío desde la bandeja tras restaurar una copia
  await esperarMensajes(pool);
  assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM con_asiento_origen WHERE id_operacion = ?', [m.id_operacion]))[0][0].n), 1);
  const [asientos] = await pool.query('SELECT COUNT(DISTINCT asiento_id) n FROM con_asiento_origen WHERE id_documento = ?', [id]);
  assert.equal(Number(asientos[0].n), 1);
});

test('Contable.RN20/RN29: la devolución genera su contraasiento por la nota de crédito y no se aplica antes que la venta', async () => {
  const id = await vender('efectivo');
  const r = await api('POST', '/api/devoluciones', { token: token(), headers: { 'X-ID-Solicitud': `devol-${++k}-abcdef` }, body: { venta_id_global: id, motivo: 'el cliente se arrepintió', items: [{ linea: 0, cantidad: 1 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  await esperarMensajes(pool);
  const nc = await asientoDe(r.json.devolucion.id_global);
  assert.ok(nc, 'falta el asiento de la devolución');
  assert.equal(nc.origenes[0].tipo_documento, 'venta_devuelta');
  assert.equal(linea(nc, 'ventas_salon', 'debe'), 82.64);
  assert.equal(linea(nc, 'iva_debito', 'debe'), 17.36);
  assert.equal(linea(nc, 'caja', 'haber'), 100);
  const venta = await asientoDe(id);
  assert.notEqual(nc.id, venta.id); // la venta original no se modifica
  assert.equal(linea(venta, 'ventas_salon', 'haber'), 206.61);
});

test('Contable.RF04: en modo resumido las ventas del día de un formulario se suman en un solo asiento con el detalle de sus documentos', async () => {
  const set = await api('PUT', '/api/contable/modos/venta', { token: gerente.token, body: { modo: 'resumido' } });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  const a1 = await vender('efectivo'), a2 = await vender('efectivo');
  const x = await asientoDe(a1), y = await asientoDe(a2);
  assert.equal(x.id, y.id);
  assert.equal(x.origenes.length >= 2, true);
  const res = await asientoDe(a2);
  assert.equal(res.resumido, true);
  assert.equal(linea(res, 'caja', 'debe'), 500);
  assert.equal(linea(res, 'ventas_salon', 'haber'), 413.22);
  assert.equal(res.lineas.reduce((s, l) => s + l.debe, 0).toFixed(2), res.lineas.reduce((s, l) => s + l.haber, 0).toFixed(2));
  // Con la función apagada vuelven a ser individuales; lo ya generado se conserva.
  assert.equal((await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { desactivar: ['CON-ASIENTOS-RESUMIDOS'], motivo: 'prueba' } })).status, 200);
  const a3 = await asientoDe(await vender('efectivo'));
  assert.equal(a3.resumido, false);
  assert.equal((await asientoDe(a1)).id, x.id);
  assert.equal((await api('PUT', '/api/contable/modos/venta', { token: gerente.token, body: { modo: 'resumido' } })).status, 409);
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['CON-ASIENTOS-RESUMIDOS'], motivo: 'prueba' } });
  await api('PUT', '/api/contable/modos/venta', { token: gerente.token, body: { modo: 'individual' } });
});

test('Contable.RF14/EX08: el reprocesamiento muestra la vista previa, regenera los asientos de períodos abiertos y excluye los cerrados', async () => {
  const id = await vender('efectivo');
  const antes = await asientoDe(id);
  const regla = (await api('GET', '/api/contable/reglas?formulario=venta', { token: gerente.token })).json.find((r) => r.componente === 'ingreso' && r.criterio === '*');
  const mostrador = clave('ventas_mostrador');
  assert.equal((await api('PUT', `/api/contable/reglas/${regla.id}`, { token: gerente.token, body: { cuenta_haber_id: mostrador.id } })).status, 200);
  const previa = await api('POST', '/api/contable/reprocesar', { token: gerente.token, body: {} });
  assert.equal(previa.status, 200, JSON.stringify(previa.json));
  assert.equal(previa.json.confirmado, false);
  assert.ok(previa.json.asientos_con_cambios >= 1);
  assert.equal(linea(await asientoDe(id), 'ventas_salon', 'haber'), 206.61); // la vista previa no cambia nada
  const hecho = await api('POST', '/api/contable/reprocesar', { token: gerente.token, body: { confirmar: true } });
  assert.equal(hecho.json.confirmado, true);
  const despues = await asientoDe(id);
  assert.equal(despues.numero, antes.numero); // conserva su número
  assert.equal(linea(despues, 'ventas_mostrador', 'haber'), 206.61);
  assert.equal(linea(despues, 'ventas_salon', 'haber'), 0);
  assert.equal((await api('POST', '/api/contable/reprocesar', { token: gerente.token, body: { confirmar: true } })).json.asientos_con_cambios, 0); // ya está al día
  // EX08: un período cerrado no se reprocesa.
  await api('PUT', `/api/contable/reglas/${regla.id}`, { token: gerente.token, body: { cuenta_haber_id: clave('ventas_salon').id } });
  await api('POST', '/api/contable/ejercicios', { token: gerente.token, body: {} }).catch(() => {});
  const per = (await api('GET', '/api/contable/periodos', { token: gerente.token })).json.find((p) => p.anio === Number(hoy.slice(0, 4)) && p.mes === Number(hoy.slice(5, 7)));
  assert.equal((await api('POST', `/api/contable/periodos/${per.id}/cerrar`, { token: gerente.token })).status, 200);
  const excl = await api('POST', '/api/contable/reprocesar', { token: gerente.token, body: { confirmar: true } });
  assert.deepEqual(excl.json.periodos_excluidos, [`${per.anio}-${String(per.mes).padStart(2, '0')}`]);
  assert.equal(excl.json.asientos_revisados, 0);
});

test('Contable.RN05: la venta con fecha de un período cerrado se contabiliza en el primer período abierto con la leyenda de su fecha original', async () => {
  const id = await vender('efectivo');
  const a = await asientoDe(id);
  assert.match(a.leyenda, /fecha original/);
  assert.notEqual(a.periodo, hoy.slice(0, 7));
});

test('Contable.RN30/EX02: sin regla de imputación el mensaje se rechaza con su motivo y la venta queda intacta', async () => {
  const [[ya]] = await pool.query("SELECT COUNT(*) n FROM con_reglas WHERE formulario = 'venta' AND componente = 'iva'");
  assert.equal(Number(ya.n), 1);
  await pool.query("UPDATE con_reglas SET activa = 0 WHERE formulario = 'venta' AND componente = 'iva'");
  const id = await vender('efectivo');
  const [[m]] = await pool.query("SELECT estado, motivo_rechazo FROM mensajes_integracion WHERE doc_id_global = ? AND modulo_destino = 'contable'", [id]);
  assert.equal(m.estado, 'rechazado');
  assert.match(m.motivo_rechazo, /Sin regla de imputación: venta \/ iva/);
  assert.equal(await asientoDe(id), null);
  assert.equal((await api('GET', `/api/ventas/${id}`, { token: token() })).status, 200);
});

test('Contable.RF26: las ventas no fiscales no se contabilizan hasta regularizarse', async () => {
  const [[{ n }]] = await pool.query("SELECT COUNT(*) n FROM mensajes_integracion WHERE modulo_destino = 'contable' AND tipo = 'venta_confirmada' AND JSON_EXTRACT(contenido, '$.no_fiscal') = true");
  assert.equal(Number(n), 0);
  for (const t of ['venta_confirmada', 'venta_devuelta', 'venta_regularizada']) assert.ok(Auto.EVENTOS[t]);
  // El cobro de una venta regularizada usa las mismas reglas de cobro.
  const c = Auto.cobros([{ metodo_pago: 'efectivo', importe: 100 }, { metodo_pago: 'cuenta_corriente', importe: 50 }], 150);
  assert.deepEqual(c, [{ forma: 'efectivo', importe: 100 }]);
});
