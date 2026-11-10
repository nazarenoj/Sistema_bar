const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const { simularArca } = require('./ayudas_online');
const Comp = require('../src/stock/compromisoService');
const Reserva = require('../src/ventas_online/reservaPedidoService');
const Checkout = require('../src/ventas_online/checkoutService');

let api, pool, cerrar, adm, gerente, A, B, L, k = 0, tokCuenta, cuentaId;

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  simularArca();
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  await api('POST', '/api/modulos/ventas_online/instalar', { token: adm.token });
  await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { codigo: 'cafe-co', nombre: 'Cafe', razon_social: 'Cafe SA', cuit: '30711111111', domicilio: 'Mitre 1', activa: true } });
  const estricto = async (nombre, stock, precio) => {
    const p = (await api('POST', '/api/productos', { token: adm.token, body: { nombre, precio, stock } })).json;
    await api('PUT', `/api/stock/configuracion/producto/${p.id}`, { token: adm.token, body: { permite_negativo: false } });
    return p;
  };
  A = await estricto('Cafe 250 g', 5, 1000);
  B = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Medialuna', precio: 300, stock: 0 } })).json;
  L = await estricto('Budin', 10, 800);
  for (const p of [A, B, L]) await api('PUT', `/api/ventas-online/catalogo/${p.id}`, { token: gerente.token, body: { categoria_online: 'Menu' } });
  const Alergenos = require('../src/services/alergenoVentaService');
  const lac = (await pool.query("SELECT id FROM ven_alergenos WHERE codigo = 'lacteos'"))[0][0].id;
  await Alergenos.declararArticulo(L.id, [lac]);
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
});
after(async () => { await cerrar(); });

const T = '/tienda/cafe-co';
const carrito = async (items) => {
  let c;
  for (const [i, it] of items.entries()) c = i === 0 ? (await api('POST', `${T}/carrito`, { body: it })).json : (await api('POST', `${T}/carrito/${c.token}/items`, { body: it })).json;
  return c;
};
const datos = (c, extra = {}) => ({ carrito: c.token, contacto: { nombre: 'Ana Perez', email: 'ana@mail.test', telefono: '341-1' }, facturacion: { tipo: 'consumidor_final' }, entrega: { tipo: 'retiro' }, medio_pago: 'pasarela', acepta_terminos: true, total_confirmado: c.total, ...extra });
const pagar = (body, solicitud = `sol-checkout-${++k}-abcdef`) => api('POST', `${T}/checkout`, { body, headers: { 'X-ID-Solicitud': solicitud } });
const disp = async (p) => (await api('GET', `${T}/catalogo`)).json.find((x) => x.id === p.id).disponible;
const reservado = async () => [...(await Comp.comprometidos()).values()].reduce((a, b) => a + b, 0);

test('Ventas Online.RF09: el resumen muestra el total final con los alergenos de cada linea antes de pagar', async () => {
  const c = await carrito([{ producto_id: L.id, cantidad: 2 }, { producto_id: B.id, cantidad: 1 }]);
  const r = await api('POST', `${T}/checkout/resumen`, { body: { carrito: c.token } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.total, 1900); assert.equal(r.json.requiere_aceptar_alergenos, true);
  assert.deepEqual(r.json.alergenos.map((a) => a.codigo), ['lacteos']);
  assert.deepEqual(r.json.lineas.find((l) => l.producto_id === L.id).alergenos.map((a) => a.codigo), ['lacteos']);
  assert.equal((await api('POST', `${T}/checkout/resumen`, { body: { carrito: 'x'.repeat(48) } })).status, 404);
});

test('Ventas Online.RF09/EX14: el checkout exige datos de contacto, terminos, alergenos y un CUIT valido para factura A', async () => {
  const c = await carrito([{ producto_id: L.id, cantidad: 1 }]);
  const base = datos(c, { acepta_alergenos: true });
  assert.equal((await api('POST', `${T}/checkout`, { body: base })).json.codigo, 'FALTA_SOLICITUD');
  assert.equal((await pagar({ ...base, contacto: { nombre: '', email: 'x' } })).status, 400);
  assert.equal((await pagar({ ...base, acepta_terminos: false })).json.codigo, 'TERMINOS_NO_ACEPTADOS');
  assert.equal((await pagar({ ...base, acepta_alergenos: false })).json.codigo, 'ALERGENOS_NO_ACEPTADOS');
  assert.equal((await pagar({ ...base, medio_pago: 'bitcoin' })).status, 400);
  const mal = await pagar({ ...base, facturacion: { tipo: 'factura_a', cuit: '30711111112', razon_social: 'X', condicion_iva: 'Responsable Inscripto' } });
  assert.equal(mal.json.codigo, 'CUIT_INVALIDO'); assert.match(mal.json.error, /consumidor final/);
  assert.equal((await pagar({ ...base, facturacion: { tipo: 'factura_a', cuit: '30711111111' } })).status, 400); // falta razon social e IVA
  assert.equal(await reservado(), 0); // ninguno de los rechazos dejo una reserva
});

test('Ventas Online.RN10: por encima del tope de consumidor final el checkout exige identificar al comprador', async () => {
  const c = await carrito([{ producto_id: L.id, cantidad: 1 }]);
  const base = datos(c, { acepta_alergenos: true, total_confirmado: (await api('POST', `${T}/checkout/resumen`, { body: { carrito: c.token } })).json?.total });
  const tope = async (v) => { await pool.query("UPDATE parametros SET valor = ? WHERE clave = 'tope_consumidor_final'", [String(v)]); require('../src/models/parametroModel').invalidar(); };
  await tope(1);
  try {
    const sin = await pagar({ ...base, facturacion: { tipo: 'consumidor_final' } });
    assert.equal(sin.status, 400, JSON.stringify(sin.json));
    assert.equal(sin.json.codigo, 'IDENTIFICACION_REQUERIDA');
    assert.equal((await pagar({ ...base, facturacion: { tipo: 'consumidor_final', dni: '12' } })).json.codigo, 'DNI_INVALIDO');
    assert.equal(await reservado(), 0);
    const con = await pagar({ ...base, facturacion: { tipo: 'consumidor_final', dni: '30.111.222' } });
    assert.notEqual(con.json.codigo, 'IDENTIFICACION_REQUERIDA', JSON.stringify(con.json));
    // Con el tope en cero (sin control) un consumidor final sin identificar pasa.
    await tope(0);
    const c2 = await carrito([{ producto_id: L.id, cantidad: 1 }]);
    assert.notEqual((await pagar({ ...datos(c2, { acepta_alergenos: true }), facturacion: { tipo: 'consumidor_final' } })).json.codigo, 'IDENTIFICACION_REQUERIDA');
  } finally { await tope(0); require('../src/ventas_online/limites').pedidos.reiniciar(); }
});

test('Ventas Online.EX09/RN05: si cambio el total desde que se mostro, se informa y se pide confirmar de nuevo', async () => {
  const c = await carrito([{ producto_id: B.id, cantidad: 2 }]);
  await pool.query('UPDATE productos SET precio = 400 WHERE id = ?', [B.id]);
  const r = await pagar(datos(c));
  assert.equal(r.status, 409); assert.equal(r.json.codigo, 'TOTAL_CAMBIO'); assert.equal(r.json.resumen.total, 800);
  const ok = await pagar(datos(c, { total_confirmado: 800 }));
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.total, 800); assert.equal(ok.json.lineas[0].precio_unitario, 400);
  await pool.query('UPDATE productos SET precio = 300 WHERE id = ?', [B.id]);
  assert.equal((await api('GET', `${T}/pedidos/${ok.json.id_global}?email=ana@mail.test`)).json.lineas[0].precio_unitario, 400); // el precio quedo fijo
});

test('Ventas Online.RN07: la reserva de stock se pide antes del cobro, dura 15 minutos y se muestra el tiempo restante', async () => {
  const antes = await disp(A);
  const c = await carrito([{ producto_id: A.id, cantidad: 2 }]);
  const r = await pagar(datos(c));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.estado, 'pendiente_pago'); assert.equal(r.json.reserva.estado, 'confirmada');
  assert.ok(r.json.reserva.segundos_restantes > 14 * 60 && r.json.reserva.segundos_restantes <= 15 * 60);
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
  assert.equal(await disp(A), antes - 2); // lo reservado se resta del disponible de todos los canales
  const [[ped]] = await pool.query('SELECT * FROM onl_pedidos WHERE id = ?', [r.json.id]);
  assert.match(ped.config_instantanea, /ONL-PASARELA/); // RN49: las reglas con que se abrio
  assert.ok(ped.config_version > 0);
});

test('Ventas Online.EX27: dos checkouts no reservan mas que el stock y el rechazado no deja reserva ni pedido', async () => {
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
  const quedan = await disp(A); // 3
  const antesPedidos = (await pool.query('SELECT COUNT(*) AS n FROM onl_pedidos'))[0][0].n;
  const c1 = await carrito([{ producto_id: A.id, cantidad: quedan }]);
  const c2 = await carrito([{ producto_id: A.id, cantidad: quedan }]);
  const [a, b] = await Promise.all([pagar(datos(c1)), pagar(datos(c2))]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  const rechazado = a.status === 409 ? a : b;
  assert.equal(rechazado.json.codigo, 'SIN_DISPONIBLE'); assert.equal(rechazado.json.detalle[0].disponible, 0);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM onl_pedidos'))[0][0].n, antesPedidos + 1); // solo el que se pudo reservar
});

test('Ventas Online.RN48: repetir la confirmacion con la misma clave devuelve el mismo pedido sin reservar otra vez', async () => {
  const c = await carrito([{ producto_id: B.id, cantidad: 1 }]);
  const clave = 'sol-repetida-0001-abcdef';
  const uno = await pagar(datos(c), clave);
  const dos = await pagar(datos(c), clave);
  assert.equal(uno.status, 201); assert.equal(dos.status, 200);
  assert.equal(dos.json.repetido, true); assert.equal(dos.json.id_global, uno.json.id_global);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM onl_pedidos WHERE id_solicitud = ?', [clave]))[0][0].n, 1);
});

test('Ventas Online.EX01/EX28: mientras reintenta conserva la reserva (se renueva hasta 3 veces); abandonar la libera de inmediato', async () => {
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
  const antes = await disp(L);
  const c = await carrito([{ producto_id: L.id, cantidad: 3 }]);
  const p = (await pagar(datos(c, { acepta_alergenos: true }))).json;
  assert.equal(p.reserva.estado, 'confirmada');
  const base = `${T}/pedidos/${p.id_global}`;
  for (let i = 0; i < 3; i++) assert.equal((await api('POST', `${base}/renovar-reserva?email=ana@mail.test`)).json.renovacion.renovada, true);
  assert.equal((await api('POST', `${base}/renovar-reserva?email=ana@mail.test`)).json.renovacion.motivo, 'RENOVACIONES_AGOTADAS');
  assert.equal((await api('GET', `${base}`)).status, 404); // no se ve un pedido ajeno
  assert.equal((await api('GET', `${base}?email=otra@mail.test`)).status, 404);
  const ab = await api('POST', `${base}/abandonar?email=ana@mail.test`);
  assert.equal(ab.json.estado, 'cancelado');
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
  assert.equal(await disp(L), antes); // la cantidad vuelve al disponible
  assert.equal((await api('POST', `${base}/abandonar?email=ana@mail.test`)).status, 409);
});

test('Ventas Online.EX28: una reserva sin pago vence sola y los impagos se cancelan pasadas N horas', async () => {
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
  const antes = await disp(L);
  const c = await carrito([{ producto_id: L.id, cantidad: 2 }]);
  const p = (await pagar(datos(c, { acepta_alergenos: true }))).json;
  const [[ped]] = await pool.query('SELECT reserva_id FROM onl_pedidos WHERE id = ?', [p.id]);
  await pool.query("UPDATE reservas SET vence_ms = ? WHERE tipo = 'compromiso_stock' AND contenido LIKE ?", [Date.now() - 1000, `%"compromiso":"${ped.reserva_id}"%`]);
  await pool.query('UPDATE onl_pedidos SET reserva_vence_ms = ? WHERE id = ?', [Date.now() - 1000, p.id]);
  assert.ok((await Reserva.marcarVencidas()) >= 1);
  assert.equal((await Checkout.vista(p.id)).reserva.estado, 'vencida');
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
  assert.equal(await disp(L), antes); // vencida: queda libre sin intervencion de nadie
  assert.equal((await Checkout.vista(p.id)).estado, 'pendiente_pago');
  await pool.query('UPDATE onl_pedidos SET created_ms = ? WHERE id = ?', [Date.now() - 25 * 3600000, p.id]);
  assert.ok((await Checkout.cancelarImpagos()) >= 1);
  assert.equal((await Checkout.vista(p.id)).estado, 'cancelado');
});

test('Ventas Online.RN45/EX30: si Stock no responde se acepta contra la disponibilidad publicada y la reserva queda pendiente hasta que responda', async () => {
  await api('POST', '/api/ventas-online/sincronizar', { token: gerente.token });
  const original = Comp.comprometer;
  Comp.comprometer = async () => { throw new Error('Stock caido'); };
  const c = await carrito([{ producto_id: L.id, cantidad: 1 }]);
  const p = await pagar(datos(c, { acepta_alergenos: true }));
  Comp.comprometer = original;
  assert.equal(p.status, 201, JSON.stringify(p.json));
  assert.equal(p.json.reserva.estado, 'pendiente'); assert.match(p.json.aviso, /Stock responda/);
  const r = await Reserva.confirmarPendientes();
  assert.equal(r.confirmadas, 1);
  assert.equal((await Checkout.vista(p.json.id)).reserva.estado, 'confirmada');
  // Cuando Stock responde y no alcanza, la reserva se rechaza y un pedido ya pagado pasa a «con faltante».
  Comp.comprometer = async () => { throw new Error('Stock caido'); };
  const c2 = await carrito([{ producto_id: L.id, cantidad: 1 }]);
  const p2 = (await pagar(datos(c2, { acepta_alergenos: true }))).json;
  Comp.comprometer = original;
  await pool.query("UPDATE onl_pedidos SET estado = 'reserva_pendiente' WHERE id = ?", [p2.id]);
  await pool.query("UPDATE stock_movimientos SET cantidad = cantidad - 100 WHERE producto_id = ? LIMIT 1", [L.id]).catch(() => {});
  const bloqueo = await Comp.comprometer({ idSolicitud: 'consumo-total-1', lineas: [{ linea: 0, producto_id: L.id, cantidad: await Comp.disponibleUnidades(L.id).then((x) => x.cantidad) }] });
  assert.equal(bloqueo.ok, true);
  const r2 = await Reserva.confirmarPendientes();
  assert.equal(r2.rechazadas, 1);
  assert.equal((await Checkout.vista(p2.id)).estado, 'con_faltante');
});

test('Ventas Online.RN19: la cuenta corriente solo se ofrece a cuentas vinculadas y respeta el veredicto de Clientes', async () => {
  require('../src/ventas_online/limites').pedidos.reiniciar(); // el tope de pedidos por hora de la IP se probo en la tienda
  const c = await carrito([{ producto_id: B.id, cantidad: 1 }]);
  assert.equal((await pagar(datos(c, { medio_pago: 'cuenta_corriente' }))).json.codigo, 'CUENTA_CORRIENTE_NO_DISPONIBLE'); // invitado
  await api('POST', '/api/modulos/clientes/instalar', { token: adm.token });
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['VEN-CC'], motivo: 'prueba' } });
  const cli = (await api('POST', '/api/clientes', { token: adm.token, body: { tipo_documento: 'CUIT', nro_documento: '30500010912', razon_social: 'Cafe del Centro SRL', consultar_arca: false } })).json;
  await api('POST', '/api/cuentas-corrientes', { token: adm.token, body: { cliente_id: cli.id, limite_credito: 1000, plazo_dias: 15 } });
  const reg = (await api('POST', `${T}/cuenta/registro`, { body: { email: 'cc@mail.test', password: 'clave-larga-1', nombre: 'CC' } })).json;
  tokCuenta = reg.token; cuentaId = reg.cuenta.id;
  await api('PUT', `/api/ventas-online/clientes/${cuentaId}/vinculo`, { token: gerente.token, body: { cliente_id: cli.id } });
  const conCuenta = async (items, extra) => {
    const cart = (await api('POST', `${T}/carrito`, { body: items[0], token: tokCuenta })).json;
    return api('POST', `${T}/checkout`, { token: tokCuenta, headers: { 'X-ID-Solicitud': `sol-cc-${++k}-abcdef` }, body: { ...datos(cart), contacto: undefined, medio_pago: 'cuenta_corriente', ...extra } });
  };
  const ok = await conCuenta([{ producto_id: B.id, cantidad: 2 }]); // 600 con limite de 1000
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const [[ped]] = await pool.query('SELECT credito_reserva_id FROM onl_pedidos WHERE id = ?', [ok.json.id]);
  assert.match(ped.credito_reserva_id, /^RC-/);
  const sin = await conCuenta([{ producto_id: B.id, cantidad: 3 }]); // 900 mas los 600 reservados superan el limite
  assert.equal(sin.status, 409, JSON.stringify(sin.json));
  assert.ok(['CREDITO_BLOQUEADO', 'CREDITO_REQUIERE_AUTORIZACION'].includes(sin.json.codigo), sin.json.codigo);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM onl_pedidos WHERE medio_pago = 'cuenta_corriente'"))[0][0].n, 1);
});

test('Ventas Online.RF24/RN07: el canje de un vale es una forma de pago, puede ser parcial y retiene el saldo (llamada 9)', async () => {
  require('../src/ventas_online/limites').pedidos.reiniciar();
  const sinFid = await carrito([{ producto_id: B.id, cantidad: 2 }]);
  assert.equal((await pagar(datos(sinFid, { canje: { codigo: 'TST01-VALE-X', importe: 100 } }))).json.codigo, 'CANJE_NO_DISPONIBLE'); // CLI-FIDEL apagada
  assert.equal((await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['CLI-FIDEL'], motivo: 'prueba' } })).status, 200);
  const [i] = await pool.query("INSERT INTO fid_instrumentos (codigo, tipo, importe_inicial, instancia, ultima_actividad) VALUES ('TST01-VALE-ONLINE1', 'vale', 500, 'TST01', CURDATE())");
  await pool.query("INSERT INTO fid_instrumento_movs (instrumento_id, movimiento, importe, id_operacion, motivo) VALUES (?, 'emision', 500, 'emision-online-1', 'prueba')", [i.insertId]);
  const c = await carrito([{ producto_id: B.id, cantidad: 2 }]); // 600
  const antes = await reservado();
  assert.equal((await pagar(datos(c, { canje: { codigo: 'TST01-NOEXISTE', importe: 100 } }))).json.codigo, 'INSTRUMENTO_RECHAZADO');
  const corto = await pagar(datos(c, { canje: { codigo: 'TST01-VALE-ONLINE1', importe: 800 } })); // se canjea hasta el total (600) y el saldo es 500
  assert.equal(corto.json.codigo, 'SALDO_INSUFICIENTE'); assert.equal(corto.json.saldo, 500);
  assert.equal(await reservado(), antes); // los rechazos no dejan reservas
  const ok = await pagar(datos(c, { canje: { codigo: 'TST01-VALE-ONLINE1', importe: 500 } }));
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.total, ok.json.canje, ok.json.a_pagar], [600, 500, 100]);
  const [[ped]] = await pool.query('SELECT retencion_id FROM onl_pedidos WHERE id = ?', [ok.json.id]);
  assert.match(ped.retencion_id, /^RS-/);
  const otro = await carrito([{ producto_id: B.id, cantidad: 2 }]);
  assert.equal((await pagar(datos(otro, { canje: { codigo: 'TST01-VALE-ONLINE1', importe: 100 } }))).json.codigo, 'SALDO_INSUFICIENTE'); // lo retenido ya no esta disponible
});
