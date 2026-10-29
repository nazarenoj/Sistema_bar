const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
// Emisor monotributista, punto de venta 1 (Factura C), igual que facturacion.test.js.
process.env.AFIP_CONDICION_IVA_EMISOR = 'monotributista';
process.env.AFIP_PUNTO_VENTA = '1';
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token, Caea, wsfe, Modulos, n = 0;
let ultimo = 0, llamadasCAE = 0, llamadasUltimo = 0, informes = [], fallaInforme = false, sinMov = [];
const dia = (delta) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const [u] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES ('adm', ?, 'admin')", [await bcrypt.hash('clave-larga-1', 4)]);
  await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
  Caea = require('../src/services/caeaService');
  wsfe = require('../src/afip/wsfeClient');
  Modulos = require('../src/modulos/registro');
  // ARCA simulado.
  wsfe.solicitarCAEA = async () => ({ caea: '12345678901234', desde: dia(-1), hasta: dia(10), tope: dia(20) });
  wsfe.compUltimoAutorizado = async () => { llamadasUltimo++; return ultimo; };
  wsfe.solicitarCAE = async ({ item }) => { llamadasCAE++; ultimo = item.CbteDesde; return { FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CAE: '70000000000001', CAEFchVto: '20261231' }] } }; };
  wsfe.informarCAEA = async ({ item }) => { if (fallaInforme) throw new Error('ARCA caído'); informes.push(item.CbteDesde); };
  wsfe.sinMovimientoCAEA = async (pto, caea) => { sinMov.push(caea); };
});
after(async () => { await cerrar(); });

const cuentaAbierta = async () => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const producto = (await api('POST', '/api/productos', { token, body: { nombre: `Café ${n}`, precio: 100 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: producto.id, cantidad: 1 }] } });
  return mesa;
};
const cobrar = (mesa, clave, extra) => api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': clave }, body: { metodo_pago: 'efectivo', ...extra } });
const conCaea = { modalidad: 'caea', tipo_comprobante: 11, doc_tipo: 99, doc_nro: '0', condicion_iva_receptor_id: 5 };

test('Ventas.RN15/EX05: sin un CAEA vigente no se emite con CAEA y la cuenta sigue abierta', async () => {
  const mesa = await cuentaAbierta();
  const r = await cobrar(mesa, 'caea-sin-vigente', conCaea);
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'SIN_CAEA');
  assert.equal((await pool.query('SELECT estado FROM mesas WHERE id = ?', [mesa.id]))[0][0].estado, 'ocupado');
  assert.equal((await pool.query('SELECT COUNT(*) n FROM ventas WHERE mesa_id = ?', [mesa.id]))[0][0].n, 0);
});

test('Ventas.RF11: se solicita y guarda el CAEA del período; queda como vigente', async () => {
  const r = await api('POST', '/api/facturas/caea/solicitar', { token, body: {} });
  assert.equal(r.status, 201);
  assert.equal(r.json.caea, '12345678901234');
  assert.equal((await api('GET', '/api/facturas/caea/vigente', { token })).json.vigente.caea, '12345678901234');
});

test('Ventas.RN55: con CAEA la numeración es un contador local atómico, sin ARCA en línea', async () => {
  const numeros = [];
  for (const clave of ['caea-venta-1', 'caea-venta-2']) {
    const mesa = await cuentaAbierta();
    const r = await cobrar(mesa, clave, conCaea);
    assert.equal(r.status, 200);
    assert.equal(r.json.factura.estado, 'aprobada');
    assert.equal(r.json.factura.modalidad, 'CAEA');
    assert.equal(r.json.factura.cae, '12345678901234');
    numeros.push(r.json.factura.numero);
  }
  assert.deepEqual(numeros, [1, 2]);
  assert.equal(llamadasCAE + llamadasUltimo, 0); // nunca se habló con ARCA para numerar
  // 5 contadores simultáneos no repiten número.
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => Caea.siguienteNumero('1:11:CAEA')));
  assert.equal(new Set(rs).size, 5);
});

test('Ventas.RF11/RN55: el informe a ARCA es idempotente por número: reenviarlo no duplica', async () => {
  assert.equal(await Caea.informarPendientes(), 2);
  assert.deepEqual(informes.sort(), [1, 2]);
  assert.equal(await Caea.informarPendientes(), 0);
  assert.equal(informes.length, 2);
});

test('Ventas.EX06: si falla el informe se reintenta y se alerta al Administrador', async () => {
  const mesa = await cuentaAbierta();
  const r = await cobrar(mesa, 'caea-venta-3', conCaea);
  fallaInforme = true;
  assert.equal(await Caea.informarPendientes(), 0);
  const [[f]] = await pool.query('SELECT informado_ms, intentos_informe FROM facturas WHERE id = ?', [r.json.factura.id]);
  assert.deepEqual([f.informado_ms, f.intentos_informe], [null, 1]);
  await Caea.alertarInformes();
  assert.equal((await pool.query("SELECT COUNT(*) n FROM notificaciones WHERE tipo = 'caea_sin_informar' AND estado <> 'resuelta'"))[0][0].n, 1);
  fallaInforme = false;
  assert.equal(await Caea.informarPendientes(), 1); // se reintenta sola
  await Caea.alertarInformes();
  assert.equal((await pool.query("SELECT COUNT(*) n FROM notificaciones WHERE tipo = 'caea_sin_informar' AND estado <> 'resuelta'"))[0][0].n, 0);
});

test('Ventas.RF11: un CAEA vencido sin comprobantes se informa sin movimiento', async () => {
  await pool.query("INSERT INTO caea (punto_venta, periodo, orden, caea, vigencia_desde, vigencia_hasta) VALUES (1, '200001', 1, '99999999999999', ?, ?)", [dia(-40), dia(-30)]);
  assert.equal(await Caea.informarSinMovimiento(), 1);
  assert.deepEqual(sinMov, ['99999999999999']);
  assert.equal(await Caea.informarSinMovimiento(), 0);
});

test('Ventas.RF12/RN84: el no fiscal tiene numeración propia por tipo y no se informa a Contable', async () => {
  const instalado = Modulos.estaInstalado;
  Modulos.estaInstalado = async (m) => m === 'contable' || instalado(m);
  try {
    const nf = [];
    for (const [clave, tipo] of [['nf-ticket-01', 'ticket'], ['nf-ticket-02', 'ticket'], ['nf-presup-01', 'presupuesto']]) {
      const r = await cobrar(await cuentaAbierta(), clave, { modalidad: 'no_fiscal', tipo_no_fiscal: tipo });
      assert.equal(r.status, 200);
      assert.equal(r.json.factura, null);
      nf.push([r.json.no_fiscal.tipo, r.json.no_fiscal.numero]);
      const [[v]] = await pool.query('SELECT id_global, condicion_fiscal FROM ventas WHERE id_global = ?', [r.json.venta_id_global]);
      assert.equal(v.condicion_fiscal, 'no_fiscal');
      assert.equal((await pool.query("SELECT COUNT(*) n FROM mensajes_integracion WHERE doc_id_global = ? AND modulo_destino = 'contable'", [v.id_global]))[0][0].n, 0);
    }
    assert.deepEqual(nf, [['ticket', 1], ['ticket', 2], ['presupuesto', 1]]);
    // En cambio una venta fiscal sí genera su evento contable.
    const fiscal = await cobrar(await cuentaAbierta(), 'fiscal-evento-1', {});
    assert.equal((await pool.query("SELECT COUNT(*) n FROM mensajes_integracion WHERE doc_id_global = ? AND modulo_destino = 'contable'", [fiscal.json.venta_id_global]))[0][0].n, 1);
  } finally {
    Modulos.estaInstalado = instalado;
  }
});

test('Ventas.RN84: las ventas no fiscales figuran pendientes y se alertan pasados N días', async () => {
  const pendientes = (await api('GET', '/api/ventas/no-fiscales-pendientes', { token })).json;
  assert.equal(pendientes.length, 3);
  assert.equal((await api('GET', '/api/ventas/no-fiscales-pendientes?dias=30', { token })).json.length, 0);
  await pool.query("UPDATE parametros SET valor = '0' WHERE clave = 'dias_alerta_no_fiscal'");
  require('../src/models/parametroModel').invalidar();
  assert.equal(await Caea.alertarNoFiscales(), 3);
  assert.equal((await pool.query("SELECT COUNT(*) n FROM notificaciones WHERE tipo = 'no_fiscal_sin_regularizar'"))[0][0].n, 1);
});

test('Ventas.RN84/EX38: regularizar factura la venta no fiscal, no la duplica y publica "Venta regularizada"', async () => {
  const instalado = Modulos.estaInstalado;
  Modulos.estaInstalado = async (m) => m === 'contable' || instalado(m);
  try {
    const pendientes = (await api('GET', '/api/ventas/no-fiscales-pendientes', { token })).json;
    const id = pendientes[0].id_global;
    const datos = { tipo_comprobante: 11, doc_tipo: 99, doc_nro: '0', condicion_iva_receptor_id: 5 };
    assert.equal((await api('POST', `/api/ventas/${id}/regularizar`, { token, body: { tipo_comprobante: 11 } })).status, 400);
    const r = await api('POST', `/api/ventas/${id}/regularizar`, { token, headers: { 'X-ID-Solicitud': 'regulariza-01' }, body: datos });
    assert.equal(r.status, 200);
    assert.equal(r.json.factura.estado, 'aprobada');
    assert.equal((await pool.query("SELECT COUNT(*) n FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'venta_regularizada'", [id]))[0][0].n, 1);
    assert.equal((await api('GET', '/api/ventas/no-fiscales-pendientes', { token })).json.length, 2);
    assert.equal((await api('POST', `/api/ventas/${id}/regularizar`, { token, headers: { 'X-ID-Solicitud': 'regulariza-02' }, body: datos })).status, 409);
    // Una venta fiscal no se regulariza.
    const fiscal = await cobrar(await cuentaAbierta(), 'fiscal-reg-0001', {});
    assert.equal((await api('POST', `/api/ventas/${fiscal.json.venta_id_global}/regularizar`, { token, body: datos })).status, 400);
  } finally {
    Modulos.estaInstalado = instalado;
  }
});
