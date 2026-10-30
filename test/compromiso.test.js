const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { hashCodigo } = require('../src/utils/credenciales');

let api, pool, cerrar, token, Comp, R, n = 0, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  Comp = require('../src/stock/compromisoService');
  R = require('../src/reservas/servicio');
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const nuevo = async (username, pin) => {
    const [u] = await pool.query("INSERT INTO users (username, password_hash, rol, pin_hash) VALUES (?, ?, 'admin', ?)", [username, await bcrypt.hash('clave-larga-1', 4), hashCodigo(pin)]);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  };
  await nuevo('adm', '1111');
  await nuevo('adm2', '2222');
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
});
after(async () => { await cerrar(); });

const insumo = async (nombre, stock) => (await api('POST', '/api/insumos', { token, body: { nombre, unidad: 'kg', stock } })).json;
// Un artículo que NO admite stock negativo: se compromete (RN63).
const estricto = async (nombre, stock) => {
  const p = (await api('POST', '/api/productos', { token, body: { nombre, precio: 100, stock } })).json;
  await api('PUT', `/api/stock/configuracion/producto/${p.id}`, { token, body: { permite_negativo: false } });
  return p;
};
const lineas = (...xs) => xs.map(([p, cantidad]) => ({ producto_id: p.id, cantidad }));
const solicitud = () => `sol-comp-${++k}-${Math.random().toString(36).slice(2, 8)}`;
const pedirAbierto = async (...xs) => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: xs.map(([p, cantidad]) => ({ producto_id: p.id, cantidad })) } });
  return mesa;
};
const cobrar = (mesa, extra = {}, clave = `cierre-comp-${++k}-abcdef`) => api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': clave }, body: { metodo_pago: 'efectivo', ...extra } });
const exist = async (tipo, id) => (await api('GET', `/api/stock/existencias?tipo=${tipo}`, { token })).json.find((e) => e.item_id === id);
const stockDe = async (tipo, id) => Number((await pool.query(`SELECT stock FROM ${tipo === 'insumo' ? 'insumos' : 'productos'} WHERE id = ?`, [id]))[0][0].stock);

test('Stock.RF36/Ventas.RN63: con dos terminales sobre la última unidad, una compromete y la otra recibe "Sin disponible"', async () => {
  const ultima = await estricto('Última torta', 1);
  const a = await pedirAbierto([ultima, 1]);
  const b = await pedirAbierto([ultima, 1]);
  const [ra, rb] = await Promise.all([cobrar(a), cobrar(b)]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
  const perdedora = ra.status === 409 ? ra : rb;
  assert.equal(perdedora.json.codigo, 'SIN_DISPONIBLE');
  assert.deepEqual(perdedora.json.detalle.map((d) => [d.nombre, d.disponible, d.requerido]), [['Última torta', 0, 1]]);
  await esperarMensajes(pool);
  assert.equal(await stockDe('producto', ultima.id), 0); // se vendió una sola
  // La cuenta que no pudo cerrar sigue abierta y ya no queda nada comprometido.
  const perdioMesa = ra.status === 409 ? a : b;
  assert.equal((await pool.query('SELECT estado FROM mesas WHERE id = ?', [perdioMesa.id]))[0][0].estado, 'ocupado');
  assert.equal((await exist('producto', ultima.id)).comprometido, 0);
});

test('Ventas.EX01: un artículo que admite stock negativo no se compromete: se vende y el saldo queda negativo', async () => {
  const libre = (await api('POST', '/api/productos', { token, body: { nombre: 'Sin control', precio: 10, stock: 1 } })).json; // por defecto admite negativo
  const mesa = await pedirAbierto([libre, 3]);
  assert.equal((await cobrar(mesa)).status, 200);
  await esperarMensajes(pool);
  assert.equal(await stockDe('producto', libre.id), -2);
});

test('Stock.RN58: el compromiso es todo o nada: si un ítem no alcanza, ninguno queda comprometido; informa lo que falta de cada uno', async () => {
  const harina = await insumo('Harina C5', 10);
  const manteca = await insumo('Manteca C5', 1);
  const queso = await insumo('Queso C5', 0);
  const pizza = (await api('POST', '/api/productos', { token, body: { nombre: 'Pizza', tipo: 'elaborado', precio: 100 } })).json;
  await api('PUT', `/api/recetas/${pizza.id}`, { token, body: { lineas: [{ insumo_id: harina.id, cantidad_consumida: 0.5 }, { insumo_id: manteca.id, cantidad_consumida: 0.5 }, { insumo_id: queso.id, cantidad_consumida: 0.2 }] } });
  const r = await Comp.comprometer({ idSolicitud: solicitud(), lineas: lineas([pizza, 4]) }); // 2 kg de harina, 2 de manteca (hay 1), 0,8 de queso (hay 0)
  assert.equal(r.ok, false);
  assert.deepEqual(r.sin_disponible.map((s) => [s.nombre, s.disponible, s.requerido]).sort(), [['Manteca C5', 1, 2], ['Queso C5', 0, 0.8]]);
  assert.equal((await exist('insumo', harina.id)).comprometido, 0); // la harina alcanzaba, pero no quedó tomada
});

test('Stock.RN59: disponible = físico − comprometido; el compromiso vence a los 2 minutos y se libera solo', async () => {
  const t = await estricto('Torta chica', 5);
  const c = await Comp.comprometer({ idSolicitud: solicitud(), lineas: lineas([t, 3]) });
  assert.equal(c.ok, true);
  const e = await exist('producto', t.id);
  assert.deepEqual([e.fisico, e.comprometido, e.disponible], [5, 3, 2]);
  assert.equal((await Comp.comprometer({ idSolicitud: solicitud(), lineas: lineas([t, 3]) })).ok, false); // lo que queda no alcanza
  // Pasados los 2 minutos sin confirmar, queda libre sin que nadie intervenga.
  await pool.query("UPDATE reservas SET vence_ms = 1 WHERE contenido LIKE ?", [`%${c.id_compromiso}%`]);
  assert.equal((await exist('producto', t.id)).disponible, 5);
  assert.equal((await Comp.comprometer({ idSolicitud: solicitud(), lineas: lineas([t, 5]) })).ok, true);
  assert.ok((await R.vencer()) >= 1);
});

test('Stock.RF36: renovar mantiene el mismo ID_Compromiso hasta 3 veces; pedir de nuevo con otra cantidad lo reemplaza', async () => {
  const t = await estricto('Budín C5', 10);
  const c = await Comp.comprometer({ idSolicitud: solicitud(), lineas: lineas([t, 4]) });
  for (let i = 0; i < 3; i++) assert.equal((await Comp.renovar(c.id_compromiso)).id_compromiso, c.id_compromiso);
  await assert.rejects(Comp.renovar(c.id_compromiso), (e) => e.codigo === 'SIN_RENOVACIONES');
  // Cambió la cantidad: el nuevo toma el lugar del anterior (no suma 4 + 7 contra un físico de 10).
  const nuevo = await Comp.comprometer({ idSolicitud: solicitud(), lineas: lineas([t, 7]), reemplazaA: c.id_compromiso });
  assert.equal(nuevo.ok, true);
  assert.notEqual(nuevo.id_compromiso, c.id_compromiso);
  assert.deepEqual([(await exist('producto', t.id)).comprometido, (await exist('producto', t.id)).disponible], [7, 3]);
  // Un compromiso vencido no se renueva.
  await pool.query('UPDATE reservas SET vence_ms = 1 WHERE contenido LIKE ?', [`%${nuevo.id_compromiso}%`]);
  await assert.rejects(Comp.renovar(nuevo.id_compromiso), (e) => e.codigo === 'RESERVA_VENCIDA');
});

test('Stock.RN82: el mismo intento (misma ID_Solicitud) devuelve el mismo compromiso sin tomar de más; liberar lo deja libre', async () => {
  const t = await estricto('Flan C5', 4);
  const s = solicitud();
  const a = await Comp.comprometer({ idSolicitud: s, lineas: lineas([t, 3]) });
  const b = await Comp.comprometer({ idSolicitud: s, lineas: lineas([t, 3]) });
  assert.equal(a.id_compromiso, b.id_compromiso);
  assert.equal((await exist('producto', t.id)).comprometido, 3);
  assert.equal(await Comp.liberar(a.id_compromiso), 1);
  assert.equal((await exist('producto', t.id)).comprometido, 0);
  const api2 = await api('POST', '/api/stock/compromisos', { token, body: { id_solicitud: solicitud(), lineas: [{ producto_id: t.id, cantidad: 4 }] } });
  assert.equal(api2.status, 201);
  assert.equal((await api('POST', '/api/stock/compromisos', { token, body: { id_solicitud: solicitud(), lineas: [{ producto_id: t.id, cantidad: 1 }] } })).status, 409);
  assert.equal((await api('DELETE', `/api/stock/compromisos/${api2.json.id_compromiso}`, { token })).json.liberados, 1);
});

test('Stock.RN59: al confirmarse la venta el descuento consume el compromiso y no descuenta dos veces', async () => {
  const t = await estricto('Tarta C5', 3);
  const mesa = await pedirAbierto([t, 2]);
  assert.equal((await cobrar(mesa)).status, 200);
  await esperarMensajes(pool);
  const e = await exist('producto', t.id);
  assert.deepEqual([e.fisico, e.comprometido, e.disponible], [1, 0, 1]);
  assert.equal(await stockDe('producto', t.id), 1);
  const [[r]] = await pool.query("SELECT COUNT(*) n FROM reservas WHERE tipo = 'compromiso_stock' AND estado = 'consumida' AND contenido LIKE '%\"tipo\":\"producto\"%'");
  assert.ok(r.n >= 1);
});

test('Ventas.RN63: si el cierre no se confirma, lo comprometido se libera', async () => {
  const t = await estricto('Scone C5', 2);
  const mesa = await pedirAbierto([t, 2]);
  const mal = await cobrar(mesa, { metodo_pago: undefined, pagos: [{ forma: 'efectivo', importe: 1 }] }); // la suma no es el total
  assert.equal(mal.status, 400);
  assert.equal((await exist('producto', t.id)).comprometido, 0);
  assert.equal((await cobrar(mesa)).status, 200); // y se puede cerrar bien
});

test('Ventas.RN63/B.5 n.º 3: si Stock no responde, el cierre exige la autorización de un supervisor', async () => {
  const t = await estricto('Muffin C5', 5);
  const mesa = await pedirAbierto([t, 1]);
  const original = Comp.comprometer;
  Comp.comprometer = async () => { throw new Error('Stock caído'); };
  try {
    const sin = await cobrar(mesa);
    assert.equal(sin.status, 409);
    assert.equal(sin.json.codigo, 'STOCK_NO_RESPONDE');
    const propio = await cobrar(mesa, { autorizacion: { credencial: '1111' } }, 'cierre-comp-propio-aut');
    assert.equal(propio.status, 409); // no se autoriza a sí mismo
    const ok = await cobrar(mesa, { autorizacion: { credencial: '2222' } }, 'cierre-comp-ok-aut');
    assert.equal(ok.status, 200);
  } finally {
    Comp.comprometer = original;
  }
  await esperarMensajes(pool);
  assert.equal(await stockDe('producto', t.id), 4); // el descuento se aplicó igual
});

test('Stock.RF01: la configuración del artículo del catálogo se consulta y se valida', async () => {
  const p = (await api('POST', '/api/productos', { token, body: { nombre: 'Config C5', precio: 1 } })).json;
  const base = (await api('GET', `/api/stock/configuracion/producto/${p.id}`, { token })).json;
  assert.deepEqual([base.controla_stock, base.permite_negativo], [1, 1]);
  assert.equal((await api('PUT', `/api/stock/configuracion/producto/${p.id}`, { token, body: { permite_negativo: 'no' } })).status, 400);
  assert.equal((await api('PUT', '/api/stock/configuracion/producto/99999', { token, body: { permite_negativo: false } })).status, 404);
  assert.equal((await api('PUT', `/api/stock/configuracion/producto/${p.id}`, { token, body: { permite_negativo: false } })).json.permite_negativo, 0);
});
