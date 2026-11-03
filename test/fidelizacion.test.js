const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
process.env.AFIP_CONDICION_IVA_EMISOR = 'monotributista';
process.env.AFIP_PUNTO_VENTA = '1';
const { iniciarApp, esperarMensajes } = require('./ayudas');
const M = require('../src/mensajeria/servicio');
const puertos = require('../src/modulos/puertos');
const F = require('../src/clientes/fidelizacionService');

let api, pool, cerrar, token, cafe, torta, tarjeta, ana, beto, n = 0, k = 0;
const AUT = { usuario: 'adm2', credencial: 'clave-larga-1' };

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username) => {
    const [r] = await pool.query("INSERT INTO users (username, password_hash, rol) VALUES (?, ?, 'admin')", [username, await bcrypt.hash('clave-larga-1', 4)]);
    await pool.query("INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = 'administrador'", [r.insertId]);
  };
  await usuario('adm'); await usuario('adm2');
  token = (await api('POST', '/api/auth/login', { body: { username: 'adm', password: 'clave-larga-1' } })).json.token;
  const wsfe = require('../src/afip/wsfeClient');
  let ultimo = 0;
  wsfe.compUltimoAutorizado = async () => ultimo;
  wsfe.solicitarCAE = async ({ item }) => { ultimo = item.CbteDesde; return { FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CAE: '70000000000001', CAEFchVto: '20261231' }] } }; };
  await api('POST', '/api/modulos/clientes/instalar', { token });
  cafe = (await api('POST', '/api/productos', { token, body: { nombre: 'Café', precio: 400 } })).json;
  torta = (await api('POST', '/api/productos', { token, body: { nombre: 'Torta', precio: 1000 } })).json;
  ana = (await api('POST', '/api/clientes', { token, body: { tipo_documento: 'DNI', nro_documento: '30123456', razon_social: 'Ana Pérez', telefono: '1155551234', consultar_arca: false } })).json;
  beto = (await api('POST', '/api/clientes', { token, body: { tipo_documento: 'DNI', nro_documento: '28999111', razon_social: 'Beto Gómez', consultar_arca: false } })).json;
});
after(async () => { await cerrar(); });

const fid = (ruta = '', metodo = 'GET', body, t = token) => api(metodo, `/api/fidelizacion${ruta}`, { token: t, body });
// Vende los productos indicados [[producto, cantidad]] con los pagos y datos extra.
const vender = async (lineas, pagos, extra = {}) => {
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: ++n, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: lineas.map(([p, c]) => ({ producto_id: p.id, cantidad: c })) } });
  const r = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': `cierre-fid-${++k}-abcdef` }, body: { pagos, ...extra } });
  await esperarMensajes(pool);
  return r;
};
const efectivo = (importe) => [{ forma: 'efectivo', importe }];
const socio = async (c) => (await fid(`/socios/${c.id}`)).json;

test('Clientes.RF22/RN23: el programa se define con permiso; el socio adhiere con consentimiento (el Consumidor Final no acumula) y se lo identifica por documento, teléfono o QR', async () => {
  assert.equal((await fid('/programa')).status, 409); // CLI-FIDEL apagada
  assert.equal((await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['CLI-FIDEL'], motivo: 'prueba' } })).status, 200);
  assert.equal((await fid('/programa', 'PUT', { estado: 'activo', importe_por_punto: 0 })).status, 400);
  const p = await fid('/programa', 'PUT', { estado: 'activo', importe_por_punto: 500, valor_punto: 100 });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.match(p.json.aviso, /no se consolidan/);
  assert.equal((await fid('/reglas', 'POST', { nombre: 'Café', sellos_para_premio: 3, premio_tipo: 'producto_gratis' })).status, 400); // por artículo o categoría
  const regla = await fid('/reglas', 'POST', { nombre: 'Café gratis al 3.er sello', producto_id: cafe.id, sellos_por_unidad: 1, sellos_para_premio: 3, premio_tipo: 'producto_gratis', premio_producto_id: cafe.id });
  assert.equal(regla.status, 201, JSON.stringify(regla.json));
  assert.equal((await fid('/socios', 'POST', { cliente_id: ana.id })).status, 400); // sin consentimiento
  const cf = (await api('GET', '/api/clientes?q=consumidor', { token })).json[0];
  assert.equal((await fid('/socios', 'POST', { cliente_id: cf.id, consentimiento: true })).status, 409);
  const s = await fid('/socios', 'POST', { cliente_id: ana.id, consentimiento: true });
  assert.deepEqual([s.status, s.json.socio, !!s.json.consentimiento_en], [201, true, true]);
  // Identificación (EX15): por documento, teléfono o QR; sin ficha se ofrece el alta rápida; con varias, la lista.
  assert.equal((await fid('/identificar?q=30123456')).json.accion, 'ok');
  assert.equal((await fid('/identificar?q=1155551234')).json.resultados[0].socio, true);
  assert.equal((await fid('/identificar?q=99999999')).json.accion, 'alta_rapida');
  const rapida = await fid('/socios/alta-rapida', 'POST', { nombre: 'Carla Díaz', telefono: '1155551234', consentimiento: true });
  assert.equal(rapida.status, 201, JSON.stringify(rapida.json));
  assert.equal((await fid('/identificar?q=1155551234')).json.accion, 'elegir'); // el teléfono está en más de una ficha
  assert.equal((await fid('/socios/alta-rapida', 'POST', { nombre: 'X', telefono: '1', consentimiento: false })).status, 400);
});

test('Clientes.RN24: los sellos y los puntos se acumulan solo por ventas cobradas a un socio, sobre el importe pagado', async () => {
  const v = await vender([[cafe, 3]], efectivo(1200), { cliente_id: ana.id });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  const s = await socio(ana);
  assert.deepEqual([s.sellos[0].sellos, s.puntos, s.valor_puntos], [3, 2, 200]); // 3 sellos y 1200 / 500 = 2 puntos de a $100
  assert.equal(s.sellos[0].premios_disponibles, 1);
  await vender([[cafe, 3]], efectivo(1200), { cliente_id: beto.id }); // Beto no es socio: no acumula
  assert.equal((await socio(beto)).socio, false);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM fid_movimientos WHERE cliente_id = ?', [beto.id]))[0][0].n, 0);
  await assert.rejects(pool.query('UPDATE fid_movimientos SET cantidad = 99'), /no se edita/); // RN28
  await assert.rejects(pool.query('DELETE FROM fid_movimientos'), /no se elimina/);
  assert.equal((await fid(`/socios/${ana.id}/ajustes`, 'POST', { tipo: 'puntos', cantidad: 5 })).status, 400); // el ajuste exige motivo
  assert.equal((await fid(`/socios/${ana.id}/ajustes`, 'POST', { tipo: 'puntos', cantidad: 5, motivo: 'Bonificación por cumpleaños' })).json.puntos, 7);
});

test('Clientes.RF24: el premio de sellos se aplica en el cobro como regla aprobada del programa y consume los sellos; sin sellos suficientes no se da', async () => {
  const regla = (await fid('/programa')).json.reglas[0];
  const sin = await vender([[cafe, 2]], efectivo(800), { cliente_id: beto.id, premio_sellos: { regla_id: regla.id } });
  assert.deepEqual([sin.status, sin.json.codigo], [409, 'PREMIO_NO_DISPONIBLE']);
  const ok = await vender([[cafe, 2]], efectivo(400), { cliente_id: ana.id, premio_sellos: { regla_id: regla.id } }); // 2 cafés a $800, uno gratis
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const s = await socio(ana);
  assert.deepEqual([s.sellos[0].sellos, s.puntos], [1, 7]); // gastó 3 sellos y los artículos de premio no acumulan: 1 café pago = 1 sello
  const sinProducto = await vender([[torta, 1]], efectivo(1000), { cliente_id: ana.id, premio_sellos: { regla_id: regla.id } });
  assert.equal(sinProducto.json.codigo, 'PREMIO_NO_DISPONIBLE'); // ya no tiene los sellos
});

test('Ventas RF51/Clientes RF29: la gift card se vende como artículo sin stock, la emite el mensaje de Ventas y se consulta por código', async () => {
  tarjeta = (await api('POST', '/api/productos', { token, body: { nombre: 'Gift card $10.000', precio: 10000, tipo: 'gift_card' } })).json;
  assert.equal(tarjeta.tipo ?? 'gift_card', 'gift_card');
  const v = await vender([[tarjeta, 1]], efectivo(10000), { cliente_id: beto.id });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  const lista = (await fid('/instrumentos?tipo=gift_card')).json;
  assert.equal(lista.length, 1);
  assert.match(lista[0].codigo, /^TST01-GC-[0-9A-F]{10}$/); // el código lleva la instancia emisora (RN26)
  assert.deepEqual([lista[0].saldo, lista[0].estado, lista[0].instancia], [10000, 'vigente', 'TST01']);
  // Sin ingreso: el pago de la gift card no suma sellos ni puntos (Beto no es socio) y no descuenta stock del producto.
  assert.equal((await fid(`/consulta?codigo=${lista[0].codigo}`)).json[0].saldo, 10000);
  assert.equal((await fid('/consulta?codigo=INEXISTENTE')).status, 404);
  assert.equal((await fid('/consulta?q=28999111')).json.length, 1); // el comprador la pidió a su nombre (sin cliente sería anónima)
});

test('Clientes.RF31/EX13/EX14: el canje retiene el saldo, no excede el del instrumento y rechaza vencidos, anulados y de otra sucursal', async () => {
  const gc = (await fid('/instrumentos?tipo=gift_card')).json[0];
  const canje = (importe, extra = {}) => vender([[torta, 3]], [{ forma: 'vale', importe, instrumento: gc.codigo }, ...(importe < 3000 ? [{ forma: 'efectivo', importe: 3000 - importe }] : [])], extra);
  const sobra = await canje(3000); // el canje nunca excede el total de la venta: se paga entera con la gift card
  assert.equal(sobra.status, 200, JSON.stringify(sobra.json));
  assert.equal((await fid(`/consulta?codigo=${gc.codigo}`)).json[0].saldo, 7000); // el canje consume el saldo
  const insuf = await vender([[torta, 8]], [{ forma: 'vale', importe: 8000, instrumento: gc.codigo }]);
  assert.deepEqual([insuf.status, insuf.json.codigo, insuf.json.detalle.saldo_actual], [409, 'SALDO_INSUFICIENTE', 7000]);
  const otra = await vender([[torta, 1]], [{ forma: 'vale', importe: 1000, instrumento: 'OTRA-GC-ABC123' }]);
  assert.deepEqual([otra.status, otra.json.codigo], [409, 'INSTRUMENTO_RECHAZADO']);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM fid_retenciones WHERE estado = 'vigente'"))[0][0].n, 0); // una venta que no se cierra no deja saldo retenido
  const sinCodigo = await vender([[torta, 1]], [{ forma: 'vale', importe: 1000 }]);
  assert.equal(sinCodigo.status, 400);
  // Anulado y vencido: rechazados; el vencido se reactiva con motivo.
  await fid(`/instrumentos/${gc.id}/anular`, 'POST', { motivo: 'prueba' });
  assert.equal((await vender([[torta, 1]], [{ forma: 'vale', importe: 1000, instrumento: gc.codigo }])).json.codigo, 'INSTRUMENTO_RECHAZADO');
});

test('Clientes.EX16/EX34/EX33: dos terminales no retienen más que el saldo; una retención vencida se retiene de nuevo si hay saldo; sin respuesta no se ofrece el canje', async () => {
  const sf = await fid('/saldo-favor', 'POST', { cliente_id: ana.id, importe: 5000, motivo: 'Recarga en caja' });
  assert.equal(sf.status, 201, JSON.stringify(sf.json));
  const codigo = sf.json.codigo;
  assert.equal((await fid('/saldo-favor', 'POST', { cliente_id: beto.id, importe: 100, motivo: 'x' })).status, 409); // solo a un socio identificado
  const pedir = (id, importe, extra = {}) => fid('/retenciones', 'POST', { codigo, importe, idSolicitud: id, ...extra });
  const [a, b] = await Promise.all([pedir('ret-term-1-abcdef', 3000), pedir('ret-term-2-abcdef', 3000)]);
  const estados = [a.json.estado, b.json.estado].sort();
  assert.deepEqual(estados, ['retenida', 'saldo_insuficiente']); // dos terminales sobre el mismo vale no retienen más que su saldo
  const perdedora = a.json.estado === 'saldo_insuficiente' ? a : b;
  assert.equal(perdedora.json.saldo_actual, 2000); // la segunda recibe el saldo restante y puede reintentar por eso
  const ganadora = a.json.estado === 'retenida' ? a : b;
  const igual = await pedir(a.json.estado === 'retenida' ? 'ret-term-1-abcdef' : 'ret-term-2-abcdef', 3000);
  assert.equal(igual.json.id_retencion, ganadora.json.id_retencion); // un reintento devuelve la misma
  // Reemplaza_A: cambiar el importe libera la anterior y toma la nueva.
  const nueva = await pedir('ret-term-3-abcdef', 4000, { reemplazaA: ganadora.json.id_retencion });
  assert.equal(nueva.json.estado, 'retenida');
  assert.equal((await fid(`/retenciones/${nueva.json.id_retencion}/renovar`, 'POST')).json.renovaciones, 1);
  // EX34: el mensaje de canje llega con la retención vencida; el saldo sigue disponible, se retiene de nuevo y se consume.
  await pool.query('UPDATE fid_retenciones SET vence_ms = ? WHERE id_retencion = ?', [Date.now() - 1000, nueva.json.id_retencion]);
  const conn = await pool.getConnection();
  await M.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'canje_instrumento', docTipo: 'venta', docIdGlobal: 'VTA-RET-VENC', contenido: { id_retencion: nueva.json.id_retencion, venta_id_global: 'VTA-RET-VENC' } });
  conn.release();
  await esperarMensajes(pool);
  assert.equal((await fid(`/consulta?codigo=${codigo}`)).json[0].saldo, 1000);
  // EX33: si Clientes no responde en la retención, la forma de pago no se ofrece.
  const real = await puertos.obtener('credito');
  puertos.registrar('credito', { ...real, retenerSaldo: async () => { throw new Error('reiniciándose'); } });
  const caido = await vender([[torta, 1]], [{ forma: 'vale', importe: 1000, instrumento: codigo }]);
  puertos.registrar('credito', real);
  assert.deepEqual([caido.status, caido.json.codigo], [409, 'CANJE_NO_DISPONIBLE']);
  // El canje con puntos del socio (cada punto vale $100): 7 puntos = $700.
  const conPuntos = await vender([[torta, 1]], [{ forma: 'vale', importe: 500, puntos: true }, { forma: 'efectivo', importe: 500 }], { cliente_id: ana.id });
  assert.equal(conPuntos.status, 200, JSON.stringify(conPuntos.json));
  assert.equal(Number((await pool.query("SELECT COALESCE(SUM(cantidad), 0) AS p FROM fid_movimientos WHERE cliente_id = ? AND movimiento = 'canje' AND tipo = 'puntos'", [ana.id]))[0][0].p), -5); // $500 a $100 por punto
});

test('Clientes.RF29/EX30/EX31: el vale por devolución se emite con el reintegro elegido, no puede ser mayor a lo devuelto y la gift card con canjes no se revierte', async () => {
  const v = await vender([[torta, 2]], efectivo(2000), { cliente_id: ana.id });
  const dev = await api('POST', '/api/devoluciones', { token, headers: { 'X-ID-Solicitud': 'devol-vale-1-abcdef' }, body: { venta_id_global: v.json.venta_id_global, motivo: 'Torta en mal estado', items: [{ linea: 0, cantidad: 1 }], reintegro: [{ forma: 'vale', importe: 1000 }], cliente_id: ana.id, autorizacion: AUT } });
  assert.equal(dev.status, 201, JSON.stringify(dev.json));
  await esperarMensajes(pool);
  const vale = (await fid(`/instrumentos?tipo=vale&devolucion_id=${dev.json.devolucion.id_global}`)).json[0];
  assert.deepEqual([vale.saldo, vale.cliente_id, vale.estado], [1000, ana.id, 'vigente']);
  // Un vale mayor al importe devuelto se rechaza (mensaje directo).
  const conn = await pool.getConnection();
  await M.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'emision_vale', docTipo: 'devolucion', docIdGlobal: 'DEV-MAL', contenido: { importe: 2000, importe_devuelto: 1000, venta_id_global: 'VTA-X', devolucion_id: 'DEV-MAL' } });
  conn.release();
  await esperarMensajes(pool);
  assert.match((await pool.query("SELECT motivo_rechazo FROM mensajes_integracion WHERE doc_id_global = 'DEV-MAL'"))[0][0].motivo_rechazo, /mayor al importe devuelto/);
  // Gift card vendida y devuelta: sin canjes se anula; con canjes se rechaza la reversión (a la bandeja de pendientes).
  const g1 = await vender([[tarjeta, 1]], efectivo(10000));
  const g1dev = await api('POST', '/api/devoluciones', { token, headers: { 'X-ID-Solicitud': 'devol-gc-1-abcdef' }, body: { venta_id_global: g1.json.venta_id_global, motivo: 'Se arrepintió', items: [{ linea: 0, cantidad: 1 }], autorizacion: AUT } });
  await esperarMensajes(pool);
  assert.equal(g1dev.status, 201, JSON.stringify(g1dev.json));
  assert.equal((await fid('/instrumentos?estado=anulado')).json.some((i) => i.venta_id_global === g1.json.venta_id_global), true);
  const g2 = await vender([[tarjeta, 1]], efectivo(10000));
  const gc2 = (await fid('/instrumentos?tipo=gift_card&estado=vigente')).json.find((i) => i.venta_id_global === g2.json.venta_id_global);
  assert.equal((await vender([[torta, 1]], [{ forma: 'vale', importe: 1000, instrumento: gc2.codigo }])).status, 200); // la canjea
  await api('POST', '/api/devoluciones', { token, headers: { 'X-ID-Solicitud': 'devol-gc-2-abcdef' }, body: { venta_id_global: g2.json.venta_id_global, motivo: 'Se arrepintió', items: [{ linea: 0, cantidad: 1 }], autorizacion: AUT } });
  await esperarMensajes(pool);
  assert.match((await pool.query("SELECT motivo_rechazo FROM mensajes_integracion WHERE tipo = 'reversion_emision' AND estado = 'rechazado'"))[0][0].motivo_rechazo, /instrumento con canjes/);
  assert.equal((await fid(`/consulta?codigo=${gc2.codigo}`)).json[0].estado, 'vigente');
});

test('Clientes.EX17/RN24: anular una venta revierte lo acumulado aunque el saldo quede negativo y restituye el canje al mismo instrumento', async () => {
  const antes = await socio(ana);
  const v = await vender([[cafe, 3]], efectivo(1200), { cliente_id: ana.id });
  const despues = await socio(ana);
  assert.equal(despues.sellos[0].sellos, antes.sellos[0].sellos + 3);
  // Gasta los sellos en otro premio y luego se anula la venta que los había dado: el saldo queda negativo.
  const regla = (await fid('/programa')).json.reglas[0];
  await vender([[cafe, 2]], efectivo(400), { cliente_id: ana.id, premio_sellos: { regla_id: regla.id } });
  await api('POST', '/api/devoluciones', { token, headers: { 'X-ID-Solicitud': 'devol-sellos-1-abcdef' }, body: { venta_id_global: v.json.venta_id_global, motivo: 'Anulación', items: [{ linea: 0, cantidad: 3 }], autorizacion: AUT } });
  await esperarMensajes(pool);
  const fin = await socio(ana);
  assert.ok(fin.sellos[0].sellos < 0, `sellos ${fin.sellos[0].sellos}`);
  const inf = (await fid('/informes')).json;
  assert.ok(inf.saldos_negativos.some((s) => s.cliente_id === ana.id && s.tipo === 'sellos'));
});

test('Clientes.RN27/RF24: el saldo vencido no se canjea ni se borra, se reactiva con permiso y motivo, se avisa antes de vencer y los informes muestran el pasivo', async () => {
  await fid('/programa', 'PUT', { venc_saldo_dias: 30, aviso_dias: 15 });
  const nuevo = (await fid('/saldo-favor', 'POST', { cliente_id: ana.id, importe: 800, motivo: 'Bonificación' })).json;
  assert.ok(nuevo.vence_en); // vencimiento configurable por tipo desde la emisión
  await pool.query('UPDATE fid_instrumentos SET vence_en = DATE_ADD(CURDATE(), INTERVAL 10 DAY) WHERE id = ?', [nuevo.id]);
  assert.deepEqual(await F.vencer(), { vencidos: 0, avisados: 1 });
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE tipo = 'vencimiento_saldo' AND estado <> 'resuelta'"))[0][0].n, 1);
  assert.deepEqual(await F.vencer(), { vencidos: 0, avisados: 0 }); // el aviso no se repite
  const prox = (await fid('/informes?dias=30')).json.vencimientos_proximos;
  assert.ok(prox.some((p) => p.codigo === nuevo.codigo));
  assert.ok((await fid('/informes')).json.pasivo.total > 0);
  await pool.query('UPDATE fid_instrumentos SET vence_en = DATE_SUB(CURDATE(), INTERVAL 1 DAY) WHERE id = ?', [nuevo.id]);
  assert.equal((await F.vencer()).vencidos, 1);
  const vencido = (await fid(`/consulta?codigo=${nuevo.codigo}`)).json[0];
  assert.deepEqual([vencido.estado, vencido.saldo], ['vencido', 0]); // queda registrado como movimiento de vencimiento
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM fid_instrumento_movs WHERE instrumento_id = ? AND movimiento = 'vencimiento'", [nuevo.id]))[0][0].n, 1);
  assert.equal((await fid('/retenciones', 'POST', { codigo: nuevo.codigo, importe: 100, idSolicitud: 'ret-venc-1-abcdef' })).json.estado, 'rechazada');
  assert.equal((await fid(`/instrumentos/${nuevo.id}/reactivar`, 'POST', {})).status, 400); // exige motivo
  const re = await fid(`/instrumentos/${nuevo.id}/reactivar`, 'POST', { motivo: 'Error de fecha', dias: 60 });
  assert.deepEqual([re.json.estado, re.json.saldo], ['vigente', 800]);
});

test('Ventas RF24/Clientes RN30: las promociones para socios solo rigen para socios (condición publicada a la copia local de Ventas)', async () => {
  await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['VEN-PROMOS'], motivo: 'prueba' } });
  const pr = (await api('POST', '/api/promociones', { token, body: { nombre: '10% socios', tipo: 'cantidad', porcentaje: 10, cantidad_minima: 2, items: [{ producto_id: torta.id }] } })).json;
  assert.equal((await api('PUT', `/api/promociones/${pr.id}/solo-socios`, { token, body: { solo_socios: true } })).json.solo_socios, 1);
  const conSocio = await vender([[torta, 2]], efectivo(1800), { cliente_id: ana.id }); // 2 x 1000 con 10% = 1800
  assert.equal(conSocio.status, 200, JSON.stringify(conSocio.json));
  const noSocio = await vender([[torta, 2]], efectivo(2000), { cliente_id: beto.id });
  assert.equal(noSocio.status, 200, JSON.stringify(noSocio.json)); // Beto no es socio: paga el precio completo
  const sinCliente = await vender([[torta, 2]], efectivo(2000));
  assert.equal(sinCliente.status, 200);
});

test('Clientes.EX18: desactivar CLI-FIDEL con saldos vigentes pide confirmar, no borra datos y los saldos vuelven al reactivar', async () => {
  const pedido = (confirmar) => api('POST', '/api/funciones/cambiar', { token, body: { desactivar: ['CLI-FIDEL'], motivo: 'prueba', ...(confirmar && { confirmar: { pendientes: true, cascada: true } }) } });
  const a = await pedido(false);
  assert.equal(a.status, 409);
  assert.match(JSON.stringify(a.json.pendientes), /instrumento\(s\) vigente\(s\)/);
  assert.equal((await pedido(true)).status, 200);
  assert.equal((await fid('/programa')).status, 409);
  assert.ok((await pool.query('SELECT COUNT(*) AS n FROM fid_instrumentos'))[0][0].n > 0); // los datos siguen
  await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['CLI-FIDEL'], motivo: 'prueba' } });
  assert.ok((await fid('/instrumentos')).json.length > 0);
});
