process.env.AFIP_CONDICION_IVA_EMISOR = 'responsable_inscripto';
process.env.AFIP_PUNTO_VENTA = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario, terminal } = require('./ayudas_financiero');
const { simularArca } = require('./ayudas_online');

// Ventas Online: el efectivo de un pedido (pago al retirar, efectivo contra entrega) se cobra en el local que entrega: Financiero lo asienta en la caja y el turno de la terminal de cobro de la tienda.
let api, pool, cerrar, adm, gerente, cajero, P, caja, term, k = 0;
const T = '/tienda/cafe-local';

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  simularArca();
  term = await terminal(pool, 'Barra 1', 'BARRA001');
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  cajero = await usuario(api, pool, 'cami', 'cajero', 'BARRA001');
  await api('POST', '/api/modulos/financiero/instalar', { token: adm.token });
  await api('POST', '/api/modulos/ventas_online/instalar', { token: adm.token });
  caja = (await api('POST', '/api/financiero/cuentas', { token: adm.token, body: { tipo: 'caja_efectivo', nombre: 'Caja Barra', terminal_id: term, fondo_cambio: 1000, saldo_inicial: 1000 } })).json;
  await api('PUT', '/api/financiero/destinos', { token: adm.token, body: { forma: 'efectivo', modo: 'caja_del_turno' } }); // el efectivo va a la caja del turno de la terminal
  assert.equal((await api('POST', '/api/financiero/turnos', { token: cajero.token, body: { cuenta_id: caja.id, fondo_contado: 1000 } })).status, 201);
  await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { codigo: 'cafe-local', nombre: 'Cafe', razon_social: 'Cafe SA', cuit: '30711111111', domicilio: 'Mitre 1', activa: true } });
  P = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Medialuna', precio: 300, stock: 0 } })).json;
  await api('PUT', `/api/ventas-online/catalogo/${P.id}`, { token: gerente.token, body: { categoria_online: 'Menu' } });
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
});
after(async () => { await cerrar(); });

const pedir = async (medio, entrega = { tipo: 'retiro' }) => {
  require('../src/ventas_online/limites').pedidos.reiniciar();
  const c = (await api('POST', `${T}/carrito`, { body: { producto_id: P.id, cantidad: 2 } })).json;
  const r = await api('POST', `${T}/checkout`, { headers: { 'X-ID-Solicitud': `sol-local-${++k}-abcdef` }, body: { carrito: c.token, contacto: { nombre: 'Ana', email: `ana${k}@mail.test` }, facturacion: { tipo: 'consumidor_final' }, entrega, medio_pago: medio, acepta_terminos: true, total_confirmado: c.total } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${r.json.id}/aceptar`, { token: gerente.token })).status, 200);
  await esperarMensajes(pool);
  const [[v]] = await pool.query('SELECT id_global FROM ventas ORDER BY id DESC LIMIT 1');
  return v.id_global;
};
const cobros = async (venta) => (await pool.query("SELECT cuenta_id, turno_id, importe, forma_pago, tipo FROM fin_movimientos WHERE doc_id_global = ? AND tipo = 'cobro'", [venta]))[0];

test('Ventas Online: el pago al retirar se asienta en la caja y el turno del local (la caja de efectivo con terminal, sin configurar nada)', async () => {
  const venta = await pedir('pago_al_retirar');
  const [m] = await cobros(venta);
  assert.ok(m, 'el cobro no llegó a Financiero');
  assert.deepEqual([m.cuenta_id, Number(m.importe), m.forma_pago], [caja.id, 600, 'efectivo']);
  assert.ok(m.turno_id, 'el cobro quedó sin turno');
});

test('Ventas Online: la terminal de cobro se configura en la tienda y el efectivo va a esa caja', async () => {
  assert.equal((await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { terminal_cobro_id: 99999 } })).status, 404);
  const ok = await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { terminal_cobro_id: term } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.terminal_cobro_id, term);
  const venta = await pedir('pago_al_retirar');
  const [m] = await cobros(venta);
  assert.ok(m, 'el cobro no llegó a Financiero');
  assert.equal(m.cuenta_id, caja.id);
  const saldo = (await api('GET', `/api/financiero/cuentas/${caja.id}`, { token: adm.token })).json.saldo;
  assert.equal(saldo, 1000 + 600 + 600);
});
