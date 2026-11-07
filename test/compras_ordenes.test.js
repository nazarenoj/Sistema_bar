process.env.AFIP_CONDICION_IVA_EMISOR = 'responsable_inscripto';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const { hashCodigo } = require('../src/utils/credenciales');
const Ordenes = require('../src/compras/ordenPagoService');

let api, pool, cerrar, adm, gerente, administrativo, contador, prov, banco, k = 0, neto0 = 1000;
const CUIT = '30711111111';
const hoyMas = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  contador = await usuario(api, pool, 'cora', 'contador');
  const [sup] = await pool.query("INSERT INTO users (username, password_hash, rol, pin_hash) VALUES ('sup', ?, 'admin', ?)", [await bcrypt.hash('clave-larga-1', 4), hashCodigo('2222')]);
  await pool.query("INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = 'administrador'", [sup.insertId]);
  await api('POST', '/api/modulos/compras/instalar', { token: adm.token });
  await api('POST', '/api/modulos/financiero/instalar', { token: adm.token });
  prov = (await api('POST', '/api/compras/proveedores', { token: administrativo.token, body: { cuit: CUIT, razon_social: 'Tostadores del Sur SA', condicion_pago_dias: 0, tipo: 'ambos', consultar_arca: false } })).json;
  banco = (await api('POST', '/api/financiero/cuentas', { token: adm.token, body: { tipo: 'banco', nombre: 'Banco Nación', saldo_inicial: 500000, limite_descubierto: 0 } })).json;
});
after(async () => { await cerrar(); });

// Una factura de neto + 21% de IVA con una sola cuota a la vista; cada una de un neto distinto para que no se tome por casi duplicada.
const factura = async (neto = (neto0 += 111), b = {}) => {
  const r = await api('POST', '/api/compras/comprobantes', { token: administrativo.token, body: { cuit: CUIT, clase: 'FACTURA', tipo: 'A', punto_venta: 1, numero: String(++k), fecha: hoyMas(-1), alicuotas: [{ alicuota: 21, neto, iva: Math.round(neto * 21) / 100 }], total: Math.round(neto * 121) / 100, ...b } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const [v] = (await api('GET', `/api/compras/vencimientos?comprobante_id=${r.json.id}`, { token: gerente.token })).json;
  return { ...r.json, venc: v };
};
const orden = (b, t = administrativo, headers = {}) => api('POST', '/api/compras/ordenes-pago', { token: t.token, headers, body: { proveedor_id: prov.id, ...b } });
const medioBanco = (importe) => ({ medio: 'transferencia', importe, cuenta_id: banco.id });
const op = (id, ruta, body = {}, t = administrativo) => api('POST', `/api/compras/ordenes-pago/${id}/${ruta}`, { token: t.token, body });
const obtener = async (id) => (await api('GET', `/api/compras/ordenes-pago/${id}`, { token: gerente.token })).json;
const saldoBanco = async () => (await api('GET', `/api/financiero/cuentas/${banco.id}`, { token: adm.token })).json.saldo;
const saldoProv = async () => (await api('GET', `/api/compras/proveedores/${prov.id}/cuenta`, { token: gerente.token })).json.saldo;

test('Compras.RF06/RN09: la orden aplica cuotas, los medios más las retenciones suman el importe aplicado y la cuota baja su saldo', async () => {
  const f = await factura(1000);
  assert.equal((await orden({ aplicaciones: [{ vencimiento_id: f.venc.id }], medios: [medioBanco(1000)] })).json.codigo, 'MEDIOS_NO_CIERRAN');
  assert.equal((await orden({ aplicaciones: [{ vencimiento_id: f.venc.id }], medios: [] })).json.codigo, 'MEDIOS_NO_CIERRAN');
  assert.equal((await orden({ aplicaciones: [{ vencimiento_id: f.venc.id, importe: 5000 }], medios: [medioBanco(5000)] })).json.codigo, 'IMPORTE_SUPERA_SALDO');
  assert.equal((await orden({ aplicaciones: [{ vencimiento_id: 99999 }], medios: [medioBanco(10)] })).status, 404);
  assert.equal((await orden({ aplicaciones: [], medios: [medioBanco(10)] })).status, 400); // sin cuotas
  assert.equal((await orden({ aplicaciones: [{ vencimiento_id: f.venc.id }], medios: [{ medio: 'efectivo', importe: 1210 }] })).status, 400); // con Financiero cada medio lleva su caja o cuenta
  assert.equal((await orden({ aplicaciones: [{ vencimiento_id: f.venc.id }], medios: [medioBanco(1210)] }, contador)).status, 403);
  const parcial = await orden({ aplicaciones: [{ vencimiento_id: f.venc.id, importe: 500 }], medios: [medioBanco(500)] });
  assert.equal(parcial.status, 201, JSON.stringify(parcial.json));
  assert.deepEqual([parcial.json.numero, parcial.json.estado, parcial.json.deuda_aplicada, parcial.json.medios_total], [1, 'aprobada', 500, 500]);
  assert.equal((await api('GET', `/api/compras/vencimientos?comprobante_id=${f.id}`, { token: gerente.token })).json[0].saldo, 710); // pago parcial: la cuota sigue pendiente
  const resto = await orden({ aplicaciones: [{ vencimiento_id: f.venc.id }], medios: [medioBanco(710)] });
  assert.equal(resto.status, 201, JSON.stringify(resto.json));
  assert.equal(resto.json.numero, 2); // numeración correlativa
  assert.equal((await api('GET', `/api/compras/vencimientos?comprobante_id=${f.id}&estado=todos`, { token: gerente.token })).json[0].estado, 'pagado');
  assert.equal((await orden({ aplicaciones: [{ vencimiento_id: f.venc.id }], medios: [medioBanco(1)] })).json.codigo, 'CUOTA_NO_PENDIENTE');
});

test('Compras.RF06/RN33: con Financiero el pago viaja como mensaje y la orden queda Aprobada hasta que Financiero lo confirma; el egreso sale de la cuenta elegida', async () => {
  const f = await factura();
  const o = (await orden({ aplicaciones: [{ vencimiento_id: f.venc.id }], medios: [medioBanco(f.total)] }, administrativo, { 'X-ID-Solicitud': 'orden-pago-0001' })).json;
  assert.equal(o.estado, 'aprobada');
  const rep = await orden({ aplicaciones: [{ vencimiento_id: f.venc.id }], medios: [medioBanco(f.total)] }, administrativo, { 'X-ID-Solicitud': 'orden-pago-0001' });
  assert.equal(rep.headers.get('idempotency-replayed'), 'true'); // el doble clic no emite otra orden
  const antes = await saldoBanco();
  assert.equal((await op(o.id, 'ejecutar', {}, contador)).status, 403);
  const ej = await op(o.id, 'ejecutar');
  assert.equal(ej.status, 200, JSON.stringify(ej.json));
  assert.equal(ej.json.ejecutada, true);
  assert.notEqual(ej.json.estado, 'pagada'); // todavía no confirmó Financiero
  assert.ok(['YA_EJECUTADA', 'YA_PAGADA'].includes((await op(o.id, 'ejecutar')).json.codigo)); // según si Financiero ya alcanzó a confirmar
  await esperarMensajes(pool);
  const pagada = await obtener(o.id);
  assert.deepEqual([pagada.estado, pagada.integracion.estado], ['pagada', 'confirmado']);
  assert.equal(await saldoBanco(), antes - f.total);
  const [m] = (await api('GET', `/api/financiero/movimientos?venta=${o.id_global}`, { token: adm.token })).json;
  assert.deepEqual([m.tipo, m.importe, m.cuenta, m.forma_pago], ['pago_proveedor', -f.total, 'Banco Nación', 'transferencia']);
  assert.equal((await op(o.id, 'ejecutar')).status, 409); // ya pagada
  // La cuenta del proveedor refleja el pago.
  const cc = (await api('GET', `/api/compras/proveedores/${prov.id}/cuenta`, { token: gerente.token })).json;
  assert.ok(cc.movimientos.some((x) => x.concepto === `Orden de pago ${o.numero}` && x.importe === -f.total));
});

test('Compras.EX07: sin fondos Financiero rechaza el pago con su motivo, sin movimiento y sin reintento: la orden queda Aprobada y se puede reintentar', async () => {
  const f = await factura();
  const o = (await orden({ aplicaciones: [{ vencimiento_id: f.venc.id }], medios: [medioBanco(f.total)] })).json;
  await pool.query("INSERT INTO fin_movimientos (id_global, cuenta_id, tipo, importe, fecha_ms) VALUES ('VACIAR-BANCO', ?, 'retiro', ?, ?)", [banco.id, -(await saldoBanco()) + 100, Date.now()]); // el banco queda con $100
  await op(o.id, 'ejecutar');
  await esperarMensajes(pool);
  const r = await obtener(o.id);
  assert.equal(r.estado, 'aprobada');
  assert.equal(r.integracion.estado, 'rechazado');
  assert.match(r.integracion.motivo, /Fondos insuficientes en "Banco Nación"/);
  assert.equal((await api('GET', `/api/financiero/movimientos?venta=${o.id_global}`, { token: adm.token })).json.length, 0);
  await pool.query("INSERT INTO fin_movimientos (id_global, cuenta_id, tipo, importe, fecha_ms) VALUES ('REPONER-BANCO', ?, 'ingreso', 500000, ?)", [banco.id, Date.now()]);
  const p = (await api('GET', '/api/integracion/pendientes', { token: adm.token })).json.find((x) => x.doc_id_global === o.id_global);
  assert.equal((await api('POST', `/api/integracion/pendientes/${p.id}/reintentar`, { token: adm.token })).status, 200);
  await esperarMensajes(pool);
  assert.equal((await obtener(o.id)).estado, 'pagada');
});

test('Compras.RF06/RN09: las notas de crédito y los anticipos se aplican a la orden; no se usa más crédito del disponible', async () => {
  const f = await factura(2000);
  const nc = (await api('POST', '/api/compras/comprobantes', { token: administrativo.token, body: { cuit: CUIT, clase: 'NOTA_CREDITO', tipo: 'A', punto_venta: 1, numero: String(++k), fecha: hoyMas(-1), alicuotas: [{ alicuota: 21, neto: 250, iva: 52.5 }], total: 302.5 } })).json;
  const o = await orden({ aplicaciones: [{ vencimiento_id: f.venc.id }], notas_credito: [{ comprobante_id: nc.id }], medios: [medioBanco(f.total - 302.5)] });
  assert.equal(o.status, 201, JSON.stringify(o.json));
  assert.deepEqual([o.json.deuda_aplicada, o.json.notas_credito, o.json.medios_total], [f.total, 302.5, f.total - 302.5]);
  const f2 = await factura();
  assert.equal((await orden({ aplicaciones: [{ vencimiento_id: f2.venc.id }], notas_credito: [{ comprobante_id: nc.id, importe: 1 }], medios: [medioBanco(f2.total - 1)] })).json.codigo, 'CREDITO_INSUFICIENTE'); // ya se usó entera
  assert.equal((await orden({ aplicaciones: [{ vencimiento_id: f2.venc.id }], notas_credito: [{ comprobante_id: f.id }], medios: [medioBanco(1)] })).status, 404); // no es una nota de crédito
  // Anticipo (RF08): pago a cuenta sin comprobante, que se imputa después.
  const ant = await orden({ tipo: 'anticipo', importe: 5000, medios: [medioBanco(5000)] });
  assert.equal(ant.status, 201, JSON.stringify(ant.json));
  const lista = (await api('GET', `/api/compras/anticipos?proveedor_id=${prov.id}`, { token: gerente.token })).json;
  assert.deepEqual([lista[0].importe, lista[0].saldo], [5000, 5000]);
  const conAnt = await orden({ aplicaciones: [{ vencimiento_id: f2.venc.id }], anticipos: [{ anticipo_id: lista[0].id, importe: 1500 }], medios: [medioBanco(f2.total - 1500)] });
  assert.equal(conAnt.status, 201, JSON.stringify(conAnt.json));
  assert.equal((await api('GET', `/api/compras/anticipos?proveedor_id=${prov.id}`, { token: gerente.token })).json[0].saldo, 3500);
  assert.equal((await orden({ aplicaciones: [{ vencimiento_id: (await factura()).venc.id }], anticipos: [{ anticipo_id: lista[0].id, importe: 9999 }], medios: [medioBanco(1)] })).json.codigo, 'ANTICIPO_INSUFICIENTE');
  assert.equal((await op(ant.json.id, 'anular', { motivo: 'error' }, gerente)).json.codigo, 'ANTICIPO_APLICADO'); // ya se aplicó una parte
});

test('Compras.RN09: una orden que supera el importe configurado espera la aprobación de otro usuario; no se ejecuta antes', async () => {
  await api('PUT', '/api/compras/config', { token: gerente.token, body: { importe_aprobacion_op: 1000 } });
  const f = await factura(3000);
  const o = (await orden({ aplicaciones: [{ vencimiento_id: f.venc.id }], medios: [medioBanco(f.total)] })).json;
  assert.equal(o.estado, 'pendiente_aprobacion');
  assert.equal((await op(o.id, 'ejecutar')).json.codigo, 'NO_APROBADA');
  assert.equal((await op(o.id, 'aprobar')).status, 403); // pide la credencial de otro usuario
  assert.equal((await op(o.id, 'aprobar', { autorizacion: { usuario: 'ana', credencial: 'clave-larga-1' } })).status, 403); // nadie se aprueba a sí mismo
  const ok = await op(o.id, 'aprobar', { autorizacion: { credencial: '2222' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.estado, 'aprobada');
  assert.equal((await op(o.id, 'aprobar', { autorizacion: { credencial: '2222' } })).status, 409);
  await api('PUT', '/api/compras/config', { token: gerente.token, body: { importe_aprobacion_op: 0 } });
});

test('Compras.RN10/RN08/RN34: la orden se anula con motivo y devuelve el saldo a la cuota; la pagada se revierte con un mensaje inverso que espera al pago; el comprobante con pagos no se anula', async () => {
  const f = await factura();
  const sinEjecutar = (await orden({ aplicaciones: [{ vencimiento_id: f.venc.id }], medios: [medioBanco(f.total)] })).json;
  assert.equal((await op(sinEjecutar.id, 'anular', {}, gerente)).status, 400);
  assert.equal((await api('POST', `/api/compras/comprobantes/${f.id}/anular`, { token: gerente.token, body: { motivo: 'cargada de más' } })).json.codigo, 'TIENE_PAGOS'); // RN08
  assert.equal((await op(sinEjecutar.id, 'anular', { motivo: 'cambió el pago' }, gerente)).json.estado, 'anulada');
  assert.equal((await api('GET', `/api/compras/vencimientos?comprobante_id=${f.id}`, { token: gerente.token })).json[0].saldo, f.total); // la cuota volvió a deber todo
  // Pagada: la reversión va a Financiero.
  const o = (await orden({ aplicaciones: [{ vencimiento_id: f.venc.id }], medios: [medioBanco(f.total)] })).json;
  await op(o.id, 'ejecutar');
  await esperarMensajes(pool);
  const antes = await saldoBanco();
  const an = await op(o.id, 'anular', { motivo: 'pago duplicado' }, gerente);
  assert.equal(an.status, 200, JSON.stringify(an.json));
  assert.equal(an.json.estado, 'anulada');
  await esperarMensajes(pool);
  assert.equal(await saldoBanco(), antes + f.total); // contramovimiento en la fecha actual
  const ms = (await api('GET', `/api/financiero/movimientos?venta=${o.id_global}`, { token: adm.token })).json;
  assert.deepEqual(ms.map((m) => m.tipo).sort(), ['anulacion_pago_proveedor', 'pago_proveedor']);
  assert.equal(ms.find((m) => m.tipo === 'anulacion_pago_proveedor').vinculo_id, ms.find((m) => m.tipo === 'pago_proveedor').id);
  assert.equal((await op(o.id, 'anular', { motivo: 'otra vez' }, gerente)).status, 409);
  assert.equal((await api('POST', `/api/compras/comprobantes/${f.id}/anular`, { token: gerente.token, body: { motivo: 'cargada de más' } })).json.estado, 'anulado'); // sin pagos vigentes ya se puede
});

test('Compras.RF06/RN10: sin Financiero solo hay efectivo y transferencia, la orden se marca Pagada a mano y una pagada solo se anula si los valores no se entregaron', async () => {
  const Modulos = require('../src/modulos/registro');
  const original = Modulos.estaInstalado;
  Modulos.estaInstalado = async (m) => (m === 'financiero' ? false : original(m));
  try {
    const f = await factura();
    const base = { aplicaciones: [{ vencimiento_id: f.venc.id }] };
    assert.equal((await orden({ ...base, medios: [{ medio: 'echeq', importe: f.total, cheque: { identificador_red: 'E-1', fecha_pago: hoyMas(5) } }] })).json.codigo, 'MEDIO_NO_DISPONIBLE');
    const o = (await orden({ ...base, medios: [{ medio: 'efectivo', importe: f.total }] })).json; // sin Financiero no hace falta la caja
    assert.equal(o.estado, 'aprobada');
    assert.equal((await op(o.id, 'ejecutar', {})).json.codigo, 'FALTA_MEDIO');
    const ej = await op(o.id, 'ejecutar', { medio_manual: 'efectivo' });
    assert.deepEqual([ej.json.estado, ej.json.medio_manual], ['pagada', 'efectivo']);
    assert.equal((await op(o.id, 'anular', { motivo: 'error' }, gerente)).json.codigo, 'VALORES_ENTREGADOS');
    assert.equal((await op(o.id, 'anular', { motivo: 'error', valores_entregados: false }, gerente)).json.estado, 'anulada');
  } finally { Modulos.estaInstalado = original; }
});

test('Compras.RF07/RN36: los pagos programados necesitan CMP-PAGOS-PROGRAMADOS, avisan en su fecha y nunca se ejecutan solos', async () => {
  const f = await factura();
  const prog = (b = {}) => orden({ aplicaciones: [{ vencimiento_id: f.venc.id }], medios: [medioBanco(f.total)], fecha_programada: hoyMas(5), ...b });
  assert.equal((await prog()).json.codigo, 'FUNCION_INACTIVA');
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['CMP-PAGOS-PROGRAMADOS'], motivo: 'prueba' } });
  assert.equal((await prog({ fecha_programada: hoyMas(-1) })).status, 400);
  const o = (await prog()).json;
  assert.equal(o.estado, 'programada');
  assert.match((await obtener(o.id)).instantanea, /CMP-PAGOS-PROGRAMADOS=1/);
  assert.equal((await op(o.id, 'ejecutar')).json.codigo, 'NO_APROBADA'); // aprobarla es un paso aparte
  await pool.query('UPDATE cmp_ordenes_pago SET fecha_programada = ? WHERE id = ?', [hoyMas(0), o.id]);
  const av = await Ordenes.avisarProgramadas();
  assert.equal(av.avisos, 1);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE clave = ?", [`cmp-op-prog:${o.id}`]))[0][0].n, 1);
  assert.equal((await obtener(o.id)).estado, 'programada'); // llegó la fecha y no se ejecutó sola
  await op(o.id, 'aprobar', { autorizacion: { credencial: '2222' } });
  assert.equal((await op(o.id, 'ejecutar')).status, 200);
  await esperarMensajes(pool);
  assert.equal((await obtener(o.id)).estado, 'pagada');
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { desactivar: ['CMP-PAGOS-PROGRAMADOS'], motivo: 'prueba' } });
});

test('Compras.RF06/RF07/EX13: cheque propio, e-cheq y cheque de terceros endosado salen de la cartera de Financiero; si se rechaza el endosado, Compras reabre la deuda con el proveedor', async () => {
  const f = await factura(), g = await factura();
  const base = (ff, medios) => ({ aplicaciones: [{ vencimiento_id: ff.venc.id }], medios });
  const propio = { medio: 'cheque_propio', importe: f.total, cuenta_id: banco.id, cheque: { banco: 'Nación', numero: '88001', fecha_pago: hoyMas(15) } };
  const sinFuncion = (await orden(base(f, [propio]))).json;
  await op(sinFuncion.id, 'ejecutar');
  await esperarMensajes(pool);
  assert.equal((await obtener(sinFuncion.id)).integracion.estado, 'rechazado'); // sin FIN-CHEQUES no hay cartera
  assert.match((await obtener(sinFuncion.id)).integracion.motivo, /FIN-CHEQUES/);
  await op(sinFuncion.id, 'anular', { motivo: 'sin cartera de cheques' }, gerente);
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['FIN-CHEQUES'], motivo: 'prueba' } });
  assert.equal((await orden(base(f, [{ medio: 'cheque_propio', importe: f.total, cuenta_id: banco.id, cheque: { banco: 'Nación' } }]))).status, 400); // faltan número y fecha de pago
  const o1 = (await orden(base(f, [propio]))).json;
  await op(o1.id, 'ejecutar');
  await esperarMensajes(pool);
  assert.equal((await obtener(o1.id)).estado, 'pagada');
  const propios = (await api('GET', '/api/financiero/cheques?origen=propio', { token: gerente.token })).json;
  assert.deepEqual([propios[0].numero, propios[0].importe, propios[0].origen_modulo, propios[0].estado], ['88001', f.total, 'compras', 'en_cartera']);
  // Cheque de terceros que Financiero recibió de un cliente y se le endosa al proveedor.
  const ch = (await api('POST', '/api/financiero/cheques', { token: gerente.token, body: { origen: 'tercero', tipo: 'fisico', banco: 'Galicia', numero: '5551', cuit_librador: '30711111111', importe: g.total, fecha_pago: hoyMas(0), cliente_id: null } })).json;
  const o2 = (await orden(base(g, [{ medio: 'cheque_tercero', importe: g.total, cheque_id: ch.id }]))).json;
  await op(o2.id, 'ejecutar');
  await esperarMensajes(pool);
  assert.equal((await obtener(o2.id)).estado, 'pagada');
  const endosado = (await api('GET', `/api/financiero/cheques/${ch.id}`, { token: gerente.token })).json;
  assert.deepEqual([endosado.estado, endosado.endosado_a], ['endosado', 'Tostadores del Sur SA']);
  // El banco rechaza el cheque: Compras reabre la deuda (EX13), idempotente.
  const antes = await saldoProv();
  const rech = await api('POST', `/api/financiero/cheques/${ch.id}/rechazar`, { token: gerente.token, body: { motivo: 'cuenta cerrada', gastos_bancarios: 200 } });
  assert.equal(rech.status, 200, JSON.stringify(rech.json));
  await esperarMensajes(pool);
  assert.equal(await saldoProv(), antes + g.total + 200);
  const nd = (await api('GET', `/api/compras/comprobantes?proveedor_id=${prov.id}&clase=NOTA_DEBITO`, { token: gerente.token })).json;
  assert.equal(nd.length, 1);
  assert.equal(nd[0].origen, 'financiero');
  assert.match((await api('GET', `/api/compras/comprobantes/${nd[0].id}`, { token: gerente.token })).json.observacion, /Cheque rechazado Galicia N° 5551 entregado en la orden de pago/);
  assert.equal((await api('GET', `/api/compras/vencimientos?comprobante_id=${nd[0].id}`, { token: gerente.token })).json.length, 1); // vuelve a haber una cuota a pagar
  // Anular la orden con un cheque propio que sigue en cartera lo anula; uno ya endosado no se revierte.
  await op(o1.id, 'anular', { motivo: 'cambio de medio' }, gerente);
  await esperarMensajes(pool);
  assert.equal((await api('GET', '/api/financiero/cheques?origen=propio', { token: gerente.token })).json[0].estado, 'anulado');
});

test('Compras.RF09/RN11/EX08: las retenciones se calculan por régimen con el mínimo no sujeto y la acumulación mensual, los certificados son correlativos y el padrón vencido usa la alícuota general', async () => {
  const reg = (b, t = gerente) => api('POST', '/api/compras/retenciones/regimenes', { token: t.token, body: b });
  assert.equal((await reg({ codigo: 'GAN', nombre: 'Ganancias', impuesto: 'GANANCIAS', alicuota_general: 6 })).status, 409); // necesita CMP-RETENCIONES... (el permiso del régimen la exige)
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['CMP-RETENCIONES'], motivo: 'prueba' } });
  assert.equal((await reg({ codigo: 'GAN', nombre: 'Ganancias', impuesto: 'XX', alicuota_general: 6 })).status, 400);
  assert.equal((await reg({ codigo: 'IIBB-CABA', nombre: 'IIBB CABA', impuesto: 'IIBB', alicuota_general: 3 })).status, 400); // falta la jurisdicción
  assert.equal((await reg({ codigo: 'GAN', nombre: 'Ganancias', impuesto: 'GANANCIAS', alicuota_general: 6, minimo_no_sujeto: 5000, acumulacion_mensual: true }, administrativo)).status, 403);
  const gan = (await reg({ codigo: 'GAN', nombre: 'Ganancias', impuesto: 'GANANCIAS', alicuota_general: 6, minimo_no_sujeto: 5000, acumulacion_mensual: true })).json;
  assert.equal(gan.alicuota_general, 6);
  assert.equal((await reg({ codigo: 'GAN', nombre: 'otra', impuesto: 'IVA', alicuota_general: 1 })).status, 409);
  // Primer pago: neto 10.000 − mínimo 5.000 = 5.000 al 6% = 300.
  const f1 = await factura(10000);
  const calc = (await api('POST', '/api/compras/ordenes-pago/calcular', { token: administrativo.token, body: { proveedor_id: prov.id, aplicaciones: [{ vencimiento_id: f1.venc.id, importe: 10000 }] } })).json;
  assert.equal(calc.retenciones[0].calculado, 300);
  const o1 = await orden({ aplicaciones: [{ vencimiento_id: f1.venc.id, importe: 10000 }], medios: [medioBanco(9700)] });
  assert.equal(o1.status, 201, JSON.stringify(o1.json));
  assert.deepEqual([o1.json.retenciones, o1.json.retenciones_detalle[0].certificado], [300, 1]);
  assert.equal((await orden({ aplicaciones: [{ vencimiento_id: f1.venc.id }], medios: [medioBanco(2210)] })).json.codigo, 'MEDIOS_NO_CIERRAN'); // sin descontar la retención no cierra
  // Segundo pago del mismo mes: acumulado 14.000 → (14.000 − 5.000) × 6% = 540, menos los 300 ya retenidos = 240.
  const f2 = await factura(4000);
  const o2 = await orden({ aplicaciones: [{ vencimiento_id: f2.venc.id, importe: 4000 }], medios: [medioBanco(3760)] });
  assert.equal(o2.status, 201, JSON.stringify(o2.json));
  assert.deepEqual([o2.json.retenciones, o2.json.retenciones_detalle[0].certificado], [240, 2]);
  // Modificar lo calculado pide su permiso y deja el valor calculado.
  const f3 = await factura(1010);
  const mod = (t) => orden({ aplicaciones: [{ vencimiento_id: f3.venc.id, importe: 1000 }], medios: [medioBanco(1000)], retenciones: [{ regimen_id: gan.id, importe: 0 }] }, t);
  assert.equal((await mod(administrativo)).json.codigo, 'SIN_PERMISO');
  const m = await mod(gerente);
  assert.equal(m.status, 201, JSON.stringify(m.json));
  assert.deepEqual([m.json.retenciones_detalle[0].importe, m.json.retenciones_detalle[0].calculado > 0], [0, true]);
  // La orden anulada deja su certificado anulado y el número no se reutiliza.
  await op(o2.json.id, 'anular', { motivo: 'error' }, gerente);
  const f4 = await factura(5000);
  const ret4 = (await api('POST', '/api/compras/ordenes-pago/calcular', { token: administrativo.token, body: { proveedor_id: prov.id, aplicaciones: [{ vencimiento_id: f4.venc.id, importe: 5000 }] } })).json.retenciones[0].calculado;
  assert.ok(ret4 > 0); // la acumulación del mes ya cuenta lo pagado en las órdenes vigentes (la anulada no)
  const o4 = await orden({ aplicaciones: [{ vencimiento_id: f4.venc.id, importe: 5000 }], medios: [medioBanco(Math.round((5000 - ret4) * 100) / 100)] });
  assert.equal(o4.status, 201, JSON.stringify(o4.json));
  assert.ok(o4.json.retenciones_detalle[0].certificado >= 4);
  assert.equal((await obtener(o2.json.id)).retenciones_detalle[0].anulado, true);
  // Padrón por contribuyente: vencido o sin importar usa la general y advierte; vigente usa la suya.
  await api('PUT', `/api/compras/retenciones/regimenes/${gan.id}`, { token: gerente.token, body: { usa_padron: true, acumulacion_mensual: false, minimo_no_sujeto: 0 } });
  const f5 = await factura(1020);
  const sinPadron = (await api('POST', '/api/compras/ordenes-pago/calcular', { token: administrativo.token, body: { proveedor_id: prov.id, aplicaciones: [{ vencimiento_id: f5.venc.id, importe: 1000 }] } })).json;
  assert.deepEqual([sinPadron.retenciones[0].alicuota, /no tiene a este proveedor/.test(sinPadron.retenciones[0].aviso)], [6, true]);
  assert.equal((await api('POST', `/api/compras/retenciones/regimenes/${gan.id}/padron`, { token: gerente.token, body: { contenido: `${CUIT};3;${hoyMas(-10)}` } })).json.importados, 1);
  assert.match((await api('POST', '/api/compras/ordenes-pago/calcular', { token: administrativo.token, body: { proveedor_id: prov.id, aplicaciones: [{ vencimiento_id: f5.venc.id, importe: 1000 }] } })).json.retenciones[0].aviso, /vencido/);
  await api('POST', `/api/compras/retenciones/regimenes/${gan.id}/padron`, { token: gerente.token, body: { contenido: `${CUIT};3;${hoyMas(100)}` } });
  const vigente = (await api('POST', '/api/compras/ordenes-pago/calcular', { token: administrativo.token, body: { proveedor_id: prov.id, aplicaciones: [{ vencimiento_id: f5.venc.id, importe: 1000 }] } })).json;
  assert.deepEqual([vigente.retenciones[0].alicuota, vigente.retenciones[0].calculado, vigente.retenciones[0].aviso], [3, 30, null]);
  assert.equal((await api('POST', `/api/compras/retenciones/regimenes/${gan.id}/padron`, { token: gerente.token, body: { contenido: 'basura' } })).json.codigo, 'PADRON_INVALIDO');
  // Certificados y exportación para el aplicativo.
  const certs = (await api('GET', `/api/compras/retenciones/certificados?regimen_id=${gan.id}`, { token: gerente.token })).json;
  assert.ok(certs.length >= 3 && certs.every((c) => c.regimen === 'GAN'));
  assert.equal((await api('GET', `/api/compras/retenciones/exportar?regimen_id=${gan.id}`, { token: gerente.token })).status, 200);
});
