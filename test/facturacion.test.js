const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
// Antes de armar la app: el emisor de la prueba es monotributista, punto de venta 1 (Factura C).
process.env.AFIP_CONDICION_IVA_EMISOR = 'monotributista';
process.env.AFIP_PUNTO_VENTA = '1';
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, afip, wsfe, Secuenciador, Resolucion, token;
let consulta = null; // respuesta de ARCA a la consulta por número: null = inexistente, objeto = existe, Error = sin conexión
let ultimo = 0, enVuelo = 0, maxEnVuelo = 0, rechazarProxima = false, cortarProxima = false, solicitudes = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
  Resolucion = require('../src/services/resolucionService');
  afip = require('../src/services/afipService');
  wsfe = require('../src/afip/wsfeClient');
  Secuenciador = require('../src/services/secuenciadorService');
  // ARCA simulado: un último autorizado y un pedido de CAE lento (para ver la concurrencia).
  wsfe.compUltimoAutorizado = async () => ultimo;
  wsfe.compConsultar = async () => { if (consulta instanceof Error) throw consulta; return consulta; };
  wsfe.solicitarCAE = async ({ item }) => {
    solicitudes++;
    enVuelo++; maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
    await new Promise((r) => setTimeout(r, 30));
    enVuelo--;
    if (cortarProxima) { cortarProxima = false; throw new Error('timeout'); }
    if (rechazarProxima) { rechazarProxima = false; return { FeDetResp: { FECAEDetResponse: [{ Resultado: 'R', Observaciones: { Obs: [{ Code: 1, Msg: 'no' }] } }] } }; }
    ultimo = item.CbteDesde;
    return { FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CAE: '70000000000001', CAEFchVto: '20261231' }] } };
  };
});
after(async () => { await cerrar(); });

const emitir = (extra = {}) => afip.emitirFactura({ tipoComprobante: 11, docTipo: 99, docNro: '0', condicionIvaReceptorId: 5, importeTotal: 100, ...extra });

test('Ventas.RN12/RN49/RN56: 5 emisiones simultáneas sobre la misma clave salen correlativas, una en vuelo a la vez', async () => {
  const base = ultimo;
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => emitir()));
  assert.deepEqual(rs.map((r) => r.numero).sort((a, b) => a - b), [base + 1, base + 2, base + 3, base + 4, base + 5]);
  assert.equal(maxEnVuelo, 1);
  assert.ok(rs.every((r) => r.estado === 'aprobada'));
  assert.equal((await Secuenciador.listar()).find((c) => c.clave === '1:11:CAE').estado, 'libre');
});

test('Ventas.EX03: un rechazo de ARCA libera el número: el próximo comprobante lo usa', async () => {
  rechazarProxima = true;
  const r1 = await emitir();
  assert.equal(r1.estado, 'rechazada');
  const r2 = await emitir();
  assert.equal(r2.estado, 'aprobada');
  assert.equal(r2.numero, r1.numero);
});

test('Ventas.RN52: repetir un intento ya autorizado devuelve el mismo comprobante sin volver a ARCA', async () => {
  const antes = solicitudes;
  const a = await emitir({ idIntento: 'intento-repetido-1' });
  const b = await emitir({ idIntento: 'intento-repetido-1' });
  assert.equal(solicitudes, antes + 1);
  assert.deepEqual(b, a);
  const [[i]] = await pool.query("SELECT estado, numero FROM intento_emision WHERE id_intento = 'intento-repetido-1'");
  assert.equal(i.estado, 'autorizado');
  assert.equal(i.numero, a.numero);
});

test('Ventas.RN52/RN53: un corte después de enviar deja el intento Indeterminado y la clave Resolviendo, sin esperar', async () => {
  cortarProxima = true;
  await assert.rejects(emitir({ idIntento: 'intento-cortado-1' }), /timeout/);
  const [[i]] = await pool.query("SELECT estado FROM intento_emision WHERE id_intento = 'intento-cortado-1'");
  assert.equal(i.estado, 'indeterminado');
  assert.equal((await Secuenciador.listar()).find((c) => c.clave === '1:11:CAE').estado, 'resolviendo');
  const t0 = Date.now();
  await assert.rejects(emitir(), (e) => e.codigo === 'CLAVE_RESOLVIENDO');
  assert.ok(Date.now() - t0 < 1000); // no espera: la venta ofrece CAEA, otro punto de venta o no fiscal
  await Resolucion.liberarClave('1:11:CAE', 'prueba', { username: 'sistema' });
  assert.equal((await emitir()).estado, 'aprobada');
});

test('Ventas.RN50: el arrendamiento vencido de otro se toma; el vigente hace esperar y vence la espera', async () => {
  const clave = '9:11:CAE';
  await pool.query("INSERT INTO secuenciador_claves (clave, estado, propietario, vence_ms) VALUES (?, 'ocupada', 'caido', ?)", [clave, Date.now() - 1000]);
  assert.equal(await Secuenciador.conClave({ puntoVenta: 9, tipo: 11 }, async () => 'tomada'), 'tomada');

  await pool.query("UPDATE secuenciador_claves SET estado = 'ocupada', propietario = 'vivo', vence_ms = ? WHERE clave = ?", [Date.now() + 60000, clave]);
  await assert.rejects(Secuenciador.conClave({ puntoVenta: 9, tipo: 11 }, async () => 'x', { esperaMs: 150 }), (e) => e.codigo === 'CLAVE_OCUPADA');
});

test('Ventas.RN50: mientras la solicitud sigue en curso el arrendamiento se renueva', async () => {
  const clave = '8:11:CAE';
  await Secuenciador.conClave({ puntoVenta: 8, tipo: 11 }, async () => {
    const [[a]] = await pool.query('SELECT vence_ms FROM secuenciador_claves WHERE clave = ?', [clave]);
    await new Promise((r) => setTimeout(r, 120));
    const [[b]] = await pool.query('SELECT vence_ms FROM secuenciador_claves WHERE clave = ?', [clave]);
    assert.ok(Number(b.vence_ms) > Number(a.vence_ms));
  }, { renovarMs: 40 });
});

test('Ventas.RN14: la Factura A exige receptor Responsable Inscripto con CUIT; el consumidor final no pasa el tope', async () => {
  const datos = { tipoComprobante: 1, docTipo: 80, condicionIvaReceptorId: 1, importeTotal: 100 };
  await afip.validarReceptor(datos);
  await assert.rejects(afip.validarReceptor({ ...datos, condicionIvaReceptorId: 5 }), /Responsable Inscripto/);
  await assert.rejects(afip.validarReceptor({ ...datos, docTipo: 96 }), /CUIT/);
  // El tope (0 = sin control) se carga como parámetro.
  await pool.query("UPDATE parametros SET valor = '500' WHERE clave = 'tope_consumidor_final'");
  require('../src/models/parametroModel').invalidar();
  await assert.rejects(emitir({ importeTotal: 501 }), /tope/);
  assert.equal((await emitir({ importeTotal: 500 })).estado, 'aprobada');
  assert.equal((await emitir({ importeTotal: 900, docTipo: 96, docNro: '30111222' })).estado, 'aprobada'); // identificado
});

// --- B7: ARCA caído o lento ---

const adelantar = (idIntento) => pool.query('UPDATE intento_emision SET proxima_consulta_ms = 0 WHERE id_intento = ?', [idIntento]);
const intento = async (id) => (await pool.query('SELECT * FROM intento_emision WHERE id_intento = ?', [id]))[0][0];
const claveEstado = async () => (await Secuenciador.listar()).find((c) => c.clave === '1:11:CAE').estado;
const cortar = async (id, facturaId) => { cortarProxima = true; await assert.rejects(emitir({ idIntento: id, facturaId }), /timeout/); };
const factura = async () => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: Math.floor(Math.random() * 9e6), salon_id: 1 } })).json;
  return require('../src/models/facturaModel').create({ mesa_id: mesa.id, sesion_apertura: new Date(), metodo_pago: 'efectivo', tipo_comprobante: 11, punto_venta: 1,
    doc_tipo: 99, doc_nro: '0', condicion_iva_receptor_id: 5, importe_total: 100, entorno: 'homologacion' });
};

test('Ventas.RN53/EX38: la respuesta tardía completa la factura con el CAE, libera la clave y avisa al cajero', async () => {
  const fac = await factura();
  await cortar('tardia-0001', fac.id);
  const numero = (await intento('tardia-0001')).numero;
  consulta = { resultado: 'A', cae: '70000000000099', caeVencimiento: '2026-12-31' };
  await adelantar('tardia-0001');
  assert.deepEqual(await Resolucion.procesarIndeterminados(), ['autorizado']);
  assert.equal((await intento('tardia-0001')).estado, 'autorizado');
  const [[f]] = await pool.query('SELECT estado, cae, numero FROM facturas WHERE id = ?', [fac.id]);
  assert.deepEqual([f.estado, f.cae, f.numero], ['aprobada', '70000000000099', numero]);
  assert.equal(await claveEstado(), 'libre');
  assert.equal((await pool.query("SELECT COUNT(*) n FROM notificaciones WHERE tipo = 'respuesta_tardia'"))[0][0].n, 1);
  ultimo = numero; // ARCA ya tiene ese número
});

test('Ventas.RN53: si ARCA no tiene el número en dos consultas separadas por 60 s, lo libera para reutilizarlo', async () => {
  await cortar('inexistente-1');
  const numero = (await intento('inexistente-1')).numero;
  consulta = null;
  await adelantar('inexistente-1');
  assert.deepEqual(await Resolucion.procesarIndeterminados(), ['pendiente']); // primera: todavía no alcanza
  assert.equal(await claveEstado(), 'resolviendo');
  await pool.query('UPDATE intento_emision SET proxima_consulta_ms = 0, inexistente_desde_ms = ? WHERE id_intento = ?', [Date.now() - 61000, 'inexistente-1']);
  assert.deepEqual(await Resolucion.procesarIndeterminados(), ['liberado']);
  assert.equal(await claveEstado(), 'libre');
  assert.equal((await emitir()).numero, numero); // el número se reutiliza
});

test('Ventas.EX02/EX07: sin conexión con ARCA el intento queda a la espera y no libera nada', async () => {
  await cortar('sinconex-1');
  consulta = new Error('sin red');
  await adelantar('sinconex-1');
  assert.deepEqual(await Resolucion.procesarIndeterminados(), ['sin_conexion']);
  assert.equal((await intento('sinconex-1')).estado, 'indeterminado');
  assert.equal(await claveEstado(), 'resolviendo');
});

test('Ventas.EX40: sin resolver a los 10 minutos hay alerta crítica y la clave sigue bloqueada', async () => {
  await pool.query("UPDATE intento_emision SET created_at = ? WHERE id_intento = 'sinconex-1'", [new Date(Date.now() - 11 * 60000)]);
  await Resolucion.procesarIndeterminados();
  const [[n]] = await pool.query("SELECT severidad, estado FROM notificaciones WHERE tipo = 'clave_sin_resolver'");
  assert.deepEqual([n.severidad, n.estado], ['critica', 'nueva']);
  assert.equal(await claveEstado(), 'resolviendo');
});

test('Ventas.RN54: una venta con intento indeterminado no puede reintentar la factura', async () => {
  const fac = await factura();
  await pool.query("UPDATE intento_emision SET factura_id = ? WHERE id_intento = 'sinconex-1'", [fac.id]);
  const r = await api('POST', `/api/facturas/${fac.id}/reintentar`, { token, headers: { 'X-ID-Solicitud': 'reintento-bloqueado' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'INTENTO_INDETERMINADO');
});

test('Ventas.RN57: la clave se libera a mano con motivo y queda auditado; la vista la lista', async () => {
  const vista = (await api('GET', '/api/facturas/claves', { token })).json;
  assert.equal(vista.find((c) => c.clave === '1:11:CAE').intentos_pendientes.length, 1);
  assert.equal((await api('POST', '/api/facturas/claves/liberar', { token, body: { clave: '1:11:CAE' } })).status, 400); // sin motivo
  const r = await api('POST', '/api/facturas/claves/liberar', { token, body: { clave: '1:11:CAE', motivo: 'ARCA confirmó por teléfono que no existe' } });
  assert.equal(r.status, 200);
  assert.equal(await claveEstado(), 'libre');
  assert.equal((await pool.query("SELECT COUNT(*) n FROM auditoria WHERE accion = 'clave_liberada'"))[0][0].n, 1);
  assert.equal((await emitir()).estado, 'aprobada');
});

test('Ventas.RN51/EX42: si la numeración local difiere de la de ARCA, la clave queda Resolviendo y se alerta', async () => {
  const sinLocal = await Resolucion.validarNumeracion(1, 6);
  assert.equal(sinLocal.adoptada, true); // sin comprobantes locales se adopta la numeración de ARCA
  const [[{ local }]] = await pool.query("SELECT MAX(numero) local FROM facturas WHERE tipo_comprobante = 11 AND estado = 'aprobada'");
  ultimo = Number(local);
  assert.equal((await Resolucion.validarNumeracion(1, 11)).ok, true);
  ultimo = Number(local) + 3; // ARCA tiene 3 que el registro local no
  const r = await Resolucion.validarNumeracion(1, 11);
  assert.equal(r.ok, false);
  assert.equal(await claveEstado(), 'resolviendo');
  const [[n]] = await pool.query("SELECT mensaje FROM notificaciones WHERE tipo = 'numeracion_distinta'");
  assert.match(n.mensaje, new RegExp(`N° ${Number(local) + 1} a ${ultimo}`));
  await assert.rejects(emitir(), (e) => e.codigo === 'CLAVE_RESOLVIENDO');
  await Resolucion.liberarClave('1:11:CAE', 'reconciliada', { username: 'sistema' });
  assert.equal((await emitir()).estado, 'aprobada');
});
