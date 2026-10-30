const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { hashCodigo } = require('../src/utils/credenciales');

let api, pool, cerrar, token, principal, Mov, M, n = 0, k = 0;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  Mov = require('../src/stock/movimientoService');
  M = require('../src/mensajeria/servicio');
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

const insumo = async (nombre, stock = 0) => (await api('POST', '/api/insumos', { token, body: { nombre, unidad: 'kg', stock } })).json;
const saldo = async (i) => Number((await pool.query('SELECT stock FROM insumos WHERE id = ?', [i.id]))[0][0].stock);
const egreso = (i, cantidad) => api('POST', '/api/stock/egresos', { token, body: { motivo: 'consumo_interno', lineas: [{ item: { tipo: 'insumo', id: i.id }, cantidad }] } });
const ingreso = (i, cantidad) => api('POST', '/api/stock/ingresos', { token, body: { motivo: 'compra', lineas: [{ item: { tipo: 'insumo', id: i.id }, cantidad }] } });
const crearToma = (alcance = {}, congelar_manual = false) => api('POST', '/api/inventario/tomas', { token, body: { alcance, congelar_manual } });
const contar = (t, i, cantidad, dep = principal.id) => api('POST', `/api/inventario/tomas/${t.json.id}/lineas`, { token, body: { item: { tipo: 'insumo', id: i.id }, deposito_id: dep, cantidad } });
const aprobar = (t, body = {}) => api('POST', `/api/inventario/tomas/${t.json.id}/aprobar`, { token, body });
const toma = async (t) => (await api('GET', `/api/inventario/tomas/${t.json.id}`, { token })).json;
const notis = async (tipo, estado = null) => (await pool.query(`SELECT * FROM notificaciones WHERE tipo = ? ${estado ? "AND estado = 'nueva'" : ''}`, [tipo]))[0];

test('Stock.RN20: el ajuste de la toma es un delta sobre el saldo vigente: no fija el saldo en lo contado', async () => {
  const harina = await insumo('Harina T1', 10);
  const t = await crearToma({ items: [{ tipo: 'insumo', id: harina.id }] });
  const l = await contar(t, harina, 8); // teórico 10, contado 8
  assert.deepEqual([l.json.lineas[0].stock_teorico, l.json.lineas[0].diferencia], [10, -2]);
  assert.equal(await saldo(harina), 10); // contar no ajusta nada
  await egreso(harina, 1); // una salida posterior al conteo
  const sin = await aprobar(t);
  assert.equal(sin.status, 409); // movimiento posterior: exige recontar o confirmar (EX50)
  assert.deepEqual(sin.json.detalle.lineas[0].motivos, ['con_movimientos_posteriores']);
  assert.equal(sin.json.detalle.lineas[0].posteriores, -1);
  const lineaId = sin.json.detalle.lineas[0].linea_id;
  const ok = await aprobar(t, { confirmaciones: { [lineaId]: 'se retiró un kilo mientras se contaba' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ajustes[0].delta, -2);
  assert.equal(await saldo(harina), 7); // 9 vigentes menos 2; si hubiera fijado lo contado serían 8
  const mov = (await api('GET', `/api/stock/kardex?item_tipo=insumo&item_id=${harina.id}`, { token })).json.pop();
  assert.deepEqual([mov.tipo, mov.motivo, mov.cantidad, mov.documento_tipo], ['ajuste', 'toma_inventario', -2, 'toma']);
});

test('Stock.RN68: la toma se aprueba una sola vez: repetir devuelve el resultado original sin duplicar ajustes', async () => {
  const sal = await insumo('Sal T2', 5);
  const t = await crearToma({ items: [{ tipo: 'insumo', id: sal.id }] });
  await contar(t, sal, 3);
  const a = await aprobar(t);
  assert.equal(a.status, 200);
  assert.equal(await saldo(sal), 3);
  const b = await aprobar(t);
  assert.deepEqual([b.status, b.json.repetida], [200, true]);
  assert.deepEqual(b.json.ajustes, a.json.ajustes);
  const dobles = await Promise.all([aprobar(t), aprobar(t)]);
  assert.ok(dobles.every((r) => r.status === 200 && r.json.repetida));
  assert.equal(await saldo(sal), 3);
  assert.equal((await contar(t, sal, 1)).status, 409); // una toma aprobada ya no se toca
  assert.equal((await api('POST', `/api/inventario/tomas/${t.json.id}/cancelar`, { token })).status, 409);
});

test('Stock.RN67/EX50: un conteo de más de 24 horas exige recontar o confirmar; recontar deja la línea limpia', async () => {
  const azucar = await insumo('Azúcar T3', 10);
  const t = await crearToma({ items: [{ tipo: 'insumo', id: azucar.id }] });
  await contar(t, azucar, 9);
  await pool.query('UPDATE toma_lineas SET contado_at = DATE_SUB(NOW(), INTERVAL 25 HOUR)');
  const viejo = await aprobar(t);
  assert.equal(viejo.status, 409);
  assert.deepEqual(viejo.json.detalle.lineas[0].motivos, ['conteo_antiguo']);
  await contar(t, azucar, 9); // recontar: nueva marca y nuevo teórico
  assert.equal((await aprobar(t)).status, 200);
  assert.equal(await saldo(azucar), 9);
});

test('Stock.EX51/RN67: los mensajes de integración sin aplicar bloquean la aprobación, salvo que se acepten con motivo', async () => {
  const cacao = await insumo('Cacao T4', 10);
  const t = await crearToma({ items: [{ tipo: 'insumo', id: cacao.id }] });
  await contar(t, cacao, 10);
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  await M.publicar(conn, { origen: 'ventas', destino: 'stock', tipo: 'descuento_stock', docTipo: 'venta', docIdGlobal: 'TST01-PENDIENTE0000000000000001', contenido: { items: [] } });
  await conn.commit();
  conn.release();
  await pool.query("UPDATE mensajes_integracion SET proximo_intento_ms = ? WHERE doc_id_global = 'TST01-PENDIENTE0000000000000001'", [Date.now() + 3600000]);
  const bloqueada = await aprobar(t);
  assert.equal(bloqueada.status, 409);
  assert.equal(bloqueada.json.detalle.pendientes[0].tipo, 'descuento_stock');
  const ok = await aprobar(t, { aceptar_pendientes: 'el descuento pendiente es de una venta ajena a este conteo' });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.pendientes_aceptados);
  await pool.query("UPDATE mensajes_integracion SET estado = 'confirmado' WHERE doc_id_global = 'TST01-PENDIENTE0000000000000001'");
});

test('Stock.RN68/EX52: un ajuste que deja el físico negativo se bloquea en ítems estrictos y pide confirmación en los que lo admiten', async () => {
  const estricto = await insumo('Estricto T5', 5);
  const t = await crearToma({ items: [{ tipo: 'insumo', id: estricto.id }] });
  await contar(t, estricto, 0); // delta -5
  await egreso(estricto, 4); // queda 1
  const bloq = await aprobar(t, { confirmaciones: { 0: 'x' } });
  assert.equal(bloq.status, 409);
  assert.ok(bloq.json.detalle.lineas[0].motivos.includes('dejaria_negativo_bloqueado'));
  assert.equal(await saldo(estricto), 1);

  const libre = await insumo('Libre T5', 5);
  await api('PUT', `/api/insumos/${libre.id}/configuracion`, { token, body: { permite_negativo: true } });
  const t2 = await crearToma({ items: [{ tipo: 'insumo', id: libre.id }] });
  await contar(t2, libre, 0);
  await egreso(libre, 4);
  const pide = await aprobar(t2);
  assert.equal(pide.status, 409);
  assert.ok(pide.json.detalle.lineas[0].motivos.includes('dejaria_negativo'));
  const lid = pide.json.detalle.lineas[0].linea_id;
  assert.equal((await aprobar(t2, { confirmaciones: { [lid]: 'se acepta el negativo hasta regularizar' } })).status, 200);
  assert.equal(await saldo(libre), -4);
});

test('Stock.RN68/EX52: un ajuste que deja el físico por debajo de lo comprometido exige un supervisor y alerta', async () => {
  const Comp = require('../src/stock/compromisoService');
  const p = (await api('POST', '/api/productos', { token, body: { nombre: 'Torta T6', precio: 1, stock: 10 } })).json;
  await api('PUT', `/api/stock/configuracion/producto/${p.id}`, { token, body: { permite_negativo: false } });
  const c = await Comp.comprometer({ idSolicitud: `sol-toma-${++k}`, lineas: [{ producto_id: p.id, cantidad: 8 }] });
  assert.equal(c.ok, true);
  const t = await crearToma({ items: [{ tipo: 'producto', id: p.id }] });
  await api('POST', `/api/inventario/tomas/${t.json.id}/lineas`, { token, body: { item: { tipo: 'producto', id: p.id }, deposito_id: principal.id, cantidad: 5 } }); // delta -5: queda 5 < 8
  const sin = await aprobar(t);
  assert.equal(sin.status, 403);
  assert.equal(sin.json.codigo, 'REQUIERE_AUTORIZACION');
  assert.equal((await aprobar(t, { autorizacion: { credencial: '1111' } })).status, 403); // no se autoriza a sí mismo
  const ok = await aprobar(t, { autorizacion: { credencial: '2222' } });
  assert.equal(ok.status, 200);
  assert.equal((await notis('reserva_comprometida')).length, 1);
  await Comp.liberar(c.id_compromiso);
});

test('Stock.RN68/EX52: la segunda toma que cuenta lo mismo se marca "superpuesta" y no aplica dos veces la diferencia', async () => {
  const leche = await insumo('Leche T7', 10);
  const a = await crearToma({ items: [{ tipo: 'insumo', id: leche.id }] });
  const b = await crearToma({ items: [{ tipo: 'insumo', id: leche.id }] });
  await contar(a, leche, 8);
  await contar(b, leche, 8); // las dos ven teórico 10 y contado 8
  assert.equal((await aprobar(a)).status, 200);
  assert.equal(await saldo(leche), 8);
  const sin = await aprobar(b);
  assert.equal(sin.status, 409);
  assert.deepEqual(sin.json.detalle.lineas[0].motivos, ['superpuesta']);
  assert.equal(sin.json.detalle.lineas[0].teorico, 8); // incorpora el ajuste de la toma aprobada antes
  const ok = await aprobar(b, { confirmaciones: { [sin.json.detalle.lineas[0].linea_id]: 'es el mismo conteo que la toma anterior' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.ajustes, []); // delta 0: no se vuelve a descontar
  assert.equal(await saldo(leche), 8);
});

test('Stock.RF14: solo se cuenta lo que está en el alcance; el alcance puede ser un depósito, una categoría o una selección', async () => {
  const cocina = (await api('POST', '/api/depositos', { token, body: { nombre: 'Cocina T8' } })).json;
  const x = await insumo('X T8', 5);
  const y = await insumo('Y T8', 5);
  const porDeposito = await crearToma({ deposito_id: cocina.id });
  assert.equal((await contar(porDeposito, x, 1, principal.id)).status, 400); // otro depósito
  assert.equal((await contar(porDeposito, x, 1, cocina.id)).status, 201);
  const porItems = await crearToma({ items: [{ tipo: 'insumo', id: x.id }] });
  assert.equal((await contar(porItems, y, 1)).status, 400); // otro ítem
  const cat = (await api('POST', '/api/categorias', { token, body: { nombre: 'Postres T8' } })).json;
  const dulce = (await api('POST', '/api/productos', { token, body: { nombre: 'Dulce T8', precio: 1, categoria_id: cat.id } })).json;
  const porCategoria = await crearToma({ categoria_id: cat.id });
  assert.equal((await contar(porCategoria, x, 1)).status, 400); // un insumo no tiene categoría de catálogo
  assert.equal((await api('POST', `/api/inventario/tomas/${porCategoria.json.id}/lineas`, { token, body: { item: { tipo: 'producto', id: dulce.id }, deposito_id: principal.id, cantidad: 2 } })).status, 201);
  assert.equal((await contar(porItems, x, -1)).status, 400); // cantidad negativa
  assert.equal((await crearToma({ deposito_id: 99999 })).status, 400);
  assert.equal((await crearToma({ items: [] })).status, 400);
  assert.equal((await api('POST', `/api/inventario/tomas/${porItems.json.id}/cancelar`, { token })).status, 200);
  assert.equal((await contar(porItems, x, 1)).status, 409); // cancelada
});

test('Stock.RF14: con "congelar movimientos manuales" los ingresos, egresos y transferencias del alcance se bloquean; las ventas no', async () => {
  const hielo = await insumo('Hielo T9', 20);
  const libre = await insumo('Fuera T9', 20);
  const t = await crearToma({ items: [{ tipo: 'insumo', id: hielo.id }] }, true);
  assert.equal((await egreso(hielo, 1)).status, 409);
  assert.equal((await egreso(hielo, 1)).json.codigo, 'TOMA_EN_CURSO');
  assert.equal((await ingreso(hielo, 1)).status, 409);
  const tr = await api('POST', '/api/stock/transferencias', { token, body: { origen_id: principal.id, destino_id: (await api('POST', '/api/depositos', { token, body: { nombre: 'Barra T9' } })).json.id, lineas: [{ item: { tipo: 'insumo', id: hielo.id }, cantidad: 1 }] } });
  assert.equal(tr.status, 409);
  assert.equal((await egreso(libre, 1)).status, 201); // fuera del alcance
  // Una venta sí descuenta aunque el ítem esté congelado.
  const frio = (await api('POST', '/api/productos', { token, body: { nombre: 'Granizado T9', tipo: 'elaborado', precio: 5 } })).json;
  await api('PUT', `/api/recetas/${frio.id}`, { token, body: { lineas: [{ insumo_id: hielo.id, cantidad_consumida: 2 }] } });
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: frio.id, cantidad: 1 }] } });
  assert.equal((await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-inv-${++k}-abcdef` }, body: { metodo_pago: 'efectivo' } })).status, 200);
  await esperarMensajes(pool);
  assert.equal(await saldo(hielo), 18);
  await api('POST', `/api/inventario/tomas/${t.json.id}/cancelar`, { token });
  assert.equal((await egreso(hielo, 1)).status, 201); // liberado
});

test('Stock.RF16: alerta cuando un ítem llega al punto de reposición o baja del mínimo, y se resuelve sola al recuperarse', async () => {
  const yerba = await insumo('Yerba T10', 20);
  await api('PUT', `/api/insumos/${yerba.id}/configuracion`, { token, body: { depositos: [{ deposito_id: principal.id, stock_minimo: 5, punto_reposicion: 8 }] } });
  const evaluar = () => api('POST', '/api/inventario/alertas/evaluar', { token });
  await evaluar();
  assert.equal((await notis('punto_reposicion', true)).filter((a) => a.mensaje.includes('Yerba T10')).length, 0);
  await egreso(yerba, 13); // 7: en reposición
  await evaluar();
  assert.equal((await notis('punto_reposicion', true)).filter((a) => a.mensaje.includes('Yerba T10')).length, 1);
  await egreso(yerba, 4); // 3: bajo el mínimo
  await evaluar();
  const baja = (await notis('stock_bajo_minimo', true)).filter((a) => a.mensaje.includes('Yerba T10'));
  assert.deepEqual([baja.length, baja[0].severidad], [1, 'alta']);
  await ingreso(yerba, 30);
  await evaluar();
  const abiertasYerba = (await pool.query("SELECT COUNT(*) n FROM notificaciones WHERE clave IN (?, ?) AND estado <> 'resuelta'", [`stock-bajo:insumo:${yerba.id}:${principal.id}`, `stock-minimo:insumo:${yerba.id}:${principal.id}`]))[0][0].n;
  assert.equal(abiertasYerba, 0);
});

test('Stock.RF16/EX01: un saldo negativo por un descuento ya cerrado genera una alerta que se resuelve al regularizarse', async () => {
  const pan = await insumo('Pan T11', 2);
  await api('PUT', `/api/insumos/${pan.id}/configuracion`, { token, body: { permite_negativo: true } });
  const elab = (await api('POST', '/api/productos', { token, body: { nombre: 'Tostada T11', tipo: 'elaborado', precio: 1 } })).json;
  await api('PUT', `/api/recetas/${elab.id}`, { token, body: { lineas: [{ insumo_id: pan.id, cantidad_consumida: 1 }] } });
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: elab.id, cantidad: 5 }] } });
  await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-neg-${++k}-abcdef` }, body: { metodo_pago: 'efectivo' } });
  await esperarMensajes(pool);
  await api('POST', '/api/inventario/alertas/evaluar', { token });
  assert.equal((await notis('stock_negativo', true)).filter((a) => a.mensaje.includes('Pan T11')).length, 1);
  await ingreso(pan, 10);
  await api('POST', '/api/inventario/alertas/evaluar', { token });
  assert.equal((await pool.query("SELECT COUNT(*) n FROM notificaciones WHERE clave = ? AND estado <> 'resuelta'", [`stock-negativo:insumo:${pan.id}`]))[0][0].n, 0);
});

test('Stock.RF16: la reposición sugerida por depósito se calcula sobre el disponible y se exporta', async () => {
  const fideos = await insumo('Fideos T12', 4);
  await api('PUT', `/api/insumos/${fideos.id}/configuracion`, { token, body: { depositos: [{ deposito_id: principal.id, stock_minimo: 2, punto_reposicion: 10 }] } });
  const lista = (await api('GET', `/api/inventario/reposicion?deposito_id=${principal.id}`, { token })).json;
  const f = lista.find((x) => x.insumo_id === fideos.id);
  assert.deepEqual([f.disponible, f.punto_reposicion, f.sugerida], [4, 10, 6]);
  const csv = await api('GET', '/api/inventario/reposicion?formato=csv', { token });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /csv/);
  assert.equal((await api('GET', '/api/inventario/reposicion?formato=raro', { token })).status, 400);
});

// ---- RF35: diferencias de integración ----

const venderUno = async (producto, cantidad) => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: producto.id, cantidad }] } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-dif-${++k}-abcdef` }, body: { metodo_pago: 'efectivo' } });
  await esperarMensajes(pool);
  await esperarMensajes(pool);
  return r.json.venta_id_global;
};
const ejecutar = async () => (await api('POST', '/api/inventario/diferencias/ejecutar', { token, body: {} })).json;
const abiertas = async (venta) => (await api('GET', '/api/inventario/diferencias?estado=abierta', { token })).json.filter((d) => d.doc_id_global === venta);

test('Stock.RF35: una venta bien descontada no tiene diferencias; la que no tiene mensaje, queda abierta con alerta crítica', async () => {
  const p = (await api('POST', '/api/productos', { token, body: { nombre: 'Dif A', precio: 1, stock: 50 } })).json;
  const ok = await venderUno(p, 2);
  const sinMensaje = await venderUno(p, 3);
  await pool.query("DELETE FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = 'descuento_stock'", [sinMensaje]);
  const r = await ejecutar();
  assert.ok(r.alertadas >= 1);
  assert.deepEqual(await abiertas(ok), []);
  const d = await abiertas(sinMensaje);
  assert.deepEqual([d[0].causa, d[0].vendido, d[0].descontado, d[0].diferencia], ['venta_sin_mensaje', 3, 3, 0]); // el descuento se hizo, pero el mensaje se perdió
  const [[al]] = await pool.query("SELECT severidad, estado FROM notificaciones WHERE tipo = 'diferencia_integracion' AND mensaje LIKE ?", [`%${sinMensaje}%`]);
  assert.deepEqual([al.severidad, al.estado], ['critica', 'nueva']);
  // Se corrige (se vuelve a crear el mensaje) y el informe la resuelve.
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  await M.publicar(conn, { origen: 'ventas', destino: 'stock', tipo: 'descuento_stock', docTipo: 'venta', docIdGlobal: sinMensaje, contenido: { doc_tipo: 'venta', items: [{ linea: 0, producto_id: p.id, cantidad: 3 }] } });
  await conn.commit();
  conn.release();
  await esperarMensajes(pool);
  await ejecutar();
  assert.deepEqual(await abiertas(sinMensaje), []);
  assert.equal((await pool.query("SELECT estado FROM notificaciones WHERE tipo = 'diferencia_integracion' AND mensaje LIKE ?", [`%${sinMensaje}%`]))[0][0].estado, 'resuelta');
});

test('Stock.RF35: un mensaje en trámite hace menos del margen no alerta; pasado el margen, sí; rechazado y fallido se informan', async () => {
  const p = (await api('POST', '/api/productos', { token, body: { nombre: 'Dif B', precio: 1, stock: 50 } })).json;
  const v1 = await venderUno(p, 1);
  const v2 = await venderUno(p, 1);
  const v3 = await venderUno(p, 1);
  const marcar = (venta, estado, extra = '') => pool.query(`UPDATE mensajes_integracion SET estado = ?, proximo_intento_ms = ? ${extra} WHERE doc_id_global = ? AND tipo = 'descuento_stock'`, [estado, Date.now() + 3600000, venta]);
  await marcar(v1, 'pendiente');
  await marcar(v2, 'pendiente', ', ts_origen_ms = ts_origen_ms - 1200000'); // hace 20 minutos
  await marcar(v3, 'rechazado', ", motivo_rechazo = 'sin receta'");
  await ejecutar();
  assert.deepEqual((await abiertas(v1)).map((d) => d.causa), ['en_tramite']);
  assert.equal((await pool.query("SELECT COUNT(*) n FROM notificaciones WHERE tipo = 'diferencia_integracion' AND mensaje LIKE ?", [`%${v1}%`]))[0][0].n, 0); // en trámite: sin alerta
  assert.deepEqual((await abiertas(v2)).map((d) => d.causa), ['descuento_pendiente']);
  const rech = await abiertas(v3);
  assert.deepEqual([rech[0].causa, rech[0].detalle], ['rechazado', 'sin receta']);
  assert.equal((await api('GET', '/api/inventario/diferencias?causa=rechazado', { token })).json.length >= 1, true);
  await pool.query("UPDATE mensajes_integracion SET estado = 'confirmado' WHERE doc_id_global IN (?, ?, ?)", [v1, v2, v3]); // no dejar nada pendiente para las pruebas que siguen
});

test('Stock.RF35: detecta lo descontado de más, el descuento duplicado y el movimiento sin venta de origen', async () => {
  const x = await insumo('Dif C', 100);
  const elab = (await api('POST', '/api/productos', { token, body: { nombre: 'Dif C elab', tipo: 'elaborado', precio: 1 } })).json;
  await api('PUT', `/api/recetas/${elab.id}`, { token, body: { lineas: [{ insumo_id: x.id, cantidad_consumida: 1 }] } });
  const venta = await venderUno(elab, 2);
  const extra = async (doc, clave) => {
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await Mov.registrar(conn, { item: { tipo: 'insumo', id: x.id }, tipo: 'venta', motivo: 'venta', cantidad: -1, documento_tipo: 'venta', documento: doc, operacion_clave: clave });
    await conn.commit();
    conn.release();
  };
  await extra(venta, 'otra-operacion|0|insumo:' + x.id); // otro descuento del mismo documento con otra ID_Operacion
  await extra('TST01-NOEXISTE00000000000000001', 'huerfano|0|insumo:' + x.id);
  await ejecutar();
  const causas = (await abiertas(venta)).map((d) => d.causa).sort();
  assert.deepEqual(causas, ['descuento_duplicado', 'diferencia_cantidad']);
  const dup = (await abiertas(venta)).find((d) => d.causa === 'diferencia_cantidad');
  assert.deepEqual([dup.vendido, dup.descontado, dup.diferencia], [2, 3, -1]);
  const huerfano = await abiertas('TST01-NOEXISTE00000000000000001');
  assert.deepEqual(huerfano.map((d) => d.causa), ['movimiento_sin_venta']);
});
