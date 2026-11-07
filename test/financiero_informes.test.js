const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario, terminal, vender } = require('./ayudas_financiero');
const { hashCodigo } = require('../src/utils/credenciales');
const M = require('../src/mensajeria/servicio');
const puertos = require('../src/modulos/puertos');
const Turnos = require('../src/financiero/turnoService');

process.env.AFIP_CONDICION_IVA_EMISOR = 'monotributista';

let api, pool, cerrar, adm, gerente, gerenteBarra, cajero, administrativo, term, barra, banco, posnet, cliente, cuentaCC, k = 0;
const hoyMas = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  term = await terminal(pool, 'Barra 1', 'BARRA001');
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  cajero = await usuario(api, pool, 'cami', 'cajero', 'BARRA001');
  gerenteBarra = await usuario(api, pool, 'geri', 'gerente', 'BARRA001');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  const [sup] = await pool.query("INSERT INTO users (username, password_hash, rol, pin_hash) VALUES ('sup', ?, 'admin', ?)", [await bcrypt.hash('clave-larga-1', 4), hashCodigo('2222')]);
  await pool.query("INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = 'administrador'", [sup.insertId]);
  await api('POST', '/api/modulos/financiero/instalar', { token: adm.token });
  await api('POST', '/api/modulos/clientes/instalar', { token: adm.token });
  const crear = async (b) => (await api('POST', '/api/financiero/cuentas', { token: adm.token, body: b })).json;
  barra = await crear({ tipo: 'caja_efectivo', nombre: 'Caja Barra', terminal_id: term, fondo_cambio: 5000, saldo_inicial: 5000 });
  banco = await crear({ tipo: 'banco', nombre: 'Banco', saldo_inicial: 20000 });
  posnet = await crear({ tipo: 'procesador', nombre: 'Posnet' });
  const destino = (b) => api('PUT', '/api/financiero/destinos', { token: adm.token, body: b });
  await destino({ forma: 'efectivo', modo: 'caja_del_turno' });
  await destino({ forma: 'tarjeta_debito', cuenta_id: posnet.id, plazo_acreditacion_dias: 2, comision_pct: 1.5 });
  assert.equal((await api('POST', '/api/financiero/turnos', { token: cajero.token, body: { cuenta_id: barra.id, fondo_contado: 5000 } })).status, 201);
  cliente = (await api('POST', '/api/clientes', { token: adm.token, body: { tipo_documento: 'CUIT', nro_documento: '30711111111', razon_social: 'Café del Centro SRL', consultar_arca: false } })).json;
  cuentaCC = (await api('POST', '/api/cuentas-corrientes', { token: adm.token, body: { cliente_id: cliente.id, limite_credito: 900000, plazo_dias: 15 } })).json;
});
after(async () => { await cerrar(); });

const venta = (importe, forma = 'efectivo', extra = {}) => vender(api, pool, cajero.token, { armar: adm.token, importe, pagos: [{ forma, importe, ...extra }] });
const saldo = async (id) => (await api('GET', `/api/financiero/cuentas/${id}`, { token: adm.token })).json.saldo;
const movs = async (q) => (await api('GET', `/api/financiero/movimientos?${q}`, { token: adm.token })).json;
const get = (ruta, t = gerente) => api('GET', `/api/financiero${ruta}`, { token: t.token });
const msg = async (origen, destino, tipo, contenido, docId = `DOC-${++k}`, extra = {}) => {
  const conn = await pool.getConnection();
  try { await M.publicar(conn, { origen, destino, tipo, docTipo: 'doc', docIdGlobal: docId, contenido, ...extra }); } finally { conn.release(); }
  await esperarMensajes(pool);
  return docId;
};

test('Financiero.RF13: el flujo de fondos parte del saldo actual y suma lo esperado de cada componente; el que no está presente se omite sin error', async () => {
  assert.equal((await get('/informes/flujo', cajero)).status, 403);
  assert.equal((await get('/informes/flujo?periodo=hora')).status, 400);
  const vacio = (await get('/informes/flujo?periodo=dia&dias=30')).json;
  assert.deepEqual(vacio.componentes, ['acreditaciones']); // sin FIN-CHEQUES, FIN-GASTOS-REC ni vencimientos de otros módulos
  assert.equal(vacio.saldo_actual, 25000); // 5.000 de la caja + 20.000 del banco (el procesador no cuenta: su plata son créditos a acreditar)
  assert.equal(vacio.filas[vacio.filas.length - 1].saldo_final, 25000);

  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['FIN-CHEQUES', 'FIN-GASTOS-REC'], motivo: 'prueba' } });
  await venta(1000, 'tarjeta_debito', { referencia: 'CUP-F1' }); // acredita en 2 días: 1.000 menos 15 de comisión estimada
  const ch = (b) => api('POST', '/api/financiero/cheques', { token: gerente.token, body: { tipo: 'fisico', banco: 'Galicia', cuit_librador: '30711111111', ...b } });
  assert.equal((await ch({ origen: 'tercero', numero: '1', importe: 3000, fecha_pago: hoyMas(5) })).status, 201);
  assert.equal((await ch({ origen: 'propio', numero: '2', cuit_librador: undefined, importe: 500, fecha_pago: hoyMas(10) })).status, 201);
  const cat = (await get('/categorias')).json.find((c) => c.nombre === 'Alquiler').id;
  assert.equal((await api('POST', '/api/financiero/gastos-recurrentes', { token: administrativo.token, body: { nombre: 'Alquiler', categoria_id: cat, cuenta_id: banco.id, importe_estimado: 2000, periodicidad: 'mensual', proxima_fecha: hoyMas(15) } })).status, 201);
  // Clientes publica sus vencimientos (a 15 días, por el plazo de la cuenta) y Compras los suyos; una foto más vieja se ignora.
  await M.publicar(await pool.getConnection().then((c) => { c.release(); return pool; }), { origen: 'ventas', destino: 'clientes', tipo: 'debito_venta', docTipo: 'venta', docIdGlobal: 'VTA-CC-1', contenido: { cliente_id: cliente.id, venta_id_global: 'VTA-CC-1', importe: 4000, fecha: hoyMas(0) } });
  await esperarMensajes(pool);
  await require('../src/clientes/vencimientosService').publicar();
  await esperarMensajes(pool);
  await msg('compras', 'financiero', 'vencimientos_por_pagar', { generado_ms: 2000, vencimientos: [{ fecha: hoyMas(20), importe: 1500 }] }, 'COMPRAS-VENCIMIENTOS', { docVersion: 1 });
  await msg('compras', 'financiero', 'vencimientos_por_pagar', { generado_ms: 1000, vencimientos: [{ fecha: hoyMas(3), importe: 99999 }] }, 'COMPRAS-VENCIMIENTOS', { docVersion: 2 }); // más vieja: se ignora
  const f = (await get('/informes/flujo?periodo=dia&dias=30')).json;
  assert.deepEqual(f.componentes.sort(), ['acreditaciones', 'cheques', 'gastos_recurrentes', 'vencimientos_clientes', 'vencimientos_compras']);
  const en = (dias) => f.filas.find((x) => x.periodo === hoyMas(dias));
  assert.equal(f.saldo_actual, 25000); // la venta con tarjeta no entra a la caja: queda como crédito a acreditar
  assert.deepEqual([en(2).ingresos, en(5).ingresos, en(10).egresos, en(15).ingresos, en(15).egresos, en(20).egresos], [985, 3000, 500, 4000, 2000, 1500]);
  const ultimo = f.filas[f.filas.length - 1];
  assert.equal(ultimo.saldo_final, 25000 + 985 + 3000 - 500 + 4000 - 2000 - 1500);
  // Por semana y por mes agrupa las mismas cifras.
  const sem = (await get('/informes/flujo?periodo=semana&dias=30')).json;
  assert.equal(sem.filas[sem.filas.length - 1].saldo_final, ultimo.saldo_final);
  assert.ok(sem.filas.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.periodo)));
  const mes = (await get('/informes/flujo?periodo=mes&dias=90')).json;
  assert.ok(mes.filas.every((x) => /^\d{4}-\d{2}$/.test(x.periodo)));
  // Lo real contra lo proyectado: para hoy trae los ingresos y egresos efectivos.
  const hoy = (await get('/informes/flujo?periodo=dia&dias=3&real=1')).json.filas.find((x) => x.periodo === hoyMas(0));
  assert.ok(hoy.real.ingresos >= 0 && hoy.real.egresos >= 0);
  assert.equal((await get(`/informes/flujo?periodo=dia&dias=3&formato=csv`)).status, 200);
});

test('Financiero.RF14/RN16: el balance de actividad cuenta lo percibido por categoría y cuenta, deja afuera lo que se mueve entre cuentas propias y compara con el período anterior', async () => {
  await venta(700, 'efectivo');
  const cat = (await get('/categorias')).json.find((c) => c.nombre === 'Insumos de limpieza').id;
  await api('POST', '/api/financiero/gastos', { token: gerente.token, body: { categoria_id: cat, cuenta_id: banco.id, importe: 300, descripcion: 'Lavandina' } });
  await api('POST', '/api/financiero/transferencias', { token: gerente.token, body: { origen_id: banco.id, destino_id: barra.id, importe: 1000, motivo: 'Cambio para la caja' } }); // movimiento interno
  const hoy = hoyMas(0);
  const b = (await get(`/informes/balance?desde=${hoy}&hasta=${hoy}`)).json;
  const fila = (g) => b.filas.find((f) => f.grupo === g);
  assert.deepEqual([fila('Ventas').ingresos, fila('Insumos de limpieza').egresos], [1700, 300]); // 700 en efectivo + 1.000 con tarjeta (percibido); la venta a cuenta corriente no está
  assert.ok(!b.filas.some((f) => /transferencia/i.test(f.grupo))); // la transferencia no es ingreso ni egreso
  assert.equal(b.neto, b.ingresos - b.egresos);
  const porCuenta = (await get(`/informes/balance?desde=${hoy}&hasta=${hoy}&agrupar=cuenta`)).json;
  assert.ok(porCuenta.filas.find((f) => f.grupo === 'Banco').egresos >= 300);
  const cmp = (await get(`/informes/balance?desde=${hoy}&hasta=${hoy}&comparar=1`)).json;
  assert.ok(cmp.anterior && cmp.comparacion.find((c) => c.grupo === 'Ventas').actual === 1700);
  assert.equal(cmp.comparacion.find((c) => c.grupo === 'Ventas').anterior, 0);
  assert.equal((await get('/informes/balance?desde=2026-11-10&hasta=2026-11-01')).status, 400);
  assert.equal((await get('/informes/balance?desde=2026-11-01&hasta=2026-11-30&agrupar=otro')).status, 400);
  assert.equal((await get(`/informes/balance?desde=${hoy}&hasta=${hoy}&formato=xlsx`)).status, 200);
  assert.equal((await get(`/informes/balance?desde=${hoy}&hasta=${hoy}&formato=pdf`)).status, 200);
  assert.equal((await get(`/informes/balance?desde=${hoy}&hasta=${hoy}&formato=doc`)).status, 400);
});

test('Financiero.RF16: el historial de turnos trae las diferencias por cajero y los cierres sucesivos; las consultas de saldos y movimientos se exportan', async () => {
  const turno = (await get('/turnos/abierto', cajero)).json;
  const c = await api('POST', `/api/financiero/turnos/${turno.id}/cerrar`, { token: cajero.token, body: { conteo: { efectivo: (await saldo(barra.id)) - 40 }, motivo: 'faltan 40', autorizacion: { credencial: '2222' } } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const t = (await get('/informes/turnos')).json;
  assert.equal(t.filas[0].diferencia, -40);
  assert.deepEqual(t.por_cajero[0], { cajero: 'cami', turnos: 1, faltantes: 40, sobrantes: 0, neto: -40 });
  assert.equal(t.filas[0].cierres.length, 1);
  assert.equal((await get('/informes/turnos?formato=csv')).status, 200);
  assert.equal((await get('/informes/saldos?formato=xlsx')).status, 200);
  assert.equal((await get('/informes/movimientos?formato=csv')).status, 200);
  assert.equal((await get('/informes/saldos', cajero)).status, 403);
  await api('POST', '/api/financiero/turnos', { token: cajero.token, body: { cuenta_id: barra.id, fondo_contado: await saldo(barra.id) } }); // se vuelve a abrir para seguir
});

test('Financiero.RF25/RF26: los indicadores del tablero y el paquete de consolidación se calculan con los datos de la instancia', async () => {
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['USU-TABLERO'], motivo: 'prueba' } });
  const disp = (await api('GET', '/api/tablero/indicadores', { token: gerente.token })).json.map((i) => i.id);
  for (const id of ['financiero.saldos', 'financiero.flujo7', 'financiero.flujo30', 'financiero.diferencias', 'financiero.acreditaciones']) assert.ok(disp.includes(id), `falta ${id}`);
  const cajeroVe = (await api('GET', '/api/tablero/indicadores', { token: cajero.token })).json.map((i) => i.id);
  assert.ok(!cajeroVe.includes('financiero.saldos')); // solo quien tiene permiso sobre los saldos
  await api('PUT', '/api/tablero', { token: gerente.token, body: { indicadores: ['financiero.saldos', 'financiero.acreditaciones', 'financiero.diferencias'], periodo: 'dia' } });
  const tab = (await api('GET', '/api/tablero', { token: gerente.token })).json;
  const v = (id) => tab.indicadores.find((i) => i.id === id);
  assert.equal(v('financiero.saldos').valor, await require('../src/financiero/proyeccionService').saldoActual());
  assert.equal(v('financiero.acreditaciones').valor, 1000);
  assert.equal(v('financiero.diferencias').valor, -40);
  // Paquete de consolidación del día.
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['USU-CONSOL'], motivo: 'prueba' } });
  await api('PUT', '/api/consolidacion/configuracion', { token: adm.token, body: { sucursal: true, casa_central: true } });
  const ayer = hoyMas(-1);
  const hoy = hoyMas(0);
  const [[cat]] = await pool.query("SELECT id FROM fin_categorias WHERE nombre = 'Insumos de limpieza'");
  await pool.query("INSERT INTO fin_movimientos (id_global, cuenta_id, tipo, importe, categoria_id, moneda, fecha_ms) VALUES ('GASTO-AYER', ?, 'gasto', -120, ?, 'ARS', ?)", [banco.id, cat.id, new Date(`${ayer}T12:00:00`).getTime()]); // un gasto de ayer
  const pub = await api('POST', '/api/consolidacion/publicar', { token: adm.token, body: { periodo: ayer } });
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  const paquete = pub.json.find((p) => p.modulo === 'financiero');
  assert.ok(paquete, 'se publicó el paquete de Financiero');
  const pubs = (await api('GET', `/api/consolidacion/publicados?periodo=${ayer}`, { token: adm.token })).json;
  const contenido = (pubs.find((p) => p.modulo === 'financiero') ?? {}).contenido ?? paquete.contenido;
  if (contenido) {
    assert.ok(contenido.movimientos.every((m) => !('id' in m) && !('referencia_externa' in m))); // agregado por día: sin movimientos individuales
    assert.ok(contenido.saldos_cierre.some((s) => s.cuenta === 'Banco'));
    assert.ok(contenido.movimientos.some((m) => m.tipo === 'gasto' && m.categoria === 'Insumos de limpieza'));
  }
  assert.deepEqual((await api('POST', '/api/consolidacion/publicar', { token: adm.token, body: { periodo: ayer } })).json.filter((p) => p.modulo === 'financiero').map((p) => p.nuevo), [false]); // idempotente
  void hoy;
});

// ---- Moneda extranjera ----

test('Financiero.RN36/RN34/EX24: VEN-DIVISA exige FIN-MONEDA-EXT y una forma de pago en divisa necesita un destino en esa moneda para activarse', async () => {
  const cambiar = (b) => api('POST', '/api/funciones/cambiar', { token: adm.token, body: { motivo: 'prueba', ...b } });
  assert.notEqual((await cambiar({ activar: ['VEN-DIVISA'] })).status, 200); // con Financiero instalado, necesita FIN-MONEDA-EXT
  assert.equal((await cambiar({ activar: ['FIN-MONEDA-EXT'] })).status, 200);
  assert.equal((await cambiar({ activar: ['VEN-DIVISA'] })).status, 200);
  assert.equal((await api('POST', '/api/monedas/cotizaciones', { token: adm.token, body: { moneda: 'USD', comprador: 1000, vendedor: 1050 } })).status, 201);
  const forma = (b) => api('POST', '/api/formas-pago', { token: adm.token, body: { codigo: 'usd_efectivo', nombre: 'Dólares', moneda: 'USD', admite_vuelto: 0, orden: 9, ...b } });
  const sin = await forma({});
  assert.equal(sin.status, 409);
  assert.equal(sin.json.codigo, 'SIN_DESTINO_EN_MONEDA');
  const creada = await forma({ activa: false });
  assert.equal(creada.status, 201, JSON.stringify(creada.json)); // se puede guardar desactivada
  assert.equal(creada.json.activa, 0);
  // Una caja en dólares y el destino de la forma.
  assert.equal((await api('POST', '/api/financiero/cuentas', { token: adm.token, body: { tipo: 'caja_fuerte', nombre: 'Fuerte ARS 2' } })).status, 201);
  const usd = (await api('POST', '/api/financiero/cuentas', { token: adm.token, body: { tipo: 'caja_fuerte', nombre: 'Caja USD', moneda: 'USD', saldo_inicial: 100 } })).json;
  assert.equal(usd.moneda, 'USD');
  assert.equal((await api('PUT', '/api/financiero/destinos', { token: adm.token, body: { forma: 'usd_efectivo', cuenta_id: banco.id } })).status, 409); // el destino tiene que ser en dólares
  assert.equal((await api('PUT', '/api/financiero/destinos', { token: adm.token, body: { forma: 'usd_efectivo', cuenta_id: usd.id } })).status, 200);
  const formaId = creada.json.id;
  const act = await api('PUT', `/api/formas-pago/${formaId}`, { token: adm.token, body: { nombre: 'Dólares', activa: true, moneda: 'USD', orden: 9 } });
  assert.equal(act.status, 200, JSON.stringify(act.json));
  assert.equal((await api('GET', '/api/formas-pago', { token: adm.token })).json.find((f) => f.codigo === 'usd_efectivo').disponible, true);
  // EX25: con el destino perdido la forma deja de ofrecerse y un cobro con ella se bloquea en la venta.
  assert.equal((await api('POST', `/api/financiero/cuentas/${usd.id}/desactivar`, { token: adm.token, body: { confirmar: true } })).status, 200);
  assert.equal((await api('GET', '/api/formas-pago', { token: adm.token })).json.find((f) => f.codigo === 'usd_efectivo').disponible, false);
  const bloqueada = await venta(1000, 'usd_efectivo', { importe_divisa: 1 });
  assert.equal(bloqueada.status, 400);
  assert.equal(bloqueada.json.codigo, 'SIN_DESTINO_DIVISA');
  await api('POST', `/api/financiero/cuentas/${usd.id}/activar`, { token: adm.token });
  // RN35: el cobro en dólares llega con la cotización que fijó Ventas y Financiero la guarda tal cual.
  const ok = await venta(1000, 'usd_efectivo', { importe_divisa: 1 });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const [m] = await movs(`venta=${ok.id}`);
  assert.deepEqual([m.cuenta, m.importe, m.importe_divisa, m.cotizacion, m.moneda], ['Caja USD', 1, 1, 1000, 'USD']);
  assert.equal(await saldo(usd.id), 101);
});

test('Financiero.RF05/RN09/RF15/EX10: la compra y venta de divisas guarda la cotización pactada, pide supervisor si se aparta de la vigente y deja el resultado por diferencia de cambio', async () => {
  const usd = (await get('/cuentas')).json.find((c) => c.nombre === 'Caja USD');
  const fuerte = (await get('/cuentas')).json.find((c) => c.nombre === 'Caja Fuerte' || c.nombre === 'Fuerte ARS 2');
  await pool.query("INSERT INTO fin_movimientos (id_global, cuenta_id, tipo, importe, fecha_ms) VALUES ('SEMILLA-PESOS', ?, 'ingreso', 500000, ?)", [fuerte.id, Date.now()]);
  const op = (b, t = gerente) => api('POST', '/api/financiero/divisas/operaciones', { token: t.token, body: { origen_id: fuerte.id, destino_id: usd.id, ...b } });
  assert.equal((await op({ tipo: 'compra', importe_divisa: 100, cotizacion: 1050, motivo: 'x' }, cajero)).status, 403); // sin el permiso
  assert.equal((await op({ tipo: 'otro', importe_divisa: 100, cotizacion: 1050, motivo: 'compra' })).status, 400);
  assert.equal((await op({ tipo: 'compra', importe_divisa: 0, cotizacion: 1050, motivo: 'compra' })).status, 400);
  assert.equal((await op({ tipo: 'compra', importe_divisa: 100, cotizacion: 1050 })).status, 400); // falta el motivo
  assert.equal((await op({ tipo: 'compra', importe_divisa: 100, cotizacion: 1050, motivo: 'compra', destino_id: banco.id })).status, 409); // el destino no es en divisa
  // A la vigente vendedora (1.050) entra sin supervisor; el resultado por diferencia de cambio es cero.
  const ok = await op({ tipo: 'compra', importe_divisa: 100, cotizacion: 1050, motivo: 'Compra de dólares' });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.importe_pesos, ok.json.resultado_cambio, ok.json.autorizado], [105000, 0, false]);
  const [mP, mD] = [(await movs(`cuenta_id=${fuerte.id}&tipo=compra_divisa`))[0], (await movs(`cuenta_id=${usd.id}&tipo=compra_divisa`))[0]];
  assert.deepEqual([mP.importe, mP.importe_divisa, mP.cotizacion, mD.importe, mD.vinculo_id], [-105000, 100, 1050, 100, mP.id]); // la cotización queda tal cual en los dos
  // Pagar 10% más que la vigente (tope 5%): pide supervisor; con él pasa y la diferencia es una pérdida.
  const caro = await op({ tipo: 'compra', importe_divisa: 10, cotizacion: 1155, motivo: 'Compra urgente' });
  assert.equal(caro.status, 403);
  assert.equal(caro.json.codigo, 'REQUIERE_AUTORIZACION');
  const conSup = await op({ tipo: 'compra', importe_divisa: 10, cotizacion: 1155, motivo: 'Compra urgente', autorizacion: { credencial: '2222' } });
  assert.equal(conSup.status, 201, JSON.stringify(conSup.json));
  assert.deepEqual([conSup.json.resultado_cambio, conSup.json.autorizado], [-1050, true]); // (1.050 - 1.155) × 10
  // La venta de divisas va a la punta compradora (1.000): vender a 1.100 (10% arriba) pide supervisor y genera ganancia.
  const venta1 = await op({ tipo: 'venta', origen_id: usd.id, destino_id: fuerte.id, importe_divisa: 20, cotizacion: 1100, motivo: 'Venta de dólares', autorizacion: { credencial: '2222' } });
  assert.equal(venta1.status, 201, JSON.stringify(venta1.json));
  assert.deepEqual([venta1.json.importe_pesos, venta1.json.resultado_cambio], [22000, 2000]); // (1.100 - 1.000) × 20
  assert.equal(await saldo(usd.id), 101 + 100 + 10 - 20);
  assert.equal((await op({ tipo: 'venta', origen_id: usd.id, destino_id: fuerte.id, importe_divisa: 9999, cotizacion: 1000, motivo: 'de más' })).json.codigo, 'SALDO_INSUFICIENTE');
  assert.equal((await get('/divisas/operaciones')).json.length, 3);
  // Valuación a la cotización vigente contra el costo de cada movimiento: 191 USD × 1.000 (compradora).
  const val = (await get('/informes/valuacion')).json;
  const f = val.filas.find((x) => x.cuenta === 'Caja USD');
  assert.deepEqual([f.saldo, f.cotizacion, f.valor_pesos], [191, 1000, 191000]);
  assert.equal((await get('/informes/valuacion?formato=csv')).status, 200);
  // EX10: sin cotización o vencida.
  const viejaFecha = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  assert.equal((await api('POST', '/api/monedas/cotizaciones', { token: adm.token, body: { moneda: 'EUR', comprador: 1500, vendedor: 1560, fecha_hora: viejaFecha } })).status, 201);
  const eur = (await api('POST', '/api/financiero/cuentas', { token: adm.token, body: { tipo: 'caja_fuerte', nombre: 'Caja EUR', moneda: 'EUR' } })).json;
  const vencida = await op({ tipo: 'compra', importe_divisa: 1, cotizacion: 1560, motivo: 'con cotización vieja', destino_id: eur.id });
  assert.equal(vencida.status, 201);
  assert.match(vencida.json.aviso, /vencida/);
  await api('PUT', '/api/financiero/config', { token: adm.token, body: { cotizacion_vencida: 'bloquear' } });
  const bloq = await op({ tipo: 'compra', importe_divisa: 1, cotizacion: 1560, motivo: 'con cotización vieja', destino_id: eur.id });
  assert.equal(bloq.status, 409);
  assert.equal(bloq.json.codigo, 'SIN_COTIZACION');
  await api('PUT', '/api/financiero/config', { token: adm.token, body: { cotizacion_vencida: 'advertir' } });
  assert.equal((await api('PUT', '/api/financiero/config', { token: adm.token, body: { divisas_tolerancia_pct: 150 } })).status, 400);
});

// ---- Devolución en efectivo y saldo de la caja ----

test('Financiero.RN45/RN42/llamada 20: la devolución en efectivo consulta el saldo de la caja; si no alcanza o Financiero no responde, solo sale con un supervisor y queda marcada', async () => {
  const dev = (id, headers = {}, body = {}) => api('POST', '/api/devoluciones', { token: gerenteBarra.token, headers: { 'X-ID-Solicitud': `dev-g9-${++k}-abcdef`, ...headers }, body: { venta_id_global: id, motivo: 'se arrepintió', todo: true, ...body } });
  const v = await venta(500, 'efectivo');
  const turno = (await get('/turnos/abierto', cajero)).json;
  const disponible = await saldo(barra.id);
  // La plata salió de la caja por otro lado: quedan 100 y se devuelven 500.
  await api('POST', `/api/financiero/turnos/${turno.id}/movimientos`, { token: gerente.token, body: { tipo: 'retiro', importe: disponible - 100, motivo: 'Retiro a la caja fuerte' } });
  assert.equal(await saldo(barra.id), 100);
  const sin = await dev(v.id);
  assert.equal(sin.status, 403); // no alcanza: necesita supervisor en ese momento
  assert.match(sin.json.error, /La caja tiene 100/);
  assert.equal((await movs(`venta=${v.id}`)).filter((m) => m.tipo === 'devolucion').length, 0);
  const aut = await dev(v.id, {}, { autorizacion: { credencial: '2222' } });
  assert.equal(aut.status, 201, JSON.stringify(aut.json));
  await esperarMensajes(pool);
  const contra = (await movs(`venta=${v.id}`)).find((m) => m.tipo === 'devolucion');
  assert.equal(contra.importe, -500);
  assert.match(contra.marcas, /^saldo_negativo_autorizado:-400/);
  assert.ok(!/sin_autorizacion/.test(contra.marcas));

  // Financiero no responde: la devolución en efectivo pide supervisor y queda «saldo no verificado».
  const original = { registrarCobro: async () => null, turnoAbierto: ({ terminalId }) => Turnos.turnoDeTerminal(terminalId), saldoCaja: async () => { throw new Error('caído'); }, destinoDe: async () => ({ asignado: true }) };
  puertos.registrar('cobros', original);
  try {
    await api('POST', `/api/financiero/turnos/${turno.id}/movimientos`, { token: gerente.token, body: { tipo: 'ingreso', importe: 5000, motivo: 'Cambio traído del banco' } });
    const v2 = await venta(300, 'efectivo');
    const sin2 = await dev(v2.id);
    assert.equal(sin2.status, 403);
    assert.match(sin2.json.error, /Financiero no responde/);
    const con2 = await dev(v2.id, {}, { autorizacion: { credencial: '2222' } });
    assert.equal(con2.status, 201, JSON.stringify(con2.json));
  } finally { puertos.registrar('cobros', { ...original, saldoCaja: async ({ terminalId }) => { const t = await Turnos.turnoDeTerminal(terminalId); return t.sinCaja ? { saldo: null } : { saldo: await require('../src/financiero/cuentaService').saldoDe(t.caja_id) }; } }); }
  // La devolución con otra forma de pago que no es efectivo no consulta la caja.
  const t3 = await venta(200, 'tarjeta_debito', { referencia: 'CUP-F3' });
  assert.equal((await dev(t3.id)).status, 201);
});

test('Financiero.EX31: la devolución que llegó sin autorización previa y dejó la caja en negativo se ratifica con la credencial de otro usuario con el permiso', async () => {
  const [{ id }] = await pool.query("SELECT id FROM fin_movimientos WHERE tipo = 'ingreso' LIMIT 1").then((r) => r[0]);
  void id;
  // El saldo cambió entre la consulta y el mensaje: llega sin autorización y la caja queda en negativo.
  const v = await venta(250, 'efectivo');
  const turno = (await get('/turnos/abierto', cajero)).json;
  const disp = await saldo(barra.id);
  await api('POST', `/api/financiero/turnos/${turno.id}/movimientos`, { token: gerente.token, body: { tipo: 'retiro', importe: disp, motivo: 'Se llevaron todo' } });
  assert.equal(await saldo(barra.id), 0);
  await msg('ventas', 'financiero', 'cobro_revertido', { venta_id_global: v.id, motivo: 'tarde', reintegros: [{ forma: 'efectivo', importe: 250 }], saldo_autorizado_por: null }, v.id, { docVersion: 77, secuencia: 2 });
  const contra = (await movs(`venta=${v.id}`)).find((m) => m.tipo === 'devolucion');
  assert.match(contra.marcas, /^saldo_negativo_sin_autorizacion:-250/);
  const rat = (b, t = gerente) => api('POST', `/api/financiero/movimientos/${contra.id}/ratificar`, { token: t.token, body: b });
  assert.equal((await rat({}, cajero)).status, 403); // sin el permiso
  assert.equal((await rat({})).status, 403); // sin credencial
  assert.equal((await rat({ autorizacion: { usuario: 'gero', credencial: 'clave-larga-1' } })).status, 403); // nadie se ratifica a sí mismo
  assert.ok((await pool.query("SELECT detalle FROM auditoria WHERE accion = 'autorizacion_rechazada'"))[0].some((a) => /propia acción/.test(a.detalle)));
  const ok = await rat({ autorizacion: { credencial: '2222' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.match(ok.json.marcas, /^saldo_negativo_ratificado:-250/);
  assert.equal((await rat({ autorizacion: { credencial: '2222' } })).status, 409); // ya no está pendiente
  const abiertas = (await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE clave = ? AND estado <> 'resuelta'", [`saldo-negativo:${contra.id}`]))[0][0].n;
  assert.equal(abiertas, 0);
});
