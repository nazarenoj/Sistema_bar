const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario, terminal } = require('./ayudas_financiero');
const { hashCodigo } = require('../src/utils/credenciales');
const M = require('../src/mensajeria/servicio');
const Claves = require('../src/servicios/comprobanteTerceroService');
const Lectura = require('../src/servicios/lecturaComprobanteService');
const Recurrentes = require('../src/financiero/gastoRecurrenteService');

let api, pool, cerrar, adm, gerente, cajero, administrativo, term, barra, banco, catServicios, catLimpieza, k = 0;
const CUIT = '30711111111';

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  term = await terminal(pool, 'Barra 1', 'BARRA001');
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  cajero = await usuario(api, pool, 'cami', 'cajero', 'BARRA001');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  const [sup] = await pool.query("INSERT INTO users (username, password_hash, rol, pin_hash) VALUES ('sup', ?, 'admin', ?)", [await bcrypt.hash('clave-larga-1', 4), hashCodigo('2222')]);
  await pool.query("INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = 'administrador'", [sup.insertId]);
  await api('POST', '/api/modulos/financiero/instalar', { token: adm.token });
  const crear = async (b) => (await api('POST', '/api/financiero/cuentas', { token: adm.token, body: b })).json;
  barra = await crear({ tipo: 'caja_efectivo', nombre: 'Caja Barra', terminal_id: term, fondo_cambio: 5000, saldo_inicial: 5000 });
  banco = await crear({ tipo: 'banco', nombre: 'Banco', saldo_inicial: 20000, limite_descubierto: 1000 });
  const cats = (await api('GET', '/api/financiero/categorias', { token: adm.token })).json;
  catServicios = cats.find((c) => c.nombre === 'Servicios').id;
  catLimpieza = cats.find((c) => c.nombre === 'Insumos de limpieza').id;
  assert.equal((await api('POST', '/api/financiero/turnos', { token: cajero.token, body: { cuenta_id: barra.id, fondo_contado: 5000 } })).status, 201);
});
after(async () => { await cerrar(); });

const gasto = (b, t = administrativo, headers = {}) => api('POST', '/api/financiero/gastos', { token: t.token, body: { categoria_id: catLimpieza, cuenta_id: banco.id, ...b }, headers });
const movs = async (q) => (await api('GET', `/api/financiero/movimientos?${q}`, { token: adm.token })).json;
const saldo = async (id) => (await api('GET', `/api/financiero/cuentas/${id}`, { token: adm.token })).json.saldo;
const auditoria = async (accion) => (await pool.query('SELECT detalle, resultado FROM auditoria WHERE accion = ?', [accion]))[0];
const comp = (n, extra = {}) => ({ cuit: CUIT, clase: 'FACTURA', tipo: 'A', punto_venta: 1, numero: n, fecha: '2026-11-01', neto: 826.45, iva: 173.55, ...extra });

test('Financiero.RF10/RN02: un gasto lo paga una caja o cuenta, queda en un movimiento y se anula con un contramovimiento', async () => {
  assert.equal((await gasto({ importe: 0 })).status, 400);
  assert.equal((await gasto({ importe: 100, categoria_id: 99999 })).status, 400);
  assert.equal((await gasto({ importe: 100, fecha: '01/11/2026' })).status, 400);
  assert.equal((await gasto({ importe: 100, cuenta_id: 99999 })).status, 404);
  assert.equal((await gasto({ importe: 100 }, cajero)).status, 403); // el cajero necesita un supervisor
  const g = await gasto({ importe: 1500, descripcion: 'Lavandina y trapos', proveedor: 'Limpieza SA', fecha: '2026-11-03' }, administrativo, { 'X-ID-Solicitud': 'gasto-lavandina-1' });
  assert.equal(g.status, 201, JSON.stringify(g.json));
  assert.deepEqual([g.json.estado, g.json.fecha, g.json.importe, g.json.fiscal, g.json.origen], ['confirmado', '2026-11-03', 1500, false, 'manual']);
  const [m] = await movs(`venta=${g.json.id_global}`);
  assert.deepEqual([m.tipo, m.importe, m.cuenta], ['gasto', -1500, 'Banco']);
  assert.equal(await saldo(banco.id), 18500);
  // La misma solicitud reenviada devuelve el mismo gasto, sin pagar otra vez.
  const rep = await gasto({ importe: 1500, descripcion: 'Lavandina y trapos', proveedor: 'Limpieza SA', fecha: '2026-11-03' }, administrativo, { 'X-ID-Solicitud': 'gasto-lavandina-1' });
  assert.equal(rep.headers.get('idempotency-replayed'), 'true');
  assert.equal(await saldo(banco.id), 18500);
  // Anular: motivo, permiso y un contramovimiento vinculado; nunca se borra.
  assert.equal((await api('POST', `/api/financiero/gastos/${g.json.id}/anular`, { token: administrativo.token, body: { motivo: 'cargado dos veces' } })).status, 403); // necesita supervisor
  assert.equal((await api('POST', `/api/financiero/gastos/${g.json.id}/anular`, { token: gerente.token, body: {} })).status, 400);
  const an = await api('POST', `/api/financiero/gastos/${g.json.id}/anular`, { token: gerente.token, body: { motivo: 'cargado dos veces' } });
  assert.equal(an.json.estado, 'anulado');
  const contra = (await movs(`venta=${g.json.id_global}`)).find((x) => x.tipo === 'anulacion_gasto');
  assert.deepEqual([contra.importe, contra.vinculo_id], [1500, m.id]);
  assert.equal(await saldo(banco.id), 20000);
  assert.equal((await api('POST', `/api/financiero/gastos/${g.json.id}/anular`, { token: gerente.token, body: { motivo: 'otra vez' } })).status, 409);
});

test('Financiero.RN08/EX04: un gasto que dejaría la caja en negativo o la cuenta pasada del descubierto se bloquea e informa el saldo disponible', async () => {
  const caja = await gasto({ importe: 5001, cuenta_id: barra.id }, gerente);
  assert.equal(caja.status, 409);
  assert.deepEqual([caja.json.codigo, caja.json.detalle.saldo], ['SALDO_INSUFICIENTE', 5000]);
  const cuenta = await gasto({ importe: 21001, cuenta_id: banco.id }, gerente); // 20.000 de saldo + 1.000 de descubierto
  assert.equal(cuenta.status, 409);
  assert.equal(cuenta.json.detalle.saldo, 21000);
  assert.equal((await gasto({ importe: 21000, cuenta_id: banco.id }, gerente)).status, 201);
  assert.equal(await saldo(banco.id), -1000);
  // Pagar con la caja exige su turno abierto.
  await api('POST', `/api/financiero/turnos/${(await api('GET', '/api/financiero/turnos/abierto', { token: cajero.token })).json.id}/cerrar`, { token: cajero.token, body: { conteo: { efectivo: 5000 } } });
  const sinTurno = await gasto({ importe: 100, cuenta_id: barra.id }, gerente);
  assert.equal(sinTurno.status, 409);
  assert.equal(sinTurno.json.codigo, 'SIN_TURNO_ABIERTO');
  await api('POST', '/api/financiero/turnos', { token: cajero.token, body: { cuenta_id: barra.id, fondo_contado: 5000 } });
  const ok = await gasto({ importe: 250, cuenta_id: barra.id, descripcion: 'Diario' }, gerente);
  assert.equal(ok.status, 201);
  assert.ok((await movs(`venta=${ok.json.id_global}`))[0].turno_id); // sale del turno de la caja
  // Para seguir con saldo en el banco.
  await pool.query("INSERT INTO fin_movimientos (id_global, cuenta_id, tipo, importe, fecha_ms) VALUES ('SEMILLA-1', ?, 'ingreso', 30000, ?)", [banco.id, Date.now()]);
});

test('Financiero.RF10: el comprobante se adjunta como archivo (JPG, PNG o PDF) y se descarga', async () => {
  const g = (await gasto({ importe: 100 })).json;
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const Gastos = require('../src/financiero/gastoService'); // la API de prueba envía JSON: el adjunto binario se prueba por el servicio
  await assert.rejects(Gastos.adjuntar(g.id, { imagen: png, tipo: 'text/html', nombre: 'x' }), /JPG, PNG o PDF/);
  const r = await Gastos.adjuntar(g.id, { imagen: png, tipo: 'image/png', nombre: 'ticket.png' });
  assert.deepEqual(r.adjunto, { nombre: 'ticket.png', tipo: 'image/png' });
  assert.equal((await Gastos.adjuntoDe(g.id)).adjunto.equals(png), true);
});

test('Financiero.EX12: la carga por foto necesita FIN-FOTO-GASTOS; si la imagen es ilegible se ofrece la carga manual con la imagen adjunta', async () => {
  const Gastos = require('../src/financiero/gastoService');
  const img = Buffer.from('ffd8ffe0', 'hex');
  await assert.rejects(Gastos.leerFoto({ imagen: img, tipo: 'image/jpeg' }), /FIN-FOTO-GASTOS/);
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['USU-FOTO', 'FIN-FOTO-GASTOS'], motivo: 'prueba' } });
  Lectura.usarProveedor(async () => ({ encabezado: { cuit: CUIT, clase: 'FACTURA', tipo: 'A', punto_venta: 1, numero: 555, importe: 1000 }, confianza: { cuit: 0.9 } }));
  const ok = await Gastos.leerFoto({ imagen: img, tipo: 'image/jpeg', nombre: 'luz.jpg' });
  assert.equal(ok.estado, 'leido');
  assert.equal(ok.comprobante.numero, 555);
  Lectura.usarProveedor(async () => { throw new Error('ilegible'); });
  const mal = await Gastos.leerFoto({ imagen: img, tipo: 'image/jpeg', nombre: 'borrosa.jpg' });
  assert.deepEqual([mal.estado, mal.ofrecer, mal.adjunto.nombre], ['ilegible', 'carga_manual', 'borrosa.jpg']);
});

test('Financiero.RN13/EX26: un gasto con comprobante fiscal calcula su clave; el duplicado exacto y el CAE repetido se bloquean y los casi duplicados piden confirmación auditada', async () => {
  const f1 = await gasto({ importe: 1000, categoria_id: catServicios, comprobante: comp(100, { cae: '70000000000001' }), proveedor: 'Edenor' });
  assert.equal(f1.status, 201, JSON.stringify(f1.json));
  assert.equal(f1.json.fiscal, true);
  assert.match(f1.json.clave, /30711111111/);
  await esperarMensajes(pool);
  const [{ estado }] = (await pool.query("SELECT estado FROM claves_comprobante WHERE clave = ?", [f1.json.clave]))[0];
  assert.equal(estado, 'vigente'); // la confirmación viajó en la misma transacción del gasto
  const [{ vinculos }] = (await pool.query("SELECT COUNT(*) AS vinculos FROM clave_vinculos WHERE modulo = 'financiero'"))[0];
  assert.equal(vinculos, 1);

  const dup = await gasto({ importe: 1000, categoria_id: catServicios, comprobante: comp(100) });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.codigo, 'DUPLICADO_EXACTO');
  assert.ok((await auditoria('gasto_duplicado_exacto')).length >= 1);
  assert.equal(await saldo(banco.id), 27900); // -1.000 (semilla 30.000, saldo -1.000, gasto de 100 y este de 1.000): el duplicado no pagó nada

  const cae = await gasto({ importe: 10, categoria_id: catServicios, comprobante: comp(101, { cae: '70000000000001' }) });
  assert.equal(cae.json.codigo, 'CAE_REPETIDO'); // el CAE identifica un solo comprobante

  const casi = await gasto({ importe: 1000, categoria_id: catServicios, comprobante: comp(100, { punto_venta: 2 }) }); // mismo emisor y número, otro punto de venta
  assert.equal(casi.status, 409);
  assert.equal(casi.json.codigo, 'CASI_DUPLICADO');
  assert.ok(casi.json.detalle.coincidentes.length >= 1);
  const conf = await gasto({ importe: 1000, categoria_id: catServicios, comprobante: comp(100, { punto_venta: 2 }), confirmar_casi_duplicado: { motivo: 'son dos sucursales distintas' } });
  assert.equal(conf.status, 201, JSON.stringify(conf.json));
  assert.ok((await auditoria('gasto_casi_duplicado_confirmado')).some((a) => /dos sucursales/.test(a.detalle)));

  // Emisor sin CUIT: la clave usa la razón social y siempre advierte.
  const sin = await gasto({ importe: 80, categoria_id: catServicios, comprobante: { razon_social: 'Ferretería Don Juan', clase: 'TICKET', tipo: 'B', punto_venta: 3, numero: 9, fecha: '2026-11-02' } });
  assert.equal(sin.json.codigo, 'CASI_DUPLICADO');
  assert.equal((await gasto({ importe: 80, categoria_id: catServicios, comprobante: { razon_social: 'Ferretería Don Juan', clase: 'TICKET', tipo: 'B', punto_venta: 3, numero: 9, fecha: '2026-11-02' }, confirmar_casi_duplicado: { motivo: 'ticket de compra chica' } })).status, 201);
  // Un remito y la factura que lo cubre son documentos distintos (no se tratan como duplicados).
  assert.equal((await gasto({ importe: 10, categoria_id: catServicios, comprobante: comp(100, { clase: 'REMITO', tipo: 'X' }) })).status, 201);
  // Datos inválidos: se dice qué corregir.
  const mal = await gasto({ importe: 10, categoria_id: catServicios, comprobante: comp(1, { cuit: '20123456780' }) });
  assert.equal(mal.status, 400);
});

test('Financiero.RN13: si el gasto no se guarda, la clave queda libre; si el servicio de claves no responde, el gasto fiscal queda en borrador', async () => {
  const f = comp(200);
  const grande = await gasto({ importe: 999999, categoria_id: catServicios, comprobante: f });
  assert.equal(grande.json.codigo, 'SALDO_INSUFICIENTE');
  assert.equal((await gasto({ importe: 300, categoria_id: catServicios, comprobante: f })).status, 201); // la reserva del intento anterior se liberó

  const original = Claves.reservar;
  Claves.reservar = async () => { throw new Error('servicio caído'); };
  let borrador;
  try {
    const antes = await saldo(banco.id);
    borrador = await gasto({ importe: 400, categoria_id: catServicios, comprobante: comp(201) });
    assert.equal(borrador.status, 201, JSON.stringify(borrador.json));
    assert.equal(borrador.json.estado, 'borrador');
    assert.match(borrador.json.aviso, /borrador/);
    assert.equal(borrador.json.movimiento_id, null);
    assert.equal(await saldo(banco.id), antes); // todavía no se pagó
  } finally { Claves.reservar = original; }
  const conf = await api('POST', `/api/financiero/gastos/${borrador.json.id}/confirmar`, { token: administrativo.token, body: {} });
  assert.equal(conf.status, 200, JSON.stringify(conf.json));
  assert.equal(conf.json.estado, 'confirmado');
  assert.match(conf.json.clave, /30711111111/);
  assert.equal((await api('POST', `/api/financiero/gastos/${conf.json.id}/confirmar`, { token: administrativo.token, body: {} })).status, 409); // ya no es borrador
  // Anular el gasto fiscal libera la clave: el comprobante puede volver a cargarse.
  await api('POST', `/api/financiero/gastos/${conf.json.id}/anular`, { token: gerente.token, body: { motivo: 'era de otro local' } });
  assert.equal((await gasto({ importe: 400, categoria_id: catServicios, comprobante: comp(201) })).status, 201);
});

test('Financiero.RN13: el gasto con comprobante fiscal se publica como evento idempotente para Compras, que lo toma si está instalado', async () => {
  const Modulos = require('../src/modulos/registro');
  const original = Modulos.estaInstalado;
  Modulos.estaInstalado = async (m) => m === 'compras' || original(m);
  try {
    const g = await gasto({ importe: 120, categoria_id: catServicios, comprobante: comp(300) });
    assert.equal(g.status, 201, JSON.stringify(g.json));
    const [msgs] = await pool.query("SELECT id_operacion, modulo_destino, contenido FROM mensajes_integracion WHERE tipo = 'gasto_con_comprobante_fiscal'");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].id_operacion, `financiero:gasto_con_comprobante_fiscal:${g.json.id_global}:1`); // idempotente por el ID del gasto
    const c = JSON.parse(msgs[0].contenido);
    assert.deepEqual([c.gasto_id_global, c.importe, c.neto, c.iva], [g.json.id_global, 120, 826.45, 173.55]);
    await pool.query("DELETE FROM mensajes_integracion WHERE tipo = 'gasto_con_comprobante_fiscal'");
  } finally { Modulos.estaInstalado = original; }
});

test('Financiero.RF12/RN27: los gastos recurrentes necesitan FIN-GASTOS-REC, recuerdan su vencimiento y generan una sola ocurrencia por período', async () => {
  const rec = (b, t = administrativo) => api('POST', '/api/financiero/gastos-recurrentes', { token: t.token, body: b });
  const datos = { nombre: 'Alquiler', categoria_id: catServicios, cuenta_id: banco.id, importe_estimado: 5000, periodicidad: 'mensual', proxima_fecha: '2026-01-31', aviso_dias: 3 };
  assert.equal((await rec(datos)).status, 409); // sin la función
  assert.deepEqual((await Recurrentes.recordatorios('2026-01-31')), { emitidos: 0 });
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['FIN-GASTOS-REC'], motivo: 'prueba' } });
  assert.equal((await rec({ ...datos, importe_estimado: 0 })).status, 400);
  assert.equal((await rec({ ...datos, periodicidad: 'diaria' })).status, 400);
  assert.equal((await rec({ ...datos, nombre: 'Sin permiso' }, cajero)).status, 403);
  const r = await rec(datos);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal((await rec(datos)).status, 409); // nombre repetido
  // Recordatorio: aparece cuando falta el aviso y no se duplica.
  assert.deepEqual(await Recurrentes.recordatorios('2026-01-27'), { emitidos: 0 }); // faltan 4 días
  assert.deepEqual(await Recurrentes.recordatorios('2026-01-28'), { emitidos: 1 });
  await Recurrentes.recordatorios('2026-01-29');
  const abiertas = (await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE modulo = 'financiero' AND tipo = 'gasto_recurrente' AND estado <> 'resuelta'"))[0][0].n;
  assert.equal(abiertas, 1);
  // Pagar la ocurrencia: gasto de origen «recurrente», próxima fecha respeta el fin de mes y el recordatorio se resuelve solo.
  const [a, b] = await Promise.all([1, 2].map(() => api('POST', `/api/financiero/gastos-recurrentes/${r.json.id}/pagar`, { token: administrativo.token, body: { importe: 5200 } })));
  assert.deepEqual([a.status, b.status].sort(), [201, 409]); // una sola ocurrencia por período
  const ok = a.status === 201 ? a : b;
  assert.equal(ok.json.proxima_fecha, '2026-02-28');
  assert.deepEqual([ok.json.gasto.origen, ok.json.gasto.importe, ok.json.gasto.fecha], ['recurrente', 5200, '2026-01-31']);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE tipo = 'gasto_recurrente' AND estado <> 'resuelta'"))[0][0].n, 0);
  assert.equal((await api('GET', '/api/financiero/gastos-recurrentes', { token: gerente.token })).json[0].proxima_fecha, '2026-02-28');
  assert.equal(Recurrentes.siguiente('2026-02-28', 'mensual', 31), '2026-03-31'); // conserva el día 31 aunque febrero no lo tenga
  assert.equal(Recurrentes.siguiente('2026-01-31', 'anual'), '2027-01-31');
  assert.equal(Recurrentes.siguiente('2026-01-05', 'semanal'), '2026-01-12');
  assert.equal(Recurrentes.siguiente('2026-01-15', 'trimestral'), '2026-04-15');
});

test('Financiero.RF23/RN25: el pago de una liquidación de comisiones sale de la caja o cuenta elegida; una anulación genera el contramovimiento', async () => {
  const msg = async (tipo, contenido, docId, secuencia = 1) => {
    const conn = await pool.getConnection();
    try { await M.publicar(conn, { origen: 'ventas', destino: 'financiero', tipo, docTipo: 'liquidacion_comision', docIdGlobal: docId, secuencia, contenido }); } finally { conn.release(); }
    await esperarMensajes(pool);
    return (await pool.query('SELECT estado, motivo_rechazo FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = ? ORDER BY id DESC LIMIT 1', [docId, tipo]))[0][0];
  };
  const sin = await msg('pago_comision', { total: 1000, cuenta_id: banco.id }, 'LIQ-A');
  assert.match(sin.motivo_rechazo, /VEN-COMISIONES/); // sin la función no se paga
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['VEN-COMISIONES'], motivo: 'prueba' } });
  assert.match((await msg('pago_comision', { total: 1000 }, 'LIQ-B')).motivo_rechazo, /de qué caja o cuenta/);
  assert.match((await msg('pago_comision', { total: 99999999, cuenta_id: banco.id }, 'LIQ-C')).motivo_rechazo, /sin fondos/);
  const antes = await saldo(banco.id);
  assert.equal((await msg('pago_comision', { total: 2500.5, cuenta_id: banco.id, medio_pago: 'transferencia', desde: '2026-10-01', hasta: '2026-10-31' }, 'LIQ-D')).estado, 'confirmado');
  const [pago] = await movs('venta=LIQ-D');
  assert.deepEqual([pago.tipo, pago.importe, pago.cuenta], ['pago_comision', -2500.5, 'Banco']);
  const cat = (await api('GET', '/api/financiero/categorias', { token: adm.token })).json.find((c) => c.nombre === 'Comisiones de vendedores').id;
  assert.equal((await pool.query('SELECT categoria_id FROM fin_movimientos WHERE id = ?', [pago.id]))[0][0].categoria_id, cat);
  assert.equal(await saldo(banco.id), antes - 2500.5);
  // Liquidación anulada en Ventas: el contramovimiento espera al pago y lo revierte (nunca se borra).
  assert.equal((await msg('anulacion_pago_comision', { motivo: 'liquidación anulada' }, 'LIQ-D', 2)).estado, 'confirmado');
  const contra = (await movs('venta=LIQ-D')).find((m) => m.tipo === 'anulacion_pago_comision');
  assert.deepEqual([contra.importe, contra.vinculo_id], [2500.5, pago.id]);
  assert.equal(await saldo(banco.id), antes);
});
