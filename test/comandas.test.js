const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token, tokenBarista, barra, cocina, cafe, tostado, gaseosa, combo, n = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
  };
  token = await usuario('adm', 'administrador');
  tokenBarista = await usuario('bea', 'barista');
  barra = (await api('POST', '/api/sectores', { token, body: { nombre: 'Barra' } })).json;
  cocina = (await api('POST', '/api/sectores', { token, body: { nombre: 'Cocina' } })).json;
  const crear = async (b) => (await api('POST', '/api/productos', { token, body: { precio: 100, stock: 100, ...b } })).json;
  cafe = await crear({ nombre: 'Café', sector_id: barra.id });
  tostado = await crear({ nombre: 'Tostado', sector_id: cocina.id });
  gaseosa = await crear({ nombre: 'Gaseosa' }); // sin sector
  combo = await crear({ nombre: 'Desayuno', tipo: 'combo' });
  await api('PUT', `/api/productos/${combo.id}/componentes`, { token, body: { componentes: [{ componente_id: cafe.id, cantidad: 1 }, { componente_id: tostado.id, cantidad: 2 }] } });
});
after(async () => { await cerrar(); });

const mesaConPedido = async (body = {}) => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id, ...body } })).json;
  return { mesa, pedido };
};
const cargar = (pedido, ...productos) => api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: productos.map(([p, cantidad = 1, observaciones]) => ({ producto_id: p.id, cantidad, observaciones })) } });
const enviar = (mesa, t = token) => api('POST', '/api/comandas/enviar', { token: t, body: { mesa_id: mesa.id } });
const resumen = (r) => Object.fromEntries(r.json.comandas.map((c) => [c.sector ?? 'sin sector', c.items.map((i) => `${Number(i.cantidad)} ${i.nombre}`)]));

test('Ventas.RF07: un envío genera una comanda por sector de destino, con lo que cada uno prepara', async () => {
  const { mesa, pedido } = await mesaConPedido();
  await cargar(pedido, [cafe, 2, 'sin azúcar'], [tostado], [gaseosa]);
  const r = await enviar(mesa);
  assert.equal(r.status, 201);
  assert.deepEqual(resumen(r), { Barra: ['2 Café'], Cocina: ['1 Tostado'], 'sin sector': ['1 Gaseosa'] });
  assert.equal(new Set(r.json.comandas.map((c) => c.envio)).size, 1); // todas del mismo envío
  assert.equal(r.json.comandas.find((c) => c.sector === 'Barra').items[0].observaciones, 'sin azúcar');
  assert.equal(r.json.comandas[0].modalidad, 'salon');
});

test('Ventas.RF07: solo se envía lo nuevo: una comanda por envío', async () => {
  const { mesa, pedido } = await mesaConPedido();
  await cargar(pedido, [cafe]);
  assert.equal((await enviar(mesa)).status, 201);
  const vacio = await enviar(mesa);
  assert.equal(vacio.status, 400);
  assert.equal(vacio.json.codigo, 'COMANDA_INVALIDA');
  await cargar(pedido, [tostado, 3]);
  const segundo = await enviar(mesa);
  assert.deepEqual(resumen(segundo), { Cocina: ['3 Tostado'] }); // el café ya se había enviado
  assert.equal((await api('GET', `/api/comandas?mesa_id=${mesa.id}`, { token })).json.length, 2);
  assert.equal((await enviar({ id: 99999 })).status, 404);
});

test('Ventas.RN69: un combo genera una línea por componente, cada una en su sector', async () => {
  const { mesa, pedido } = await mesaConPedido();
  await cargar(pedido, [combo, 2]);
  assert.deepEqual(resumen(await enviar(mesa)), { Barra: ['2 Café'], Cocina: ['4 Tostado'] });
});

test('Ventas.RF07: una comanda de mostrador lleva la modalidad y los datos del cliente', async () => {
  const { mesa, pedido } = await mesaConPedido({ modalidad: 'delivery', referencia: 'Ana 1155550000 - Calle 1' });
  const mesaId = pedido.mesa_id;
  await cargar(pedido, [cafe]);
  const r = await enviar({ id: mesaId });
  assert.deepEqual([r.json.comandas[0].modalidad, r.json.comandas[0].referencia], ['delivery', 'Ana 1155550000 - Calle 1']);
  assert.ok(mesa); // (la mesa del salón no se usó)
});

test('Ventas.EX08: la comanda sin imprimir queda en la cola de su sector hasta que la terminal la confirma', async () => {
  const { mesa, pedido } = await mesaConPedido();
  await cargar(pedido, [cafe], [tostado]);
  const r = await enviar(mesa);
  const deBarra = r.json.comandas.find((c) => c.sector === 'Barra');
  const cola = async (q) => (await api('GET', `/api/comandas?pendientes=1&mesa_id=${mesa.id}${q}`, { token })).json;
  assert.equal((await cola('')).length, 2);
  assert.equal((await cola(`&sector_id=${barra.id}`)).length, 1);
  assert.equal((await api('POST', `/api/comandas/${deBarra.id}/impresa`, { token })).status, 200);
  assert.deepEqual((await cola('')).map((c) => c.sector), ['Cocina']);
  const pdf = await api('GET', `/api/comandas/${deBarra.id}/pdf`, { token });
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /pdf/);
  assert.equal((await api('GET', '/api/comandas/99999', { token })).status, 404);
});

test('Ventas.RF07/EX08: reimprimir exige motivo y queda auditado; redirigir la manda a la cola de otro sector', async () => {
  const { mesa, pedido } = await mesaConPedido();
  await cargar(pedido, [cafe]);
  const c = (await enviar(mesa)).json.comandas[0];
  await api('POST', `/api/comandas/${c.id}/impresa`, { token });
  assert.equal((await api('POST', `/api/comandas/${c.id}/reimprimir`, { token, body: {} })).status, 400);
  const re = await api('POST', `/api/comandas/${c.id}/reimprimir`, { token, body: { motivo: 'se mojó el papel' } });
  assert.equal(re.json.reimpresiones, 1);
  assert.equal((await pool.query("SELECT COUNT(*) n FROM auditoria WHERE accion = 'comanda_reimpresa' AND entidad_id = ?", [c.id_global]))[0][0].n, 1);

  const red = await api('POST', `/api/comandas/${c.id}/redirigir`, { token, body: { sector_id: cocina.id, motivo: 'la impresora de barra no anda' } });
  assert.equal(red.status, 200);
  assert.deepEqual([red.json.sector, red.json.impresa_at], ['Cocina', null]); // vuelve a la cola, ahora de cocina
  assert.equal((await api('POST', `/api/comandas/${c.id}/redirigir`, { token, body: { sector_id: 99999, motivo: 'x' } })).status, 400);
});

test('Ventas.RF07: anular una comanda exige motivo y permiso, y queda registrado', async () => {
  const { mesa, pedido } = await mesaConPedido();
  await cargar(pedido, [cafe]);
  const c = (await enviar(mesa)).json.comandas[0];
  assert.equal((await api('POST', `/api/comandas/${c.id}/anular`, { token: tokenBarista, body: { motivo: 'x' } })).status, 403);
  assert.equal((await api('POST', `/api/comandas/${c.id}/anular`, { token, body: {} })).status, 400);
  const r = await api('POST', `/api/comandas/${c.id}/anular`, { token, body: { motivo: 'el cliente se fue' } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.estado, r.json.motivo_anulacion], ['anulada', 'el cliente se fue']);
  assert.equal((await api('POST', `/api/comandas/${c.id}/anular`, { token, body: { motivo: 'otra vez' } })).status, 400);
  assert.equal((await api('POST', `/api/comandas/${c.id}/reimprimir`, { token, body: { motivo: 'x' } })).status, 400); // anulada no se reimprime
  assert.equal((await api('GET', '/api/comandas?pendientes=1&mesa_id=' + mesa.id, { token })).json.length, 0); // sale de la cola
});

test('Ventas.RN11: un ítem ya enviado a producción solo se quita con permiso y motivo', async () => {
  const { mesa, pedido } = await mesaConPedido();
  await cargar(pedido, [cafe], [tostado]);
  const [a, b] = (await pool.query('SELECT id FROM pedido_productos WHERE pedido_id = ? ORDER BY id', [pedido.id]))[0];
  await enviar(mesa);
  await cargar(pedido, [gaseosa]); // este todavía no se envió
  const quitar = (id, t = token, body) => api('DELETE', `/api/pedidos/${pedido.id}/productos/${id}`, { token: t, body });

  assert.equal((await quitar(a.id, tokenBarista, { motivo: 'x' })).status, 403); // sin permiso
  const sin = await quitar(a.id);
  assert.equal(sin.status, 400);
  assert.equal(sin.json.codigo, 'MOTIVO_OBLIGATORIO');
  assert.equal((await quitar(a.id, token, { motivo: 'error del mozo' })).status, 200);
  const [g] = (await pool.query("SELECT id FROM pedido_productos WHERE pedido_id = ? AND nombre = 'Gaseosa'", [pedido.id]))[0];
  assert.equal((await quitar(g.id)).status, 200); // sin enviar, no hace falta motivo
  assert.equal((await pool.query('SELECT COUNT(*) n FROM item_anulaciones WHERE pedido_id = ?', [pedido.id]))[0][0].n, 2);
  assert.ok(b);
});
