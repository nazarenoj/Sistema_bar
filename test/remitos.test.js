const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
process.env.AFIP_CONDICION_IVA_EMISOR = 'monotributista';
process.env.AFIP_PUNTO_VENTA = '1';
const { iniciarApp, esperarMensajes } = require('./ayudas');
const M = require('../src/mensajeria/servicio');

let api, pool, cerrar, token, cliente, otro, cuenta, A, B, ultimo = 0, emitidas = [], k = 0;
const dia = (hace) => { const f = new Date(Date.now() - hace * 86400000); const p = (x) => String(x).padStart(2, '0'); return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`; };

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [r] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query("INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = 'administrador'", [r.insertId]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
  const wsfe = require('../src/afip/wsfeClient');
  wsfe.compUltimoAutorizado = async () => ultimo;
  wsfe.solicitarCAE = async ({ item }) => { emitidas.push(item); ultimo = item.CbteDesde; return { FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CAE: '70000000000001', CAEFchVto: '20261231' }] } }; };
  await api('POST', '/api/modulos/clientes/instalar', { token });
  cliente = (await api('POST', '/api/clientes', { token, body: { tipo_documento: 'CUIT', nro_documento: '30711111111', razon_social: 'Panadería Sur SRL', condicion_iva: 'Responsable Inscripto', condicion_iva_receptor_id: 1, consultar_arca: false } })).json;
  otro = (await api('POST', '/api/clientes', { token, body: { tipo_documento: 'CUIT', nro_documento: '20123456786', razon_social: 'Almacén Norte', consultar_arca: false } })).json;
  A = (await api('POST', '/api/productos', { token, body: { nombre: 'Pan de campo', precio: 100 } })).json;
  B = (await api('POST', '/api/productos', { token, body: { nombre: 'Facturas x12', precio: 50 } })).json;
});
after(async () => { await cerrar(); });

const remito = (body, h = {}) => api('POST', '/api/remitos', { token, headers: { 'X-ID-Solicitud': `rem-${++k}-abcdefgh`, ...h }, body: { cliente_id: cliente.id, items: [{ producto_id: A.id, cantidad: 2 }, { producto_id: B.id, cantidad: 1 }], ...body } });
const saldo = async () => (await api('GET', `/api/cuentas-corrientes/${cuenta.id}`, { token })).json.saldo;
const movimientos = async () => (await api('GET', `/api/cuentas-corrientes/${cuenta.id}/movimientos`, { token })).json;
const facturar = (body, h = {}) => api('POST', '/api/remitos/facturar', { token, headers: { 'X-ID-Solicitud': `fac-${++k}-abcdefgh`, ...h }, body: { cliente_id: cliente.id, ...body } });

test('Ventas RF12: el remito tiene numeración propia, descuenta stock y sin asignar a la cuenta se factura aparte; asignado exige VEN-CC, veredicto y reserva', async () => {
  const r1 = await remito({});
  assert.equal(r1.status, 201, JSON.stringify(r1.json));
  assert.deepEqual([r1.json.numero, r1.json.total, r1.json.cuenta_asignada, r1.json.facturacion], [1, 250, false, 'pendiente']);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'descuento_stock'", [r1.json.id_global]))[0][0].n, 1); // el stock se descuenta con el remito
  assert.equal((await remito({ asignar_a_cuenta: true })).status, 400); // VEN-CC apagada
  await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['VEN-CC'], motivo: 'prueba' } });
  cuenta = (await api('POST', '/api/cuentas-corrientes', { token, body: { cliente_id: cliente.id, limite_credito: 100000, plazo_dias: 15 } })).json;
  const r2 = await remito({ asignar_a_cuenta: true });
  assert.equal(r2.status, 201, JSON.stringify(r2.json));
  assert.deepEqual([r2.json.numero, r2.json.cuenta_asignada], [2, true]);
  await esperarMensajes(pool);
  const m = (await movimientos())[0];
  assert.deepEqual([m.tipo, m.importe, m.comprobante_ref, m.id_reserva_credito === r2.json.id_reserva_credito], ['remito', 250, r2.json.id_global, true]); // un único mensaje: el débito de tipo Remito
  assert.equal(await saldo(), 250);
  // Idempotente por clave: el mismo envío no crea otro remito ni otro número.
  const igual = await remito({ asignar_a_cuenta: true }, { 'X-ID-Solicitud': 'rem-fijo-1-abcdef' });
  const igual2 = await remito({ asignar_a_cuenta: true }, { 'X-ID-Solicitud': 'rem-fijo-1-abcdef' });
  assert.equal(igual2.json.id_global, igual.json.id_global);
  // Con la cuenta bloqueada el remito no se asigna (RN73, EX29): sin remito, sin reserva, sin débito.
  await api('POST', `/api/cuentas-corrientes/${cuenta.id}/bloquear`, { token, body: { motivo: 'Cheques rechazados' } });
  const bloq = await remito({ asignar_a_cuenta: true });
  assert.deepEqual([bloq.status, bloq.json.codigo], [409, 'CREDITO_BLOQUEADO']);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM remitos'))[0][0].n, 3);
  await api('POST', `/api/cuentas-corrientes/${cuenta.id}/desbloquear`, { token, body: { motivo: 'Regularizó' } });
  assert.equal((await remito({ items: [{ producto_id: 99999, cantidad: 1 }] })).status, 404);
});

test('Ventas RF27: sin CLI-FACT-AGRUPADA cada remito se factura por separado', async () => {
  const lista = (await api('GET', '/api/remitos?facturacion=pendiente', { token })).json.filter((r) => r.cuenta_asignada);
  const dos = await facturar({ remitos: lista.slice(0, 2).map((r) => r.id_global) });
  assert.deepEqual([dos.status, dos.json.codigo], [409, 'SIN_FACTURACION_AGRUPADA']);
  const uno = await facturar({ remitos: [lista[0].id_global] }); // factura individual de un remito
  assert.equal(uno.status, 200, JSON.stringify(uno.json));
  assert.deepEqual([uno.json.factura.importe_total, uno.json.factura.cae], [250, '70000000000001']);
  await esperarMensajes(pool);
  assert.equal(await saldo(), 500); // la factura reemplaza al remito: la deuda no se duplica
  assert.equal((await movimientos()).find((m) => m.comprobante_ref === lista[0].id_global).estado, 'facturado');
});

test('Clientes.RN10/Ventas RN31: la factura agrupada usa los precios del día, muestra la diferencia por remito y el usuario debe aceptarla; reemplaza a los remitos sin duplicar deuda', async () => {
  await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['CLI-FACT-AGRUPADA'], motivo: 'prueba' } });
  const base = await saldo();
  const rA = (await remito({ asignar_a_cuenta: true })).json, rB = (await remito({ asignar_a_cuenta: true, items: [{ producto_id: A.id, cantidad: 1 }] })).json;
  await esperarMensajes(pool);
  assert.equal(await saldo(), base + 250 + 100);
  // Se paga una parte del primer remito: esa imputación pasa a la factura.
  const movA = (await movimientos()).find((m) => m.comprobante_ref === rA.id_global);
  await api('POST', '/api/recibos', { token, headers: { 'X-ID-Solicitud': 'rec-rem-1-abcdefgh' }, body: { cuenta_id: cuenta.id, valores: [{ forma: 'efectivo', importe: 100 }], imputacion: 'manual', imputaciones: [{ debito_id: movA.id, importe: 100 }] } });
  const pend = (await api('GET', `/api/cuentas-corrientes/remitos-pendientes?cliente_id=${cliente.id}`, { token })).json;
  assert.ok(pend.length >= 2);
  await api('PUT', `/api/productos/${A.id}`, { token, body: { nombre: 'Pan de campo', precio: 120 } }); // sube el precio: la factura sale con el del día
  const ids = [rA.id_global, rB.id_global];
  const previa = (await api('POST', '/api/cuentas-corrientes/facturacion-agrupada', { token, body: { cliente_id: cliente.id, remitos: ids, previa: true } })).json;
  assert.deepEqual(previa.remitos.map((r) => [r.importe_remito, r.importe_a_facturar, r.diferencia]), [[250, 290, 40], [100, 120, 20]]);
  assert.equal(previa.total, 410);
  const sin = await api('POST', '/api/cuentas-corrientes/facturacion-agrupada', { token, body: { cliente_id: cliente.id, remitos: ids } });
  assert.deepEqual([sin.status, sin.json.codigo], [409, 'DIFERENCIA_NO_ACEPTADA']); // si no acepta la diferencia no se emite
  assert.equal(emitidas.length, 1); // solo la factura individual de antes
  const antesFact = await saldo();
  const ok = await api('POST', '/api/cuentas-corrientes/facturacion-agrupada', { token, body: { cliente_id: cliente.id, remitos: ids, aceptar_diferencias: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.factura.importe_total, 410);
  assert.equal(emitidas.length, 2);
  assert.equal(emitidas[1].ImpTotal, 410); // UN solo comprobante por los dos remitos
  await esperarMensajes(pool);
  const movs = await movimientos();
  assert.deepEqual(movs.filter((m) => ids.includes(m.comprobante_ref)).map((m) => [m.estado, m.saldo_pendiente]), [['facturado', 0], ['facturado', 0]]);
  const fac = movs.find((m) => m.comprobante_ref === ok.json.factura.id_global);
  assert.deepEqual([fac.tipo, fac.importe, fac.estado], ['venta', 410, 'pendiente']);
  assert.equal(await saldo(), antesFact - 350 + 410); // los remitos dejaron de sumar y la factura los reemplaza: nada se duplica
  assert.equal(fac.saldo_pendiente, 310); // los 100 cobrados del primer remito pasaron a la factura
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM remitos WHERE facturacion = 'facturado'"))[0][0].n, 3);
});

test('Ventas EX36: un remito ya facturado, de otro cliente o anulado se rechaza con su motivo y se sigue con los válidos solo si el usuario lo confirma', async () => {
  const nuevo = (await remito({ asignar_a_cuenta: true })).json;
  const ajeno = (await remito({ cliente_id: otro.id })).json;
  const anulado = (await remito({})).json;
  await api('POST', `/api/remitos/${anulado.id_global}/anular`, { token });
  const ya = (await api('GET', '/api/remitos?facturacion=facturado', { token })).json[0];
  const ids = [nuevo.id_global, ya.id_global, ajeno.id_global, anulado.id_global, 'REM-NO-EXISTE'];
  const rechazo = await facturar({ remitos: ids, aceptar_diferencias: true });
  assert.deepEqual([rechazo.status, rechazo.json.codigo, rechazo.json.invalidos.map((i) => i.motivo)], [409, 'REMITOS_INVALIDOS', ['ya está facturado', 'es de otro cliente', 'está anulado', 'no existe']]);
  assert.equal(rechazo.json.puede_continuar, true);
  const cant = emitidas.length;
  const sigue = await facturar({ remitos: ids, aceptar_diferencias: true, continuar_con_validos: true });
  assert.equal(sigue.status, 200, JSON.stringify(sigue.json));
  assert.deepEqual(sigue.json.remitos.map((r) => r.remito), [nuevo.id_global]);
  assert.equal(emitidas.length, cant + 1);
  const otra = await facturar({ remitos: [nuevo.id_global], aceptar_diferencias: true });
  assert.equal(otra.json.codigo, 'REMITOS_INVALIDOS'); // el facturado no vuelve a facturarse
});

test('Clientes.RN10/Ventas RN74: una nota de crédito sobre un remito facturado referencia la factura agrupada, no la reabre y no supera su saldo', async () => {
  await esperarMensajes(pool);
  const movs = await movimientos();
  const rem = movs.find((m) => m.tipo === 'remito' && m.estado === 'facturado' && m.referencia_id);
  const fac = movs.find((m) => m.id === rem.referencia_id);
  const nota = (importe) => api('POST', `/api/cuentas-corrientes/${cuenta.id}/notas`, { token, body: { tipo: 'nc', importe, motivo: 'bonificacion', referencia_id: rem.id } });
  assert.equal((await nota(fac.saldo_pendiente + 1)).status, 409); // no supera el saldo de la factura
  const antes = await saldo();
  const ok = await nota(50);
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.referencia_id, fac.id); // referencia la factura agrupada
  assert.match(ok.json.detalle, new RegExp(`remito de origen: ${rem.comprobante_ref}`));
  assert.equal(await saldo(), antes - 50);
  assert.equal((await movimientos()).find((m) => m.id === rem.id).estado, 'facturado'); // el remito sigue Facturado
});

test('Ventas RN74/Clientes RN20: un remito pendiente se anula con el mensaje inverso; con remitos pendientes no se desactiva la facturación agrupada ni VEN-CC', async () => {
  const r = (await remito({ asignar_a_cuenta: true })).json;
  await esperarMensajes(pool);
  const antes = await saldo();
  const bloqueo = await api('POST', '/api/funciones/cambiar', { token, body: { desactivar: ['VEN-CC'], motivo: 'prueba', confirmar: { cascada: true, pendientes: true } } });
  assert.deepEqual([bloqueo.status, bloqueo.json.codigo], [409, 'DATOS_VIGENTES']); // hay remitos pendientes de facturar: se facturan o se desasignan
  assert.match(JSON.stringify(bloqueo.json.datos), /pendiente\(s\) de facturar/);
  const an = await api('POST', `/api/remitos/${r.id_global}/anular`, { token });
  assert.equal(an.json.estado, 'anulado');
  await esperarMensajes(pool);
  assert.equal(await saldo(), antes - r.total); // el remito se emitió con el precio nuevo
  assert.equal((await api('POST', `/api/remitos/${r.id_global}/anular`, { token })).status, 409);
  const fact = (await api('GET', '/api/remitos?facturacion=facturado', { token })).json[0];
  assert.equal((await api('POST', `/api/remitos/${fact.id_global}/anular`, { token })).status, 409); // el facturado se corrige con una nota de crédito
  // Facturados todos, la función se puede desactivar.
  const pendientes = (await api('GET', '/api/remitos?facturacion=pendiente&estado=emitido', { token })).json.filter((x) => x.cuenta_asignada).map((x) => x.id_global);
  const f = await facturar({ remitos: pendientes, aceptar_diferencias: true });
  assert.equal(f.status, 200, JSON.stringify(f.json));
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { desactivar: ['CLI-FACT-AGRUPADA'], motivo: 'prueba' } })).status, 200);
});

test('Clientes.RF21: el ciclo de facturación del mayorista genera la alerta interna al llegar la fecha, con la lista de trabajo', async () => {
  const Informes = require('../src/clientes/informesService');
  await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['CLI-FACT-AGRUPADA'], motivo: 'prueba' } });
  assert.equal((await api('PUT', `/api/clientes/${otro.id}`, { token, body: { ciclo_facturacion: 'cada_tanto' } })).status, 400);
  await api('PUT', `/api/clientes/${otro.id}`, { token, body: { ciclo_facturacion: 'semanal' } });
  const c2 = (await api('POST', '/api/cuentas-corrientes', { token, body: { cliente_id: otro.id, limite_credito: 100000, plazo_dias: 15 } })).json;
  assert.deepEqual(await Informes.alertasCiclo(), []); // sin remitos pendientes no hay nada que facturar
  const conn = await pool.getConnection();
  await M.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'remito_emitido', docTipo: 'remito', docIdGlobal: 'REM-VIEJO', contenido: { cliente_id: otro.id, importe: 900, remito_id_global: 'REM-VIEJO', fecha: dia(10) } });
  await M.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'remito_emitido', docTipo: 'remito', docIdGlobal: 'REM-RECIENTE', contenido: { cliente_id: otro.id, importe: 100, remito_id_global: 'REM-RECIENTE', fecha: dia(1) } });
  conn.release();
  await esperarMensajes(pool);
  const hechas = await Informes.alertasCiclo();
  assert.deepEqual(hechas, [{ cliente_id: otro.id, remitos: 2 }]); // el más viejo ya cumplió los 7 días del ciclo semanal
  assert.match((await pool.query("SELECT mensaje FROM notificaciones WHERE tipo = 'ciclo_facturacion'"))[0][0].mensaje, /Almacén Norte: 2 remito\(s\) por 1000/);
  assert.ok(c2.id);
});
