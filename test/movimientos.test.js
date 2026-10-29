const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');
const { hashCodigo } = require('../src/utils/credenciales');

let api, pool, cerrar, token, principal, n = 0, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const [roles] = await pool.query("SELECT id FROM roles WHERE codigo = 'administrador'");
  const nuevo = async (username, pin) => {
    const [u] = await pool.query("INSERT INTO users (username, password_hash, rol, pin_hash) VALUES (?, ?, 'admin', ?)", [username, await bcrypt.hash('clave-larga-1', 4), hashCodigo(pin)]);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) VALUES (?, ?)', [u.insertId, roles[0].id]);
  };
  await nuevo('adm', '1111');
  await nuevo('adm2', '2222');
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
  principal = (await api('GET', '/api/depositos', { token })).json.find((d) => d.predeterminado);
});
after(async () => { await cerrar(); });

const insumo = async (nombre, unidad = 'kg', stock = 0) => (await api('POST', '/api/insumos', { token, body: { nombre, unidad, stock } })).json;
const deposito = async (nombre) => (await api('POST', '/api/depositos', { token, body: { nombre } })).json;
const stockDe = async (tipo, id) => Number((await pool.query(`SELECT stock FROM ${tipo === 'insumo' ? 'insumos' : 'productos'} WHERE id = ?`, [id]))[0][0].stock);
const sumaMov = async (tipo, id) => Number((await pool.query(`SELECT COALESCE(SUM(cantidad), 0) s FROM stock_movimientos WHERE ${tipo}_id = ?`, [id]))[0][0].s);
const ingreso = (body) => api('POST', '/api/stock/ingresos', { token, body });
const egreso = (body, extra = {}) => api('POST', '/api/stock/egresos', { token, body, ...extra });
const kardex = async (tipo, id, q = '') => (await api('GET', `/api/stock/kardex?item_tipo=${tipo}&item_id=${id}${q}`, { token })).json;
const linea = (i, cantidad, extra = {}) => ({ item: { tipo: 'insumo', id: i.id }, cantidad, ...extra });

test('Stock.RN02: el saldo sale solo de sumar movimientos; el total del ítem siempre coincide con el libro', async () => {
  const harina = await insumo('Harina', 'kg', 10);
  assert.equal((await kardex('insumo', harina.id)).length, 1); // el saldo inicial es un movimiento
  assert.equal((await ingreso({ motivo: 'compra', lineas: [linea(harina, 5)] })).status, 201);
  assert.equal((await egreso({ motivo: 'consumo_interno', lineas: [linea(harina, 3)] })).status, 201);
  assert.equal(await stockDe('insumo', harina.id), 12);
  assert.equal(await sumaMov('insumo', harina.id), 12);
  assert.deepEqual((await kardex('insumo', harina.id)).map((m) => m.saldo), [10, 15, 12]); // saldo corrido
  const incoherentes = (await pool.query('SELECT i.id FROM insumos i WHERE i.stock <> (SELECT COALESCE(SUM(cantidad), 0) FROM stock_movimientos m WHERE m.insumo_id = i.id)'))[0];
  assert.deepEqual(incoherentes, []);
});

test('Stock.RN02: no hay forma de cambiar el stock sin un movimiento, ni de modificar o borrar uno', async () => {
  const sal = await insumo('Sal', 'kg', 4);
  const producto = (await api('POST', '/api/productos', { token, body: { nombre: 'Galletita', precio: 10, stock: 6 } })).json;
  await assert.rejects(pool.query('UPDATE insumos SET stock = 999 WHERE id = ?', [sal.id]), /solo cambia con un movimiento/);
  await assert.rejects(pool.query('UPDATE productos SET stock = 999 WHERE id = ?', [producto.id]), /solo cambia con un movimiento/);
  await pool.query("UPDATE insumos SET nombre = 'Sal fina' WHERE id = ?", [sal.id]); // lo demás sí se edita
  await assert.rejects(pool.query('UPDATE stock_movimientos SET cantidad = 1'), /solo agregar/);
  await assert.rejects(pool.query('DELETE FROM stock_movimientos'), /solo agregar/);
  assert.deepEqual([await stockDe('insumo', sal.id), await stockDe('producto', producto.id)], [4, 6]);
  assert.equal(await sumaMov('producto', producto.id), 6); // los productos del catálogo también salen del libro
});

test('Stock.RF03: la venta descuenta del depósito del sector y la devolución lo reingresa, ambos como movimientos', async () => {
  const vitrina = await deposito('Vitrina');
  const barra = (await api('POST', '/api/sectores', { token, body: { nombre: 'Barra' } })).json;
  await api('PUT', `/api/depositos/sectores/${barra.id}`, { token, body: { deposito_id: vitrina.id } });
  const cafe = await insumo('Café en grano', 'kg', 10);
  const espresso = (await api('POST', '/api/productos', { token, body: { nombre: 'Espresso', precio: 100, stock: 20, sector_id: barra.id } })).json;
  await api('POST', `/api/productos/${espresso.id}/insumos`, { token, body: { insumo_id: cafe.id, cantidad_consumida: 0.02 } });
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: espresso.id, cantidad: 5 }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-mov-${++k}-abcd` }, body: { metodo_pago: 'efectivo' } });
  assert.equal(r.status, 200);

  const ventaCafe = (await kardex('insumo', cafe.id)).find((m) => m.tipo === 'venta');
  assert.deepEqual([ventaCafe.deposito, ventaCafe.cantidad, ventaCafe.documento_tipo], ['Vitrina', -0.1, 'venta']);
  assert.equal(await stockDe('producto', espresso.id), 15);
  assert.equal(await stockDe('insumo', cafe.id), 9.9);

  const d = await api('POST', '/api/devoluciones', { token, headers: { 'X-ID-Solicitud': `devol-mov-${++k}-abcd` }, body: { venta_id_global: r.json.venta_id_global, motivo: 'prueba', todo: true } });
  assert.equal(d.status, 201);
  const dev = (await kardex('producto', espresso.id)).find((m) => m.tipo === 'devolucion');
  assert.deepEqual([dev.deposito, dev.cantidad, dev.documento], ['Vitrina', 5, d.json.devolucion.id_global]);
  assert.deepEqual([await stockDe('producto', espresso.id), await stockDe('insumo', cafe.id)], [20, 10]);
  // La venta ya no pisa el saldo con un piso en cero: un faltante se ve.
  await pool.query('SET @x = 0');
  assert.equal((await egreso({ motivo: 'rotura', observacion: 'se cayó', lineas: [linea(cafe, 15)] })).status, 201);
  assert.equal(await stockDe('insumo', cafe.id), -5);
});

test('Stock.RF04: el ingreso manual guarda motivo, comprobante, costo y presentación (con su factor)', async () => {
  const leche = await insumo('Leche', 'l');
  const caja = (await api('POST', '/api/presentaciones', { token, body: { insumo_id: leche.id, nombre: 'caja x12', factor: 12, usos: ['compra'] } })).json;
  const sachet = (await api('POST', '/api/presentaciones', { token, body: { insumo_id: leche.id, nombre: 'ml', factor: 0.001, usos: ['receta'] } })).json;
  const comprobante = { cuit: '30711111118', clase: 'A', tipo: 'FACTURA', punto_venta: 3, numero: '00001234', cae: '70123456789012' };
  const r = await ingreso({ motivo: 'compra', proveedor: 'Lácteos SA', comprobante, lineas: [linea(leche, 2, { presentacion_id: caja.id, costo_unitario: 900 })] });
  assert.equal(r.status, 201);
  assert.equal(await stockDe('insumo', leche.id), 24); // 2 cajas x 12
  const mov = (await kardex('insumo', leche.id))[0];
  assert.deepEqual([mov.motivo, mov.costo_unitario, mov.documento_tipo], ['compra', '900.0000', 'ingreso']);
  const [[guardado]] = await pool.query('SELECT cantidad_presentacion, factor_aplicado, presentacion_id FROM stock_movimientos WHERE insumo_id = ?', [leche.id]);
  assert.deepEqual([Number(guardado.cantidad_presentacion), Number(guardado.factor_aplicado), guardado.presentacion_id], [2, 12, caja.id]);

  // La presentación ya tiene movimientos: ahora se versiona en vez de editarse (RN61).
  const nueva = await api('PUT', `/api/presentaciones/${caja.id}`, { token, body: { factor: 10 } });
  assert.deepEqual([nueva.json.nueva_version, nueva.json.version], [true, 2]);

  // El comprobante de origen se registra una sola vez (RN09).
  const dup = await ingreso({ motivo: 'compra', comprobante, lineas: [linea(leche, 1)] });
  assert.equal(dup.status, 409);
  assert.equal(await stockDe('insumo', leche.id), 24);
  assert.equal((await ingreso({ motivo: 'compra', comprobante: { ...comprobante, numero: '00001235' }, lineas: [linea(leche, 1)] })).status, 201);

  // Validaciones: todo o nada.
  for (const [descripcion, body] of [
    ['presentación que no es de compra', { motivo: 'compra', lineas: [linea(leche, 1, { presentacion_id: sachet.id })] }],
    ['cantidad cero', { motivo: 'compra', lineas: [linea(leche, 0)] }],
    ['costo negativo', { motivo: 'compra', lineas: [linea(leche, 1, { costo_unitario: -1 })] }],
    ['motivo de egreso', { motivo: 'rotura', lineas: [linea(leche, 1)] }],
    ['motivo inexistente', { motivo: 'nada', lineas: [linea(leche, 1)] }],
    ['motivo que exige observación', { motivo: 'otros_ingresos', lineas: [linea(leche, 1)] }],
    ['depósito inexistente', { motivo: 'compra', deposito_id: 99999, lineas: [linea(leche, 1)] }],
    ['sin líneas', { motivo: 'compra', lineas: [] }],
    ['ítem inexistente', { motivo: 'compra', lineas: [{ item: { tipo: 'insumo', id: 99999 }, cantidad: 1 }] }],
  ]) assert.equal((await ingreso(body)).status, descripcion === 'ítem inexistente' ? 404 : 400, descripcion);
  const antes = await stockDe('insumo', leche.id);
  assert.equal((await ingreso({ motivo: 'compra', lineas: [linea(leche, 5), linea(leche, 0)] })).status, 400); // la segunda línea invalida todo
  assert.equal(await stockDe('insumo', leche.id), antes);
});

test('Stock.RF12: el egreso exige motivo; algunos piden observación o la autorización de otro supervisor', async () => {
  const vasos = await insumo('Vasos', 'u', 100);
  assert.equal((await egreso({ lineas: [linea(vasos, 1)] })).status, 400); // sin motivo
  assert.equal((await egreso({ motivo: 'nada', lineas: [linea(vasos, 1)] })).status, 400);
  assert.equal((await egreso({ motivo: 'rotura', lineas: [linea(vasos, 1)] })).status, 400); // exige observación
  assert.equal((await egreso({ motivo: 'devolucion_proveedor', lineas: [linea(vasos, 1)] })).status, 400); // reservado del sistema
  assert.equal((await egreso({ motivo: 'degustacion', lineas: [linea(vasos, 2)] })).status, 201);

  const sin = await egreso({ motivo: 'robo', observacion: 'faltante', lineas: [linea(vasos, 3)] });
  assert.equal(sin.status, 403);
  assert.equal(sin.json.codigo, 'REQUIERE_AUTORIZACION');
  const propio = await egreso({ motivo: 'robo', observacion: 'faltante', lineas: [linea(vasos, 3)], autorizacion: { credencial: '1111' } });
  assert.equal(propio.status, 403); // nadie se autoriza a sí mismo
  const ok = await egreso({ motivo: 'robo', observacion: 'faltante', lineas: [linea(vasos, 3)], autorizacion: { credencial: '2222' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.clase_contable, 'otra');
  assert.equal(await stockDe('insumo', vasos.id), 95);
  assert.ok((await pool.query("SELECT COUNT(*) n FROM auditoria WHERE accion = 'egreso' AND detalle LIKE '%autorizó adm2%'"))[0][0].n >= 1);
});

test('Stock.RF13: una transferencia es un solo documento: egreso del origen e ingreso en el destino, todo o nada', async () => {
  const cocina = await deposito('Cocina');
  const manteca = await insumo('Manteca', 'kg', 8);
  const r = await api('POST', '/api/stock/transferencias', { token, body: { origen_id: principal.id, destino_id: cocina.id, lineas: [linea(manteca, 3)] } });
  assert.equal(r.status, 201);
  const k = await kardex('insumo', manteca.id);
  const t = k.filter((m) => m.tipo === 'transferencia');
  assert.deepEqual(t.map((m) => [m.deposito, m.cantidad]), [['Depósito principal', -3], ['Cocina', 3]]);
  assert.equal(new Set(t.map((m) => m.documento)).size, 1);
  assert.equal(await stockDe('insumo', manteca.id), 8); // el total no cambia
  const porDeposito = (await api('GET', '/api/stock/existencias?tipo=insumo', { token })).json.filter((e) => e.item_id === manteca.id);
  assert.deepEqual(Object.fromEntries(porDeposito.map((e) => [e.deposito, e.fisico])), { 'Depósito principal': 5, Cocina: 3 });
  assert.equal((await api('POST', '/api/stock/transferencias', { token, body: { origen_id: cocina.id, destino_id: cocina.id, lineas: [linea(manteca, 1)] } })).status, 400);
  assert.equal((await api('POST', '/api/stock/transferencias', { token, body: { origen_id: principal.id, destino_id: 99999, lineas: [linea(manteca, 1)] } })).status, 400);
  const antes = (await kardex('insumo', manteca.id)).length;
  assert.equal((await api('POST', '/api/stock/transferencias', { token, body: { origen_id: principal.id, destino_id: cocina.id, lineas: [linea(manteca, 1), linea(manteca, -1)] } })).status, 400);
  assert.equal((await kardex('insumo', manteca.id)).length, antes); // nada quedó a medias
});

test('Stock.RN02: un error se corrige con un movimiento inverso que referencia al original', async () => {
  const azucar = await insumo('Azúcar', 'kg', 5);
  const e = await egreso({ motivo: 'consumo_interno', lineas: [linea(azucar, 2)] });
  const original = e.json.movimientos[0];
  assert.equal((await api('POST', `/api/stock/movimientos/${original.id}/corregir`, { token, body: {} })).status, 400); // sin motivo
  const c = await api('POST', `/api/stock/movimientos/${original.id}/corregir`, { token, body: { observacion: 'se cargó de más' } });
  assert.equal(c.status, 201);
  assert.equal(await stockDe('insumo', azucar.id), 5);
  const k = await kardex('insumo', azucar.id);
  const inversa = k.find((m) => m.tipo === 'correccion');
  assert.deepEqual([inversa.cantidad, inversa.movimiento_original_id], [2, original.id]);
  assert.equal(k.find((m) => m.id === original.id).cantidad, -2); // el original queda como estaba
  assert.equal((await api('POST', `/api/stock/movimientos/${original.id}/corregir`, { token, body: { observacion: 'otra vez' } })).status, 409);
  assert.equal((await api('POST', `/api/stock/movimientos/${c.json.id}/corregir`, { token, body: { observacion: 'x' } })).status, 400); // una corrección no se corrige
  assert.equal((await api('POST', '/api/stock/movimientos/99999/corregir', { token, body: { observacion: 'x' } })).status, 404);
});

test('Stock.RF18: el kardex filtra por fecha y depósito, se exporta, y las mermas se agrupan por motivo', async () => {
  const pan = await insumo('Pan', 'u', 50);
  const mermasHoy = async () => Object.fromEntries((await api('GET', '/api/stock/mermas', { token })).json.map((m) => [m.motivo, m.cantidad]));
  const antes = await mermasHoy();
  await egreso({ motivo: 'merma_fin_dia', lineas: [linea(pan, 4)] });
  await egreso({ motivo: 'merma_fin_dia', lineas: [linea(pan, 6)] });
  await egreso({ motivo: 'rotura', observacion: 'se cayó', lineas: [linea(pan, 1)] });
  await egreso({ motivo: 'consumo_interno', lineas: [linea(pan, 9)] }); // no es merma
  const hoy = new Date().toISOString().slice(0, 10);
  assert.equal((await kardex('insumo', pan.id, `&desde=${hoy}&hasta=${hoy}`)).length, 5);
  assert.equal((await kardex('insumo', pan.id, '&desde=2000-01-01&hasta=2000-01-02')).length, 0);
  assert.equal((await kardex('insumo', pan.id, `&deposito_id=${principal.id}`)).length, 5);
  const csv = await api('GET', `/api/stock/kardex?item_tipo=insumo&item_id=${pan.id}&formato=csv`, { token });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /csv/);
  const despues = await mermasHoy();
  assert.equal(despues.merma_fin_dia - (antes.merma_fin_dia ?? 0), 10);
  assert.equal(despues.rotura - (antes.rotura ?? 0), 1);
  assert.ok(!('consumo_interno' in despues)); // no es merma
  assert.ok(Object.keys((await api('GET', `/api/stock/mermas?desde=${hoy}`, { token })).json).length > 0);
  assert.equal((await api('GET', '/api/stock/kardex?item_tipo=raro&item_id=1', { token })).status, 400);
});

test('Stock.RF12: los motivos son configurables; los reservados del sistema no se desactivan ni cambian de clase', async () => {
  const lista = (await api('GET', '/api/stock/motivos', { token })).json;
  assert.ok(lista.some((m) => m.codigo === 'devolucion_proveedor' && m.reservado === 1 && m.clase_contable === 'sin_asiento'));
  const nuevo = await api('POST', '/api/stock/motivos', { token, body: { codigo: 'muestra_cliente', nombre: 'Muestra a cliente', tipo: 'egreso', requiere_observacion: true, clase_contable: 'otra' } });
  assert.equal(nuevo.status, 201);
  assert.equal((await api('POST', '/api/stock/motivos', { token, body: { codigo: 'muestra_cliente', nombre: 'otra', tipo: 'egreso' } })).status, 409);
  assert.equal((await api('POST', '/api/stock/motivos', { token, body: { codigo: 'X!', nombre: 'mal', tipo: 'egreso' } })).status, 400);
  assert.equal((await api('POST', '/api/stock/motivos', { token, body: { codigo: 'otro_motivo', nombre: 'mal', tipo: 'rara' } })).status, 400);
  const reservado = lista.find((m) => m.codigo === 'devolucion_merma');
  assert.equal((await api('PUT', `/api/stock/motivos/${reservado.id}`, { token, body: { activo: false } })).status, 409);
  assert.equal((await api('PUT', `/api/stock/motivos/${reservado.id}`, { token, body: { clase_contable: 'otra' } })).status, 409);
  assert.equal((await api('PUT', `/api/stock/motivos/${nuevo.json.id}`, { token, body: { activo: false } })).status, 200); // uno propio sí
  const x = await insumo('Muestra', 'u', 5);
  assert.equal((await egreso({ motivo: 'muestra_cliente', observacion: 'x', lineas: [linea(x, 1)] })).status, 400); // desactivado
});
