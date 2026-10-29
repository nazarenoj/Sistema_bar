const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');

let api, pool, cerrar, token, tokenBarista, v, n = 0, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rolCodigo) => {
    const [r] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)", [username, await bcrypt.hash('clave-larga-1', 4), rolCodigo === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rolCodigo]);
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
  };
  token = await usuario('adm', 'administrador');
  tokenBarista = await usuario('bea', 'barista');
  await sembrar();
});
after(async () => { await cerrar(); });

// Vende 1 producto de $100 x cantidad; devuelve el ID_Global de la venta.
const vender = async (cantidad, body) => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const p = (await api('POST', '/api/productos', { token, body: { nombre: `P ${n}`, precio: 100, stock: 50 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: p.id, cantidad }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `venta-reg-${++k}-${Math.random().toString(36).slice(2, 7)}` }, body });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { id: r.json.venta_id_global, mesa: mesa.numero_mesa };
};
const devolver = (id, body) => api('POST', '/api/devoluciones', { token, headers: { 'X-ID-Solicitud': `devol-reg-${++k}-${Math.random().toString(36).slice(2, 7)}` }, body: { venta_id_global: id, motivo: 'prueba', ...body } });
const registro = async (q = '') => (await api('GET', `/api/ventas${q}`, { token })).json;

const sembrar = async () => {
  v = {
    efectivo: await vender(2, { metodo_pago: 'efectivo' }),                                                                      // 200
    transf: await vender(3, { metodo_pago: 'transferencia' }),                                                                   // 300
    mixta: await vender(4, { pagos: [{ forma: 'efectivo', importe: 100 }, { forma: 'transferencia', importe: 300 }] }),          // 400
    anulada: await vender(1, { metodo_pago: 'efectivo' }),                                                                       // 100, se anula
    parcial: await vender(5, { metodo_pago: 'efectivo' }),                                                                       // 500, se devuelven 100
    nofiscal: await vender(1, { metodo_pago: 'efectivo', modalidad: 'no_fiscal' }),                                              // 100
  };
  await devolver(v.anulada.id, { todo: true });
  await devolver(v.parcial.id, { items: [{ linea: 0, cantidad: 1 }] });
};

test('Ventas.RF19/RF21: el registro lista las ventas con su estado, comprobante y formas de pago', async () => {
  const r = await registro();
  const por = Object.fromEntries(r.ventas.map((x) => [x.id_global, x]));
  assert.equal(por[v.efectivo.id].estado, 'cerrada');
  assert.equal(por[v.parcial.id].estado, 'devuelta_parcial');
  assert.equal(por[v.mixta.id].formas, 'efectivo,transferencia');
  assert.equal(por[v.nofiscal.id].condicion_fiscal, 'no_fiscal');
  assert.equal(r.limit, 50); // 50 filas por página por defecto (RN26)
});

test('Ventas.RN24: los totales excluyen las anuladas y restan las devoluciones, con desglose por forma de pago', async () => {
  const r = await registro();
  assert.equal(r.totales.cantidad, 5); // la anulada no cuenta
  assert.equal(r.totales.total, 200 + 300 + 400 + 400 + 100); // la parcial suma 500 - 100
  const forma = Object.fromEntries(r.totales.por_forma_pago.map((f) => [f.forma, f.total]));
  assert.deepEqual(forma, { efectivo: 200 + 100 + 400 + 100, transferencia: 300 + 300 });
  const con = await registro('?incluir_anuladas=1');
  assert.equal(con.totales.cantidad, 6);
  assert.equal(con.totales.total, 1400); // la anulada suma 100 - 100 = 0
});

test('Ventas.RF20: los filtros se combinan; sin resultados no es un error', async () => {
  assert.deepEqual((await registro('?estado=anulada')).ventas.map((x) => x.id_global), [v.anulada.id]);
  assert.deepEqual((await registro('?modalidad=no_fiscal')).ventas.map((x) => x.id_global), [v.nofiscal.id]);
  assert.equal((await registro('?forma_pago=transferencia')).ventas.length, 2);
  assert.equal((await registro('?forma_pago=transferencia&importe_min=350')).ventas.length, 1);
  assert.deepEqual((await registro(`?mesa=${v.transf.mesa}`)).ventas.map((x) => x.id_global), [v.transf.id]);
  assert.equal((await registro('?pendiente_facturacion=1')).ventas.length, 1);
  assert.equal((await registro('?modalidad=sin_comprobante')).ventas.length, 4); // sin la anulada ni la no fiscal
  const vacio = await api('GET', '/api/ventas?importe_min=99999', { token });
  assert.equal(vacio.status, 200);
  assert.deepEqual([vacio.json.ventas.length, vacio.json.totales.cantidad], [0, 0]);
  assert.equal((await api('GET', '/api/ventas?desde=ayer', { token })).status, 400);
  assert.equal((await api('GET', '/api/ventas?estado=rara', { token })).status, 400);
});

test('Ventas.RF21: se puede ordenar por cualquier columna', async () => {
  const asc = (await registro('?sort=total&order=asc')).ventas.map((x) => Number(x.total));
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
  const desc = (await registro('?sort=total&order=desc')).ventas.map((x) => Number(x.total));
  assert.deepEqual(desc, [...desc].sort((a, b) => b - a));
});

test('Ventas.RF21/EX17: exporta lo filtrado y, si supera el límite, avisa en vez de truncar', async () => {
  const r = await api('GET', '/api/ventas/exportar?formato=json&estado=cerrada', { token });
  assert.equal(r.status, 200);
  await pool.query("UPDATE parametros SET valor = '2' WHERE clave = 'exportar_max_filas'");
  require('../src/models/parametroModel').invalidar();
  const largo = await api('GET', '/api/ventas/exportar?formato=json', { token });
  assert.equal(largo.status, 400);
  assert.match(largo.json.error, /supera el límite de 2 filas/);
  assert.equal(largo.json.limite, 2);
  const corto = await api('GET', '/api/ventas/exportar?formato=json&modalidad=no_fiscal', { token });
  assert.equal(corto.status, 200);
});

test('Ventas.RN22/RN20: la reimpresión se registra con usuario, formato y motivo, y se ve en el detalle', async () => {
  const id = v.efectivo.id;
  assert.equal((await api('POST', `/api/ventas/${id}/reimpresiones`, { token, body: { formato: 'carta' } })).status, 400);
  assert.equal((await api('POST', `/api/ventas/${id}/reimpresiones`, { token, body: { formato: 'ticket', motivo: 'se perdió el ticket' } })).status, 201);
  assert.equal((await api('POST', `/api/ventas/${id}/reimpresiones`, { token, body: { formato: 'pdf' } })).status, 201);
  const d = (await api('GET', `/api/ventas/${id}`, { token })).json;
  assert.deepEqual(d.reimpresiones.map((r) => [r.username, r.formato, r.motivo]), [['adm', 'ticket', 'se perdió el ticket'], ['adm', 'pdf', null]]);
  assert.equal((await registro()).ventas.find((x) => x.id_global === id).reimpresiones, 2);
  assert.equal(Number(d.total), 200); // la venta no cambió
  await assert.rejects(pool.query('DELETE FROM reimpresiones'), /solo agregar/);
  // Con el parámetro activo, el motivo es obligatorio.
  await pool.query("UPDATE parametros SET valor = '1' WHERE clave = 'reimpresion_motivo_obligatorio'");
  require('../src/models/parametroModel').invalidar();
  assert.equal((await api('POST', `/api/ventas/${id}/reimpresiones`, { token, body: { formato: 'a4' } })).status, 400);
});

test('Ventas.EX15/RN23: sin permiso de reimprimir se bloquea y queda registrado el intento', async () => {
  const r = await api('POST', `/api/ventas/${v.efectivo.id}/reimpresiones`, { token: tokenBarista, body: { formato: 'ticket', motivo: 'x' } });
  assert.equal(r.status, 403);
  assert.ok((await pool.query("SELECT COUNT(*) n FROM auditoria WHERE accion = 'acceso_denegado' AND entidad_id = 'ventas.reimprimir'"))[0][0].n >= 1);
});

test('Ventas.RN26: la primera página con 100.000 ventas sale en menos de 3 segundos', async () => {
  const [[{ id: mesaId }]] = await pool.query('SELECT id FROM mesas LIMIT 1');
  const conn = await pool.getConnection();
  await conn.query('SET SESSION cte_max_recursion_depth = 200000');
  await conn.query(
    `INSERT INTO ventas (id_global, mesa_id, sesion_apertura, total, detalle, created_at)
     WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 100000)
     SELECT CONCAT('TST01-CARGA', LPAD(i, 10, '0')), ?, DATE_ADD('2020-01-01', INTERVAL i MINUTE), (i % 500) + 10, '[]', DATE_ADD('2020-01-01', INTERVAL i MINUTE) FROM s`, [mesaId]);
  conn.release();
  const t0 = Date.now();
  const r = await api('GET', '/api/ventas?limit=50', { token });
  const ms = Date.now() - t0;
  assert.equal(r.status, 200);
  assert.ok(r.json.totales.cantidad >= 100000);
  assert.equal(r.json.ventas.length, 50);
  assert.ok(ms < 3000, `tardó ${ms} ms`);
  const t1 = Date.now();
  assert.equal((await api('GET', '/api/ventas?desde=2020-01-02&hasta=2020-01-03&forma_pago=efectivo', { token })).status, 200);
  assert.ok(Date.now() - t1 < 3000);
});
