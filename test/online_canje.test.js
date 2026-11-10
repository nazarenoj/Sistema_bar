process.env.AFIP_CONDICION_IVA_EMISOR = 'responsable_inscripto';
process.env.AFIP_PUNTO_VENTA = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const { simularArca } = require('./ayudas_online');

// Ventas Online RF24/RN07, Ventas RN77: el canje de un vale en la tienda, de punta a punta: el pedido retiene el saldo, al aceptarlo pasa a Ventas con la forma de pago «vale» y Clientes consume el instrumento;
// y si el pedido se cancela antes, el saldo vuelve.
let api, pool, cerrar, adm, gerente, P, k = 0;
const T = '/tienda/cafe-canje';

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  simularArca();
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  await api('POST', '/api/modulos/clientes/instalar', { token: adm.token });
  await api('POST', '/api/modulos/ventas_online/instalar', { token: adm.token });
  assert.equal((await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['CLI-FIDEL'], motivo: 'prueba' } })).status, 200);
  await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { codigo: 'cafe-canje', nombre: 'Cafe', razon_social: 'Cafe SA', cuit: '30711111111', domicilio: 'Mitre 1', activa: true } });
  P = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Medialuna', precio: 300, stock: 0 } })).json;
  await api('PUT', `/api/ventas-online/catalogo/${P.id}`, { token: gerente.token, body: { categoria_online: 'Menu' } });
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
});
after(async () => { await cerrar(); });

const vale = async (codigo, importe) => {
  const [i] = await pool.query("INSERT INTO fid_instrumentos (codigo, tipo, importe_inicial, instancia, ultima_actividad) VALUES (?, 'vale', ?, 'TST01', CURDATE())", [codigo, importe]);
  await pool.query("INSERT INTO fid_instrumento_movs (instrumento_id, movimiento, importe, id_operacion, motivo) VALUES (?, 'emision', ?, ?, 'prueba')", [i.insertId, importe, `emision-${codigo}`]);
};
const saldo = async (codigo) => Number((await pool.query('SELECT COALESCE(SUM(m.importe), 0) AS s FROM fid_instrumento_movs m JOIN fid_instrumentos i ON i.id = m.instrumento_id WHERE i.codigo = ?', [codigo]))[0][0].s);
const pedir = async (cantidad, canje, medio = 'canje') => {
  require('../src/ventas_online/limites').pedidos.reiniciar();
  const c = (await api('POST', `${T}/carrito`, { body: { producto_id: P.id, cantidad } })).json;
  return api('POST', `${T}/checkout`, { headers: { 'X-ID-Solicitud': `sol-canje-${++k}-abcdef` }, body: { carrito: c.token, contacto: { nombre: 'Ana', email: `ana${k}@mail.test` }, facturacion: { tipo: 'consumidor_final' }, entrega: { tipo: 'retiro' },
    medio_pago: medio, acepta_terminos: true, total_confirmado: c.total, canje } });
};

test('Ventas Online.RF24: el vale cubre el pedido, Ventas registra la venta con la forma «vale» y Clientes consume el saldo', async () => {
  await vale('TST01-VALE-E2E1', 1000);
  const r = await pedir(2, { codigo: 'TST01-VALE-E2E1', importe: 600 }); // 600 de total
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.total, r.json.canje, r.json.a_pagar], [600, 600, 0]);
  assert.equal(await saldo('TST01-VALE-E2E1'), 1000); // retenido, todavía no consumido
  const ac = await api('POST', `/api/ventas-online/pedidos/${r.json.id}/aceptar`, { token: gerente.token });
  assert.equal(ac.status, 200, JSON.stringify(ac.json));
  await esperarMensajes(pool);
  const [[v]] = await pool.query('SELECT id_global, total FROM ventas ORDER BY id DESC LIMIT 1');
  assert.equal(Number(v.total), 600);
  const [pagos] = await pool.query('SELECT metodo_pago, importe, instrumento FROM pago_venta pv JOIN ventas ve ON ve.id = pv.venta_id WHERE ve.id_global = ?', [v.id_global]);
  assert.deepEqual(pagos.map((p) => [p.metodo_pago, Number(p.importe), p.instrumento]), [['vale', 600, 'TST01-VALE-E2E1']]);
  assert.equal(await saldo('TST01-VALE-E2E1'), 400); // el canje se concretó: 1000 - 600
  const [[m]] = await pool.query("SELECT estado FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'canje_instrumento'", [v.id_global]);
  assert.equal(m.estado, 'confirmado');
});

test('Ventas Online.RF24: si el pedido se cancela antes de aceptarse, el saldo retenido vuelve al vale', async () => {
  await vale('TST01-VALE-E2E2', 500);
  const r = await pedir(1, { codigo: 'TST01-VALE-E2E2', importe: 300 }); // total 300, cubierto por el vale
  assert.equal(r.status, 201, JSON.stringify(r.json));
  // Retenido: otro pedido no puede usar ese saldo.
  const otro = await pedir(1, { codigo: 'TST01-VALE-E2E2', importe: 300 });
  assert.equal(otro.json.codigo, 'SALDO_INSUFICIENTE'); // quedan 200 libres
  await require('../src/ventas_online/checkoutService').abandonar(r.json.id, { motivo: 'El cliente se arrepintió' });
  const libre = await pedir(1, { codigo: 'TST01-VALE-E2E2', importe: 300 });
  assert.equal(libre.status, 201, JSON.stringify(libre.json)); // el saldo volvió
  assert.equal(await saldo('TST01-VALE-E2E2'), 500); // nunca se consumió
});
