const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');

let api, pool, cerrar, token, tokenBarista, n = 0, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
  };
  token = await usuario('adm', 'administrador');
  tokenBarista = await usuario('bea', 'barista');
});
after(async () => { await cerrar(); });

const cotizar = (body, t = token) => api('POST', '/api/monedas/cotizaciones', { token: t, body });
const vigente = async (m, fecha = '') => api('GET', `/api/monedas/cotizaciones/vigente?moneda=${m}${fecha}`, { token });
const formas = async () => (await api('GET', '/api/formas-pago', { token })).json;
// Una cuenta de $1500; se cobra con los pagos indicados.
const cobrar = async (pagos) => {
  const p = (await api('POST', '/api/productos', { token, body: { nombre: `Prod ${++n}`, precio: 1500 } })).json;
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: p.id, cantidad: 1 }] } });
  return api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-div-${++k}-abcdef` }, body: { pagos } });
};
const horas = (h) => { const d = new Date(Date.now() - h * 3600000); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

test('Usuarios.RF14: monedas local y extranjeras', async () => {
  const lista = (await api('GET', '/api/monedas', { token })).json;
  assert.deepEqual(lista.filter((m) => m.es_local).map((m) => m.codigo), ['ARS']);
  assert.ok(lista.some((m) => m.codigo === 'USD'));
  assert.equal((await api('POST', '/api/monedas', { token, body: { codigo: 'us', nombre: 'x', simbolo: '$' } })).status, 400);
  assert.equal((await api('POST', '/api/monedas', { token, body: { codigo: 'USD', nombre: 'Dólar', simbolo: '$' } })).status, 409);
  assert.equal((await api('POST', '/api/monedas', { token, body: { codigo: 'BRL', nombre: 'Real', simbolo: 'R$' } })).status, 201);
  assert.equal((await api('PUT', '/api/monedas/ARS/activa', { token, body: { activa: false } })).status, 409);
  assert.equal((await api('POST', '/api/monedas', { token: tokenBarista, body: { codigo: 'CLP', nombre: 'Peso chileno', simbolo: '$' } })).status, 403);
});

test('Usuarios.RN17: la cotización se carga con permiso, es de solo agregar y la vigente es la última hasta la fecha', async () => {
  assert.equal((await vigente('USD')).status, 404);
  assert.equal((await cotizar({ moneda: 'USD', comprador: 1000, vendedor: 1050 }, tokenBarista)).status, 403);
  assert.equal((await cotizar({ moneda: 'USD', comprador: 0, vendedor: 1050 })).status, 400);
  assert.equal((await cotizar({ moneda: 'USD', comprador: 1100, vendedor: 1050 })).status, 400); // el vendedor no es menor
  assert.equal((await cotizar({ moneda: 'ARS', comprador: 1, vendedor: 1 })).status, 409);
  assert.equal((await cotizar({ moneda: 'XXX', comprador: 1, vendedor: 2 })).status, 404);
  const vieja = await cotizar({ moneda: 'USD', comprador: 900, vendedor: 950, fecha_hora: horas(30) });
  assert.equal(vieja.status, 201, JSON.stringify(vieja.json));
  assert.equal(vieja.json.vencida, true); // más vieja que las 24 h permitidas
  const nueva = await cotizar({ moneda: 'USD', comprador: 1000, vendedor: 1050 });
  assert.deepEqual([nueva.json.vencida, (await vigente('USD')).json.id], [false, nueva.json.id]);
  assert.equal((await vigente('USD', `&fecha=${encodeURIComponent(horas(10))}`)).json.id, vieja.json.id); // la vigente a una fecha pasada
  assert.equal((await vigente('ARS')).json.comprador, 1); // la local vale 1
  assert.equal((await api('GET', '/api/monedas/cotizaciones?moneda=USD', { token })).json.length, 2);
  await assert.rejects(pool.query('UPDATE cotizaciones SET comprador = 1 WHERE id = ?', [nueva.json.id]), /solo agregar/);
});

test('Ventas.RF28/RN44: la forma en divisa necesita VEN-DIVISA; el cobro fija la cotización y total, comprobante y vuelto quedan en pesos', async () => {
  const forma = { codigo: 'efectivo_usd', nombre: 'Efectivo USD', moneda: 'USD', admite_vuelto: true };
  assert.equal((await api('POST', '/api/formas-pago', { token, body: forma })).status, 409); // sin la función
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['VEN-DIVISA'], motivo: 'prueba' } })).status, 200);
  assert.equal((await api('POST', '/api/formas-pago', { token, body: { ...forma, moneda: 'ARS2' } })).status, 409);
  const creada = await api('POST', '/api/formas-pago', { token, body: forma });
  assert.equal(creada.status, 201, JSON.stringify(creada.json));
  const usd = (await formas()).find((f) => f.codigo === 'efectivo_usd');
  assert.deepEqual([usd.disponible, usd.cotizacion], [true, 1000]);
  // 1 USD (= $1000 a la compradora) + $500 en pesos cubren la cuenta de $1500.
  const cot = (await vigente('USD')).json;
  const r = await cobrar([{ forma: 'efectivo_usd', importe_divisa: 1, cotizacion_id: cot.id }, { forma: 'efectivo', importe: 500 }]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await esperarMensajes(pool);
  const v = (await api('GET', `/api/ventas/${r.json.venta_id_global}`, { token })).json;
  assert.equal(Number(v.total), 1500);
  const pd = v.pagos.find((p) => p.moneda === 'USD');
  assert.deepEqual([Number(pd.importe), Number(pd.importe_divisa), Number(pd.cotizacion), pd.cotizacion_id], [1000, 1, 1000, cot.id]);
  // Una cotización nueva no cambia lo ya cobrado (queda fijada) y la que se fija al iniciar el cobro manda.
  await cotizar({ moneda: 'USD', comprador: 1200, vendedor: 1250 });
  const fijada = await cobrar([{ forma: 'efectivo_usd', importe_divisa: 1.5, cotizacion_id: cot.id }]);
  assert.equal(fijada.status, 200, JSON.stringify(fijada.json)); // 1,5 × 1000 = 1500
  assert.equal(Number((await api('GET', `/api/ventas/${fijada.json.venta_id_global}`, { token })).json.pagos[0].cotizacion), 1000);
  // Con pesos en importe se convierte con la cotización vigente; el vuelto sale en pesos.
  const vuelto = await cobrar([{ forma: 'efectivo_usd', importe: 1500, recibido_divisa: 2 }]); // vigente ahora: 1200 → 1,25 USD; recibe 2 → vuelto 0,75 × 1200
  assert.equal(vuelto.status, 200, JSON.stringify(vuelto.json));
  const pv = (await api('GET', `/api/ventas/${vuelto.json.venta_id_global}`, { token })).json.pagos[0];
  assert.deepEqual([Number(pv.importe_divisa), Number(pv.vuelto)], [1.25, 900]);
  assert.equal((await cobrar([{ forma: 'efectivo_usd', importe_divisa: 1, cotizacion_id: cot.id }])).status, 400); // no cubre el total: el resto va con otra forma
  assert.equal((await cobrar([{ forma: 'efectivo_usd', importe_divisa: 1, cotizacion_id: 99999 }])).status, 400);
  // La moneda de una forma con cobros no cambia.
  const eur = await api('PUT', `/api/formas-pago/${creada.json.id}`, { token, body: { nombre: 'Efectivo USD', moneda: 'EUR' } });
  assert.equal(eur.status, 409);
});

test('Ventas.EX32/RF28: sin cotización vigente las formas en divisa se deshabilitan y se cobra en pesos; el reporte discrimina por moneda', async () => {
  assert.equal((await api('POST', '/api/formas-pago', { token, body: { codigo: 'efectivo_eur', nombre: 'Efectivo EUR', moneda: 'EUR' } })).status, 201);
  let eur = (await formas()).find((f) => f.codigo === 'efectivo_eur');
  assert.equal(eur.disponible, false); // todavía no hay cotización de EUR
  assert.match(eur.motivo_no_disponible, /cotización/);
  assert.equal((await cotizar({ moneda: 'EUR', comprador: 1500, vendedor: 1560, fecha_hora: horas(30) })).status, 201);
  eur = (await formas()).find((f) => f.codigo === 'efectivo_eur');
  assert.equal(eur.disponible, false); // la última tiene 30 h: pasó la antigüedad
  const sin = await cobrar([{ forma: 'efectivo_eur', importe_divisa: 1 }]);
  assert.equal(sin.status, 400);
  assert.equal(sin.json.codigo, 'SIN_COTIZACION');
  assert.equal((await cobrar([{ forma: 'efectivo', importe: 1500 }])).status, 200); // en pesos sigue andando
  assert.equal((await cotizar({ moneda: 'EUR', comprador: 1500, vendedor: 1560, fecha_hora: horas(20) })).status, 201);
  assert.equal((await formas()).find((f) => f.codigo === 'efectivo_eur').disponible, true); // última dentro de las 24 h: se usa
  assert.equal((await cobrar([{ forma: 'efectivo_eur', importe_divisa: 1 }])).status, 200);
  const rep = (await api('GET', '/api/ventas/por-moneda', { token })).json;
  const usd = rep.find((x) => x.moneda === 'USD');
  assert.deepEqual([usd.cobros, usd.total_divisa, usd.total_pesos], [3, 3.75, 4000]);
  assert.deepEqual(rep.map((x) => x.moneda).sort(), ['EUR', 'USD']);
  // Apagada la función, la forma en divisa deja de ofrecerse.
  await pool.query("UPDATE estado_funcionalidades SET activa = 0 WHERE funcion_id = 'VEN-DIVISA'");
  const f = (await formas()).find((x) => x.codigo === 'efectivo_usd');
  assert.equal(f.disponible, false);
  assert.equal((await cobrar([{ forma: 'efectivo_usd', importe_divisa: 1.5 }])).status, 400);
});
