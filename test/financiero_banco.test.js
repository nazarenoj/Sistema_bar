const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');

let api, pool, cerrar, adm, gerente, cajero, banco, cuentaCC, cliente, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  cajero = await usuario(api, pool, 'cami', 'cajero');
  await api('POST', '/api/modulos/financiero/instalar', { token: adm.token });
  await api('POST', '/api/modulos/clientes/instalar', { token: adm.token });
  banco = (await api('POST', '/api/financiero/cuentas', { token: adm.token, body: { tipo: 'banco', nombre: 'Banco Nación', saldo_inicial: 10000, limite_descubierto: 0 } })).json;
  cliente = (await api('POST', '/api/clientes', { token: adm.token, body: { tipo_documento: 'CUIT', nro_documento: '30711111111', razon_social: 'Café del Centro SRL', consultar_arca: false } })).json;
  cuentaCC = (await api('POST', '/api/cuentas-corrientes', { token: adm.token, body: { cliente_id: cliente.id, limite_credito: 500000 } })).json;
});
after(async () => { await cerrar(); });

const hoyMas = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const cheque = (b, t = gerente) => api('POST', '/api/financiero/cheques', { token: t.token, body: { origen: 'tercero', tipo: 'fisico', banco: 'Galicia', numero: String(100000 + ++k), cuit_librador: '30711111111', importe: 5000, fecha_pago: hoyMas(0), ...b } });
const op = (id, nombre, body = {}, t = gerente) => api('POST', `/api/financiero/cheques/${id}/${nombre}`, { token: t.token, body });
const saldo = async (id = banco.id) => (await api('GET', `/api/financiero/cuentas/${id}`, { token: adm.token })).json.saldo;
const movs = async (q) => (await api('GET', `/api/financiero/movimientos?${q}`, { token: adm.token })).json;

test('Financiero.RN27: sin FIN-CHEQUES no hay cartera de cheques', async () => {
  assert.equal((await cheque({})).status, 409);
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['FIN-CHEQUES', 'FIN-CONCILIACION'], motivo: 'prueba' } });
  assert.equal((await cheque({}, cajero)).status, 403);
});

test('Financiero.RN10/EX08: un cheque físico se identifica por banco, número y CUIT del librador y un e-cheq por el identificador de la red; no hay duplicados', async () => {
  assert.equal((await cheque({ importe: 0 })).status, 400);
  assert.equal((await cheque({ fecha_pago: '10/11/2026' })).status, 400);
  assert.equal((await cheque({ cuit_librador: '123' })).status, 400); // el CUIT tiene 11 dígitos
  assert.equal((await cheque({ banco: '', numero: '' })).status, 400);
  const a = await cheque({ banco: 'Galicia', numero: '777', cuit_librador: '30711111111' });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  assert.equal(a.json.estado, 'en_cartera');
  const dup = await cheque({ banco: ' galicia ', numero: '777', cuit_librador: '30711111111' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.codigo, 'CHEQUE_DUPLICADO');
  assert.equal(dup.json.detalle.cheque.id, a.json.id); // se muestra el existente
  assert.equal((await cheque({ banco: 'Galicia', numero: '777', cuit_librador: '20123456786' })).status, 201); // otro librador: otro cheque
  const e = await cheque({ tipo: 'echeq', identificador_red: 'ECHEQ-0001', banco: undefined, numero: undefined, cuit_librador: undefined });
  assert.equal(e.status, 201, JSON.stringify(e.json));
  assert.equal((await cheque({ tipo: 'echeq', identificador_red: 'echeq-0001' })).json.codigo, 'CHEQUE_DUPLICADO');
  assert.equal((await cheque({ tipo: 'echeq' })).status, 400); // falta el identificador
  assert.equal((await cheque({ origen: 'propio', banco: 'Nación', numero: '55', cuit_librador: undefined })).status, 201); // un cheque propio no lleva CUIT de librador
});

test('Financiero.RF07/EX09: solo se deposita o endosa un cheque en cartera, con aviso si pasó el plazo de presentación y sin adelantar los de pago diferido', async () => {
  const c = (await cheque({ fecha_pago: hoyMas(-2) })).json;
  assert.equal((await op(c.id, 'depositar', {}, cajero)).status, 403);
  assert.equal((await op(c.id, 'depositar', { cuenta_id: 99999 })).status, 404);
  const dep = await op(c.id, 'depositar', { cuenta_id: banco.id });
  assert.equal(dep.status, 200, JSON.stringify(dep.json));
  assert.deepEqual([dep.json.estado, dep.json.cuenta_id], ['depositado', banco.id]);
  assert.equal((await op(c.id, 'depositar', { cuenta_id: banco.id })).json.codigo, 'ESTADO_INVALIDO'); // ya no está en cartera
  assert.equal((await op(c.id, 'endosar', { a: 'Proveedor SA' })).json.codigo, 'ESTADO_INVALIDO');

  const viejo = (await cheque({ fecha_pago: hoyMas(-40) })).json;
  const aviso = await op(viejo.id, 'depositar', { cuenta_id: banco.id });
  assert.equal(aviso.status, 409);
  assert.deepEqual([aviso.json.codigo, aviso.json.detalle.dias, aviso.json.detalle.plazo], ['CHEQUE_VENCIDO', 40, 30]);
  assert.equal((await op(viejo.id, 'depositar', { cuenta_id: banco.id, confirmar: true })).json.estado, 'depositado');

  const diferido = (await cheque({ fecha_pago: hoyMas(10) })).json;
  assert.equal((await op(diferido.id, 'depositar', { cuenta_id: banco.id })).json.codigo, 'CHEQUE_DIFERIDO');
  assert.equal((await op(diferido.id, 'endosar', { a: '' })).status, 400);
  const end = await op(diferido.id, 'endosar', { a: 'Proveedor SA', modulo: 'compras' });
  assert.equal(end.status, 409); // también es diferido
  const propio = (await cheque({ origen: 'propio', banco: 'Nación', numero: '9001', cuit_librador: undefined })).json;
  assert.equal((await op(propio.id, 'depositar', { cuenta_id: banco.id })).status, 409); // los propios no se depositan
  await api('PUT', '/api/financiero/config', { token: adm.token, body: { plazo_presentacion_cheque_dias: 60 } });
  assert.equal((await op((await cheque({ fecha_pago: hoyMas(-40) })).json.id, 'depositar', { cuenta_id: banco.id })).status, 200); // el plazo es parametrizable
  await api('PUT', '/api/financiero/config', { token: adm.token, body: { plazo_presentacion_cheque_dias: 30 } });
});

test('Financiero.RN02/RF08: el depósito acreditado suma a la cuenta y el rechazo posterior lo revierte con un contramovimiento y registra los gastos bancarios', async () => {
  const antes = await saldo();
  const c = (await cheque({ importe: 3000 })).json;
  await op(c.id, 'depositar', { cuenta_id: banco.id });
  assert.equal(await saldo(), antes); // depositado todavía no es plata
  assert.equal((await op(c.id, 'acreditar', { cuenta_id: banco.id })).json.estado, 'acreditado');
  assert.equal(await saldo(), antes + 3000);
  const rech = await op(c.id, 'rechazar', { motivo: 'sin fondos', gastos_bancarios: 150 });
  assert.equal(rech.status, 200, JSON.stringify(rech.json));
  assert.equal(rech.json.estado, 'rechazado');
  assert.equal(await saldo(), antes - 150);
  const ms = await movs(`venta=${c.id_global}`);
  assert.deepEqual(ms.map((m) => [m.tipo, m.importe]).sort(), [['cheque_acreditado', 3000], ['cheque_rechazado', -3000], ['gasto_bancario', -150]].sort());
  assert.equal(ms.find((m) => m.tipo === 'cheque_rechazado').vinculo_id, ms.find((m) => m.tipo === 'cheque_acreditado').id);
  assert.equal((await op(c.id, 'rechazar', { motivo: 'otra vez' })).json.codigo, 'ESTADO_INVALIDO');
  assert.equal((await op((await cheque({})).json.id, 'rechazar', { motivo: 'sin fondos' })).json.codigo, 'ESTADO_INVALIDO'); // uno en cartera no se rechaza
  const h = (await api('GET', `/api/financiero/cheques/${c.id}`, { token: gerente.token })).json.historial.map((x) => x.estado);
  assert.deepEqual(h, ['en_cartera', 'depositado', 'acreditado', 'rechazado']);
  // Anular: solo en cartera, con motivo.
  const a = (await cheque({})).json;
  assert.equal((await op(a.id, 'anular', {})).status, 400);
  assert.equal((await op(a.id, 'anular', { motivo: 'cargado por error' })).json.estado, 'anulado');
  // El cheque propio se debita de la cuenta.
  const propio = (await cheque({ origen: 'propio', banco: 'Nación', numero: '9100', cuit_librador: undefined, importe: 700 })).json;
  const antes2 = await saldo();
  assert.equal((await op(propio.id, 'acreditar', { cuenta_id: banco.id })).json.estado, 'acreditado');
  assert.equal(await saldo(), antes2 - 700);
  assert.equal((await api('GET', '/api/financiero/cheques?estado=anulado', { token: gerente.token })).json.length, 1);
});

test('Financiero.RF07/RF08/RN11: el cheque de un recibo de Clientes llega a la cartera y, si se rechaza, Clientes reabre la deuda con una nota de débito; Financiero no toca saldos de clientes', async () => {
  const recibo = await api('POST', '/api/recibos', { token: adm.token, headers: { 'X-ID-Solicitud': 'recibo-cheque-0001' },
    body: { cuenta_id: cuentaCC.id, valores: [{ forma: 'cheque', importe: 8000, cheque: { banco: 'Santander', numero: '44001', fecha_pago: hoyMas(0), cuit_librador: '30711111111' } }], imputacion: 'ninguna' } });
  assert.equal(recibo.status, 201, JSON.stringify(recibo.json));
  await esperarMensajes(pool);
  const [ch] = (await api('GET', '/api/financiero/cheques?estado=en_cartera', { token: gerente.token })).json.filter((c) => c.numero === '44001');
  assert.ok(ch, 'el cheque del recibo está en la cartera');
  assert.deepEqual([ch.origen_modulo, ch.cliente_id, ch.importe], ['clientes', cliente.id, 8000]);
  const saldoCC = async () => (await api('GET', `/api/cuentas-corrientes/${cuentaCC.id}`, { token: adm.token })).json.saldo;
  const antes = await saldoCC(); // el recibo dejó saldo a favor (negativo)
  await op(ch.id, 'depositar', { cuenta_id: banco.id });
  assert.equal(await saldoCC(), antes); // depositarlo no mueve la cuenta del cliente
  const rech = await op(ch.id, 'rechazar', { motivo: 'cuenta cerrada', gastos_bancarios: 200 });
  assert.equal(rech.status, 200, JSON.stringify(rech.json));
  await esperarMensajes(pool);
  assert.equal(await saldoCC(), antes + 8200); // el cliente vuelve a deber el cheque más los gastos
  const nd = (await api('GET', `/api/cuentas-corrientes/${cuentaCC.id}/movimientos`, { token: adm.token })).json.find((m) => m.tipo === 'nd');
  assert.match(nd.detalle, /Cheque rechazado Santander N° 44001: cuenta cerrada/);
  // Reenviar el mismo recibo no duplica el cheque.
  await api('POST', '/api/recibos', { token: adm.token, headers: { 'X-ID-Solicitud': 'recibo-cheque-0001' }, body: { cuenta_id: cuentaCC.id, valores: [{ forma: 'cheque', importe: 8000, cheque: { banco: 'Santander', numero: '44001', fecha_pago: hoyMas(0), cuit_librador: '30711111111' } }], imputacion: 'ninguna' } });
  assert.equal((await api('GET', '/api/financiero/cheques', { token: gerente.token })).json.filter((c) => c.numero === '44001').length, 1);
});

// ---- Conciliación ----

const importar = (b, t = gerente) => api('POST', '/api/financiero/extractos/importar', { token: t.token, body: { cuenta_id: banco.id, ...b } });
const lineas = async (q = '') => (await api('GET', `/api/financiero/extractos/lineas?cuenta_id=${banco.id}&${q}`, { token: gerente.token })).json;

test('Financiero.RF09/EX05/EX06: el extracto se importa de CSV u OFX con el formato del banco; un archivo inválido se rechaza completo y las líneas repetidas no se vuelven a importar', async () => {
  const csv = 'Fecha;Descripcion;Debito;Credito;Referencia\n05/11/2026;Deposito cheque;;4.321,00;DEP-1\n06/11/2026;Comision mantenimiento;120,50;;COM-1\n06/11/2026;Impuesto debitos y creditos;18,30;;IMP-1\n';
  assert.equal((await importar({ tipo: 'csv', contenido: csv }, cajero)).status, 403);
  assert.equal((await importar({ tipo: 'pdf', contenido: csv })).status, 400);
  const malo = await importar({ tipo: 'csv', contenido: 'Fecha;Descripcion;Debito;Credito\n05/11/2026;ok;;100,00\n99/99/2026;mal;;50,00\n' });
  assert.equal(malo.status, 400);
  assert.deepEqual([malo.json.codigo, malo.json.detalle.fila], ['EXTRACTO_INVALIDO', 3]);
  assert.equal((await lineas()).length, 0); // no entró ninguna línea del archivo inválido
  assert.equal((await importar({ tipo: 'csv', contenido: 'Dia;Monto\n1;2' })).json.codigo, 'EXTRACTO_INVALIDO'); // sin columna de fecha
  const ok = await importar({ tipo: 'csv', contenido: csv, formato: { separador: ';', debito: 'Debito', credito: 'Credito' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.importadas, ok.json.duplicadas], [3, 0]);
  const ls = await lineas();
  assert.deepEqual(ls.map((l) => [l.fecha, l.importe]), [['2026-11-05', 4321], ['2026-11-06', -120.5], ['2026-11-06', -18.3]]);
  const otra = await importar({ tipo: 'csv', contenido: csv, formato: { separador: ';', debito: 'Debito', credito: 'Credito' } }); // el mismo archivo otra vez
  assert.deepEqual([otra.json.importadas, otra.json.duplicadas], [0, 3]);
  assert.equal((await lineas()).length, 3);
  const ofx = '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261107<TRNAMT>2500.00<FITID>OFX-9<MEMO>Transferencia recibida</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
  assert.equal((await importar({ tipo: 'ofx', contenido: ofx })).json.importadas, 1);
  assert.equal((await importar({ tipo: 'ofx', contenido: '<OFX></OFX>' })).status, 400);
  const manual = await api('POST', '/api/financiero/extractos/lineas', { token: gerente.token, body: { cuenta_id: banco.id, fecha: '2026-11-07', importe: -50, referencia: 'MAN-1' } });
  assert.equal(manual.json.importadas, 1);
  const xlsx = await (async () => { const E = require('exceljs'); const wb = new E.Workbook(); const ws = wb.addWorksheet('x'); ws.addRow(['Fecha', 'Importe', 'Referencia']); ws.addRow(['2026-11-08', 900, 'XL-1']); return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64'); })();
  assert.equal((await importar({ tipo: 'xlsx', contenido: xlsx })).json.importadas, 1);
});

test('Financiero.RF09/RN12/EX07: la conciliación automática une por importe, fecha y referencia; lo ambiguo no se adivina y lo que no coincide queda pendiente de identificar', async () => {
  const hoy = Date.now();
  const mov = async (importe, tipo, ref, dias = 0) => (await pool.query("INSERT INTO fin_movimientos (id_global, cuenta_id, tipo, importe, referencia_externa, fecha_ms) VALUES (?, ?, ?, ?, ?, ?)", [`CONC-${++k}`, banco.id, tipo, importe, ref, new Date('2026-11-05T12:00:00').getTime() + dias * 86400000]))[0].insertId;
  const mDeposito = await mov(4321, 'cheque_acreditado', null, 0); // coincide con DEP-1 (4321 el 5/11)
  const mComisionA = await mov(-120.5, 'comision', 'COM-1', 1);
  await mov(-18.3, 'impuesto', null, 1); // coincide con IMP-1
  const m50a = await mov(-50, 'gasto', 'MAN-1', 2), m50b = await mov(-50, 'gasto', null, 2); // dos candidatos para la línea de -50: se desempata por la referencia
  void hoy; void mComisionA;
  const r = await api('POST', '/api/financiero/conciliacion/automatica', { token: gerente.token, body: { cuenta_id: banco.id } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.conciliadas, 4); // DEP-1, COM-1, IMP-1 y MAN-1 (por referencia)
  assert.equal(r.json.pendientes_de_identificar, 2); // OFX-9 y XL-1, que no tienen movimiento
  const ls = await lineas();
  assert.equal(ls.find((l) => l.referencia === 'MAN-1').estado, 'conciliada');
  assert.equal(ls.filter((l) => l.estado === 'pendiente_de_identificar').length, 2);
  const [{ n }] = (await pool.query('SELECT COUNT(*) AS n FROM fin_conciliacion_vinculos WHERE movimiento_id IN (?, ?)', [mDeposito, m50a]))[0];
  assert.equal(n, 2);
  // Un movimiento se concilia una sola vez: m50b ya no es candidato de la línea MAN-1, y no se puede vincular a otra línea que ya tiene dueño.
  const linea = ls.find((l) => l.referencia === 'OFX-9');
  assert.equal((await api('POST', `/api/financiero/conciliacion/lineas/${linea.id}/vincular`, { token: gerente.token, body: { movimiento_ids: [mDeposito] } })).status, 400); // el importe no coincide
  assert.equal((await api('POST', `/api/financiero/conciliacion/lineas/${ls.find((l) => l.referencia === 'XL-1').id}/vincular`, { token: gerente.token, body: { movimiento_ids: [m50b] } })).status, 400);
  assert.equal((await api('POST', `/api/financiero/conciliacion/lineas/${linea.id}/vincular`, { token: gerente.token, body: { movimiento_ids: [] } })).status, 400);
});

test('Financiero.RF09: la conciliación manual une una línea con varios movimientos; lo que el sistema no tenía se registra desde el extracto', async () => {
  const ls = await lineas('estado=pendiente_de_identificar');
  const ofx = ls.find((l) => l.referencia === 'OFX-9'); // +2500
  const m1 = (await pool.query("INSERT INTO fin_movimientos (id_global, cuenta_id, tipo, importe, fecha_ms) VALUES ('MAN-A', ?, 'ingreso', 1500, ?)", [banco.id, Date.now()]))[0].insertId;
  const m2 = (await pool.query("INSERT INTO fin_movimientos (id_global, cuenta_id, tipo, importe, fecha_ms) VALUES ('MAN-B', ?, 'ingreso', 1000, ?)", [banco.id, Date.now()]))[0].insertId;
  const sinConc = (await api('GET', `/api/financiero/extractos/movimientos-sin-conciliar?cuenta_id=${banco.id}`, { token: gerente.token })).json.map((m) => m.id);
  assert.ok(sinConc.includes(m1) && sinConc.includes(m2));
  const v = await api('POST', `/api/financiero/conciliacion/lineas/${ofx.id}/vincular`, { token: gerente.token, body: { movimiento_ids: [m1, m2] } });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  assert.equal(v.json.estado, 'conciliada');
  assert.equal((await api('POST', `/api/financiero/conciliacion/lineas/${ofx.id}/vincular`, { token: gerente.token, body: { movimiento_ids: [m1] } })).status, 409); // la línea ya está conciliada
  const des = await api('POST', `/api/financiero/conciliacion/lineas/${ofx.id}/desvincular`, { token: gerente.token });
  assert.equal(des.json.estado, 'pendiente');
  assert.equal((await api('POST', `/api/financiero/conciliacion/lineas/${ofx.id}/vincular`, { token: gerente.token, body: { movimiento_ids: [m1, m2] } })).status, 200);
  // Registrar desde el extracto: la línea del Excel (+900) es una transferencia que el sistema no conocía.
  const xl = (await lineas()).find((l) => l.referencia === 'XL-1');
  assert.equal((await api('POST', `/api/financiero/conciliacion/lineas/${xl.id}/registrar`, { token: gerente.token, body: { tipo: 'cualquiera' } })).status, 400);
  const antes = await saldo();
  const reg = await api('POST', `/api/financiero/conciliacion/lineas/${xl.id}/registrar`, { token: gerente.token, body: { tipo: 'transferencia_sin_identificar' } });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  assert.equal(reg.json.linea.estado, 'conciliada');
  assert.equal(await saldo(), antes + 900);
  const [m] = await movs(`cuenta_id=${banco.id}&tipo=transferencia_sin_identificar`);
  assert.equal(m.marcas, 'desde_extracto');
});

test('Financiero.RF09/RN12: se cierra el período con su saldo conciliado y un período cerrado no admite cambios', async () => {
  const cierre = (b) => api('POST', '/api/financiero/conciliacion/cierres', { token: gerente.token, body: { cuenta_id: banco.id, desde: '2026-11-01', hasta: '2026-11-30', saldo_inicial: 0, ...b } });
  await api('POST', '/api/financiero/extractos/lineas', { token: gerente.token, body: { cuenta_id: banco.id, fecha: '2026-11-09', importe: 10, referencia: 'EXTRA' } });
  const sin = await cierre({ saldo_extracto: 0 });
  assert.equal(sin.status, 409);
  assert.equal(sin.json.codigo, 'LINEAS_SIN_CONCILIAR'); // quedan líneas pendientes de identificar
  const quedan = await lineas('estado=pendiente');
  for (const l of quedan) await api('POST', `/api/financiero/conciliacion/lineas/${l.id}/registrar`, { token: gerente.token, body: { tipo: 'interes' } });
  // 4321 - 120,50 - 18,30 - 50 + 2500 + 900 + 10 = 7542,20
  const mal = await cierre({ saldo_extracto: 6000 });
  assert.equal(mal.status, 409);
  assert.deepEqual([mal.json.codigo, mal.json.detalle.saldo_conciliado], ['SALDO_NO_CUADRA', 7542.2]);
  const ok = await cierre({ saldo_extracto: 7542.2 });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.saldo_conciliado, ok.json.diferencia, ok.json.lineas], [7542.2, 0, 7]);
  // Nada de lo cerrado cambia.
  const una = (await lineas()).find((l) => l.referencia === 'DEP-1');
  assert.equal((await api('POST', `/api/financiero/conciliacion/lineas/${una.id}/desvincular`, { token: gerente.token })).json.codigo, 'PERIODO_CERRADO');
  assert.equal((await importar({ tipo: 'ofx', contenido: '<OFX><STMTTRN><DTPOSTED>20261115<TRNAMT>10.00<FITID>OFX-NOV</STMTTRN></OFX>' })).json.codigo, 'PERIODO_CERRADO');
  assert.equal((await cierre({ saldo_extracto: 7542.2 })).json.codigo, 'PERIODO_CERRADO'); // el período se superpone
  assert.equal((await api('GET', `/api/financiero/conciliacion/cierres?cuenta_id=${banco.id}`, { token: gerente.token })).json.length, 1);
  // El siguiente período arranca del saldo conciliado anterior.
  assert.equal((await importar({ tipo: 'ofx', contenido: '<OFX><STMTTRN><DTPOSTED>20261203<TRNAMT>100.00<FITID>OFX-DIC</STMTTRN></OFX>' })).json.importadas, 1);
});
